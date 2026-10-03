// Durable ingestion queue: accepted intake requests, their payload bytes and
// their status. Nothing here runs a model or fetches a URL; a worker drives
// requests through the claim/complete port below.
//
// Storage, outside every bank's fs/ sandbox (bank ids cannot start with "."):
//   <root>/.ingestion/<bank>/staging/<id>/            being written, not accepted
//   <root>/.ingestion/<bank>/requests/<id>/request.json
//   <root>/.ingestion/<bank>/requests/<id>/items/<n>  stored text / file bytes
//   <root>/.ingestion/<bank>/idempotency/<sha256(key)>.json
// Override the directory with MEMORY_BANK_INGESTION_DIR.
//
// Accept protocol (accept()):
//   1. payload bytes + request.json are written and fsynced into staging/<id>
//   2. under the bank's lifecycle lock (BankRegistry.admitDurableWork): bank
//      must be active, a durable hold `intake-<id>` is persisted, staging/<id>
//      is renamed to requests/<id>, the idempotency record is written
//   3. only then does the caller answer 202.
// A crash before step 2 leaves a staging dir (never acknowledged, deleted on
// recovery). A crash inside step 2 can leave a hold without a request (an
// orphan) or a request without its idempotency record; recover() repairs
// both, so an orphan hold never keeps a bank `archiving` forever.
//
// Statuses: queued -> running -> succeeded | partial | failed. A running
// request whose claim lease expired goes back to queued (reapExpired).
// The durable hold is released when a request reaches a terminal status.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { bankRoot } from '../bank.ts';
import { ApiError } from '../banks/errors.ts';
import {
  assertBankId,
  durableHoldId,
  fsyncDir,
  writeJsonDurable,
  type DurableWorkGuard,
} from '../banks/registry.ts';

export const INGESTION_DIR = '.ingestion';
export const INGESTION_KIND = 'intake' as const;

export type IngestionStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
export type ItemStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type ItemKind = 'text' | 'file' | 'url';

export const INGESTION_STATUSES: readonly IngestionStatus[] = ['queued', 'running', 'succeeded', 'partial', 'failed'];
const TERMINAL = new Set<IngestionStatus>(['succeeded', 'partial', 'failed']);

export interface ItemError {
  code: string;
  message: string;
}

/** What a worker needs to know about one item. Bytes come from readItem(). */
export interface ItemDescriptor {
  index: number;
  kind: ItemKind;
  filename: string | null;
  mediaType: string | null;
  /** Stored bytes; null for url items. */
  size: number | null;
  sha256: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface IngestionItem extends ItemDescriptor {
  status: ItemStatus;
  error: ItemError | null;
}

export interface IngestionRecord {
  id: string;
  bank: string;
  status: IngestionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  idempotencyKey: string | null;
  metadata: Record<string, unknown> | null;
  items: IngestionItem[];
  /** Bank revision (git commit) the worker produced; null until completed. */
  revision: string | null;
  error: ItemError | null;
}

interface StoredClaim {
  token: string;
  workerId: string;
  pid: number;
  leaseExpiresAt: string;
}

interface StoredRequest extends IngestionRecord {
  schema: 1;
  fingerprint: string;
  claim: StoredClaim | null;
}

/** One item as received, before it is stored. */
export interface NewItem {
  kind: ItemKind;
  /** text / file content; absent for url items. */
  bytes?: Buffer;
  filename?: string | null;
  mediaType?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AcceptInput {
  bank: string;
  items: NewItem[];
  metadata?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

export interface AcceptResult {
  record: IngestionRecord;
  /** true when an earlier request with the same Idempotency-Key was returned. */
  replayed: boolean;
}

export interface ListOptions {
  status?: IngestionStatus | 'all';
  limit?: number;
  /** Return requests whose id sorts strictly before this one (newest first). */
  before?: string;
}

export interface IngestionBatchClaim {
  bank: string;
  token: string;
  workerId: string;
  leaseExpiresAt: string;
  requests: Array<{
    id: string;
    bank: string;
    createdAt: string;
    attempts: number;
    metadata: Record<string, unknown> | null;
    items: ItemDescriptor[];
  }>;
}

export interface ItemOutcome {
  index: number;
  status: 'succeeded' | 'failed';
  error?: ItemError | null;
}

export interface RequestOutcome {
  requestId: string;
  items: ItemOutcome[];
  /** Bank revision (git commit sha) that contains this request's result. */
  revision?: string | null;
  /** Request-level error, e.g. when every item failed for one reason. */
  error?: ItemError | null;
}

/** The claim token no longer owns the request (lease expired and reaped, or completed). */
export class IngestionClaimLost extends Error {
  readonly code = 'claim_lost';
  constructor(message: string) {
    super(message);
    this.name = 'IngestionClaimLost';
  }
}

/**
 * The port the ingestion worker depends on. `IngestionStore` implements it.
 * The worker must process claimed work even when the bank is `archiving`
 * (the durable hold is what keeps archive waiting) and must not call
 * BankLifecycleGuard.beginOperation for it.
 */
export interface IngestionWorkQueue {
  /** Banks with at least one queued request, and when their oldest one was accepted. */
  pendingBanks(): Promise<Array<{ bank: string; firstQueuedAt: string }>>;
  pendingCounts(bank: string): Promise<{ queued: number; running: number }>;
  /** Every queued request of the bank -> running under one fencing token. Null when none queued. */
  claimBatch(options: { bank: string; workerId: string; leaseMs: number }): Promise<IngestionBatchClaim | null>;
  /** Extend the lease. Throws IngestionClaimLost when fenced out. */
  heartbeat(claim: IngestionBatchClaim, leaseMs?: number): Promise<void>;
  /** Stored text or file bytes. URL items have none: the worker fetches them. */
  readItem(claim: IngestionBatchClaim, requestId: string, index: number): Promise<Buffer>;
  /** Outcomes must cover every request and item of the batch. Releases the durable holds. */
  complete(claim: IngestionBatchClaim, outcomes: RequestOutcome[]): Promise<IngestionRecord[]>;
  /** Running requests whose lease expired -> queued. Returns how many. */
  reapExpired(now?: number): Promise<number>;
  /** Repair every bank after a restart (orphan holds, missing holds/idempotency records, staging). */
  recoverAll(): Promise<void>;
}

export const DEFAULT_LEASE_MS = 10 * 60_000;

// Per-bank serialisation of read-modify-write within one process. This store
// assumes a single writer process per root, like BankRegistry does.
const LOCKS = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = LOCKS.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  LOCKS.set(key, tail);
  try {
    return await run;
  } finally {
    if (LOCKS.get(key) === tail) LOCKS.delete(key);
  }
}

// Staging dirs being written right now by this process: recovery must not delete them.
const ACTIVE_STAGING = new Set<string>();
// Banks already recovered by this process, keyed by ingestion root + bank.
const RECOVERED = new Map<string, Promise<void>>();

export function ingestionRoot(): string {
  const fromEnv = process.env.MEMORY_BANK_INGESTION_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(bankRoot(), INGESTION_DIR);
}

/** Time-sortable id: lexicographic order = acceptance order. */
export function newIngestionId(now = Date.now()): string {
  return `ing_${now.toString(36).padStart(10, '0')}_${randomBytes(6).toString('hex')}`;
}

const ID_RE = /^ing_[0-9a-z]{10}_[0-9a-f]{12}$/;

export function isIngestionId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export class IngestionStore implements IngestionWorkQueue {
  private readonly lifecycle: DurableWorkGuard;

  constructor(lifecycle: DurableWorkGuard) {
    this.lifecycle = lifecycle;
  }

  // ---- paths --------------------------------------------------------------

  private bankDir(bank: string): string {
    return path.join(ingestionRoot(), bank);
  }
  private requestsDir(bank: string): string {
    return path.join(this.bankDir(bank), 'requests');
  }
  private requestDir(bank: string, id: string): string {
    return path.join(this.requestsDir(bank), id);
  }
  private requestFile(bank: string, id: string): string {
    return path.join(this.requestDir(bank, id), 'request.json');
  }
  private stagingDir(bank: string, id?: string): string {
    const dir = path.join(this.bankDir(bank), 'staging');
    return id ? path.join(dir, id) : dir;
  }
  private idempotencyFile(bank: string, key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return path.join(this.bankDir(bank), 'idempotency', `${digest}.json`);
  }
  private lockKey(bank: string): string {
    return `${ingestionRoot()}\0${bank}`;
  }

  // ---- intake -------------------------------------------------------------

  /**
   * Persist a request durably and return it as `queued`. Throws ApiError:
   * bank_not_found / bank_archiving / bank_archived (from the lifecycle),
   * idempotency_conflict (same key, different payload).
   */
  async accept(input: AcceptInput): Promise<AcceptResult> {
    assertBankId(input.bank);
    const bank = input.bank;
    const items = input.items.map((item) => ({ ...item, sha256: item.bytes ? sha256(item.bytes) : null }));
    const fingerprint = fingerprintOf(input.metadata ?? null, items);
    const key = input.idempotencyKey ?? null;

    if (key) {
      const prior = await withLock(this.lockKey(bank), async () => {
        await this.recoverLocked(bank);
        return this.replay(bank, key, fingerprint);
      });
      if (prior) return prior;
    }

    const id = newIngestionId();
    const now = new Date().toISOString();
    const record: StoredRequest = {
      schema: 1,
      id,
      bank,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      idempotencyKey: key,
      metadata: input.metadata ?? null,
      items: items.map((item, index) => ({
        index,
        kind: item.kind,
        filename: item.filename ?? null,
        mediaType: item.mediaType ?? null,
        size: item.bytes ? item.bytes.length : null,
        sha256: item.sha256,
        url: item.url ?? null,
        metadata: item.metadata ?? null,
        status: 'queued',
        error: null,
      })),
      revision: null,
      error: null,
      fingerprint,
      claim: null,
    };

    const staging = this.stagingDir(bank, id);
    ACTIVE_STAGING.add(staging);
    try {
      await this.stage(staging, record, items);
      return await withLock(this.lockKey(bank), async () => {
        await this.recoverLocked(bank);
        if (key) {
          // A concurrent identical request may have committed while we staged.
          const prior = await this.replay(bank, key, fingerprint);
          if (prior) return prior;
        }
        return this.lifecycle.admitDurableWork(bank, INGESTION_KIND, id, async () => {
          await fs.mkdir(this.requestsDir(bank), { recursive: true });
          await fs.rename(staging, this.requestDir(bank, id));
          await fsyncDir(this.requestsDir(bank));
          try {
            if (key) await this.writeIdempotency(bank, key, id, fingerprint);
          } catch (err) {
            // Roll the commit back: the caller never sees a 202 for it.
            await fs.rm(this.requestDir(bank, id), { recursive: true, force: true });
            throw err;
          }
          return { record: publicRecord(record), replayed: false };
        });
      });
    } finally {
      ACTIVE_STAGING.delete(staging);
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  private async stage(staging: string, record: StoredRequest, items: NewItem[]): Promise<void> {
    await fs.mkdir(path.join(staging, 'items'), { recursive: true });
    for (const [index, item] of items.entries()) {
      if (!item.bytes) continue;
      await writeFileDurable(path.join(staging, 'items', String(index)), item.bytes);
    }
    await fsyncDir(path.join(staging, 'items'));
    await writeJsonDurable(path.join(staging, 'request.json'), record);
  }

  /** Same key: same payload -> the stored request; other payload -> 409. Caller holds the lock. */
  private async replay(bank: string, key: string, fingerprint: string): Promise<AcceptResult | null> {
    const entry = await readJson<{ key: string; requestId: string; fingerprint: string }>(
      this.idempotencyFile(bank, key),
    );
    if (!entry) return null;
    const stored = await this.readStored(bank, entry.requestId);
    if (!stored) return null; // dangling; recovery removes it
    if (entry.fingerprint !== fingerprint) {
      throw new ApiError(
        'idempotency_conflict',
        'Idempotency-Key was already used for a different request payload on this bank',
        { bank, ingestionId: entry.requestId },
      );
    }
    return { record: publicRecord(stored), replayed: true };
  }

  private async writeIdempotency(bank: string, key: string, requestId: string, fingerprint: string): Promise<void> {
    const file = this.idempotencyFile(bank, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJsonDurable(file, { key, requestId, fingerprint, createdAt: new Date().toISOString() });
  }

  // ---- reads --------------------------------------------------------------

  async get(bank: string, id: string): Promise<IngestionRecord | null> {
    assertBankId(bank);
    if (!isIngestionId(id)) return null;
    await this.recover(bank);
    const stored = await this.readStored(bank, id);
    return stored ? publicRecord(stored) : null;
  }

  /** Newest first. */
  async list(bank: string, options: ListOptions = {}): Promise<{ ingestions: IngestionRecord[]; nextBefore: string | null }> {
    assertBankId(bank);
    await this.recover(bank);
    const status = options.status ?? 'all';
    const limit = options.limit ?? 50;
    const ids = (await this.requestIds(bank))
      .filter((id) => options.before === undefined || id < options.before)
      .reverse();
    const ingestions: IngestionRecord[] = [];
    let nextBefore: string | null = null;
    for (const id of ids) {
      const stored = await this.readStored(bank, id);
      if (!stored) continue;
      if (status !== 'all' && stored.status !== status) continue;
      if (ingestions.length === limit) {
        nextBefore = ingestions[ingestions.length - 1].id;
        break;
      }
      ingestions.push(publicRecord(stored));
    }
    return { ingestions, nextBefore };
  }

  async pendingCounts(bank: string): Promise<{ queued: number; running: number }> {
    assertBankId(bank);
    await this.recover(bank);
    const counts = { queued: 0, running: 0 };
    for (const stored of await this.readAll(bank)) {
      if (stored.status === 'queued') counts.queued++;
      else if (stored.status === 'running') counts.running++;
    }
    return counts;
  }

  async pendingBanks(): Promise<Array<{ bank: string; firstQueuedAt: string }>> {
    const out: Array<{ bank: string; firstQueuedAt: string }> = [];
    for (const bank of await this.banks()) {
      await this.recover(bank);
      let first: string | null = null;
      for (const stored of await this.readAll(bank)) {
        if (stored.status === 'queued' && (first === null || stored.createdAt < first)) first = stored.createdAt;
      }
      if (first) out.push({ bank, firstQueuedAt: first });
    }
    return out.sort((a, b) => a.firstQueuedAt.localeCompare(b.firstQueuedAt));
  }

  // ---- worker port --------------------------------------------------------

  async claimBatch(options: { bank: string; workerId: string; leaseMs: number }): Promise<IngestionBatchClaim | null> {
    assertBankId(options.bank);
    const bank = options.bank;
    return withLock(this.lockKey(bank), async () => {
      await this.recoverLocked(bank);
      const queued = (await this.readAll(bank)).filter((r) => r.status === 'queued');
      if (queued.length === 0) return null;
      const now = new Date();
      const claim: StoredClaim = {
        token: randomUUID(),
        workerId: options.workerId,
        pid: process.pid,
        leaseExpiresAt: new Date(now.getTime() + options.leaseMs).toISOString(),
      };
      const requests: IngestionBatchClaim['requests'] = [];
      for (const stored of queued) {
        const next: StoredRequest = {
          ...stored,
          status: 'running',
          attempts: stored.attempts + 1,
          startedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          items: stored.items.map((item) => ({ ...item, status: 'running', error: null })),
          claim,
        };
        await this.writeStored(next);
        requests.push({
          id: next.id,
          bank,
          createdAt: next.createdAt,
          attempts: next.attempts,
          metadata: next.metadata,
          items: next.items.map(descriptor),
        });
      }
      return { bank, token: claim.token, workerId: claim.workerId, leaseExpiresAt: claim.leaseExpiresAt, requests };
    });
  }

  async heartbeat(claim: IngestionBatchClaim, leaseMs = DEFAULT_LEASE_MS): Promise<void> {
    await withLock(this.lockKey(claim.bank), async () => {
      const owned = await this.ownedRequests(claim);
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      for (const stored of owned) {
        await this.writeStored({ ...stored, claim: { ...stored.claim!, leaseExpiresAt } });
      }
      claim.leaseExpiresAt = leaseExpiresAt;
    });
  }

  async readItem(claim: IngestionBatchClaim, requestId: string, index: number): Promise<Buffer> {
    const stored = await withLock(this.lockKey(claim.bank), async () => {
      const owned = await this.ownedRequests(claim);
      return owned.find((r) => r.id === requestId);
    });
    if (!stored) throw new Error(`Request ${requestId} is not part of this claim`);
    const item = stored.items[index];
    if (!item) throw new Error(`Request ${requestId} has no item ${index}`);
    if (item.kind === 'url') throw new Error(`Item ${index} of ${requestId} is a URL: fetch it, nothing is stored`);
    return fs.readFile(path.join(this.requestDir(claim.bank, requestId), 'items', String(index)));
  }

  async complete(claim: IngestionBatchClaim, outcomes: RequestOutcome[]): Promise<IngestionRecord[]> {
    const done = await withLock(this.lockKey(claim.bank), async () => {
      const owned = await this.ownedRequests(claim);
      const byId = new Map(outcomes.map((o) => [o.requestId, o]));
      if (byId.size !== outcomes.length || byId.size !== owned.length || owned.some((r) => !byId.has(r.id))) {
        throw new Error('complete() needs exactly one outcome per claimed request');
      }
      const now = new Date().toISOString();
      const results: StoredRequest[] = [];
      for (const stored of owned) {
        const outcome = byId.get(stored.id)!;
        const itemOutcomes = new Map(outcome.items.map((i) => [i.index, i]));
        if (itemOutcomes.size !== stored.items.length || stored.items.some((i) => !itemOutcomes.has(i.index))) {
          throw new Error(`complete() needs exactly one outcome per item of ${stored.id}`);
        }
        const items = stored.items.map((item) => {
          const o = itemOutcomes.get(item.index)!;
          return {
            ...item,
            status: o.status,
            error: o.status === 'failed' ? (o.error ?? { code: 'failed', message: 'Item failed' }) : null,
          };
        });
        const ok = items.filter((i) => i.status === 'succeeded').length;
        const status: IngestionStatus = ok === items.length ? 'succeeded' : ok === 0 ? 'failed' : 'partial';
        const next: StoredRequest = {
          ...stored,
          status,
          items,
          finishedAt: now,
          updatedAt: now,
          revision: outcome.revision ?? null,
          error: outcome.error ?? null,
          claim: null,
        };
        await this.writeStored(next);
        results.push(next);
      }
      return results;
    });
    // Outside the store lock: releasing may settle archiving -> archived.
    for (const r of done) await this.lifecycle.releaseDurableWork(r.bank, durableHoldId(INGESTION_KIND, r.id));
    return done.map(publicRecord);
  }

  async reapExpired(now = Date.now()): Promise<number> {
    let reaped = 0;
    for (const bank of await this.banks()) {
      reaped += await withLock(this.lockKey(bank), async () => {
        let n = 0;
        for (const stored of await this.readAll(bank)) {
          if (stored.status !== 'running') continue;
          if (stored.claim && Date.parse(stored.claim.leaseExpiresAt) > now) continue;
          await this.writeStored({
            ...stored,
            status: 'queued',
            updatedAt: new Date(now).toISOString(),
            items: stored.items.map((item) => ({ ...item, status: 'queued', error: null })),
            claim: null,
          });
          n++;
        }
        return n;
      });
    }
    return reaped;
  }

  /** Requests of this claim still owned by its token; throws IngestionClaimLost otherwise. Lock held. */
  private async ownedRequests(claim: IngestionBatchClaim): Promise<StoredRequest[]> {
    const owned: StoredRequest[] = [];
    for (const r of claim.requests) {
      const stored = await this.readStored(claim.bank, r.id);
      if (!stored || stored.status !== 'running' || stored.claim?.token !== claim.token) {
        throw new IngestionClaimLost(`Claim ${claim.token} no longer owns ingestion ${r.id}`);
      }
      owned.push(stored);
    }
    return owned;
  }

  // ---- recovery -----------------------------------------------------------

  async recoverAll(): Promise<void> {
    for (const bank of await this.banks()) await this.recover(bank);
  }

  /** Once per bank per process (and per ingestion root). Safe to call any time. */
  async recover(bank: string): Promise<void> {
    assertBankId(bank);
    const key = this.lockKey(bank);
    if (!RECOVERED.has(key)) {
      // The memo is set inside the lock by recoverLocked; nothing to do if it ran meanwhile.
      await withLock(key, () => this.recoverLocked(bank));
    }
  }

  /**
   * Caller holds the store lock. Repairs what a crash can leave behind:
   * - staging dirs: never acknowledged, deleted
   * - intake holds whose request does not exist: orphans, released
   * - committed non-terminal requests without a hold: hold re-created
   * - committed requests whose idempotency record is missing: re-written
   */
  private async recoverLocked(bank: string): Promise<void> {
    const key = this.lockKey(bank);
    const memo = RECOVERED.get(key);
    if (memo) return memo;
    const run = this.repair(bank);
    RECOVERED.set(key, run);
    try {
      await run;
    } catch (err) {
      RECOVERED.delete(key);
      throw err;
    }
  }

  private async repair(bank: string): Promise<void> {
    for (const name of await readdirOrEmpty(this.stagingDir(bank))) {
      const dir = this.stagingDir(bank, name);
      if (!ACTIVE_STAGING.has(dir)) await fs.rm(dir, { recursive: true, force: true });
    }
    const ids = new Set(await this.requestIds(bank));
    // Re-create missing holds BEFORE dropping orphans: releasing a hold may
    // settle an archiving bank, which must still see every live request.
    for (const stored of await this.readAll(bank)) {
      if (!TERMINAL.has(stored.status)) await this.lifecycle.ensureDurableWork(bank, INGESTION_KIND, stored.id);
      if (stored.idempotencyKey) {
        const file = this.idempotencyFile(bank, stored.idempotencyKey);
        const entry = await readJson<{ requestId: string }>(file);
        if (!entry || !ids.has(entry.requestId)) {
          await this.writeIdempotency(bank, stored.idempotencyKey, stored.id, stored.fingerprint);
        }
      }
    }
    for (const hold of await this.lifecycle.listDurableWork(bank)) {
      if (hold.kind === INGESTION_KIND && !ids.has(hold.ref)) {
        await this.lifecycle.releaseDurableWork(bank, hold.id);
      }
    }
  }

  // ---- storage helpers ----------------------------------------------------

  /** Banks that have an ingestion directory. */
  private async banks(): Promise<string[]> {
    const names = await readdirOrEmpty(ingestionRoot());
    return names.filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)).sort();
  }

  private async requestIds(bank: string): Promise<string[]> {
    return (await readdirOrEmpty(this.requestsDir(bank))).filter(isIngestionId).sort();
  }

  private async readAll(bank: string): Promise<StoredRequest[]> {
    const out: StoredRequest[] = [];
    for (const id of await this.requestIds(bank)) {
      const stored = await this.readStored(bank, id);
      if (stored) out.push(stored);
    }
    return out;
  }

  private async readStored(bank: string, id: string): Promise<StoredRequest | null> {
    if (!isIngestionId(id)) return null;
    const raw = await readJson<StoredRequest>(this.requestFile(bank, id));
    if (!raw) return null;
    if (raw.schema !== 1 || raw.id !== id || raw.bank !== bank || !INGESTION_STATUSES.includes(raw.status)) {
      throw new Error(`Corrupt ingestion record ${this.requestFile(bank, id)}`);
    }
    return raw;
  }

  private async writeStored(stored: StoredRequest): Promise<void> {
    await writeJsonDurable(this.requestFile(stored.bank, stored.id), stored);
  }
}

// ---- pure helpers -----------------------------------------------------------

function descriptor(item: IngestionItem): ItemDescriptor {
  const { status: _s, error: _e, ...rest } = item;
  return rest;
}

function publicRecord(stored: StoredRequest): IngestionRecord {
  const { schema: _schema, fingerprint: _f, claim: _c, ...record } = stored;
  return record;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Payload identity for Idempotency-Key: everything the client sent, content by hash. */
function fingerprintOf(metadata: Record<string, unknown> | null, items: Array<NewItem & { sha256: string | null }>): string {
  const canonical = canonicalJson({
    metadata,
    items: items.map((i) => ({
      kind: i.kind,
      sha256: i.sha256,
      filename: i.filename ?? null,
      mediaType: i.mediaType ?? null,
      url: i.url ?? null,
      metadata: i.metadata ?? null,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

async function writeFileDurable(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}
