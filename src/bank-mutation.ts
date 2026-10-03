// One writer per bank, and the last revision a writer finished cleanly.
//
// Every mutating Librarian entrypoint — the legacy HTTP routes, the CLI and the
// ingestion worker — runs inside `withBankMutation(bank, ...)`. The lock is
// two layers deep:
//   - in-process: a promise chain per bank, so two requests in the server
//     never interleave;
//   - cross-process: generation files under `<root>/.locks/<bank>/` holding
//     the owner's pid, so `npm run librarian` in another process waits for the
//     server's run (and vice versa). A holder whose pid is gone is stale and is
//     superseded by the next generation (see the cross-process section).
// Supported mode is one server per MEMORY_BANK_ROOT (plus CLI runs) on one
// local filesystem; it is not a multi-host lock.
//
// Completed revision: when the holder calls `markCompleted`, the bank's full
// HEAD sha is written to `<root>/.revisions/<bank>.json`. Intermediate commits
// (`ingest: ...` before curate) are never recorded, and a run that throws never
// advances it, so a reader of this record never sees a half-filed bank state.
//
// Baseline: the first time a bank is locked and has no record, the record is
// written BEFORE the holder runs — `by: 'bootstrap'`: the newest first-parent
// commit that is not an `ingest:` commit (a legacy state accepted as-is, not a
// proven completed run), or `revision: null` when the bank has no repo or no
// such commit (nothing searchable). So a first run that crashes leaves the
// baseline in place, and neither its ingest-only HEAD nor one left by an older
// crashed legacy run is ever promoted.
// The query read side owns snapshotting; this module only records.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { BANK_NAME_RE, bankPath, bankRoot } from './bank.ts';

const exec = promisify(execFile);

export const LOCKS_DIR = '.locks';
export const REVISIONS_DIR = '.revisions';
const LOCK_POLL_MS = 200;

export interface CompletedRevision {
  bank: string;
  /**
   * Full 40-hex sha of `<root>/<bank>/` HEAD after the run. null: the bank had
   * no repo when first locked and no run has completed since.
   */
  revision: string | null;
  completedAt: string;
  /** `bootstrap`: pre-existing state taken as the baseline, never a proven completed run. */
  by: 'worker' | 'legacy' | 'bootstrap';
  /** Worker batch id, legacy run id, or 'bootstrap'. */
  runId: string;
  /** Ingestion requests whose results point at this revision (worker only). */
  ingestionIds?: string[];
}

export interface MarkCompletedInput {
  by: CompletedRevision['by'];
  runId: string;
  ingestionIds?: string[];
}

export interface BankMutation {
  readonly bank: string;
  /** Record the bank's current HEAD as the last completed revision. */
  markCompleted(input: MarkCompletedInput): Promise<CompletedRevision>;
}

// ---- in-process layer -------------------------------------------------------

const CHAINS = new Map<string, Promise<unknown>>();
// Tokens of lock files this process currently holds (a pid match alone is not
// proof: a leaked file from a crashed run in a recycled pid would look alive).
const HELD = new Set<string>();

function lockKey(bank: string): string {
  return `${bankRoot()}\0${bank}`;
}

async function chained<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = CHAINS.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  CHAINS.set(key, tail);
  try {
    return await run;
  } finally {
    if (CHAINS.get(key) === tail) CHAINS.delete(key);
  }
}

/** True while some caller in this process holds or waits for the bank's lock. */
export function bankMutationBusy(bank: string): boolean {
  return CHAINS.has(lockKey(bank));
}

// ---- cross-process layer ----------------------------------------------------
//
// Generation files: `<root>/.locks/<bank>/<generation>.json`, the generation
// a zero-padded counter. Ownership = having CREATED the highest generation
// while the one before it was dead (released, or its pid gone). A stale lock
// is never deleted to be reclaimed; it is superseded by creating the next
// generation, and creation is atomic and exclusive (`link(2)` of a fully
// written temp file, EEXIST if taken). Two reclaimers of the same stale
// generation g both try to create g+1: exactly one succeeds.
//
// Invariants that make this safe:
//   1. Only the creator writes its generation file, and only to replace it
//      with a `released` tombstone (atomic rename). The highest generation is
//      never deleted, so the maximum only ever grows.
//   2. A generation is created only after reading that the then-highest one
//      is dead.
//   3. After creating g, the creator lists the directory again; if anything
//      higher exists it lost (its view was stale), deletes its own g and
//      retries. Lower generations are dead by (2) and are swept by the owner.
// So at most one live owner exists at any time. Liveness relies on pid checks
// (a recycled pid looks alive: the lock then waits, it never double-grants).

interface LockFile {
  pid: number;
  token: string;
  acquiredAt: string;
  released?: boolean;
}

interface HeldLock {
  generation: number;
  token: string;
}

const GEN_WIDTH = 12;

function lockDir(bank: string): string {
  return path.join(bankRoot(), LOCKS_DIR, bank);
}

function genFile(bank: string, generation: number): string {
  return path.join(lockDir(bank), `${String(generation).padStart(GEN_WIDTH, '0')}.json`);
}

async function generations(bank: string): Promise<number[]> {
  let names: string[];
  try {
    names = await fs.readdir(lockDir(bank));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => Number(n.slice(0, -5)))
    .sort((a, b) => a - b);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockAlive(lock: LockFile | null | 'missing'): boolean {
  if (lock === 'missing') return false;
  if (!lock || lock.released) return false;
  // Our own pid but no live handle: leaked by a crashed run in this process.
  if (lock.pid === process.pid) return HELD.has(lock.token);
  return pidAlive(lock.pid);
}

async function acquireFileLock(bank: string): Promise<HeldLock> {
  const dir = lockDir(bank);
  await fs.mkdir(dir, { recursive: true });
  const token = randomUUID();
  const body: LockFile = { pid: process.pid, token, acquiredAt: new Date().toISOString() };
  for (;;) {
    const gens = await generations(bank);
    const top = gens.at(-1) ?? 0;
    if (top) {
      const holder = await readLock(genFile(bank, top));
      if (holder === 'missing') continue; // listing went stale under us: look again
      if (lockAlive(holder)) {
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
        continue;
      }
    }
    const generation = top + 1;
    const mine = genFile(bank, generation);
    const tmp = path.join(dir, `.${token}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify(body)}\n`);
    try {
      await fs.link(tmp, mine);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      continue; // someone else created this generation first
    } finally {
      await fs.rm(tmp, { force: true });
    }
    const after = await generations(bank);
    if ((after.at(-1) ?? 0) > generation) {
      // Our view was stale: a newer generation exists. Not the top, so ours may go.
      await fs.rm(mine, { force: true });
      continue;
    }
    HELD.add(token);
    for (const g of after) if (g < generation) await fs.rm(genFile(bank, g), { force: true });
    return { generation, token };
  }
}

async function releaseFileLock(bank: string, held: HeldLock): Promise<void> {
  HELD.delete(held.token);
  const file = genFile(bank, held.generation);
  const current = await readLock(file);
  if (current === 'missing' || current?.token !== held.token) return;
  // Tombstone, not delete: the top generation must stay so the counter never goes back.
  const tmp = path.join(lockDir(bank), `.${held.token}.release.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify({ ...current, released: true })}\n`);
  await fs.rename(tmp, file);
}

/** 'missing' when the file is gone; null when it cannot be parsed (counts as dead). */
async function readLock(file: string): Promise<LockFile | null | 'missing'> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as LockFile;
    return typeof parsed?.pid === 'number' && typeof parsed.token === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ---- public API ---------------------------------------------------------------

/**
 * Run `fn` as the bank's only writer. Waits for any other holder, in this
 * process or another one. Throws on an invalid bank id.
 */
export async function withBankMutation<T>(bank: string, fn: (m: BankMutation) => Promise<T>): Promise<T> {
  if (!BANK_NAME_RE.test(bank)) throw new Error(`Invalid bank name "${bank}"`);
  return chained(lockKey(bank), async () => {
    const held = await acquireFileLock(bank);
    try {
      if (!(await readRevision(bank))) await writeBaseline(bank);
      return await fn({ bank, markCompleted: (input) => recordCompleted(bank, input) });
    } finally {
      await releaseFileLock(bank, held);
    }
  });
}

function revisionFile(bank: string): string {
  return path.join(bankRoot(), REVISIONS_DIR, `${bank}.json`);
}

async function headSha(bank: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: bankPath(bank) });
  return stdout.trim();
}

async function readRevision(bank: string): Promise<CompletedRevision | null> {
  try {
    return JSON.parse(await fs.readFile(revisionFile(bank), 'utf8')) as CompletedRevision;
  } catch {
    return null;
  }
}

async function writeRevision(record: CompletedRevision): Promise<CompletedRevision> {
  const file = revisionFile(record.bank);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await fs.rename(tmp, file);
  return record;
}

async function writeBaseline(bank: string): Promise<void> {
  const hasRepo = existsSync(path.join(bankPath(bank), '.git'));
  await writeRevision({
    bank,
    revision: hasRepo ? await baselineSha(bank) : null,
    completedAt: new Date().toISOString(),
    by: 'bootstrap',
    runId: 'bootstrap',
  });
}

/**
 * Newest first-parent commit whose subject does not start with `ingest:`.
 * A pre-existing bank whose last legacy run died between its ingest and
 * curate commits has an `ingest: ...` HEAD; that half-filed state is skipped.
 * null when there is no such commit (or no commit at all).
 */
async function baselineSha(bank: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['log', '--first-parent', '--format=%H %s', '-n', '1000'], {
      cwd: bankPath(bank),
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp !== 40) continue;
      if (!line.slice(41).startsWith('ingest:')) return line.slice(0, 40);
    }
    return null;
  } catch {
    return null; // empty repo: no HEAD yet
  }
}

async function recordCompleted(bank: string, input: MarkCompletedInput): Promise<CompletedRevision> {
  return writeRevision({
    bank,
    revision: await headSha(bank),
    completedAt: new Date().toISOString(),
    by: input.by,
    runId: input.runId,
    ...(input.ingestionIds?.length ? { ingestionIds: input.ingestionIds } : {}),
  });
}

/** Read side for the query path. Only this module writes the record. */
export const completedRevisions = {
  /** Stored record or null. Never blocks. */
  async get(bank: string): Promise<CompletedRevision | null> {
    return BANK_NAME_RE.test(bank) ? readRevision(bank) : null;
  },

  /**
   * Stored record; for a bank with a repo but no record yet (it predates this
   * module and was never locked since), take the lock — waiting for any active
   * writer — which writes the `bootstrap` baseline. null when the bank has no
   * git repo and was never locked.
   */
  async resolve(bank: string): Promise<CompletedRevision | null> {
    const stored = await this.get(bank);
    if (stored || !BANK_NAME_RE.test(bank) || !existsSync(path.join(bankPath(bank), '.git'))) return stored;
    return withBankMutation(bank, () => readRevision(bank));
  },
};
