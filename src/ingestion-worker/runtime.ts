// Server wiring for the ingestion worker: the real ingest + Librarian steps,
// one worker per process, started once the Flue runtime is up and stopped on
// the same signals the Flue server shuts down on.
//
// Shutdown: SIGINT/SIGTERM stop scheduling at once. A batch still running when
// the server exits is not lost: its lease expires and the next start re-runs
// it (at-least-once, see docs/design/ingestion-worker.md).
import { getAgentInstance } from '@flue/runtime';
import { Librarian } from '../../.flue/agents/librarian.js';
import { ingestOne } from '../ingest.js';
import { formatIngestCommitMessage, toIngestSource } from '../ingest-provenance.ts';
import { runLibrarian } from '../librarian.js';
import type { BankLifecycleGuard } from '../banks/index.ts';
import type { IngestionWorkPort } from './port.ts';
import { IngestionWorker, type IngestionWorkerOptions } from './worker.ts';

const SINGLETON = Symbol.for('memory-banks.ingestion-worker');
type Holder = { [SINGLETON]?: IngestionWorker };

/** `MEMORY_BANK_INGESTION_WORKER=off` disables the worker (e.g. a read-only replica). */
export function ingestionWorkerEnabled(env = process.env): boolean {
  return (env.MEMORY_BANK_INGESTION_WORKER ?? 'on').toLowerCase() !== 'off';
}

function envMs(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function createIngestionWorker(
  store: IngestionWorkPort,
  banks: BankLifecycleGuard,
  overrides: Partial<IngestionWorkerOptions> = {},
): IngestionWorker {
  return new IngestionWorker({
    store,
    ingest: ingestOne,
    // The worker types sources loosely; anything unrecognised is recorded as "unknown".
    formatIngestCommit: (entries, opts) =>
      formatIngestCommitMessage(
        entries.map((e) => ({ rawName: e.rawName, source: toIngestSource(e.source) })),
        opts,
      ),
    curate: async (bank, runId, hint, ctx) => {
      const res = await runLibrarian({ bank, items: [], ...(hint ? { hint } : {}) }, runId, ctx);
      return { commits: res.commits, summary: res.summary };
    },
    bankStatus: (bank) => banks.lookup(bank),
    windowMs: envMs('MEMORY_BANK_INGESTION_WINDOW_MS'),
    ...overrides,
  });
}

/**
 * Start the process-wide worker once (idempotent, survives dev re-imports of
 * app.ts). Returns the worker, or null when disabled.
 */
export function startIngestionWorker(
  store: IngestionWorkPort,
  banks: BankLifecycleGuard,
  overrides: Partial<IngestionWorkerOptions> = {},
): IngestionWorker | null {
  if (!ingestionWorkerEnabled()) return null;
  const holder = globalThis as Holder;
  if (holder[SINGLETON]) return holder[SINGLETON];
  const worker = createIngestionWorker(store, banks, overrides);
  holder[SINGLETON] = worker;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // With nobody else listening (no Flue server entry, e.g. a bare dev
      // process), our listener would swallow the signal: re-raise it once the
      // worker stopped so the default exit still happens.
      const alone = process.listenerCount(signal) === 0;
      void worker.stop().finally(() => {
        if (alone) process.kill(process.pid, signal);
      });
    });
  }

  // app.ts is imported before the Flue runtime is assembled; agent calls only
  // work after. Probe with a cheap lookup until it stops throwing.
  void (async () => {
    for (let i = 0; ; i++) {
      try {
        await getAgentInstance(Librarian, 'ingestion-worker-readiness-probe');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(1000, 50 * 2 ** i)).unref?.());
      }
    }
    try {
      await worker.start();
    } catch (err) {
      console.error('[ingestion-worker] start failed', err);
    }
  })();
  return worker;
}
