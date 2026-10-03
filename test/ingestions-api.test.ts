// /v1/banks/:bank/ingestions: durable 202 intake, status, history, idempotency,
// archive retention, crash recovery and the worker claim port. In-process Hono
// plus child processes for real restarts. Throwaway MEMORY_BANK_ROOT; no
// models, no network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { Hono } from 'hono';

import { BankRegistry, createBanksRouter } from '../src/banks/index.ts';
import { IngestionClaimLost, IngestionStore, createIngestionsRouter } from '../src/ingestions/index.ts';

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'ingestion-process.ts');

let base: string;
let root: string;
let app: Hono;
let registry: BankRegistry;
let store: IngestionStore;
let rootCounter = 0;

before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-banks-ingest-'));
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  root = path.join(base, `root-${++rootCounter}`);
  await fs.mkdir(root);
  process.env.MEMORY_BANK_ROOT = root;
  delete process.env.MEMORY_BANK_INGESTION_DIR;
  registry = new BankRegistry();
  store = new IngestionStore(registry);
  app = new Hono();
  app.route('/v1', createBanksRouter(registry));
  app.route('/v1', createIngestionsRouter(store, registry));
  await registry.create({ id: 'notes' });
});

async function send(method: string, url: string, init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body = init.body;
  if (init.json !== undefined) {
    body = typeof init.json === 'string' ? init.json : JSON.stringify(init.json);
    headers['content-type'] ??= 'application/json';
  }
  const res = await app.request(url, { method, body, headers });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

const post = (json: unknown, headers?: Record<string, string>, bank = 'notes') =>
  send('POST', `/v1/banks/${bank}/ingestions`, { json, headers });

function assertError(res: { status: number; body: any }, status: number, code: string) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code);
  assert.deepEqual(Object.keys(res.body), ['error']);
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const reqDir = (bank: string, id: string) => path.join(root, '.ingestion', bank, 'requests', id);

async function treeOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    out.push(path.relative(dir, path.join(e.parentPath, e.name)));
  }
  return out.sort();
}

async function child(...args: string[]) {
  const { stdout } = await run(process.execPath, [FIXTURE, ...args], { env: { ...process.env, MEMORY_BANK_ROOT: root } });
  return JSON.parse(stdout);
}

// ---- accept ---------------------------------------------------------------------

test('JSON text + url: 202 {id,status,status_url}, stored durably, bank fs untouched', async () => {
  const bankFsBefore = await treeOf(path.join(root, 'notes'));
  const res = await post({
    metadata: { source: 'slack' },
    items: [
      { type: 'text', text: '# Standup\nshipped intake', filename: 'standup.md', mediaType: 'text/markdown' },
      { type: 'url', url: 'https://example.com/a?b=1', metadata: { why: 'later' } },
    ],
  });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ['id', 'status', 'status_url']);
  assert.equal(res.body.status, 'queued');
  assert.equal(res.body.status_url, `/v1/banks/notes/ingestions/${res.body.id}`);
  assert.equal(res.headers.get('location'), res.body.status_url);

  const got = await send('GET', res.body.status_url);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, 'queued');
  assert.deepEqual(got.body.metadata, { source: 'slack' });
  assert.equal(got.body.items.length, 2);
  assert.deepEqual(
    { ...got.body.items[0] },
    {
      index: 0,
      kind: 'text',
      filename: 'standup.md',
      mediaType: 'text/markdown',
      size: Buffer.byteLength('# Standup\nshipped intake'),
      sha256: sha('# Standup\nshipped intake'),
      url: null,
      metadata: null,
      status: 'queued',
      error: null,
    },
  );
  assert.deepEqual(got.body.commits, []);
  assert.equal(got.body.items[1].kind, 'url');
  assert.equal(got.body.items[1].url, 'https://example.com/a?b=1');
  assert.equal(got.body.items[1].size, null, 'URL is a descriptor, nothing fetched');
  for (const hidden of ['fingerprint', 'claim', 'schema']) assert.ok(!(hidden in got.body));

  const stored = await fs.readFile(path.join(reqDir('notes', res.body.id), 'items', '0'), 'utf8');
  assert.equal(stored, '# Standup\nshipped intake');
  await assert.rejects(fs.stat(path.join(reqDir('notes', res.body.id), 'items', '1')));
  const holds = await registry.listDurableWork('notes');
  assert.deepEqual(holds.map((h) => h.ref), [res.body.id]);
  assert.deepEqual(await treeOf(path.join(root, 'notes')), bankFsBefore, 'nothing written into the bank');
  assert.deepEqual(await fs.readdir(path.join(root, '.ingestion', 'notes', 'staging')), []);
});

test('multipart: files, an image, text, url and metadata are stored byte-exact', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
  const form = new FormData();
  form.append('file', new File([png], 'photo.png', { type: 'image/png' }));
  form.append('file', new File(['hello pdf'], '../../etc/evil.txt', { type: 'text/plain' }));
  form.append('text', 'loose note');
  form.append('url', 'http://example.org/page');
  form.append('metadata', JSON.stringify({ origin: 'upload-form' }));
  const res = await send('POST', '/v1/banks/notes/ingestions', { body: form });
  assert.equal(res.status, 202, JSON.stringify(res.body));

  const got = (await send('GET', res.body.status_url)).body;
  assert.deepEqual(
    got.items.map((i: any) => [i.kind, i.filename, i.mediaType, i.size]),
    [
      ['file', 'photo.png', 'image/png', png.length],
      ['file', 'evil.txt', 'text/plain', 9],
      ['text', null, 'text/plain', 10],
      ['url', null, null, null],
    ],
  );
  assert.deepEqual(got.metadata, { origin: 'upload-form' });
  assert.deepEqual(await fs.readFile(path.join(reqDir('notes', res.body.id), 'items', '0')), png);
  assert.equal(got.items[0].sha256, sha(png));
});

test('validation errors use the /v1 envelope and store nothing', async () => {
  const cases: Array<[unknown, number, string, Record<string, string>?]> = [
    [{}, 400, 'validation_error'],
    [{ items: [] }, 400, 'validation_error'],
    [{ items: [{ type: 'text', text: '' }] }, 400, 'validation_error'],
    [{ items: [{ type: 'text', text: 'x', extra: 1 }] }, 400, 'validation_error'],
    [{ items: [{ type: 'text', text: 'x', filename: '../x' }] }, 400, 'validation_error'],
    [{ items: [{ type: 'text', text: 'x', mediaType: 'nope' }] }, 400, 'validation_error'],
    [{ items: [{ type: 'url', url: 'file:///etc/passwd' }] }, 400, 'validation_error'],
    [{ items: [{ type: 'url', url: 'https://u:p@example.com/' }] }, 400, 'validation_error'],
    [{ items: [{ type: 'file' }] }, 400, 'validation_error'],
    [{ items: [{ type: 'text', text: 'x' }], metadata: [1] }, 400, 'validation_error'],
    [{ items: [{ type: 'text', text: 'x' }], foo: 1 }, 400, 'validation_error'],
    [{ items: Array.from({ length: 101 }, () => ({ type: 'text', text: 'x' })) }, 400, 'validation_error'],
    ['{not json', 400, 'invalid_json'],
    [{ items: [{ type: 'text', text: 'x' }] }, 400, 'validation_error', { 'Idempotency-Key': 'has space' }],
  ];
  for (const [body, status, code, headers] of cases) assertError(await post(body, headers), status, code);

  assertError(
    await send('POST', '/v1/banks/notes/ingestions', { body: 'hi', headers: { 'content-type': 'text/plain' } }),
    415,
    'unsupported_media_type',
  );
  const badMeta = new FormData();
  badMeta.append('text', 'x');
  badMeta.append('metadata', '[1]');
  assertError(await send('POST', '/v1/banks/notes/ingestions', { body: badMeta }), 400, 'validation_error');
  const unknownPart = new FormData();
  unknownPart.append('other', 'x');
  assertError(await send('POST', '/v1/banks/notes/ingestions', { body: unknownPart }), 400, 'validation_error');

  assertError(await post({ items: [{ type: 'text', text: 'x' }] }, {}, 'ghost'), 404, 'bank_not_found');
  assertError(await post({ items: [{ type: 'text', text: 'x' }] }, {}, 'Bad_Id'), 400, 'invalid_bank_id');
  assertError(await send('GET', '/v1/banks/notes/ingestions/ing_nope'), 404, 'ingestion_not_found');
  assertError(await send('GET', '/v1/banks/ghost/ingestions'), 404, 'bank_not_found');

  const big = Buffer.alloc(50 * 1024 * 1024 + 10, 'a');
  assertError(
    await send('POST', '/v1/banks/notes/ingestions', {
      body: big,
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
    }),
    413,
    'payload_too_large',
  );

  assert.equal((await store.list('notes')).ingestions.length, 0);
  assert.deepEqual(await registry.listDurableWork('notes'), []);
});

// ---- idempotency ------------------------------------------------------------------

test('Idempotency-Key: same payload replays, different payload is 409, keys are per bank', async () => {
  await registry.create({ id: 'other' });
  const body = { items: [{ type: 'text', text: 'once' }] };
  const first = await post(body, { 'Idempotency-Key': 'k-1' });
  assert.equal(first.status, 202);
  const again = await post(body, { 'Idempotency-Key': 'k-1' });
  assert.equal(again.status, 202);
  assert.equal(again.body.id, first.body.id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');

  const conflict = await post({ items: [{ type: 'text', text: 'different' }] }, { 'Idempotency-Key': 'k-1' });
  assertError(conflict, 409, 'idempotency_conflict');
  assert.equal(conflict.body.error.details.ingestionId, first.body.id);

  const otherBank = await post(body, { 'Idempotency-Key': 'k-1' }, 'other');
  assert.equal(otherBank.status, 202);
  assert.notEqual(otherBank.body.id, first.body.id);

  const noKey = await post(body);
  assert.notEqual(noKey.body.id, first.body.id, 'without a key every POST is a new request');
  assert.equal((await store.list('notes')).ingestions.length, 2);
});

test('concurrent identical repeats with one key create exactly one request', async () => {
  const body = { items: [{ type: 'text', text: 'race' }] };
  const results = await Promise.all(Array.from({ length: 20 }, () => post(body, { 'Idempotency-Key': 'race-key' })));
  assert.ok(results.every((r) => r.status === 202), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal((await fs.readdir(path.join(root, '.ingestion', 'notes', 'requests'))).length, 1);
  assert.equal((await registry.listDurableWork('notes')).length, 1);
  assert.deepEqual(await fs.readdir(path.join(root, '.ingestion', 'notes', 'staging')), [], 'losers cleaned up');

  const distinct = await Promise.all(Array.from({ length: 10 }, (_, i) => post({ items: [{ type: 'text', text: `n${i}` }] })));
  assert.equal(new Set(distinct.map((r) => r.body.id)).size, 10);
});

test('restart: queued request, idempotency and history survive a new process', async () => {
  const a = await child('post', 'notes', 'from process A');
  assert.equal(a.status, 202);
  const b = await child('post', 'notes', 'from process A');
  assert.equal(b.body.id, a.body.id, 'replayed after restart');
  const c = await child('post', 'notes', 'changed payload');
  assert.equal(c.status, 409);
  const list = await child('list', 'notes');
  assert.deepEqual(list.body.ingestions.map((i: any) => [i.id, i.status]), [[a.body.id, 'queued']]);
});

// ---- archive retention --------------------------------------------------------------

test('archive waits for queued work across restarts and settles when the worker completes', async () => {
  const accepted = await post({ items: [{ type: 'text', text: 'keep me' }] });
  assert.equal(accepted.status, 202);

  const archive = await send('POST', '/v1/banks/notes/archive');
  assert.equal(archive.status, 202);
  assert.equal(archive.body.status, 'archiving');
  assertError(await post({ items: [{ type: 'text', text: 'new' }] }), 409, 'bank_archiving');
  assertError(await send('POST', '/v1/banks/notes/restore'), 409, 'bank_archiving');

  // A fresh process (no PID lease anywhere) still sees the hold.
  const restarted = await child('get-bank', 'notes');
  assert.equal(restarted.body.status, 'archiving');
  assert.equal((await send('GET', accepted.body.status_url)).body.status, 'queued', 'history readable while archiving');

  // The worker drains accepted work of an archiving bank in another process.
  const drained = await child('drain', 'notes');
  assert.equal(drained.drained, 1);
  assert.equal(drained.bank.status, 'archived');
  assert.equal((await send('GET', '/v1/banks/notes')).body.status, 'archived');
  const done = (await send('GET', accepted.body.status_url)).body;
  assert.equal(done.status, 'succeeded');
  assert.equal(done.revision, 'abc123');
  assertError(await post({ items: [{ type: 'text', text: 'late' }] }), 409, 'bank_archived');
});

test('recovery: orphan hold, missing hold, missing idempotency record and stale staging', async () => {
  const a = await post({ items: [{ type: 'text', text: 'a' }] }, { 'Idempotency-Key': 'ka' });
  const ingest = path.join(root, '.ingestion', 'notes');
  const holds = path.join(root, '.lifecycle', 'holds', 'notes');
  // Crash leftovers: an orphan hold (hold written, request never renamed), a
  // committed request whose hold and idempotency record were lost, a staging dir.
  await fs.writeFile(
    path.join(holds, 'intake-ing_0000000000_000000000000.json'),
    JSON.stringify({ id: 'intake-ing_0000000000_000000000000', bank: 'notes', kind: 'intake', ref: 'ing_0000000000_000000000000', createdAt: new Date().toISOString() }),
  );
  await fs.rm(path.join(holds, `intake-${a.body.id}.json`));
  await fs.rm(path.join(ingest, 'idempotency'), { recursive: true });
  await fs.mkdir(path.join(ingest, 'staging', 'ing_0000000001_000000000000', 'items'), { recursive: true });

  // The archive request comes from a process that has not recovered yet.
  await registry.archive('notes');
  assert.equal((await registry.get('notes'))?.status, 'archiving', 'orphan hold blocks until repaired');

  const restarted = await child('get-bank', 'notes');
  assert.equal(restarted.body.status, 'archiving', 'the real request still holds');
  assert.deepEqual((await registry.listDurableWork('notes')).map((h) => h.ref), [a.body.id]);
  assert.deepEqual(await fs.readdir(path.join(ingest, 'staging')), []);
  assert.equal((await fs.readdir(path.join(ingest, 'idempotency'))).length, 1);

  const drained = await child('drain', 'notes');
  assert.equal(drained.bank.status, 'archived');
});

test('orphan hold alone does not block archive once the bank is recovered', async () => {
  const holds = path.join(root, '.lifecycle', 'holds', 'notes');
  await fs.mkdir(holds, { recursive: true });
  await fs.writeFile(
    path.join(holds, 'intake-ing_0000000000_000000000000.json'),
    JSON.stringify({ id: 'intake-ing_0000000000_000000000000', bank: 'notes', kind: 'intake', ref: 'ing_0000000000_000000000000', createdAt: new Date().toISOString() }),
  );
  await fs.mkdir(path.join(root, '.ingestion', 'notes'), { recursive: true });
  const archive = await registry.archive('notes');
  assert.equal(archive.status, 'archiving');
  const restarted = await child('get-bank', 'notes');
  assert.equal(restarted.body.status, 'archived');
});

// ---- history ------------------------------------------------------------------------

test('history is newest first, paginated, filterable; cursor bound to bank and filter', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await post({ items: [{ type: 'text', text: `t${i}` }] })).body.id);
  const newestFirst = [...ids].reverse();

  const p1 = await send('GET', '/v1/banks/notes/ingestions?limit=2');
  assert.deepEqual(p1.body.ingestions.map((i: any) => i.id), newestFirst.slice(0, 2));
  const p2 = await send('GET', `/v1/banks/notes/ingestions?limit=2&cursor=${p1.body.nextCursor}`);
  assert.deepEqual(p2.body.ingestions.map((i: any) => i.id), newestFirst.slice(2, 4));
  const p3 = await send('GET', `/v1/banks/notes/ingestions?limit=2&cursor=${p2.body.nextCursor}`);
  assert.deepEqual(p3.body.ingestions.map((i: any) => i.id), newestFirst.slice(4));
  assert.equal(p3.body.nextCursor, null);

  assert.equal((await send('GET', '/v1/banks/notes/ingestions?status=queued')).body.ingestions.length, 5);
  assert.equal((await send('GET', '/v1/banks/notes/ingestions?status=failed')).body.ingestions.length, 0);
  assertError(await send('GET', `/v1/banks/notes/ingestions?status=queued&cursor=${p1.body.nextCursor}`), 400, 'invalid_cursor');
  assertError(await send('GET', '/v1/banks/notes/ingestions?status=nope'), 400, 'validation_error');
  assertError(await send('GET', '/v1/banks/notes/ingestions?limit=0'), 400, 'validation_error');
  assertError(await send('GET', '/v1/banks/notes/ingestions?limit=101'), 400, 'validation_error');
});

// ---- worker port --------------------------------------------------------------------

test('worker port: batch claim, fencing, item bytes, reap, partial/failed outcomes', async () => {
  await registry.create({ id: 'other' });
  const r1 = (await post({ items: [{ type: 'text', text: 'one' }, { type: 'url', url: 'https://example.com/x' }] })).body.id;
  await new Promise((r) => setTimeout(r, 5));
  const r2 = (await post({ items: [{ type: 'text', text: 'two' }] })).body.id;
  await post({ items: [{ type: 'text', text: 'elsewhere' }] }, {}, 'other');

  const banks = await store.pendingBanks();
  assert.deepEqual(banks.map((b) => b.bank), ['notes', 'other']);
  assert.deepEqual(await store.pendingCounts('notes'), { queued: 2, running: 0 });

  const claim = await store.claimBatch({ bank: 'notes', workerId: 'w1', leaseMs: 60_000 });
  assert.ok(claim);
  assert.deepEqual(claim.requests.map((r) => r.id), [r1, r2], 'whole bank, oldest first');
  assert.equal(claim.requests[0].attempts, 1);
  assert.equal(await store.claimBatch({ bank: 'notes', workerId: 'w2', leaseMs: 60_000 }), null);
  assert.deepEqual(await store.pendingCounts('notes'), { queued: 0, running: 2 });
  assert.equal((await send('GET', `/v1/banks/notes/ingestions/${r1}`)).body.status, 'running');

  assert.equal((await store.readItem(claim, r1, 0)).toString(), 'one');
  await assert.rejects(store.readItem(claim, r1, 1), /URL/);
  await store.heartbeat(claim, 60_000);

  // Lease expiry: the batch goes back to queued and the old token is fenced out.
  assert.equal(await store.reapExpired(Date.now() + 120_000), 2);
  await assert.rejects(store.heartbeat(claim), IngestionClaimLost);
  await assert.rejects(store.complete(claim, []), IngestionClaimLost);

  const second = await store.claimBatch({ bank: 'notes', workerId: 'w2', leaseMs: 60_000 });
  assert.ok(second);
  assert.equal(second.requests[0].attempts, 2);
  await assert.rejects(store.complete(second, []), /exactly one outcome/);
  await assert.rejects(
    store.complete(second, [
      { requestId: r1, commits: ['not-a-sha'], items: [{ index: 0, status: 'succeeded' }, { index: 1, status: 'succeeded' }] },
      { requestId: r2, items: [{ index: 0, status: 'succeeded' }] },
    ]),
    /hex shas/,
  );
  const done = await store.complete(second, [
    {
      requestId: r1,
      revision: 'deadbeef',
      commits: ['abc1234', 'deadbeef'],
      items: [
        { index: 0, status: 'succeeded' },
        { index: 1, status: 'failed', error: { code: 'fetch_failed', message: 'HTTP 404' } },
      ],
    },
    { requestId: r2, items: [{ index: 0, status: 'failed' }], error: { code: 'librarian_failed', message: 'x' } },
  ]);
  assert.deepEqual(done.map((r) => r.status), ['partial', 'failed']);
  const got = (await send('GET', `/v1/banks/notes/ingestions/${r1}`)).body;
  assert.equal(got.revision, 'deadbeef');
  assert.deepEqual(got.commits, ['abc1234', 'deadbeef']);
  assert.deepEqual((await send('GET', `/v1/banks/notes/ingestions/${r2}`)).body.commits, [], 'no commits sent -> empty');
  assert.deepEqual(got.items[1].error, { code: 'fetch_failed', message: 'HTTP 404' });
  assert.ok(got.finishedAt);
  assert.deepEqual(await store.pendingCounts('notes'), { queued: 0, running: 0 });
  assert.deepEqual(await registry.listDurableWork('notes'), [], 'terminal requests release their holds');
  await assert.rejects(store.complete(second, []), IngestionClaimLost, 'a completed claim cannot complete again');
});

test('MEMORY_BANK_INGESTION_DIR moves the queue; default stays outside bank dirs', async () => {
  const custom = path.join(base, `queue-${rootCounter}`);
  process.env.MEMORY_BANK_INGESTION_DIR = custom;
  try {
    const res = await post({ items: [{ type: 'text', text: 'x' }] });
    assert.equal(res.status, 202);
    await fs.stat(path.join(custom, 'notes', 'requests', res.body.id, 'request.json'));
    await assert.rejects(fs.stat(path.join(root, '.ingestion')));
  } finally {
    delete process.env.MEMORY_BANK_INGESTION_DIR;
  }
});
