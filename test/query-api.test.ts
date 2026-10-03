// POST /v1/banks/:bank/query over Hono in-process: the answer comes from an
// immutable snapshot of the completed revision while a fake Librarian keeps
// committing to the live bank. No models, no network: the retriever is a fake
// that reads the snapshot directory it is handed. Throwaway MEMORY_BANK_ROOT.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Hono } from 'hono';

import { BankRegistry } from '../src/banks/index.ts';
import {
  EMPTY_ANSWER,
  SNAPSHOTS_DIR,
  createQueryRouter,
  mapReference,
  type CompletedRevision,
  type PendingIngestions,
  type RetrieveFn,
  type RetrieveInput,
} from '../src/query/index.ts';

let base: string;
let root: string;
let counter = 0;
let registry: BankRegistry;
let records: Map<string, CompletedRevision | null>;
let pending: Map<string, PendingIngestions> | null;
let retrieve: RetrieveFn;
let calls: RetrieveInput[];

before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-banks-query-'));
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  root = path.join(base, `root-${++counter}`);
  await fs.mkdir(root);
  process.env.MEMORY_BANK_ROOT = root;
  registry = new BankRegistry();
  records = new Map();
  pending = null;
  calls = [];
  retrieve = async () => ({ answer: 'unused', references: [], meta: {} });
});

function makeApp() {
  const app = new Hono();
  app.route(
    '/v1',
    createQueryRouter({
      guard: registry,
      revisions: { resolve: async (bank) => records.get(bank) ?? null },
      retrieve: async (input) => {
        calls.push(input);
        return retrieve(input);
      },
      ...(pending
        ? { ingestions: { pendingCounts: async (bank: string) => pending!.get(bank) ?? { queued: 0, running: 0 } } }
        : {}),
    }),
  );
  return app;
}

async function query(bank: string, body: unknown) {
  const res = await makeApp().request(`/v1/banks/${bank}/query`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return { status: res.status, body: (await res.json()) as any };
}

function git(bank: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: path.join(root, bank),
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

/** Write files under the live fs/ and commit them; returns the new HEAD. */
async function commitFiles(bank: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, bank, 'fs', rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  git(bank, 'add', '-A');
  git(bank, 'commit', '-q', '-m', message);
  return git(bank, 'rev-parse', 'HEAD');
}

async function bankWithRevision(bank: string, by: CompletedRevision['by'] = 'worker') {
  await registry.create({ id: bank });
  const sha = await commitFiles(bank, { 'notes/a.md': 'v1 alpha\n', 'notes/keep.md': 'keep\n' }, 'curate: v1');
  records.set(bank, { bank, revision: sha, completedAt: '2026-10-03T10:00:00.000Z', by, runId: 'r1' });
  return sha;
}

/** Every path + content hash under dir (git internals included). */
async function treeHash(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const abs = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, abs)] = entry.isFile()
      ? createHash('sha256').update(await fs.readFile(abs)).digest('hex')
      : 'dir';
  }
  return out;
}

async function snapshotDirs(bank: string): Promise<string[]> {
  return fs.readdir(path.join(root, SNAPSHOTS_DIR, bank)).catch(() => []);
}

function assertError(res: { status: number; body: any }, status: number, code: string) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code);
  assert.deepEqual(Object.keys(res.body), ['error']);
}

test('answers from the completed revision while a fake Librarian commits to the live bank', async () => {
  const sha = await bankWithRevision('alpha');
  const liveFs = path.join(root, 'alpha', 'fs');
  let seen: Record<string, string | null> = {};

  retrieve = async ({ readRoot, fsPath }) => {
    // The Librarian is mid-run: rewrites a note, adds one, deletes one, commits.
    await commitFiles('alpha', { 'notes/a.md': 'v2 beta\n', 'notes/new.md': 'new\n' }, 'ingest: 1 item(s)');
    await fs.rm(path.join(liveFs, 'notes', 'keep.md'));
    const read = (rel: string) => fs.readFile(path.join(readRoot, rel), 'utf8').catch(() => null);
    seen = { a: await read('notes/a.md'), keep: await read('notes/keep.md'), fresh: await read('notes/new.md') };
    assert.equal(fsPath, liveFs);
    assert.ok(!readRoot.startsWith(path.join(root, 'alpha')), 'snapshot must live outside the bank');
    return {
      answer: 'alpha is v1',
      references: [
        { path: path.join(readRoot, 'notes', 'a.md'), why: 'snapshot-absolute' },
        { path: '/notes/keep.md', why: 'sandbox-absolute' },
        { path: 'notes/a.md', why: 'relative' },
        { path: path.join(liveFs, 'notes', 'a.md'), why: 'already live' },
      ],
      meta: { model: 'fake', bash_calls: 2 },
    };
  };

  const res = await query('alpha', { question: 'what is alpha?', hint: '  look in notes ' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(seen, { a: 'v1 alpha\n', keep: 'keep\n', fresh: null });
  assert.equal(res.body.revision, sha);
  assert.equal(res.body.answer, 'alpha is v1');
  assert.deepEqual(
    res.body.references.map((r: any) => r.path),
    [
      path.join(liveFs, 'notes/a.md'),
      path.join(liveFs, 'notes/keep.md'),
      path.join(liveFs, 'notes/a.md'),
      path.join(liveFs, 'notes/a.md'),
    ],
  );
  assert.ok(!JSON.stringify(res.body).includes(SNAPSHOTS_DIR), 'temporary snapshot path leaked into the response');
  assert.deepEqual(res.body.processing, {
    searchable: true,
    revisionCompletedAt: '2026-10-03T10:00:00.000Z',
    revisionSource: 'worker',
    provenance: 'verified',
    pendingIngestions: null,
  });
  assert.equal(res.body.meta.model, 'fake');
  assert.equal(res.body.meta.unexpected_writes, 0);
  assert.equal(calls[0].question, 'what is alpha?');
  assert.equal(calls[0].hint, 'look in notes');
  // The Librarian's live changes are untouched and the snapshot is gone.
  assert.equal(await fs.readFile(path.join(liveFs, 'notes', 'a.md'), 'utf8'), 'v2 beta\n');
  assert.deepEqual(await snapshotDirs('alpha'), []);
});

test('the query never writes to the live bank or its git repo', async () => {
  await bankWithRevision('quiet');
  const before = await treeHash(path.join(root, 'quiet'));
  retrieve = async ({ readRoot }) => {
    assert.equal(await fs.readFile(path.join(readRoot, 'notes', 'a.md'), 'utf8'), 'v1 alpha\n');
    return { answer: 'ok', references: [], meta: {} };
  };
  const res = await query('quiet', { question: 'q' });
  assert.equal(res.status, 200);
  assert.deepEqual(await treeHash(path.join(root, 'quiet')), before);
  assert.deepEqual(git('quiet', 'status', '--porcelain'), '');
});

test('the snapshot is read-only: the retriever cannot create, change or delete files', async () => {
  if (process.getuid?.() === 0) return; // root ignores permission bits
  await bankWithRevision('locked');
  const failures: string[] = [];
  retrieve = async ({ readRoot }) => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['modify', () => fs.writeFile(path.join(readRoot, 'notes', 'a.md'), 'hacked')],
      ['append', () => fs.appendFile(path.join(readRoot, '_index.md'), 'x')],
      ['create', () => fs.writeFile(path.join(readRoot, 'notes', 'evil.md'), 'x')],
      ['create-root', () => fs.writeFile(path.join(readRoot, 'evil.md'), 'x')],
      ['delete', () => fs.rm(path.join(readRoot, 'notes', 'keep.md'))],
      ['mkdir', () => fs.mkdir(path.join(readRoot, 'notes', 'sub'))],
      ['rename', () => fs.rename(path.join(readRoot, 'notes', 'a.md'), path.join(readRoot, 'notes', 'b.md'))],
    ];
    for (const [name, attempt] of attempts) {
      await attempt().then(
        () => failures.push(`${name} succeeded`),
        (err) => {
          if (!['EACCES', 'EPERM'].includes(err.code)) failures.push(`${name}: ${err.code}`);
        },
      );
    }
    return { answer: 'ok', references: [], meta: {} };
  };
  const res = await query('locked', { question: 'q' });
  assert.equal(res.status, 200);
  assert.deepEqual(failures, []);
  assert.equal(res.body.meta.unexpected_writes, 0);
  assert.deepEqual(await snapshotDirs('locked'), [], 'read-only snapshot must still be cleaned up');
});

test('no completed revision yet: 200 no-data answer, no model call, pending counts reported', async () => {
  await registry.create({ id: 'fresh' });
  pending = new Map([['fresh', { queued: 2, running: 1 }]]);
  const expected = {
    bank: 'fresh',
    answer: EMPTY_ANSWER,
    references: [],
    revision: null,
    processing: {
      searchable: false,
      reason: 'no_completed_revision',
      revisionCompletedAt: null,
      revisionSource: null,
      provenance: null,
      pendingIngestions: { queued: 2, running: 1 },
    },
  };

  // No record at all.
  let res = await query('fresh', { question: 'anything?' });
  assert.equal(res.status, 200);
  assert.deepEqual({ ...res.body, meta: undefined }, { ...expected, meta: undefined });
  assert.equal(res.body.meta.model, null);

  // Record exists but the bank had no repo when first locked.
  records.set('fresh', { bank: 'fresh', revision: null, completedAt: 'x', by: 'bootstrap', runId: 'bootstrap' });
  res = await query('fresh', { question: 'anything?' });
  assert.equal(res.status, 200);
  assert.equal(res.body.revision, null);
  assert.equal(res.body.processing.searchable, false);

  assert.equal(calls.length, 0, 'the model must not be called without a completed revision');
  assert.deepEqual(await snapshotDirs('fresh'), []);
});

test('bootstrap revision is answered but marked unverified', async () => {
  const sha = await bankWithRevision('legacy', 'bootstrap');
  retrieve = async () => ({ answer: 'old', references: [], meta: {} });
  const res = await query('legacy', { question: 'q' });
  assert.equal(res.status, 200);
  assert.equal(res.body.revision, sha);
  assert.equal(res.body.processing.revisionSource, 'bootstrap');
  assert.equal(res.body.processing.provenance, 'unverified');
});

test('a revision that cannot be snapshotted is a clean 500 snapshot_failed, nothing left behind', async () => {
  await bankWithRevision('broken');
  records.set('broken', { bank: 'broken', revision: 'f'.repeat(40), completedAt: 'x', by: 'worker', runId: 'r' });
  const res = await query('broken', { question: 'q' });
  assertError(res, 500, 'snapshot_failed');
  assert.equal(res.body.error.details.revision, 'f'.repeat(40));
  assert.equal(calls.length, 0);
  assert.deepEqual(await snapshotDirs('broken'), []);
});

test('a malformed revision record is a snapshot_failed, never a live-tree fallback', async () => {
  await bankWithRevision('weird');
  records.set('weird', { bank: 'weird', revision: 'HEAD', completedAt: 'x', by: 'worker', runId: 'r' });
  const res = await query('weird', { question: 'q' });
  assertError(res, 500, 'snapshot_failed');
  assert.equal(calls.length, 0);
});

test('retriever failure releases the snapshot and the lease', async () => {
  await bankWithRevision('flaky');
  retrieve = async () => {
    throw new Error('model exploded');
  };
  const res = await query('flaky', { question: 'q' });
  assertError(res, 500, 'internal_error');
  assert.deepEqual(await snapshotDirs('flaky'), []);
  // Lease released: archive settles immediately.
  assert.equal((await registry.archive('flaky')).status, 'archived');
});

test('lifecycle: missing 404, archiving/archived 409, and archive waits for a running query', async () => {
  assertError(await query('nope', { question: 'q' }), 404, 'bank_not_found');

  await bankWithRevision('busy');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  retrieve = async () => {
    entered();
    await gate;
    return { answer: 'done', references: [], meta: {} };
  };
  const running = query('busy', { question: 'q' });
  await inside;
  assert.equal((await registry.archive('busy')).status, 'archiving');
  assertError(await query('busy', { question: 'q' }), 409, 'bank_archiving');
  release();
  assert.equal((await running).status, 200, 'an admitted query finishes');
  assert.equal((await registry.get('busy'))!.status, 'archived');
  assertError(await query('busy', { question: 'q' }), 409, 'bank_archived');
});

test('request validation', async () => {
  await bankWithRevision('val');
  assertError(await query('Bad_Id', { question: 'q' }), 400, 'invalid_bank_id');
  assertError(await query('val', 'not json'), 400, 'invalid_json');
  assertError(await query('val', '[1]'), 400, 'invalid_json');
  assertError(await query('val', {}), 400, 'validation_error');
  assertError(await query('val', { question: '   ' }), 400, 'validation_error');
  assertError(await query('val', { question: 1 }), 400, 'validation_error');
  assertError(await query('val', { question: 'q', hint: 3 }), 400, 'validation_error');
  assertError(await query('val', { question: 'x'.repeat(4001) }), 400, 'validation_error');
  // A caller can never choose what is read.
  const res = await query('val', { question: 'q', path: '/etc', revision: 'abc', fsPath: '/tmp' });
  assertError(res, 400, 'validation_error');
  assert.deepEqual(res.body.error.details.fields, ['path', 'revision', 'fsPath']);
  assert.equal(calls.length, 0);
});

test('snapshots left by a dead process are swept on the next query', async () => {
  await bankWithRevision('sweep');
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  const stale = path.join(root, SNAPSHOTS_DIR, 'sweep', `abcdef012345-${dead}-deadbeef`);
  await fs.mkdir(path.join(stale, 'notes'), { recursive: true });
  await fs.writeFile(path.join(stale, 'notes', 'x.md'), 'x');
  await fs.chmod(path.join(stale, 'notes'), 0o555);
  await fs.chmod(stale, 0o555);
  retrieve = async () => ({ answer: 'ok', references: [], meta: {} });
  assert.equal((await query('sweep', { question: 'q' })).status, 200);
  assert.equal(existsSync(stale), false);
});

test('concurrent queries on one bank get independent snapshots', async () => {
  const sha = await bankWithRevision('para');
  const roots: string[] = [];
  retrieve = async ({ readRoot }) => {
    roots.push(readRoot);
    await new Promise((r) => setTimeout(r, 20));
    return { answer: await fs.readFile(path.join(readRoot, 'notes', 'a.md'), 'utf8'), references: [], meta: {} };
  };
  const results = await Promise.all([1, 2, 3].map(() => query('para', { question: 'q' })));
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, sha);
    assert.equal(r.body.answer, 'v1 alpha\n');
  }
  assert.equal(new Set(roots).size, 3);
  assert.deepEqual(await snapshotDirs('para'), []);
});

test('mapReference keeps escapes and empty paths honest', () => {
  const snap = '/r/.query-snapshots/b/abc-1-x';
  const live = '/r/b/fs';
  assert.equal(mapReference({ path: `${snap}/a.md`, why: '' }, snap, live).path, '/r/b/fs/a.md');
  assert.equal(mapReference({ path: '../../etc/passwd', why: '' }, snap, live).path, '../../etc/passwd');
  assert.equal(mapReference({ path: `${snap}/../../x`, why: '' }, snap, live).path, `${snap}/../../x`);
  assert.equal(mapReference({ path: '  ', why: 'w' }, snap, live).path, '');
  assert.equal(mapReference({ path: '/', why: '' }, snap, live).path, live);
});
