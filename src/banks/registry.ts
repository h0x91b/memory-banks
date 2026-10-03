// Bank identity and lifecycle: the durable source of truth for which banks
// exist, their mutable metadata, and whether they accept work.
//
// Storage (all under MEMORY_BANK_ROOT, see src/bank.ts):
//   <root>/<id>/                          the bank itself (git repo + fs/), never
//                                         moved or deleted by anything here
//   <root>/.lifecycle/banks/<id>.json     lifecycle record (metadata + status)
//   <root>/.lifecycle/leases/<id>/*.json  one file per in-flight operation
//
// `.lifecycle` starts with a dot, so it can never collide with a bank id
// ([a-z0-9][a-z0-9-]*). A bank directory without a record is an existing bank
// from before this module: it is reported as active with name = id, and its
// record is written on the first mutation. No migration step.
//
// States: active -> archiving -> archived -> (restore) -> active.
// `archiving` is persisted the moment archive is requested, so new work is
// refused from then on even across a restart. It turns into `archived` once
// no live operation lease remains. Leases are files, so a restart cannot
// forget them; a lease whose owning process is gone is stale and ignored.
//
// Durable holds (<root>/.lifecycle/holds/<id>/<holdId>.json) are the second
// kind of pending work: accepted-but-unprocessed work such as a queued
// ingestion. Unlike a lease a hold is not tied to a PID, so it keeps a bank
// `archiving` across restarts until its owner releases it explicitly.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BANK_NAME_RE, bankRoot, ensureBank } from '../bank.ts';
import { withBankMutation } from '../bank-mutation.ts';
import { gitEnsureRepo } from '../git.ts';
import { ApiError } from './errors.ts';

export type BankStatus = 'active' | 'archiving' | 'archived';
export type BankStatusFilter = BankStatus | 'all';

export interface BankRecord {
  id: string;
  name: string;
  description: string;
  status: BankStatus;
  createdAt: string;
  updatedAt: string;
  archiveRequestedAt: string | null;
  archivedAt: string | null;
}

/** What a unit of work against a bank is. All kinds require an active bank. */
export type OperationKind = 'intake' | 'curate' | 'query';

/**
 * Proof that an operation was admitted while the bank was active. Archiving
 * waits for every live lease to be released before the bank becomes archived.
 * Always release in `finally`; release is idempotent.
 */
export interface OperationLease {
  readonly id: string;
  readonly bank: string;
  readonly kind: OperationKind;
  release(): Promise<void>;
}

/**
 * The narrow port intake, the job queue/worker and stats code should depend on.
 * `BankRegistry` implements it.
 */
export interface BankLifecycleGuard {
  /** Never throws for a bad id: an invalid id is simply 'missing'. */
  lookup(bank: string): Promise<BankStatus | 'missing'>;
  /**
   * Admit one operation. Throws ApiError `invalid_bank_id`, `bank_not_found`,
   * `bank_archiving` or `bank_archived`; nothing is recorded in that case.
   */
  beginOperation(bank: string, kind: OperationKind): Promise<OperationLease>;
}

/** Accepted work that must finish before the bank can become archived. */
export interface DurableHold {
  /** Deterministic: `<kind>-<ref>`, so re-creating a hold is idempotent. */
  readonly id: string;
  readonly bank: string;
  readonly kind: OperationKind;
  /** Owner's id for the work, e.g. an ingestion request id. */
  readonly ref: string;
  readonly createdAt: string;
}

/**
 * Port for queues that accept work now and run it later (ingestion). Holds
 * survive restarts; archive waits for them exactly like it waits for leases.
 */
export interface DurableWorkGuard {
  /**
   * Under the bank's lifecycle lock: refuse unless active (same errors as
   * beginOperation), persist the hold, then run `commit` still holding the
   * lock. If `commit` throws, the hold is removed and the error rethrown.
   * Crash between hold and commit leaves an orphan hold: the owner must
   * reconcile it (see `listDurableWork` / `releaseDurableWork`).
   */
  admitDurableWork<T>(
    bank: string,
    kind: OperationKind,
    ref: string,
    commit: (hold: DurableHold) => Promise<T>,
  ): Promise<T>;
  /** Idempotent. Lets an archiving bank settle to archived. */
  releaseDurableWork(bank: string, holdId: string): Promise<void>;
  listDurableWork(bank: string): Promise<DurableHold[]>;
  /**
   * Recovery only: re-create the hold for work that was already accepted,
   * whatever the bank status (it may be archiving by now). Never use this to
   * admit new work.
   */
  ensureDurableWork(bank: string, kind: OperationKind, ref: string): Promise<DurableHold>;
}

export function durableHoldId(kind: OperationKind, ref: string): string {
  return `${kind}-${ref}`;
}

export interface CreateBankInput {
  id: string;
  name?: string;
  description?: string;
}

export interface UpdateBankInput {
  name?: string;
  description?: string;
}

export interface ListBanksOptions {
  status?: BankStatusFilter;
  limit?: number;
  /** Return banks whose id sorts strictly after this one. */
  after?: string;
}

// Matches src/bank.ts BANK_NAME_RE; the cap only keeps <id>.json under filesystem name limits.
export const BANK_ID_MAX = 200;
export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 1000;
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;
export const LIFECYCLE_DIR = '.lifecycle';

interface StoredRecord extends BankRecord {
  schema: 1;
}

interface StoredLease {
  id: string;
  bank: string;
  kind: OperationKind;
  pid: number;
  startedAt: string;
}

// Lease ids held by live handles in this process. Only answers "is a lease
// written by this very process still held"; the lease itself is on disk.
const LIVE_LEASES = new Set<string>();

// Per-bank serialisation of read-modify-write sequences within one process.
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

export class BankRegistry implements BankLifecycleGuard, DurableWorkGuard {
  // Resolved per call so MEMORY_BANK_ROOT behaves exactly as in src/bank.ts.
  private root(): string {
    return bankRoot();
  }

  private bankDir(id: string): string {
    return path.join(this.root(), id);
  }

  private recordFile(id: string): string {
    return path.join(this.root(), LIFECYCLE_DIR, 'banks', `${id}.json`);
  }

  private leaseDir(id: string): string {
    return path.join(this.root(), LIFECYCLE_DIR, 'leases', id);
  }

  private holdDir(id: string): string {
    return path.join(this.root(), LIFECYCLE_DIR, 'holds', id);
  }

  private lockKey(id: string): string {
    return `${this.root()}\0${id}`;
  }

  // ---- public API ---------------------------------------------------------

  async lookup(bank: string): Promise<BankStatus | 'missing'> {
    if (!isValidBankId(bank)) return 'missing';
    const record = await this.get(bank);
    return record ? record.status : 'missing';
  }

  /** The bank's record, or null when it does not exist. Throws on an invalid id. */
  async get(bank: string): Promise<BankRecord | null> {
    assertBankId(bank);
    const record = await this.readRecord(bank);
    if (!record || record.status !== 'archiving') return record;
    return withLock(this.lockKey(bank), () => this.settle(bank));
  }

  async require(bank: string): Promise<BankRecord> {
    const record = await this.get(bank);
    if (!record) throw notFound(bank);
    return record;
  }

  async list(options: ListBanksOptions = {}): Promise<{ banks: BankRecord[]; nextAfter: string | null }> {
    const status = options.status ?? 'active';
    const limit = options.limit ?? LIST_LIMIT_DEFAULT;
    const ids = (await this.discoverIds()).filter((id) => options.after === undefined || id > options.after);
    const banks: BankRecord[] = [];
    let nextAfter: string | null = null;
    for (const id of ids) {
      const record = await this.get(id);
      if (!record) continue;
      if (status !== 'all' && record.status !== status) continue;
      if (banks.length === limit) {
        nextAfter = banks[banks.length - 1].id;
        break;
      }
      banks.push(record);
    }
    return { banks, nextAfter };
  }

  async create(input: CreateBankInput): Promise<BankRecord> {
    assertBankId(input.id);
    const name = input.name === undefined ? input.id : validateName(input.name);
    const description = input.description === undefined ? '' : validateDescription(input.description);
    return withLock(this.lockKey(input.id), async () => {
      if (existsSync(this.bankDir(input.id)) || (await this.readStored(input.id))) {
        throw new ApiError('bank_exists', `Bank "${input.id}" already exists`, { bank: input.id });
      }
      // Scaffold under the bank mutation lock: taken before the repo exists,
      // its baseline records `revision: null`, so the scaffold commit is never
      // a searchable revision; the first completed run is.
      await withBankMutation(input.id, async () => {
        const { repoPath } = await ensureBank(input.id);
        await gitEnsureRepo(repoPath);
      });
      const now = new Date().toISOString();
      const record: BankRecord = {
        id: input.id,
        name,
        description,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        archiveRequestedAt: null,
        archivedAt: null,
      };
      await this.writeRecord(record);
      return record;
    });
  }

  async update(bank: string, input: UpdateBankInput): Promise<BankRecord> {
    assertBankId(bank);
    const name = input.name === undefined ? undefined : validateName(input.name);
    const description = input.description === undefined ? undefined : validateDescription(input.description);
    return withLock(this.lockKey(bank), async () => {
      const current = await this.readRecord(bank);
      if (!current) throw notFound(bank);
      const next: BankRecord = {
        ...current,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.writeRecord(next);
      return next;
    });
  }

  /**
   * Stop accepting work now; become archived once in-flight operations end.
   * Idempotent. Never touches the bank's files or git history.
   */
  async archive(bank: string): Promise<BankRecord> {
    assertBankId(bank);
    return withLock(this.lockKey(bank), async () => {
      const current = await this.readRecord(bank);
      if (!current) throw notFound(bank);
      if (current.status === 'active') {
        const now = new Date().toISOString();
        await this.writeRecord({ ...current, status: 'archiving', archiveRequestedAt: now, updatedAt: now });
      }
      return this.settle(bank);
    });
  }

  /**
   * Make an archived bank active again, files untouched. Idempotent on an
   * active bank. Refused while archiving: operations admitted before the
   * archive request may still be running.
   */
  async restore(bank: string): Promise<BankRecord> {
    assertBankId(bank);
    return withLock(this.lockKey(bank), async () => {
      const current = await this.settle(bank);
      if (current.status === 'active') return current;
      if (current.status === 'archiving') {
        throw new ApiError('bank_archiving', `Bank "${bank}" is still archiving; retry once it is archived`, {
          bank,
          status: current.status,
        });
      }
      const next: BankRecord = {
        ...current,
        status: 'active',
        archiveRequestedAt: null,
        archivedAt: null,
        updatedAt: new Date().toISOString(),
      };
      await this.writeRecord(next);
      return next;
    });
  }

  async beginOperation(bank: string, kind: OperationKind): Promise<OperationLease> {
    assertBankId(bank);
    const lease = await withLock(this.lockKey(bank), async () => {
      const current = await this.readRecord(bank);
      if (!current) throw notFound(bank);
      if (current.status !== 'active') {
        throw new ApiError(
          current.status === 'archiving' ? 'bank_archiving' : 'bank_archived',
          `Bank "${bank}" is ${current.status} and does not accept new work`,
          { bank, status: current.status },
        );
      }
      const stored: StoredLease = {
        id: randomUUID(),
        bank,
        kind,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      await fs.mkdir(this.leaseDir(bank), { recursive: true });
      await writeJsonAtomic(path.join(this.leaseDir(bank), `${stored.id}.json`), stored);
      LIVE_LEASES.add(stored.id);
      return stored;
    });

    let released = false;
    return {
      id: lease.id,
      bank,
      kind,
      release: async () => {
        if (released) return;
        released = true;
        LIVE_LEASES.delete(lease.id);
        await withLock(this.lockKey(bank), async () => {
          await fs.rm(path.join(this.leaseDir(bank), `${lease.id}.json`), { force: true });
          const current = await this.readRecord(bank);
          if (current?.status === 'archiving') await this.settle(bank);
        });
      },
    };
  }

  async admitDurableWork<T>(
    bank: string,
    kind: OperationKind,
    ref: string,
    commit: (hold: DurableHold) => Promise<T>,
  ): Promise<T> {
    assertBankId(bank);
    assertHoldRef(ref);
    return withLock(this.lockKey(bank), async () => {
      const current = await this.readRecord(bank);
      if (!current) throw notFound(bank);
      if (current.status !== 'active') {
        throw new ApiError(
          current.status === 'archiving' ? 'bank_archiving' : 'bank_archived',
          `Bank "${bank}" is ${current.status} and does not accept new work`,
          { bank, status: current.status },
        );
      }
      const hold = await this.writeHold(bank, kind, ref);
      try {
        return await commit(hold);
      } catch (err) {
        await fs.rm(this.holdFile(bank, hold.id), { force: true });
        throw err;
      }
    });
  }

  async ensureDurableWork(bank: string, kind: OperationKind, ref: string): Promise<DurableHold> {
    assertBankId(bank);
    assertHoldRef(ref);
    return withLock(this.lockKey(bank), async () => {
      const existing = await readJson<DurableHold>(this.holdFile(bank, durableHoldId(kind, ref)));
      return existing ?? this.writeHold(bank, kind, ref);
    });
  }

  async releaseDurableWork(bank: string, holdId: string): Promise<void> {
    assertBankId(bank);
    assertHoldRef(holdId);
    await withLock(this.lockKey(bank), async () => {
      await fs.rm(this.holdFile(bank, holdId), { force: true });
      const current = await this.readRecord(bank);
      if (current?.status === 'archiving') await this.settle(bank);
    });
  }

  async listDurableWork(bank: string): Promise<DurableHold[]> {
    assertBankId(bank);
    let names: string[];
    try {
      names = await fs.readdir(this.holdDir(bank));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const holds: DurableHold[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const hold = await readJson<DurableHold>(path.join(this.holdDir(bank), name));
      if (hold) holds.push(hold);
    }
    return holds;
  }

  // ---- internals (callers hold the lock where it matters) -----------------

  private holdFile(bank: string, holdId: string): string {
    return path.join(this.holdDir(bank), `${holdId}.json`);
  }

  private async writeHold(bank: string, kind: OperationKind, ref: string): Promise<DurableHold> {
    const hold: DurableHold = { id: durableHoldId(kind, ref), bank, kind, ref, createdAt: new Date().toISOString() };
    await fs.mkdir(this.holdDir(bank), { recursive: true });
    await writeJsonDurable(this.holdFile(bank, hold.id), hold);
    return hold;
  }

  /** archiving -> archived when no live lease remains. Stale lease files are removed. */
  private async settle(bank: string): Promise<BankRecord> {
    const current = await this.readRecord(bank);
    if (!current) throw notFound(bank);
    if (current.status !== 'archiving') return current;
    if ((await this.liveLeaseCount(bank)) > 0) return current;
    if ((await this.listDurableWork(bank)).length > 0) return current;
    const now = new Date().toISOString();
    const next: BankRecord = { ...current, status: 'archived', archivedAt: now, updatedAt: now };
    await this.writeRecord(next);
    return next;
  }

  private async liveLeaseCount(bank: string): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(this.leaseDir(bank));
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
    let live = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.leaseDir(bank), name);
      const lease = await readJson<StoredLease>(file);
      if (lease && leaseIsLive(lease)) {
        live++;
      } else {
        // Lease files are bookkeeping, not bank data: dropping a stale one is safe.
        await fs.rm(file, { force: true });
      }
    }
    return live;
  }

  /** Real directories under the root named like a bank and holding fs/ or .git. */
  private async discoverIds(): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(this.root(), { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidBankId(entry.name)) continue;
      if (await this.isBankDir(entry.name)) ids.push(entry.name);
    }
    return ids.sort();
  }

  private async isBankDir(id: string): Promise<boolean> {
    const dir = this.bankDir(id);
    const st = await fs.lstat(dir).catch(() => null);
    if (!st || !st.isDirectory()) return false; // symlinks are never banks
    for (const marker of ['fs', '.git']) {
      const m = await fs.lstat(path.join(dir, marker)).catch(() => null);
      if (m && (m.isDirectory() || (marker === '.git' && m.isFile()))) return true;
    }
    return false;
  }

  /** Record for an existing bank: stored, or synthesised for a pre-existing bank. */
  private async readRecord(id: string): Promise<BankRecord | null> {
    if (!(await this.isBankDir(id))) return null;
    const stored = await this.readStored(id);
    if (stored) return stored;
    const st = await fs.stat(this.bankDir(id));
    const created = (st.birthtimeMs > 0 ? st.birthtime : st.mtime).toISOString();
    return {
      id,
      name: id,
      description: '',
      status: 'active',
      createdAt: created,
      updatedAt: created,
      archiveRequestedAt: null,
      archivedAt: null,
    };
  }

  private async readStored(id: string): Promise<BankRecord | null> {
    const raw = await readJson<StoredRecord>(this.recordFile(id));
    if (!raw) return null;
    if (raw.schema !== 1 || raw.id !== id || !['active', 'archiving', 'archived'].includes(raw.status)) {
      throw new Error(`Corrupt lifecycle record ${this.recordFile(id)}`);
    }
    const { schema: _schema, ...record } = raw;
    return record;
  }

  private async writeRecord(record: BankRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.recordFile(record.id)), { recursive: true });
    const stored: StoredRecord = { schema: 1, ...record };
    await writeJsonAtomic(this.recordFile(record.id), stored);
  }
}

// ---- validation -----------------------------------------------------------

export function isValidBankId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= BANK_ID_MAX && BANK_NAME_RE.test(id);
}

export function assertBankId(id: unknown): asserts id is string {
  if (!isValidBankId(id)) {
    throw new ApiError(
      'invalid_bank_id',
      `Bank id must be 1-${BANK_ID_MAX} chars of lowercase a-z, 0-9 and "-", starting with a letter or digit`,
      { bank: typeof id === 'string' ? id.slice(0, 100) : null },
    );
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

function validateName(value: unknown): string {
  if (typeof value !== 'string') throw invalidField('name', 'must be a string');
  const name = value.trim();
  const len = [...name].length;
  if (len < 1 || len > NAME_MAX) throw invalidField('name', `must be 1-${NAME_MAX} characters after trimming`);
  if (CONTROL.test(name)) throw invalidField('name', 'must be a single line without control characters');
  return name;
}

function validateDescription(value: unknown): string {
  if (typeof value !== 'string') throw invalidField('description', 'must be a string');
  const description = value.trim();
  if ([...description].length > DESCRIPTION_MAX) {
    throw invalidField('description', `must be at most ${DESCRIPTION_MAX} characters`);
  }
  if (CONTROL_EXCEPT_NEWLINE.test(description)) {
    throw invalidField('description', 'must not contain control characters other than newlines');
  }
  return description;
}

function invalidField(field: string, problem: string): ApiError {
  return new ApiError('validation_error', `${field} ${problem}`, { field });
}

const HOLD_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/;

function assertHoldRef(ref: string): void {
  if (!HOLD_REF_RE.test(ref)) throw new Error(`Invalid durable work ref "${ref}"`);
}

function notFound(bank: string): ApiError {
  return new ApiError('bank_not_found', `Bank "${bank}" not found`, { bank });
}

// ---- small fs helpers -----------------------------------------------------

function leaseIsLive(lease: StoredLease): boolean {
  if (LIVE_LEASES.has(lease.id)) return true;
  // Written by this process but no live handle: leaked, not running.
  if (lease.pid === process.pid) return false;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

/** Like writeJsonAtomic, but fsyncs the file and its directory: survives power loss, not just a crash. */
export async function writeJsonDurable(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fsyncDir(path.dirname(file));
}

export async function fsyncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } catch (err) {
    // Some platforms refuse fsync on directories; the rename is still atomic.
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
  } finally {
    await handle.close();
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}
