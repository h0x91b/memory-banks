// The narrow port between the ingestion worker and the durable ingestion
// store (src/ingestions/, owned by the intake API). The worker never touches
// the store's files; everything goes through this interface, so a fake store
// in tests and the real one behave the same for the worker.
//
// Delivery is at-least-once: a batch whose worker dies is reclaimed after its
// lease expires and run again (see docs/design/ingestion-worker.md).

export type QueuedItemKind = 'text' | 'file' | 'url';

export interface QueuedItem {
  index: number;
  kind: QueuedItemKind;
  /** Caller-supplied name for text/file items. */
  filename?: string | null;
  /** http(s) URL for `url` items; downloaded by the worker, not at accept time. */
  url?: string | null;
  mediaType?: string | null;
  size?: number | null;
  sha256?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface QueuedRequest {
  id: string;
  bank: string;
  /** Arrival time (ISO). The bank's fixed window starts at its oldest queued arrival. */
  createdAt: string;
  /** Claims so far, including the current one. */
  attempts: number;
  /**
   * Caller metadata. The worker reads only a legacy string `hint` from it, for
   * requests that carry no top-level `hint`; provenance is the ingest step's job.
   */
  metadata?: Record<string, unknown> | null;
  /** Caller context for the Librarian about this request's own items. */
  hint?: string | null;
  /** The caller asked to skip the bank's batch window (`immediate: true`). Informational for the worker. */
  immediate?: boolean;
  items: QueuedItem[];
}

export interface PendingBank {
  bank: string;
  /** createdAt of the bank's oldest queued request (ISO). */
  firstQueuedAt: string;
  /**
   * At least one queued request of the bank asked for `immediate: true`: the
   * bank's next batch (with everything queued) is eligible now instead of when
   * the window closes. Derived from durable queued state, so it survives a
   * restart and an idempotent replay of a finished request cannot set it.
   */
  immediate?: boolean;
}

/** Every queued request of one bank, claimed together under one fencing token. */
export interface BatchClaim {
  bank: string;
  workerId: string;
  token: string;
  leaseExpiresAt?: string;
  requests: QueuedRequest[];
}

export interface ItemOutcome {
  index: number;
  status: 'succeeded' | 'failed';
  error?: { code: string; message: string };
  /** Where the item landed, relative to the bank's fs/ (before curation). */
  rawPath?: string;
  /** Item provenance: the URL with credentials and secret-like query values redacted, or the caller's filename. */
  source?: string;
  /** Already ingested by an earlier attempt of this request (crash replay). */
  replayed?: boolean;
}

export interface RequestOutcome {
  requestId: string;
  items: ItemOutcome[];
  /** Short shas of the commits this batch made (ingest, curate). */
  commits: string[];
  /** Full sha of the completed revision these items are searchable at; null if the run did not complete. */
  revision: string | null;
  /** Request-level failure (curate failed, bank gone, attempts exhausted). */
  error?: { code: string; message: string };
  batchId: string;
}

/** Any error with `code === 'claim_lost'` counts, so the store's own class works too. */
export function isClaimLost(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'claim_lost';
}

export class ClaimLostError extends Error {
  readonly code = 'claim_lost';
  constructor(message = 'Claim lost: the lease expired and the batch was reclaimed') {
    super(message);
    this.name = 'ClaimLostError';
  }
}

export interface IngestionWorkPort {
  /** Banks with queued requests, and when each bank's oldest queued request arrived. */
  pendingBanks(): Promise<PendingBank[]>;
  /**
   * Atomically move every queued request of `bank` to running (attempts++) under
   * one new fencing token. null when nothing is queued.
   */
  claimBatch(input: { bank: string; workerId: string; leaseMs: number }): Promise<BatchClaim | null>;
  /** Extend the lease by `leaseMs`. Throws ClaimLostError once the claim was fenced out. */
  heartbeat(claim: BatchClaim, leaseMs?: number): Promise<void>;
  /** Stored bytes of a text/file item. */
  readItem(claim: BatchClaim, requestId: string, index: number): Promise<Buffer>;
  /**
   * Persist results and move each request to its terminal status (derived
   * from item outcomes); releases the requests' durable lifecycle holds.
   * Throws ClaimLostError for a stale token: nothing is written then.
   */
  complete(claim: BatchClaim, outcomes: RequestOutcome[]): Promise<unknown>;
  /** Running requests whose lease expired go back to queued. Returns how many. */
  reapExpired(now?: number): Promise<number>;
  /** Startup repair of crash leftovers (orphan holds, missing holds of committed requests). */
  recoverAll?(): Promise<unknown>;
}
