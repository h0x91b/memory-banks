// Ingestion worker: turns durably queued ingestion requests into Librarian
// runs, one bank at a time per bank, many banks in parallel.
//
// Scheduling (per bank, fixed window — not a debounce):
//   - the window opens at the bank's oldest queued arrival and closes
//     `windowMs` later; arrivals inside it do not push it back;
//   - when it closes the worker takes the bank mutation lock, THEN claims every
//     request queued at that moment as one batch (the batch closes at run start);
//   - requests arriving while the batch runs stay queued and open the next
//     window, measured from their own arrival — if it already elapsed, the next
//     batch starts right after the current one;
//   - a queued request with `immediate: true` makes the bank's next batch
//     eligible now (an open window is cut short; everything queued joins it).
//     A busy bank still waits for its running batch: never two runs per bank,
//     nothing is cancelled or preempted.
//
// Exclusion: a batch runs inside `withBankMutation`, the same lock the legacy
// HTTP/CLI Librarian takes, so two runs of one bank never overlap in the
// supported one-server-per-root mode. The lease + fencing token only decide
// whose results the store accepts: a run that lost its claim keeps the lock
// until it finishes, so a reclaimed batch can only start after it.
//
// Delivery is at-least-once. A worker that dies mid-batch leaves the requests
// `running`; once the lease expires `reapExpired` re-queues them and they run
// again. Items whose ingest commit already landed (found by the
// `Ingestion-Item:` trailer) are not ingested twice; anything else may be.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { bankFsPath, bankPath } from '../bank.ts';
import { withBankMutation, type BankMutation } from '../bank-mutation.ts';
import { gitCommitAll, gitEnsureRepo } from '../git.ts';
import { redactUrlIn, redactUrlSecrets } from '../ingest-provenance.ts';
import type { IngestItem, IngestResult } from '../ingest.ts';
import {
  isClaimLost,
  type BatchClaim,
  type IngestionWorkPort,
  type ItemOutcome,
  type PendingBank,
  type QueuedItem,
  type QueuedRequest,
  type RequestOutcome,
} from './port.ts';

const exec = promisify(execFile);

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** Timers the worker schedules with; tests swap in a manual clock. */
export interface WorkerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: WorkerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface CurateResult {
  commits: string[];
  summary?: string;
}

/** What this batch ingested, for a Librarian briefing that names item origins. */
export interface CurateContext {
  /** One entry per item ingested in this attempt (not replayed ones). */
  provenance: Array<{ rawName: string; source: unknown }>;
  /** Short sha of this batch's ingest commit, null when nothing new was ingested. */
  ingestCommit: string | null;
  /**
   * One entry per batched request that carried a hint, in batch order, each
   * tied to the raw files of its own items, so one caller's context never
   * reads as applying to another's material.
   */
  callerHints: CallerHint[];
}

export interface CallerHint {
  requestId: string;
  hint: string;
  /** Names in fs/_raw/ of the request's items ingested in this attempt. */
  rawNames: string[];
  /** Items ingested by an earlier, interrupted attempt; their raw names were not recorded. */
  unlistedFiles: number;
}

/** Runs the Librarian over whatever sits in the bank's fs/_raw/. */
export type CurateFn = (bank: string, runId: string, ctx: CurateContext) => Promise<CurateResult>;
/** Original descriptor of a spooled item, so ingest can record provenance instead of the spool path. */
export interface IngestOrigin {
  kind: QueuedItem['kind'];
  filename?: string;
  url?: string;
  mediaType?: string;
}
export type IngestFn = (
  bank: string,
  item: IngestItem,
  opts?: { origin?: IngestOrigin },
) => Promise<Omit<IngestResult, 'rawName' | 'source'> & { rawName?: string; source?: unknown }>;
/** Builds the batch's ingest commit message; `trailers` must stay its last paragraph. */
export type IngestCommitFormatter = (
  entries: Array<{ rawName: string; source: unknown }>,
  opts: { trailers: string[] },
) => string;
export type BankStatusFn = (bank: string) => Promise<'active' | 'archiving' | 'archived' | 'missing'>;

export interface QueueTiming {
  windowMs: number;
  /** Arrival of the bank's oldest queued request (ISO), null when nothing is queued. */
  firstQueuedAt: string | null;
  /**
   * Earliest the bank's next batch can start (ISO): when the fixed window
   * closes, or already now when a queued request asked for `immediate`.
   */
  eligibleAt: string | null;
  /** A queued request of the bank asked for `immediate`: the window is skipped. */
  immediate: boolean;
  /** A batch of this bank is running now; the next one waits for it. */
  batchRunning: boolean;
}

export interface IngestionWorkerOptions {
  store: IngestionWorkPort;
  curate: CurateFn;
  /** The existing ingest step (src/ingest.ts `ingestOne`). */
  ingest: IngestFn;
  /** Provenance-aware commit message (src/ingest-provenance.ts); default: subject + trailers. */
  formatIngestCommit?: IngestCommitFormatter;
  /** Bank lifecycle lookup. Archiving banks are still drained; archived/missing ones fail the batch. */
  bankStatus?: BankStatusFn;
  fetch?: typeof fetch;
  clock?: WorkerClock;
  workerId?: string;
  windowMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  downloadTimeoutMs?: number;
  downloadMaxBytes?: number;
  log?: (message: string) => void;
}

export class IngestionWorker {
  readonly workerId: string;
  private readonly o: Required<
    Omit<IngestionWorkerOptions, 'bankStatus' | 'workerId' | 'heartbeatMs' | 'formatIngestCommit'>
  > & { bankStatus?: BankStatusFn; heartbeatMs: number; formatIngestCommit: IngestCommitFormatter };
  /** Armed window timers per bank, with the epoch ms they fire at. */
  private readonly windows = new Map<string, { handle: unknown; at: number }>();
  private readonly running = new Map<string, Promise<void>>();
  private pollTimer: unknown = null;
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private started = false;
  private stopped = false;

  constructor(options: IngestionWorkerOptions) {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.o = {
      store: options.store,
      curate: options.curate,
      ingest: options.ingest,
      formatIngestCommit: options.formatIngestCommit ?? defaultIngestCommit,
      bankStatus: options.bankStatus,
      fetch: options.fetch ?? fetch,
      clock: options.clock ?? systemClock,
      windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
      leaseMs,
      heartbeatMs: options.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3)),
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      downloadTimeoutMs: options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      downloadMaxBytes: options.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
      log: options.log ?? ((m) => console.log(`[ingestion-worker] ${m}`)),
    };
  }

  /** Recover crashed batches, then schedule every bank with queued work. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.o.store.recoverAll?.();
    await this.scan();
    this.schedulePoll();
  }

  /** Hint that `bank` got new work (intake calls this after an accept). Safe to over-call. */
  notify(_bank?: string): void {
    if (this.started && !this.stopped) void this.scan();
  }

  /**
   * Stop scheduling and wait for running batches to finish. A batch that does
   * not finish (process killed) is recovered on the next start via its lease.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const { handle } of this.windows.values()) this.o.clock.clearTimeout(handle);
    this.windows.clear();
    if (this.pollTimer) this.o.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.scanning;
    await Promise.allSettled([...this.running.values()]);
  }

  /** Test/diagnostic view: banks with an open window or a running batch. */
  state(): { waiting: string[]; running: string[] } {
    return { waiting: [...this.windows.keys()].sort(), running: [...this.running.keys()].sort() };
  }

  /** Resolves when no scan or batch is in progress (windows may still be open). */
  async idle(): Promise<void> {
    while (this.scanning || this.running.size) {
      await this.scanning;
      await Promise.allSettled([...this.running.values()]);
    }
  }

  // ---- scheduling ---------------------------------------------------------

  private schedulePoll(): void {
    if (this.stopped) return;
    this.pollTimer = this.o.clock.setTimeout(() => {
      this.pollTimer = null;
      void this.scan().finally(() => this.schedulePoll());
    }, this.o.pollMs);
  }

  private scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.rescan = false;
        try {
          await this.scanOnce();
        } catch (err) {
          this.o.log(`scan failed: ${errorMessage(err)}`);
        }
      } while (this.rescan && !this.stopped);
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    if (this.stopped) return;
    // Claims of a crashed process expire and go back to the queue. A batch of
    // this process that is merely slow keeps heartbeating, so it is not reaped;
    // a reaped one could only rerun after it releases the bank lock anyway.
    const reaped = await this.o.store.reapExpired(this.o.clock.now());
    if (reaped) this.o.log(`re-queued ${reaped} request(s) from expired claims`);
    for (const pending of await this.o.store.pendingBanks()) {
      const { bank } = pending;
      // A running bank is rescanned when its batch releases the lock.
      if (this.running.has(bank)) continue;
      const at = this.eligibleAt(pending);
      const armed = this.windows.get(bank);
      // An armed window only moves earlier (an immediate arrival), never later.
      if (armed && armed.at <= at) continue;
      if (armed) this.o.clock.clearTimeout(armed.handle);
      const handle = this.o.clock.setTimeout(() => {
        this.windows.delete(bank);
        this.launch(bank);
      }, Math.max(0, at - this.o.clock.now()));
      this.windows.set(bank, { handle, at });
    }
  }

  /** Epoch ms the bank's next batch may start: window close, or now for an immediate request. */
  private eligibleAt(pending: PendingBank): number {
    const closes = this.windowClosesAt(pending.firstQueuedAt);
    return pending.immediate ? Math.min(closes, this.o.clock.now()) : closes;
  }

  /** When the fixed window opened by the bank's oldest queued arrival closes (epoch ms). */
  private windowClosesAt(firstQueuedAt: string): number {
    const arrived = Date.parse(firstQueuedAt);
    return (Number.isFinite(arrived) ? arrived : this.o.clock.now()) + this.o.windowMs;
  }

  /**
   * Read-only view of when `bank`'s queued work becomes eligible to run. The
   * window close is the earliest start, not a promise: a batch already running
   * for the bank (`batchRunning`) holds the bank lock until it finishes.
   */
  async queueTiming(bank: string): Promise<QueueTiming> {
    const pending = (await this.o.store.pendingBanks()).find((p) => p.bank === bank);
    return {
      windowMs: this.o.windowMs,
      firstQueuedAt: pending?.firstQueuedAt ?? null,
      eligibleAt: pending ? new Date(this.eligibleAt(pending)).toISOString() : null,
      immediate: pending?.immediate === true,
      batchRunning: this.running.has(bank),
    };
  }

  private launch(bank: string): void {
    if (this.stopped || this.running.has(bank)) return;
    const run = this.runBatch(bank)
      .catch((err) => this.o.log(`${bank}: batch failed: ${errorMessage(err)}`))
      .finally(() => {
        this.running.delete(bank);
        // Arrivals during the run are still queued: open their window now.
        if (!this.stopped) void this.scan();
      });
    this.running.set(bank, run);
  }

  // ---- one batch ----------------------------------------------------------

  private async runBatch(bank: string): Promise<void> {
    await withBankMutation(bank, async (mutation) => {
      if (this.stopped) return;
      const claim = await this.o.store.claimBatch({ bank, workerId: this.workerId, leaseMs: this.o.leaseMs });
      if (!claim) return;
      this.o.log(`${bank}: batch ${claim.token} claimed ${claim.requests.length} request(s)`);

      let lost: Error | null = null;
      let hbHandle: unknown = null;
      let hbActive = true;
      const beat = () => {
        hbHandle = this.o.clock.setTimeout(() => {
          this.o.store.heartbeat(claim, this.o.leaseMs).then(
            () => hbActive && beat(),
            (err) => {
              lost = err instanceof Error ? err : new Error(String(err));
              this.o.log(`${bank}: batch ${claim.token} lost its claim: ${errorMessage(err)}`);
            },
          );
        }, this.o.heartbeatMs);
      };
      beat();

      let outcomes: RequestOutcome[];
      try {
        outcomes = await this.processBatch(claim, mutation, () => lost !== null);
      } finally {
        hbActive = false;
        if (hbHandle) this.o.clock.clearTimeout(hbHandle);
      }
      if (lost) return; // fenced out: the reclaimed batch reports instead
      try {
        await this.o.store.complete(claim, outcomes);
        this.o.log(`${bank}: batch ${claim.token} completed`);
      } catch (err) {
        if (!isClaimLost(err)) throw err;
        this.o.log(`${bank}: batch ${claim.token} results rejected: ${errorMessage(err)}`);
      }
    });
  }

  private async processBatch(claim: BatchClaim, mutation: BankMutation, isLost: () => boolean): Promise<RequestOutcome[]> {
    const { bank, token: batchId } = claim;
    const outcomes = new Map<string, RequestOutcome>();
    const fail = (r: QueuedRequest, code: string, message: string) =>
      outcomes.set(r.id, {
        requestId: r.id,
        batchId,
        commits: [],
        revision: null,
        error: { code, message },
        items: r.items.map((it) => ({ index: it.index, status: 'failed', error: { code, message } })),
      });

    const status = this.o.bankStatus ? await this.o.bankStatus(bank) : 'active';
    if (status === 'archived' || status === 'missing') {
      const code = status === 'archived' ? 'bank_archived' : 'bank_not_found';
      for (const r of claim.requests) fail(r, code, `Bank "${bank}" is ${status}`);
      return [...outcomes.values()];
    }

    const live: QueuedRequest[] = [];
    for (const r of claim.requests) {
      if (r.attempts > this.o.maxAttempts) {
        fail(r, 'max_attempts_exceeded', `Gave up after ${r.attempts - 1} interrupted attempt(s)`);
      } else {
        live.push(r);
      }
    }
    if (!live.length) return [...outcomes.values()];

    const repoPath = bankPath(bank);
    await gitEnsureRepo(repoPath);
    const already = await ingestedTrailers(repoPath);
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'mb-ingest-'));
    const trailers: string[] = [];
    const entries: Array<{ rawName: string; source: unknown }> = [];
    const callerHints: CallerHint[] = [];
    let ingestedNow = 0;
    let anyIngested = false;
    try {
      for (const r of live) {
        const items: ItemOutcome[] = [];
        const hint = requestHint(r);
        const rawNames: string[] = [];
        let unlistedFiles = 0;
        for (const item of r.items) {
          if (isLost()) break;
          const key = `${r.id}/${item.index}`;
          const source = itemSource(item);
          if (already.has(key)) {
            items.push({ index: item.index, status: 'succeeded', replayed: true, ...(source ? { source } : {}) });
            unlistedFiles++;
            anyIngested = true;
            continue;
          }
          try {
            const { input, origin } = await this.materialize(claim, r, item, staging);
            const res = await this.o.ingest(bank, input, { origin });
            const rawName = res.rawName ?? path.basename(res.rawPath);
            entries.push({ rawName, source: res.source ?? origin });
            rawNames.push(rawName);
            const rawPath = path.relative(bankFsPath(bank), res.rawPath).split(path.sep).join('/');
            items.push({ index: item.index, status: 'succeeded', rawPath, ...(source ? { source } : {}) });
            trailers.push(`Ingestion-Item: ${key}`);
            ingestedNow++;
            anyIngested = true;
          } catch (err) {
            items.push({
              index: item.index,
              status: 'failed',
              error: { code: errorCode(err), message: itemErrorMessage(item, err) },
              ...(source ? { source } : {}),
            });
          }
        }
        if (hint && (rawNames.length || unlistedFiles)) {
          callerHints.push({ requestId: r.id, hint, rawNames, unlistedFiles });
        }
        outcomes.set(r.id, { requestId: r.id, batchId, commits: [], revision: null, items });
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }

    // Committed even after a lost claim (this run still holds the bank lock):
    // the trailers are what stop the reclaimed batch from ingesting them twice.
    const ingestCommit = ingestedNow
      ? await gitCommitAll(
          repoPath,
          // The trailers are the replay guard (see ingestedTrailers).
          this.o.formatIngestCommit(entries, { trailers: [`Ingestion-Batch: ${batchId}`, ...trailers] }),
        )
      : null;
    const commits = ingestCommit ? [ingestCommit] : [];

    let revision: string | null = null;
    let runError: { code: string; message: string } | null = null;
    if (anyIngested && !isLost()) {
      try {
        const res = await this.o.curate(bank, batchId, { provenance: entries, ingestCommit, callerHints });
        commits.push(...res.commits);
      } catch (err) {
        runError = { code: 'curate_failed', message: errorMessage(err) };
      }
      // Only a finished curate advances the completed revision: a batch whose
      // items all failed must not promote an ingest-only HEAD left by a crash.
      if (!runError && !isLost()) {
        const done = await mutation.markCompleted({ by: 'worker', runId: batchId, ingestionIds: live.map((r) => r.id) });
        revision = done.revision;
      }
    }

    for (const r of live) {
      const o = outcomes.get(r.id)!;
      o.commits = commits;
      o.revision = revision;
      if (runError) {
        o.error = {
          code: runError.code,
          message: `${runError.message} (ingested items stay in fs/_raw/ and are filed by the bank's next run)`,
        };
        o.items = o.items.map((it) => (it.status === 'succeeded' ? { ...it, status: 'failed', error: runError! } : it));
      }
    }
    return [...outcomes.values()];
  }

  /** Turn a stored item into an argument for the existing ingest step, plus its original descriptor. */
  private async materialize(
    claim: BatchClaim,
    r: QueuedRequest,
    item: QueuedItem,
    staging: string,
  ): Promise<{ input: IngestItem; origin: IngestOrigin }> {
    const origin: IngestOrigin = {
      kind: item.kind,
      ...(item.filename ? { filename: item.filename } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.mediaType ? { mediaType: item.mediaType } : {}),
    };
    const slot = `${r.id}-${item.index}`;
    if (item.kind === 'text') {
      const bytes = await this.o.store.readItem(claim, r.id, item.index);
      return {
        input: { kind: 'inline', content: bytes.toString('utf8'), ...(item.filename ? { filename: item.filename } : {}) },
        origin,
      };
    }
    if (item.kind === 'file') {
      const bytes = await this.o.store.readItem(claim, r.id, item.index);
      return { input: await stage(staging, slot, item.filename || `file-${item.index}`, bytes), origin };
    }
    if (item.kind === 'url') {
      const got = await this.download(item.url ?? '');
      if (!origin.mediaType && got.contentType) origin.mediaType = got.contentType;
      return { input: await stage(staging, slot, nameFromUrl(item.url!, got.contentType), got.body), origin };
    }
    throw new ItemError('unsupported_item', `Unsupported item kind "${(item as QueuedItem).kind}"`);
  }

  private async download(url: string): Promise<{ body: Buffer; contentType: string | null }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ItemError('invalid_url', `Invalid URL "${url}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ItemError('invalid_url', `Only http(s) URLs are downloaded, got ${parsed.protocol}`);
    }
    let res: Response;
    try {
      res = await this.o.fetch(url, { signal: AbortSignal.timeout(this.o.downloadTimeoutMs), redirect: 'follow' });
    } catch (err) {
      throw new ItemError('download_failed', `fetch ${url}: ${errorMessage(err)}`);
    }
    if (!res.ok) throw new ItemError('download_failed', `fetch ${url} → HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (declared > this.o.downloadMaxBytes) throw tooLarge(url, this.o.downloadMaxBytes);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > this.o.downloadMaxBytes) throw tooLarge(url, this.o.downloadMaxBytes);
    return { body, contentType: res.headers.get('content-type') };
  }
}

// ---- helpers ---------------------------------------------------------------

class ItemError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function tooLarge(url: string, max: number): ItemError {
  return new ItemError('download_too_large', `fetch ${url}: body exceeds ${max} bytes`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string {
  return err instanceof ItemError ? err.code : 'ingest_failed';
}

function defaultIngestCommit(entries: Array<{ rawName: string }>, opts: { trailers: string[] }): string {
  return [`ingest: ${entries.length} item(s) into fs/_raw/`, '', ...opts.trailers].join('\n');
}

/** The request's top-level hint; a legacy `metadata.hint` string only when it has none. */
function requestHint(r: QueuedRequest): string | undefined {
  const legacy = r.metadata?.hint;
  const hint = typeof r.hint === 'string' ? r.hint : typeof legacy === 'string' ? legacy : '';
  return hint.trim() || undefined;
}

/** Public provenance for an item outcome; a URL is redacted (the stored descriptor keeps the real one). */
function itemSource(item: QueuedItem): string | undefined {
  if (item.kind === 'url') return item.url ? redactUrlSecrets(item.url) : undefined;
  return item.filename ?? undefined;
}

/** Outcome error text: a URL item's own address (raw or as echoed by fetch) shows only redacted. */
function itemErrorMessage(item: QueuedItem, err: unknown): string {
  const message = errorMessage(err);
  return item.kind === 'url' && item.url ? redactUrlIn(message, item.url) : message;
}

/** `<request>/<index>` keys already ingested, from `Ingestion-Item:` trailers in the bank's history. */
async function ingestedTrailers(repoPath: string): Promise<Set<string>> {
  const { stdout } = await exec('git', ['log', '--format=%B', '--grep=^Ingestion-Item: ', '-n', '500'], {
    cwd: repoPath,
    maxBuffer: 16 * 1024 * 1024,
  });
  const keys = new Set<string>();
  for (const m of stdout.matchAll(/^Ingestion-Item: (\S+)$/gm)) keys.add(m[1]);
  return keys;
}

/** Stage bytes as a file whose basename becomes the `_raw/` name. One dir per item avoids collisions. */
async function stage(staging: string, slot: string, name: string, bytes: Buffer): Promise<IngestItem> {
  const dir = path.join(staging, slot.replace(/[^a-zA-Z0-9._-]+/g, '_'));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, sanitize(path.basename(name)));
  await fs.writeFile(file, bytes);
  return { kind: 'path', uri: pathToFileURL(file).href };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 200) || 'item';
}

function nameFromUrl(url: string, contentType: string | null): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'download';
  if (path.extname(last)) return last;
  const ct = (contentType ?? '').toLowerCase();
  const ext = ct.includes('text/html')
    ? '.html'
    : ct.includes('text/markdown')
      ? '.md'
      : ct.includes('text/plain')
        ? '.txt'
        : ct.includes('application/json')
          ? '.json'
          : ct.includes('application/pdf')
            ? '.pdf'
            : '';
  return `${last}${ext}`;
}
