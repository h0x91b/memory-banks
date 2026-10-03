// /v1 bank lifecycle API: create/list/get/patch/archive/restore over HTTP
// (Hono in-process, no server), plus the lifecycle guard used by future
// intake/queue code. Banks live in a throwaway MEMORY_BANK_ROOT; no models,
// no network.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Hono } from 'hono';

import { BankRegistry, createBanksRouter } from '../src/banks/index.ts';

let base: string;
let root: string;
let outside: string;
let app: Hono;
let registry: BankRegistry;
let rootCounter = 0;

before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-banks-api-'));
  outside = path.join(base, 'outside');
  await fs.mkdir(path.join(outside, 'fs'), { recursive: true });
  await fs.writeFile(path.join(outside, 'fs', 'secret.md'), 'not a bank of ours\n');
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  root = path.join(base, `root-${++rootCounter}`);
  await fs.mkdir(root);
  process.env.MEMORY_BANK_ROOT = root;
  registry = new BankRegistry();
  app = new Hono();
  app.route('/v1', createBanksRouter(registry));
});

async function call(method: string, url: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app.request(url, init);
  return { status: res.status, body: (await res.json()) as any };
}

function assertError(res: { status: number; body: any }, status: number, code: string) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code);
  assert.equal(typeof res.body.error.message, 'string');
  assert.deepEqual(Object.keys(res.body), ['error']);
}

/** Every path + content hash under dir (git internals included). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, abs);
    out[rel] = entry.isFile() ? createHash('sha256').update(await fs.readFile(abs)).digest('hex') : 'dir';
  }
  return out;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid!;
}

async function writeLease(bank: string, pid: number) {
  const dir = path.join(root, '.lifecycle', 'leases', bank);
  await fs.mkdir(dir, { recursive: true });
  const id = `fixture-${pid}`;
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, bank, kind: 'curate', pid, startedAt: new Date().toISOString() }),
  );
}

// ---- create ---------------------------------------------------------------

test('POST /v1/banks creates a bank on disk with git and a durable record', async () => {
  const res = await call('POST', '/v1/banks', { id: 'notes', name: 'My notes', description: 'Household notes' });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'notes');
  assert.equal(res.body.name, 'My notes');
  assert.equal(res.body.description, 'Household notes');
  assert.equal(res.body.status, 'active');
  assert.equal(res.body.archivedAt, null);
  assert.equal(res.body.createdAt, res.body.updatedAt);

  await fs.access(path.join(root, 'notes', 'fs', '_index.md'));
  await fs.access(path.join(root, 'notes', '.git'));
  const stored = JSON.parse(await fs.readFile(path.join(root, '.lifecycle', 'banks', 'notes.json'), 'utf8'));
  assert.equal(stored.schema, 1);
  assert.equal(stored.name, 'My notes');

  const defaults = await call('POST', '/v1/banks', { id: 'plain' });
  assert.equal(defaults.status, 201);
  assert.equal(defaults.body.name, 'plain');
  assert.equal(defaults.body.description, '');
});

test('creating an existing bank is a 409 conflict, including a pre-existing bank without a record', async () => {
  assert.equal((await call('POST', '/v1/banks', { id: 'dup' })).status, 201);
  assertError(await call('POST', '/v1/banks', { id: 'dup', name: 'again' }), 409, 'bank_exists');

  await fs.mkdir(path.join(root, 'legacy', 'fs'), { recursive: true });
  assertError(await call('POST', '/v1/banks', { id: 'legacy' }), 409, 'bank_exists');
});

test('create validates id, body shape and fields', async () => {
  for (const id of ['Upper', '-lead', '../escape', 'a/b', 'a_b', '', 'x'.repeat(201), 42]) {
    assertError(await call('POST', '/v1/banks', { id }), 400, 'invalid_bank_id');
  }
  assertError(await call('POST', '/v1/banks', {}), 400, 'validation_error');
  assertError(await call('POST', '/v1/banks', '{not json'), 400, 'invalid_json');
  assertError(await call('POST', '/v1/banks', '[1]'), 400, 'invalid_json');
  assertError(await call('POST', '/v1/banks', { id: 'ok', status: 'archived' }), 400, 'validation_error');
  assertError(await call('POST', '/v1/banks', { id: 'ok', name: '   ' }), 400, 'validation_error');
  assertError(await call('POST', '/v1/banks', { id: 'ok', name: 'a\nb' }), 400, 'validation_error');
  assertError(await call('POST', '/v1/banks', { id: 'ok', name: 7 }), 400, 'validation_error');
  assertError(await call('POST', '/v1/banks', { id: 'ok', description: 'd'.repeat(1001) }), 400, 'validation_error');
  assert.deepEqual(await fs.readdir(root), [], 'rejected creates must not touch the disk');
});

// ---- get / not found / path safety -----------------------------------------

test('GET unknown bank is 404; malformed or traversal ids are 400 and never reach the disk', async () => {
  assertError(await call('GET', '/v1/banks/nope'), 404, 'bank_not_found');
  for (const url of ['/v1/banks/UPPER', '/v1/banks/..%2F..%2Foutside', '/v1/banks/a%00b']) {
    assertError(await call('GET', url), 400, 'invalid_bank_id');
  }
  // The URL parser folds %2e%2e into "..", so this never reaches the router at all.
  assert.equal((await app.request('/v1/banks/%2e%2e')).status, 404);
  for (const action of ['archive', 'restore']) {
    assertError(await call('POST', `/v1/banks/nope/${action}`), 404, 'bank_not_found');
    assertError(await call('POST', `/v1/banks/..%2Foutside/${action}`), 400, 'invalid_bank_id');
  }
  assertError(await call('PATCH', '/v1/banks/nope', { name: 'x' }), 404, 'bank_not_found');
});

test('a symlink in the root pointing elsewhere is never treated as a bank', async () => {
  const before = await snapshot(outside);
  await fs.symlink(outside, path.join(root, 'sneaky'));
  await fs.mkdir(path.join(root, 'stray-folder')); // no fs/ or .git: not a bank

  assert.deepEqual((await call('GET', '/v1/banks?status=all')).body.banks, []);
  assertError(await call('GET', '/v1/banks/sneaky'), 404, 'bank_not_found');
  assertError(await call('POST', '/v1/banks/sneaky/archive'), 404, 'bank_not_found');
  assertError(await call('PATCH', '/v1/banks/sneaky', { name: 'x' }), 404, 'bank_not_found');
  assertError(await call('GET', '/v1/banks/stray-folder'), 404, 'bank_not_found');
  assert.deepEqual(await snapshot(outside), before);
});

// ---- list -----------------------------------------------------------------

test('list is sorted by id, paginates deterministically and defaults to active', async () => {
  for (const id of ['echo', 'alpha', 'delta', 'charlie', 'bravo']) {
    assert.equal((await call('POST', '/v1/banks', { id })).status, 201);
  }
  assert.equal((await call('POST', '/v1/banks/charlie/archive')).body.status, 'archived');

  const all = await call('GET', '/v1/banks');
  assert.deepEqual(all.body.banks.map((b: any) => b.id), ['alpha', 'bravo', 'delta', 'echo']);
  assert.equal(all.body.nextCursor, null);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url: string = `/v1/banks?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
    const page = await call('GET', url);
    assert.equal(page.status, 200);
    seen.push(...page.body.banks.map((b: any) => b.id));
    cursor = page.body.nextCursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ['alpha', 'bravo', 'delta', 'echo']);
  assert.equal(pages, 2, 'exactly full pages must not produce an empty trailing page');

  const archived = await call('GET', '/v1/banks?status=archived');
  assert.deepEqual(archived.body.banks.map((b: any) => b.id), ['charlie']);
  const every = await call('GET', '/v1/banks?status=all&limit=100');
  assert.equal(every.body.banks.length, 5);

  const first = await call('GET', '/v1/banks?limit=1');
  assertError(await call('GET', `/v1/banks?status=all&cursor=${first.body.nextCursor}`), 400, 'invalid_cursor');
  assertError(await call('GET', '/v1/banks?cursor=garbage'), 400, 'invalid_cursor');
  for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'status=deleted']) {
    assertError(await call('GET', `/v1/banks?${q}`), 400, 'validation_error');
  }
});

test('existing banks are discovered without migration and keep their files', async () => {
  const legacy = path.join(root, 'old-bank');
  await fs.mkdir(path.join(legacy, 'fs', 'recipes'), { recursive: true });
  await fs.writeFile(path.join(legacy, 'fs', 'recipes', 'borscht.md'), 'beets\n');
  spawnSync('git', ['init', '-q', legacy]);
  const before = await snapshot(legacy);

  const list = await call('GET', '/v1/banks');
  assert.equal(list.body.banks.length, 1);
  assert.equal(list.body.banks[0].id, 'old-bank');
  assert.equal(list.body.banks[0].name, 'old-bank');
  assert.equal(list.body.banks[0].status, 'active');
  assert.equal(await registry.lookup('old-bank'), 'active');

  const patched = await call('PATCH', '/v1/banks/old-bank', { description: 'Recipes' });
  assert.equal(patched.body.description, 'Recipes');
  assert.equal(patched.body.createdAt, list.body.banks[0].createdAt);
  assert.equal((await call('POST', '/v1/banks/old-bank/archive')).body.status, 'archived');
  assert.deepEqual(await snapshot(legacy), before, 'lifecycle state lives outside the bank directory');
});

// ---- patch ----------------------------------------------------------------

test('PATCH changes name/description only; id is stable', async () => {
  await call('POST', '/v1/banks', { id: 'work', name: 'Work' });
  const res = await call('PATCH', '/v1/banks/work', { name: '  Work notes  ', description: 'Standups\nand plans' });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'work');
  assert.equal(res.body.name, 'Work notes');
  assert.equal(res.body.description, 'Standups\nand plans');
  assert.ok(res.body.updatedAt >= res.body.createdAt);

  const desc = await call('PATCH', '/v1/banks/work', { description: '' });
  assert.equal(desc.body.name, 'Work notes');
  assert.equal(desc.body.description, '');

  assertError(await call('PATCH', '/v1/banks/work', { id: 'other' }), 400, 'validation_error');
  assertError(await call('PATCH', '/v1/banks/work', { status: 'archived' }), 400, 'validation_error');
  assertError(await call('PATCH', '/v1/banks/work', {}), 400, 'validation_error');
  assertError(await call('PATCH', '/v1/banks/work', 'nope'), 400, 'invalid_json');
  assertError(await call('PATCH', '/v1/banks/work', { name: 'n'.repeat(101) }), 400, 'validation_error');
  assert.equal((await call('GET', '/v1/banks/work')).body.name, 'Work notes');
});

// ---- archive / restore ----------------------------------------------------

test('archive and restore keep every file and git object; both are idempotent', async () => {
  await call('POST', '/v1/banks', { id: 'keep' });
  await fs.writeFile(path.join(root, 'keep', 'fs', 'note.md'), 'important\n');
  const before = await snapshot(path.join(root, 'keep'));

  const archived = await call('POST', '/v1/banks/keep/archive');
  assert.equal(archived.status, 200);
  assert.equal(archived.body.status, 'archived');
  assert.ok(archived.body.archivedAt);
  assert.equal((await call('POST', '/v1/banks/keep/archive')).status, 200);
  assert.equal((await call('GET', '/v1/banks/keep')).body.status, 'archived', 'archived banks stay readable by id');
  assert.deepEqual(await snapshot(path.join(root, 'keep')), before);

  const restored = await call('POST', '/v1/banks/keep/restore');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, 'active');
  assert.equal(restored.body.archivedAt, null);
  assert.equal((await call('POST', '/v1/banks/keep/restore')).status, 200);
  assert.deepEqual(await snapshot(path.join(root, 'keep')), before);
  assert.equal((await call('POST', '/v1/banks', { id: 'keep' })).status, 409, 'restore is not a re-create');
});

test('archiving refuses new work at once and waits for admitted work to finish', async () => {
  await call('POST', '/v1/banks', { id: 'busy' });
  const lease = await registry.beginOperation('busy', 'curate');

  const res = await call('POST', '/v1/banks/busy/archive');
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'archiving');
  assert.equal(await registry.lookup('busy'), 'archiving');
  await assert.rejects(registry.beginOperation('busy', 'intake'), { code: 'bank_archiving' });
  assertError(await call('POST', '/v1/banks/busy/restore'), 409, 'bank_archiving');
  assert.equal((await call('POST', '/v1/banks/busy/archive')).status, 202, 'repeat while archiving');

  await lease.release();
  await lease.release(); // idempotent
  assert.equal(await registry.lookup('busy'), 'archived');
  await assert.rejects(registry.beginOperation('busy', 'query'), { code: 'bank_archived' });
  await assert.rejects(registry.beginOperation('nope', 'query'), { code: 'bank_not_found' });
  await assert.rejects(registry.beginOperation('../x', 'query'), { code: 'invalid_bank_id' });

  await call('POST', '/v1/banks/busy/restore');
  const again = await registry.beginOperation('busy', 'intake');
  await again.release();
  assert.equal(await registry.lookup('busy'), 'active');
  assert.equal(await registry.lookup('Not Valid'), 'missing');
});

// ---- restart durability ---------------------------------------------------

test('state survives a restart; an archive left half-way finishes once its operations are gone', async () => {
  await call('POST', '/v1/banks', { id: 'durable', name: 'Durable' });
  await call('PATCH', '/v1/banks/durable', { description: 'kept across restarts' });
  await call('POST', '/v1/banks', { id: 'parked' });
  await call('POST', '/v1/banks/parked/archive');

  // Simulate a crash during archiving: lease written by a process that no longer exists.
  await call('POST', '/v1/banks', { id: 'crashed' });
  await writeLease('crashed', deadPid());
  // ...and one whose owner (another process, e.g. a CLI run) is still alive.
  await call('POST', '/v1/banks', { id: 'running' });
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  await writeLease('running', sleeper.pid!);
  for (const id of ['crashed', 'running']) {
    const stored = path.join(root, '.lifecycle', 'banks', `${id}.json`);
    const rec = JSON.parse(await fs.readFile(stored, 'utf8'));
    await fs.writeFile(stored, JSON.stringify({ ...rec, status: 'archiving', archiveRequestedAt: rec.createdAt }));
  }

  try {
    // "Restart": a brand-new registry and router over the same root.
    const fresh = new BankRegistry();
    const app2 = new Hono();
    app2.route('/v1', createBanksRouter(fresh));
    const get = async (id: string) => (await (await app2.request(`/v1/banks/${id}`)).json()) as any;

    const durable = await get('durable');
    assert.equal(durable.name, 'Durable');
    assert.equal(durable.description, 'kept across restarts');
    assert.equal((await get('parked')).status, 'archived');
    assert.equal((await get('crashed')).status, 'archived');
    assert.equal((await get('running')).status, 'archiving');
    await assert.rejects(fresh.beginOperation('running', 'intake'), { code: 'bank_archiving' });

    sleeper.kill();
    await new Promise((resolve) => sleeper.once('exit', resolve));
    assert.equal((await get('running')).status, 'archived');
  } finally {
    sleeper.kill();
  }
});
