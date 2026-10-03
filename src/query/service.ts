// POST /v1/banks/:bank/query — answer a question from the bank's last
// completed revision, never from the live tree the Librarian is mutating.
//
// Flow, per request:
//   1. lifecycle guard: the bank must exist and be active (same lease as the
//      legacy retriever route, so archive waits for running queries);
//   2. pick the revision: the completed-revision record written by the bank
//      mutation lock (src/bank-mutation.ts). This module only reads it;
//   3. export that commit's fs/ into a private snapshot (./snapshot.ts);
//   4. run the retriever against the snapshot, then map its references back
//      to the bank's real fs/ paths;
//   5. report which revision answered and what accepted work is still pending.
//
// Contract: docs/api/query.md.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { bankFsPath } from '../bank.ts';
import { ApiError, assertBankId, type BankLifecycleGuard } from '../banks/index.ts';
import type { CompletedRevision } from '../bank-mutation.ts';
import { materializeSnapshot, type Snapshot } from './snapshot.ts';

export const EMPTY_ANSWER = 'No relevant data found in the memory bank.';
export const QUESTION_MAX = 4000;
export const HINT_MAX = 4000;

export type { CompletedRevision };

/** The read side of src/bank-mutation.ts (`completedRevisions`); this module never writes revisions. */
export interface CompletedRevisionReader {
  /** Stored record; bootstraps a never-locked bank that has a repo. */
  resolve(bank: string): Promise<CompletedRevision | null>;
}

/** Accepted ingestion requests that are not searchable yet. */
export interface PendingIngestions {
  queued: number;
  running: number;
}

export interface PendingIngestionSource {
  pendingCounts(bank: string): Promise<PendingIngestions>;
}

export interface RetrieveInput {
  bank: string;
  question: string;
  hint?: string;
  /** Snapshot directory the retriever must read (its sandbox root). */
  readRoot: string;
  /** The bank's real fs/ path: shown to the model and used for references. */
  fsPath: string;
  runId: string;
}

export interface RetrieveOutput {
  answer: string;
  references: { path: string; why: string }[];
  meta: Record<string, unknown>;
}

export type RetrieveFn = (input: RetrieveInput) => Promise<RetrieveOutput>;

export interface QueryDeps {
  guard: BankLifecycleGuard;
  revisions: CompletedRevisionReader;
  retrieve: RetrieveFn;
  /** Absent until the ingestion store is wired: `pendingIngestions` is then null. */
  ingestions?: PendingIngestionSource;
}

export interface QueryInput {
  question: string;
  hint?: string;
}

export interface QueryProcessing {
  /** false only when the bank has no completed revision yet. */
  searchable: boolean;
  reason?: 'no_completed_revision';
  revisionCompletedAt: string | null;
  revisionSource: CompletedRevision['by'] | null;
  /** `unverified`: a pre-existing (bootstrap) state, not proven to be a finished Librarian run. */
  provenance: 'verified' | 'unverified' | null;
  pendingIngestions: PendingIngestions | null;
}

export interface QueryResult {
  bank: string;
  answer: string;
  references: { path: string; why: string }[];
  revision: string | null;
  processing: QueryProcessing;
  meta: Record<string, unknown>;
}

/** Validate the request body. Throws ApiError on any problem. */
export function parseQueryBody(body: unknown): QueryInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('invalid_json', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((k) => k !== 'question' && k !== 'hint');
  if (unknown.length) {
    throw new ApiError('validation_error', `Unknown field(s): ${unknown.join(', ')}`, { fields: unknown });
  }
  const { question, hint } = body as Record<string, unknown>;
  if (typeof question !== 'string' || !question.trim()) {
    throw new ApiError('validation_error', 'question must be a non-empty string', { field: 'question' });
  }
  if ([...question.trim()].length > QUESTION_MAX) {
    throw new ApiError('validation_error', `question must be at most ${QUESTION_MAX} characters`, { field: 'question' });
  }
  if (hint !== undefined && hint !== null && typeof hint !== 'string') {
    throw new ApiError('validation_error', 'hint must be a string', { field: 'hint' });
  }
  if (typeof hint === 'string' && [...hint.trim()].length > HINT_MAX) {
    throw new ApiError('validation_error', `hint must be at most ${HINT_MAX} characters`, { field: 'hint' });
  }
  const trimmedHint = typeof hint === 'string' ? hint.trim() : '';
  return { question: question.trim(), ...(trimmedHint ? { hint: trimmedHint } : {}) };
}

export async function queryBank(deps: QueryDeps, bank: string, input: QueryInput): Promise<QueryResult> {
  assertBankId(bank);
  const lease = await deps.guard.beginOperation(bank, 'query');
  try {
    const record = await deps.revisions.resolve(bank);
    const pendingIngestions = deps.ingestions ? await deps.ingestions.pendingCounts(bank) : null;

    if (!record?.revision) {
      return {
        bank,
        answer: EMPTY_ANSWER,
        references: [],
        revision: null,
        processing: {
          searchable: false,
          reason: 'no_completed_revision',
          revisionCompletedAt: null,
          revisionSource: null,
          provenance: null,
          pendingIngestions,
        },
        meta: { model: null, tokens: null, cost: null, bash_calls: 0, telemetry: null },
      };
    }

    // Exactly the writer's sha: no fallback to the live tree, no re-picking here.
    const revision = record.revision;

    const t0 = Date.now();
    let snapshot: Snapshot;
    try {
      snapshot = await materializeSnapshot(bank, revision);
    } catch (err) {
      throw snapshotFailed(bank, revision, err);
    }
    const snapshotMs = Date.now() - t0;

    try {
      const before = await manifest(snapshot.dir);
      const fsPath = bankFsPath(bank);
      const out = await deps.retrieve({
        bank,
        question: input.question,
        hint: input.hint,
        readRoot: snapshot.dir,
        fsPath,
        runId: `query-${randomUUID().slice(0, 8)}`,
      });
      const after = await manifest(snapshot.dir);
      return {
        bank,
        answer: out.answer,
        references: out.references.map((r) => mapReference(r, snapshot.dir, fsPath)),
        revision,
        processing: {
          searchable: true,
          revisionCompletedAt: record.completedAt,
          revisionSource: record.by,
          provenance: record.by === 'bootstrap' ? 'unverified' : 'verified',
          pendingIngestions,
        },
        meta: { ...out.meta, unexpected_writes: diffCount(before, after), snapshot_ms: snapshotMs },
      };
    } finally {
      await snapshot.release();
    }
  } finally {
    await lease.release();
  }
}

/**
 * Turn whatever path the model cited into an absolute path under the bank's
 * real fs/. Accepts paths under the snapshot dir, under the real fs/,
 * sandbox-absolute (`/notes/a.md`) or relative (`notes/a.md`). The snapshot
 * path itself never leaks out. A path that would climb out of fs/ is kept
 * as-is: it is not a bank file and must not be dressed up as one.
 */
export function mapReference(
  ref: { path: string; why: string },
  snapshotDir: string,
  fsPath: string,
): { path: string; why: string } {
  const raw = ref.path.trim();
  if (!raw) return { path: raw, why: ref.why };
  let rel: string;
  if (isUnder(raw, snapshotDir)) rel = path.relative(snapshotDir, raw);
  else if (isUnder(raw, fsPath)) rel = path.relative(fsPath, raw);
  else rel = raw.replace(/^\/+/, '');
  const normal = path.normalize(rel);
  if (normal === '..' || normal.startsWith(`..${path.sep}`) || path.isAbsolute(normal)) {
    return { path: raw, why: ref.why };
  }
  return { path: normal === '.' ? fsPath : path.join(fsPath, normal), why: ref.why };
}

function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

function snapshotFailed(bank: string, revision: string, err: unknown): ApiError {
  console.error(err);
  return new ApiError('snapshot_failed', `Could not read revision ${revision.slice(0, 12)} of bank "${bank}"`, {
    bank,
    revision,
  });
}

/** path -> size:mtime for every entry under dir. */
async function manifest(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const abs = path.join(entry.parentPath, entry.name);
    const st = await fs.lstat(abs).catch(() => null);
    if (st) out.set(path.relative(dir, abs), entry.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`);
  }
  return out;
}

function diffCount(a: Map<string, string>, b: Map<string, string>): number {
  let n = 0;
  for (const [k, v] of b) if (a.get(k) !== v) n++;
  for (const k of a.keys()) if (!b.has(k)) n++;
  return n;
}
