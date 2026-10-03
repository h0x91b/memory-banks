import fs from 'node:fs/promises';
import path from 'node:path';
import type { PromptUsage } from '@flue/runtime';
import { bankRoot } from './bank.ts';

/**
 * Durable, append-only journal of model spend and HTTP requests, kept on the
 * host outside every bank's `fs/` sandbox: `<MEMORY_BANK_ROOT>/.accounting/
 * ledger.jsonl` (override with `MEMORY_BANK_ACCOUNTING_DIR`). Bank names
 * cannot start with a dot, so the directory never collides with a bank, and
 * archiving or deleting a bank does not touch it.
 *
 * One JSON object per line, timestamps in UTC. Every event carries an `id`;
 * the reader keeps the first event per id, so recording the same execution
 * twice (a retried write, a re-run of the recording code) never doubles the
 * money, while separate paid attempts — which get separate ids — all count.
 */

export const LEDGER_VERSION = 1;

/**
 * Where a cost figure came from.
 * - `reported`  — the provider returned the billed amount for this call.
 * - `estimated` — computed from the model's declared per-token rates. This is
 *   what Flue 2.1.0 / pi-ai 0.83 give today (`calculateCost`); it is NOT an
 *   OpenRouter invoice.
 * - `missing`   — no usable cost; counted separately, never as zero.
 */
export type CostSource = 'reported' | 'estimated' | 'missing';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ModelCallEvent {
  v: typeof LEDGER_VERSION;
  kind: 'model_call';
  /** Idempotency key: one per paid execution (agent instance / attempt). */
  id: string;
  /** UTC ISO-8601. */
  ts: string;
  bank: string;
  agent: string;
  run_id?: string;
  model: string;
  tokens: TokenCounts | null;
  cost_source: CostSource;
  /** USD; null exactly when `cost_source` is `missing`. */
  cost_usd: number | null;
}

export interface HttpRequestEvent {
  v: typeof LEDGER_VERSION;
  kind: 'http_request';
  id: string;
  ts: string;
  bank: string | null;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
}

export type LedgerEvent = ModelCallEvent | HttpRequestEvent;

export interface ModelCallInput {
  executionId: string;
  bank: string;
  agent: string;
  runId?: string;
  model: string;
  /** Returned usage, or null when the call produced none (e.g. it failed). */
  usage: PromptUsage | null;
  /** How `usage.cost` was produced. Default `estimated` — see `CostSource`. */
  costSource?: Exclude<CostSource, 'missing'>;
  at?: Date;
}

export interface HttpRequestInput {
  requestId: string;
  bank: string | null;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  at?: Date;
}

export interface LedgerReadResult {
  events: LedgerEvent[];
  /** Lines that could not be parsed (e.g. a write torn by a crash). Skipped, never guessed. */
  skippedLines: number;
}

/** Narrow interface the pipelines depend on, so tests can pass a fake. */
export interface SpendRecorder {
  recordModelCall(input: ModelCallInput): Promise<{ recorded: boolean }>;
  recordHttpRequest(input: HttpRequestInput): Promise<{ recorded: boolean }>;
}

export function defaultLedgerPath(): string {
  const dir = process.env.MEMORY_BANK_ACCOUNTING_DIR?.trim();
  return path.join(dir ? path.resolve(dir) : path.join(bankRoot(), '.accounting'), 'ledger.jsonl');
}

/**
 * Turn returned usage into a ledger cost. A cost of exactly 0 for a call that
 * used tokens means the model has no declared pricing, so it is `missing`,
 * not free.
 */
export function costFromUsage(
  usage: PromptUsage | null,
  source: Exclude<CostSource, 'missing'> = 'estimated',
): { cost_source: CostSource; cost_usd: number | null } {
  const total = usage?.cost?.total;
  if (usage == null || typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
    return { cost_source: 'missing', cost_usd: null };
  }
  if (total === 0 && usage.totalTokens > 0) return { cost_source: 'missing', cost_usd: null };
  return { cost_source: source, cost_usd: total };
}

function tokensFromUsage(usage: PromptUsage | null): TokenCounts | null {
  if (!usage) return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens,
  };
}

function isEvent(value: unknown): value is LedgerEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    (e.kind === 'model_call' || e.kind === 'http_request') &&
    typeof e.id === 'string' &&
    typeof e.ts === 'string' &&
    !Number.isNaN(Date.parse(e.ts))
  );
}

export class SpendLedger implements SpendRecorder {
  readonly file: string;
  private seen: Set<string> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string = defaultLedgerPath()) {
    this.file = file;
  }

  recordModelCall(input: ModelCallInput): Promise<{ recorded: boolean }> {
    return this.append({
      v: LEDGER_VERSION,
      kind: 'model_call',
      id: `model:${input.executionId}`,
      ts: (input.at ?? new Date()).toISOString(),
      bank: input.bank,
      agent: input.agent,
      ...(input.runId ? { run_id: input.runId } : {}),
      model: input.model,
      tokens: tokensFromUsage(input.usage),
      ...costFromUsage(input.usage, input.costSource),
    });
  }

  recordHttpRequest(input: HttpRequestInput): Promise<{ recorded: boolean }> {
    return this.append({
      v: LEDGER_VERSION,
      kind: 'http_request',
      id: `http:${input.requestId}`,
      ts: (input.at ?? new Date()).toISOString(),
      bank: input.bank,
      method: input.method,
      route: input.route,
      status: input.status,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
    });
  }

  /** All events, oldest first, de-duplicated by id (first write wins). */
  async read(): Promise<LedgerReadResult> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], skippedLines: 0 };
      throw err;
    }
    const events: LedgerEvent[] = [];
    const ids = new Set<string>();
    let skippedLines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!isEvent(parsed)) {
        skippedLines += 1;
        continue;
      }
      if (ids.has(parsed.id)) continue;
      ids.add(parsed.id);
      events.push(parsed);
    }
    return { events, skippedLines };
  }

  /**
   * Appends are serialised within the process and skip ids already on disk.
   * Another process (the CLI) appending the same id concurrently is still safe:
   * `read()` de-duplicates.
   */
  private append(event: LedgerEvent): Promise<{ recorded: boolean }> {
    const run = this.queue.then(async () => {
      if (!this.seen) {
        const { events } = await this.read();
        this.seen = new Set(events.map((e) => e.id));
      }
      if (this.seen.has(event.id)) return { recorded: false };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, JSON.stringify(event) + '\n', 'utf8');
      this.seen.add(event.id);
      return { recorded: true };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const shared = new Map<string, SpendLedger>();

/**
 * Process-wide ledger for the current `defaultLedgerPath()`. Server routes and
 * pipelines must share one instance so they share the write queue and the
 * in-memory id set. Resolved per call, so tests that switch
 * `MEMORY_BANK_ROOT` get their own file.
 */
export function sharedSpendLedger(): SpendLedger {
  const file = defaultLedgerPath();
  let ledger = shared.get(file);
  if (!ledger) shared.set(file, (ledger = new SpendLedger(file)));
  return ledger;
}

/**
 * Pipeline hook: run one paid agent execution and record its spend.
 *
 * `call` resolves to anything carrying the returned `usage` (e.g. the result
 * of `readStructuredReply`). If it throws, the attempt is recorded with no
 * usage — it may have been billed, so it shows up as missing cost rather than
 * vanishing — and the error is rethrown unchanged. A failure to write the
 * ledger is logged and never fails the pipeline.
 *
 * `executionId` must be unique per paid attempt; the fresh agent instance id
 * (`freshInstanceId`) is.
 */
export async function recordAgentCall<T extends { usage: PromptUsage | null }>(
  recorder: SpendRecorder,
  meta: Omit<ModelCallInput, 'usage' | 'at'>,
  call: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await call();
  } catch (err) {
    await safeRecord(recorder, { ...meta, usage: null });
    throw err;
  }
  await safeRecord(recorder, { ...meta, usage: result.usage });
  return result;
}

async function safeRecord(recorder: SpendRecorder, input: ModelCallInput): Promise<void> {
  try {
    await recorder.recordModelCall(input);
  } catch (err) {
    console.error('[spend] failed to record model call', err);
  }
}
