// Immutable read view of one bank revision for the query path.
//
// The Librarian keeps mutating `<root>/<bank>/fs/` while a query runs, so the
// retriever never reads the live tree. Instead the `fs/` subtree of the chosen
// commit is exported with `git archive <sha>:fs | tar -x` into a private
// directory outside every bank:
//
//   <root>/.query-snapshots/<bank>/<sha12>-<pid>-<rand>/
//
// Nothing here writes to the bank repo: no worktree, no index, no checkout,
// no refs. After extraction the whole tree is made read-only (files 0444,
// directories 0555), so the retriever's sandbox physically cannot create,
// modify or delete anything in it, whatever the prompt says. `.query-snapshots` starts with a dot, so it can never be mistaken
// for a bank id. Each query gets its own directory and removes it when done;
// directories left behind by a process that died are swept on the next
// snapshot. The directory path is internal and never comes from a caller.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BANK_NAME_RE, bankPath, bankRoot } from '../bank.ts';

export const SNAPSHOTS_DIR = '.query-snapshots';
const SHA_RE = /^[0-9a-f]{40}$/;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export interface Snapshot {
  bank: string;
  revision: string;
  /** Host directory holding the revision's `fs/` contents. */
  dir: string;
  /** Remove the directory. Idempotent; never throws. */
  release(): Promise<void>;
}

// Snapshot directories this process created and has not released yet.
const LIVE = new Set<string>();

export function snapshotsRoot(): string {
  return path.join(bankRoot(), SNAPSHOTS_DIR);
}

/** Export `fs/` of `revision` into a fresh private directory. */
export async function materializeSnapshot(bank: string, revision: string): Promise<Snapshot> {
  if (!BANK_NAME_RE.test(bank)) throw new SnapshotError(`Invalid bank name "${bank}"`);
  if (!SHA_RE.test(revision)) throw new SnapshotError(`Revision must be a full 40-hex sha, got "${revision}"`);
  const repo = bankPath(bank);

  const bankDir = path.join(snapshotsRoot(), bank);
  await fs.mkdir(bankDir, { recursive: true });
  await sweepStale(bankDir);

  const dir = path.join(bankDir, `${revision.slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir);
  LIVE.add(dir);
  const release = async () => {
    LIVE.delete(dir);
    await removeTree(dir);
  };

  try {
    const type = await git(repo, ['cat-file', '-t', revision]).catch(() => null);
    if (type?.trim() !== 'commit') throw new SnapshotError(`Revision ${revision} is not a commit in bank "${bank}"`);
    // A revision without fs/ (should not happen: every bank is scaffolded with
    // fs/_index.md) snapshots as an empty tree rather than failing.
    const hasFs = (await git(repo, ['cat-file', '-t', `${revision}:fs`]).catch(() => null))?.trim() === 'tree';
    if (hasFs) await archiveInto(repo, `${revision}:fs`, dir);
    await makeReadOnly(dir);
  } catch (err) {
    await release();
    throw err instanceof SnapshotError ? err : new SnapshotError(`Snapshot of ${bank}@${revision} failed: ${message(err)}`);
  }

  return { bank, revision, dir, release };
}

/** Remove snapshot directories whose owning process is gone. */
async function sweepStale(bankDir: string): Promise<void> {
  const names = await fs.readdir(bankDir).catch(() => [] as string[]);
  for (const name of names) {
    const dir = path.join(bankDir, name);
    const pid = Number(name.split('-')[1]);
    if (LIVE.has(dir)) continue;
    if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) continue;
    await removeTree(dir);
  }
}

/** Files 0444, directories 0555 (children first, root last). Symlinks untouched. */
async function makeReadOnly(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    const abs = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory()) dirs.push(abs);
    else if (entry.isFile()) await fs.chmod(abs, 0o444);
  }
  // Deepest first, so a parent is never locked before its children are done.
  dirs.sort((a, b) => b.length - a.length);
  for (const d of dirs) await fs.chmod(d, 0o555);
  await fs.chmod(dir, 0o555);
}

/** Give the owner write access back on every directory, then delete. Never throws. */
async function removeTree(dir: string): Promise<void> {
  try {
    await fs.chmod(dir, 0o755);
    for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) await fs.chmod(path.join(entry.parentPath, entry.name), 0o755).catch(() => undefined);
    }
  } catch {
    // missing or already partly gone: rm below handles what is left
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `git exited ${code}`))));
  });
}

/** `git archive <treeish> | tar -x -C dir`, failing if either side fails. */
function archiveInto(repo: string, treeish: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', treeish], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-f', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let archiveErr = '';
    let tarErr = '';
    archive.stderr.on('data', (d) => (archiveErr += d));
    tar.stderr.on('data', (d) => (tarErr += d));
    archive.stdout.pipe(tar.stdin);
    // tar dying early must not crash the process with EPIPE.
    tar.stdin.on('error', () => undefined);

    let pending = 2;
    let failure: Error | null = null;
    const done = (who: string, code: number | null, stderr: string) => {
      if (code !== 0 && !failure) failure = new Error(`${who} exited ${code}: ${stderr.trim()}`);
      if (--pending === 0) (failure ? reject(failure) : resolve());
    };
    archive.on('error', (e) => (failure ??= e));
    tar.on('error', (e) => (failure ??= e));
    archive.on('close', (code) => done('git archive', code, archiveErr));
    tar.on('close', (code) => done('tar', code, tarErr));
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
