// One console line per durably accepted ingestion (the 202), so the dev-server
// console explains the otherwise silent wait for the batching window.
//
// Only identifiers, counts and times are logged: never item contents, URLs,
// file names, metadata or the Idempotency-Key.

import { logLine } from '../console-log.ts';
import type { IngestionStatus } from './store.ts';

export interface AdmissionEvent {
  bank: string;
  id: string;
  status: IngestionStatus;
  itemCount: number;
  /** true when an earlier request with the same Idempotency-Key was returned. */
  replayed: boolean;
  /** The request itself asked for `immediate`. */
  immediate?: boolean;
}

/** The worker's view of the bank's queue (IngestionWorker.queueTiming). */
export interface AdmissionTiming {
  windowMs: number;
  firstQueuedAt: string | null;
  eligibleAt: string | null;
  /** A queued request of the bank asked for `immediate`: the window is skipped. */
  immediate?: boolean;
  batchRunning: boolean;
}

export function formatAdmission(e: AdmissionEvent, timing: AdmissionTiming | null, now: number): string {
  const items = `${e.itemCount} item${e.itemCount === 1 ? '' : 's'}`;
  const head = e.replayed
    ? `${e.id} idempotent replay (no new work), status ${e.status}`
    : `${e.id} accepted (${items}), status ${e.status}`;
  if (e.status !== 'queued') return head;
  if (!timing) return `${head}; ingestion worker is off in this process, nothing will process it here`;
  // An immediate request can be claimed before this lookup runs: nothing queued is left to time.
  if (!timing.eligibleAt || !timing.firstQueuedAt) {
    return e.immediate ? `${head}; immediate requested, batch window skipped, already picked up by the worker` : head;
  }
  const busy = timing.batchRunning ? '; a Librarian batch is running for this bank, the next one waits for it' : '';
  if (timing.immediate || e.immediate) {
    // Bank-level: a replay or a plain request also rides an immediate batch already queued.
    return `${head}; immediate requested for this bank's queue, batch window skipped, eligible to start now${busy}`;
  }
  const eligible = Date.parse(timing.eligibleAt);
  const wait = eligible - now;
  const when =
    wait > 0 ? `earliest start ${clock(timing.eligibleAt)} (in ${Math.ceil(wait / 1000)}s)` : 'eligible to start now';
  const window = `${Math.round(timing.windowMs / 1000)}s batch window from oldest queued request at ${clock(timing.firstQueuedAt)}`;
  return `${head}; ${window}, ${when}${busy}`;
}

/**
 * Logger for the router's `onAccepted` hook. Fire-and-forget: the 202 never
 * waits for the timing lookup, and a failed lookup still logs the admission.
 */
export function createAdmissionLogger(
  timing: ((bank: string) => Promise<AdmissionTiming>) | null,
  options: { log?: (bank: string, message: string) => void; now?: () => number } = {},
): (e: AdmissionEvent) => Promise<void> {
  const log = options.log ?? ((bank, message) => logLine('ingestion', message, 'green', bank));
  const now = options.now ?? Date.now;
  return async (e) => {
    let t: AdmissionTiming | null = null;
    if (timing) {
      try {
        t = await timing(e.bank);
      } catch {
        t = { windowMs: 0, firstQueuedAt: null, eligibleAt: null, batchRunning: false };
      }
    }
    log(e.bank, formatAdmission(e, t, now()));
  };
}

/** HH:MM:SS UTC, matching the console's own timestamps. */
function clock(iso: string): string {
  return `${iso.slice(11, 19)}Z`;
}
