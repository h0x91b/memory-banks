// In-memory IngestionWorkPort with the store's documented semantics (batch
// claim, lease + fencing token, reaping, holds released on complete), driven
// by an injectable clock. Lets the worker tests run without the real store.
import { randomUUID } from 'node:crypto';
import {
  ClaimLostError,
  type BatchClaim,
  type IngestionWorkPort,
  type QueuedItem,
  type RequestOutcome,
} from '../../src/ingestion-worker/port.ts';

export interface FakeRequest {
  id: string;
  bank: string;
  createdAt: string;
  attempts: number;
  metadata?: Record<string, unknown>;
  hint?: string;
  immediate?: boolean;
  items: QueuedItem[];
  bytes: Map<number, Buffer>;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
  token: string | null;
  leaseUntil: number;
  outcome?: RequestOutcome;
  hold: boolean;
}

export class FakeIngestionStore implements IngestionWorkPort {
  readonly requests = new Map<string, FakeRequest>();
  readonly claims: BatchClaim[] = [];
  completes = 0;
  /** Make the next heartbeats fail as if fenced out. */
  fenceOut = false;

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  enqueue(
    bank: string,
    items: Array<QueuedItem & { content?: string }>,
    options: { id?: string; metadata?: Record<string, unknown>; hint?: string; immediate?: boolean; attempts?: number; at?: number } = {},
  ): FakeRequest {
    const id = options.id ?? `req-${randomUUID().slice(0, 8)}`;
    const bytes = new Map<number, Buffer>();
    const descriptors = items.map(({ content, ...d }) => {
      if (content !== undefined) bytes.set(d.index, Buffer.from(content));
      return d;
    });
    const r: FakeRequest = {
      id,
      bank,
      createdAt: new Date(options.at ?? this.now()).toISOString(),
      attempts: options.attempts ?? 0,
      metadata: options.metadata,
      ...(options.hint ? { hint: options.hint } : {}),
      ...(options.immediate ? { immediate: true } : {}),
      items: descriptors,
      bytes,
      status: 'queued',
      token: null,
      leaseUntil: 0,
      hold: true,
    };
    this.requests.set(id, r);
    return r;
  }

  async pendingBanks() {
    const first = new Map<string, string>();
    const immediate = new Set<string>();
    for (const r of this.requests.values()) {
      if (r.status !== 'queued') continue;
      const cur = first.get(r.bank);
      if (!cur || r.createdAt < cur) first.set(r.bank, r.createdAt);
      if (r.immediate) immediate.add(r.bank);
    }
    return [...first].map(([bank, firstQueuedAt]) =>
      immediate.has(bank) ? { bank, firstQueuedAt, immediate: true } : { bank, firstQueuedAt },
    );
  }

  async claimBatch({ bank, workerId, leaseMs }: { bank: string; workerId: string; leaseMs: number }) {
    const queued = [...this.requests.values()]
      .filter((r) => r.bank === bank && r.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!queued.length) return null;
    const token = `batch-${randomUUID().slice(0, 8)}`;
    for (const r of queued) {
      r.status = 'running';
      r.attempts += 1;
      r.token = token;
      r.leaseUntil = this.now() + leaseMs;
    }
    const claim: BatchClaim = {
      bank,
      workerId,
      token,
      requests: queued.map((r) => ({
        id: r.id,
        bank: r.bank,
        createdAt: r.createdAt,
        attempts: r.attempts,
        metadata: r.metadata,
        hint: r.hint,
        ...(r.immediate ? { immediate: true } : {}),
        items: r.items,
      })),
    };
    this.claims.push(claim);
    return claim;
  }

  private owned(claim: BatchClaim): FakeRequest[] {
    const mine = claim.requests.map((q) => this.requests.get(q.id)!);
    if (this.fenceOut || mine.some((r) => r.token !== claim.token || r.status !== 'running')) {
      throw new ClaimLostError();
    }
    return mine;
  }

  async heartbeat(claim: BatchClaim) {
    for (const r of this.owned(claim)) r.leaseUntil = this.now() + 60_000;
  }

  async readItem(claim: BatchClaim, requestId: string, index: number) {
    this.owned(claim);
    const b = this.requests.get(requestId)?.bytes.get(index);
    if (!b) throw new Error(`no stored bytes for ${requestId}/${index}`);
    return b;
  }

  async complete(claim: BatchClaim, outcomes: RequestOutcome[]) {
    const mine = this.owned(claim);
    if (outcomes.length !== mine.length) throw new Error('outcomes must cover the batch');
    for (const o of outcomes) {
      const r = this.requests.get(o.requestId)!;
      const ok = o.items.filter((i) => i.status === 'succeeded').length;
      r.status = ok === o.items.length && !o.error ? 'succeeded' : ok ? 'partial' : 'failed';
      if (o.items.length === 0) r.status = o.error ? 'failed' : 'succeeded';
      r.outcome = o;
      r.token = null;
      r.hold = false;
    }
    this.completes++;
  }

  async reapExpired(now = this.now()) {
    let n = 0;
    for (const r of this.requests.values()) {
      if (r.status === 'running' && r.leaseUntil <= now) {
        r.status = 'queued';
        r.token = null;
        n++;
      }
    }
    return n;
  }

  holds(bank: string): number {
    return [...this.requests.values()].filter((r) => r.bank === bank && r.hold).length;
  }
}

/** setTimeout-compatible manual clock: time moves only through advance(). */
export class ManualClock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.parse('2026-10-03T10:00:00Z')) {
    this.t = start;
  }

  now = () => this.t;

  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };

  /** Move time forward, firing due timers in order (and timers they schedule). */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}
