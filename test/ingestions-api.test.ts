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
import { canonicalJson } from '../src/ingestions/store.ts';

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

// ---- caller hint -------------------------------------------------------------------

test('hint: JSON and multipart hints are trimmed, stored, shown, and claimed with their request', async () => {
  const json = await post({ hint: '  receipts from the Lisbon trip, for taxes \n', items: [{ type: 'text', text: 'r1' }] });
  assert.equal(json.status, 202, JSON.stringify(json.body));
  const form = new FormData();
  form.append('text', 'loose note');
  form.append('hint', 'draft ideas, not decisions');
  const multi = await send('POST', '/v1/banks/notes/ingestions', { body: form });
  assert.equal(multi.status, 202, JSON.stringify(multi.body));
  const none = await post({ hint: '   ', items: [{ type: 'text', text: 'plain' }] });
  const nul = await post({ hint: null, items: [{ type: 'text', text: 'plain2' }] });
  const atMax = await post({ hint: 'é'.repeat(4000), items: [{ type: 'text', text: 'max' }] });
  assert.equal(atMax.status, 202, 'exactly 4000 characters (not bytes) is accepted');

  assert.equal((await send('GET', json.body.status_url)).body.hint, 'receipts from the Lisbon trip, for taxes');
  assert.equal((await send('GET', multi.body.status_url)).body.hint, 'draft ideas, not decisions');
  for (const id of [none.body.id, nul.body.id]) {
    const got = (await send('GET', `/v1/banks/notes/ingestions/${id}`)).body;
    assert.ok(!('hint' in got), 'no hint -> field omitted');
    const stored = JSON.parse(await fs.readFile(path.join(reqDir('notes', id), 'request.json'), 'utf8'));
    assert.ok(!('hint' in stored), 'no hint -> not written to request.json');
  }

  const claim = await store.claimBatch({ bank: 'notes', workerId: 'w', leaseMs: 60_000 });
  assert.deepEqual(
    claim!.requests.map((r) => r.hint ?? null),
    ['receipts from the Lisbon trip, for taxes', 'draft ideas, not decisions', null, null, 'é'.repeat(4000)],
  );
});

test('hint: malformed, oversized and duplicate hints are 400 and store nothing', async () => {
  const items = [{ type: 'text', text: 'x' }];
  for (const hint of [42, true, ['a'], { text: 'a' }, 'x'.repeat(4001), `  ${'x'.repeat(4001)}  `]) {
    const res = await post({ hint, items });
    assertError(res, 400, 'validation_error');
    assert.equal(res.body.error.details.field, 'hint');
  }
  const twice = new FormData();
  twice.append('text', 'x');
  twice.append('hint', 'one');
  twice.append('hint', 'two');
  assertError(await send('POST', '/v1/banks/notes/ingestions', { body: twice }), 400, 'validation_error');
  const asFile = new FormData();
  asFile.append('text', 'x');
  asFile.append('hint', new File(['context'], 'hint.txt', { type: 'text/plain' }));
  assertError(await send('POST', '/v1/banks/notes/ingestions', { body: asFile }), 400, 'validation_error');
  const long = new FormData();
  long.append('text', 'x');
  long.append('hint', 'y'.repeat(4001));
  assertError(await send('POST', '/v1/banks/notes/ingestions', { body: long }), 400, 'validation_error');

  assert.equal((await store.list('notes')).ingestions.length, 0);
  assert.deepEqual(await registry.listDurableWork('notes'), []);
});

test('hint: part of the Idempotency-Key fingerprint; no hint keeps the pre-hint fingerprint', async () => {
  const items = [{ type: 'text', text: 'same bytes' }];
  const first = await post({ hint: 'tax receipts', items }, { 'Idempotency-Key': 'h-1' });
  assert.equal(first.status, 202);
  const sameAfterTrim = await post({ hint: '  tax receipts ', items }, { 'Idempotency-Key': 'h-1' });
  assert.equal(sameAfterTrim.body.id, first.body.id, 'normalized hint replays');
  assert.equal(sameAfterTrim.headers.get('idempotent-replayed'), 'true');
  const otherIntent = await post({ hint: 'medical receipts', items }, { 'Idempotency-Key': 'h-1' });
  assertError(otherIntent, 409, 'idempotency_conflict');
  assert.equal(otherIntent.body.error.details.ingestionId, first.body.id);
  assertError(await post({ items }, { 'Idempotency-Key': 'h-1' }), 409, 'idempotency_conflict');

  const plain = await post({ items }, { 'Idempotency-Key': 'h-2' });
  assert.equal((await post({ hint: ' ', items }, { 'Idempotency-Key': 'h-2' })).body.id, plain.body.id, 'blank = none');
  const stored = JSON.parse(await fs.readFile(path.join(reqDir('notes', plain.body.id), 'request.json'), 'utf8'));
  const preHint = sha(
    canonicalJson({
      metadata: null,
      items: [{ kind: 'text', sha256: sha('same bytes'), filename: null, mediaType: 'text/plain', url: null, metadata: null }],
    }),
  );
  assert.equal(stored.fingerprint, preHint, 'keys stored before hints existed still replay');
});

test('hint: survives a restart and reaches a claim made by another process', async () => {
  const a = await child('post', 'notes', 'from process A', '  prep for Monday  ');
  assert.equal(a.status, 202, JSON.stringify(a.body));
  const replay = await child('post', 'notes', 'from process A', 'prep for Monday');
  assert.equal(replay.body.id, a.body.id, 'replayed after restart');
  assert.equal((await child('post', 'notes', 'from process A', 'other purpose')).status, 409);
  assert.deepEqual(await child('claim-hints', 'notes'), [{ id: a.body.id, hint: 'prep for Monday' }]);
});

// ---- immediate -------------------------------------------------------------------

test('immediate: JSON boolean and one multipart field; stored and shown only when true; claimed with its request', async () => {
  const yes = await post({ immediate: true, items: [{ type: 'text', text: 'now' }] });
  assert.equal(yes.status, 202, JSON.stringify(yes.body));
  assert.equal(yes.body.status, 'queued', 'still asynchronous: 202 queued, nothing processed in POST');
  const no = await post({ immediate: false, items: [{ type: 'text', text: 'later' }] });
  const absent = await post({ items: [{ type: 'text', text: 'default' }] });
  const formYes = new FormData();
  formYes.append('text', 'multipart now');
  formYes.append('immediate', 'true');
  const multiYes = await send('POST', '/v1/banks/notes/ingestions', { body: formYes });
  assert.equal(multiYes.status, 202, JSON.stringify(multiYes.body));
  const formNo = new FormData();
  formNo.append('text', 'multipart later');
  formNo.append('immediate', 'false');
  const multiNo = await send('POST', '/v1/banks/notes/ingestions', { body: formNo });
  assert.equal(multiNo.status, 202, JSON.stringify(multiNo.body));

  for (const r of [yes, multiYes]) assert.equal((await send('GET', r.body.status_url)).body.immediate, true);
  for (const r of [no, absent, multiNo]) {
    const got = (await send('GET', r.body.status_url)).body;
    assert.ok(!('immediate' in got), 'default -> field omitted');
    const stored = JSON.parse(await fs.readFile(path.join(reqDir('notes', r.body.id), 'request.json'), 'utf8'));
    assert.ok(!('immediate' in stored), 'default -> not written to request.json');
  }

  assert.deepEqual(await store.pendingBanks(), [
    { bank: 'notes', firstQueuedAt: (await store.get('notes', yes.body.id))!.createdAt, immediate: true },
  ]);
  const claim = await store.claimBatch({ bank: 'notes', workerId: 'w', leaseMs: 60_000 });
  assert.deepEqual(
    claim!.requests.map((r) => r.immediate ?? false),
    [true, false, false, true, false],
    'one batch takes every queued request, immediate or not',
  );
  assert.deepEqual(await store.pendingBanks(), [], 'nothing queued once claimed');
});

test('immediate: strict parsing, 400 and nothing stored', async () => {
  const items = [{ type: 'text', text: 'x' }];
  for (const immediate of ['true', 1, 0, null, 'yes', ['true'], { on: true }]) {
    const res = await post({ immediate, items });
    assertError(res, 400, 'validation_error');
    assert.equal(res.body.error.details.field, 'immediate');
  }
  for (const value of ['TRUE', '1', 'yes', '', ' true']) {
    const form = new FormData();
    form.append('text', 'x');
    form.append('immediate', value);
    assertError(await send('POST', '/v1/banks/notes/ingestions', { body: form }), 400, 'validation_error');
  }
  const twice = new FormData();
  twice.append('text', 'x');
  twice.append('immediate', 'true');
  twice.append('immediate', 'true');
  assertError(await send('POST', '/v1/banks/notes/ingestions', { body: twice }), 400, 'validation_error');
  const asFile = new FormData();
  asFile.append('text', 'x');
  asFile.append('immediate', new File(['true'], 'flag.txt', { type: 'text/plain' }));
  assertError(await send('POST', '/v1/banks/notes/ingestions', { body: asFile }), 400, 'validation_error');

  assert.equal((await store.list('notes')).ingestions.length, 0);
  assert.deepEqual(await registry.listDurableWork('notes'), []);
});

test('immediate: part of the Idempotency-Key fingerprint; false keeps the pre-immediate fingerprint', async () => {
  const items = [{ type: 'text', text: 'same bytes' }];
  const first = await post({ immediate: true, items }, { 'Idempotency-Key': 'i-1' });
  assert.equal(first.status, 202);
  const again = await post({ immediate: true, items }, { 'Idempotency-Key': 'i-1' });
  assert.equal(again.body.id, first.body.id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  const otherIntent = await post({ items }, { 'Idempotency-Key': 'i-1' });
  assertError(otherIntent, 409, 'idempotency_conflict');
  assertError(await post({ immediate: false, items }, { 'Idempotency-Key': 'i-1' }), 409, 'idempotency_conflict');

  const plain = await post({ items }, { 'Idempotency-Key': 'i-2' });
  assert.equal((await post({ immediate: false, items }, { 'Idempotency-Key': 'i-2' })).body.id, plain.body.id, 'false = absent');
  assertError(await post({ immediate: true, items }, { 'Idempotency-Key': 'i-2' }), 409, 'idempotency_conflict');
  const stored = JSON.parse(await fs.readFile(path.join(reqDir('notes', plain.body.id), 'request.json'), 'utf8'));
  const preImmediate = sha(
    canonicalJson({
      metadata: null,
      items: [{ kind: 'text', sha256: sha('same bytes'), filename: null, mediaType: 'text/plain', url: null, metadata: null }],
    }),
  );
  assert.equal(stored.fingerprint, preImmediate, 'keys stored before immediate existed still replay');
});

test('immediate: a replayed terminal request does not make the bank immediate', async () => {
  const items = [{ type: 'text', text: 'urgent' }];
  const first = await post({ immediate: true, items }, { 'Idempotency-Key': 'i-done' });
  const claim = await store.claimBatch({ bank: 'notes', workerId: 'w', leaseMs: 60_000 });
  await store.complete(
    claim!,
    claim!.requests.map((r) => ({ requestId: r.id, items: r.items.map((i) => ({ index: i.index, status: 'succeeded' as const })) })),
  );
  const later = await post({ items: [{ type: 'text', text: 'unrelated' }] });
  const replay = await post({ immediate: true, items }, { 'Idempotency-Key': 'i-done' });
  assert.equal(replay.body.id, first.body.id);
  assert.equal(replay.body.status, 'succeeded');
  const pending = await store.pendingBanks();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].immediate, undefined, 'only the unrelated, non-immediate request is queued');
  assert.equal(pending[0].firstQueuedAt, (await store.get('notes', later.body.id))!.createdAt);
});

test('immediate: survives a restart, replays across processes, and holds archive like any queued request', async () => {
  const a = await child('post-immediate', 'notes', 'from process A');
  assert.equal(a.status, 202, JSON.stringify(a.body));
  assert.equal((await child('post-immediate', 'notes', 'from process A')).body.id, a.body.id, 'replayed after restart');
  const pending = await child('pending', 'notes');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].immediate, true, 'a fresh process still sees the immediate intent');

  assert.equal((await send('POST', '/v1/banks/notes/archive')).body.status, 'archiving', 'durable hold keeps archive waiting');
  assertError(await post({ immediate: true, items: [{ type: 'text', text: 'new' }] }), 409, 'bank_archiving');
  const drained = await child('drain', 'notes');
  assert.equal(drained.drained, 1);
  assert.equal(drained.bank.status, 'archived');
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

test('public records redact URL secrets; stored request, worker descriptor and idempotency keep the real URL', async () => {
  const signed = 'https://bucket.example.com/doc.pdf?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=SIGVAL&page=2';
  const shown = 'https://bucket.example.com/doc.pdf?X-Amz-Credential=redacted&X-Amz-Signature=redacted&page=2';
  const long = `https://example.com/${'p'.repeat(1500)}?q=1`; // > redactUri's 1000-char clamp
  const body = { items: [{ type: 'url', url: signed }, { type: 'url', url: long }] };
  const leaks = (v: unknown) => ['AKIAEXAMPLE', 'SIGVAL'].filter((s) => JSON.stringify(v).includes(s));

  const res = await post(body, { 'Idempotency-Key': 'signed-1' });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual(leaks(res.body), []);
  const id = res.body.id;

  // Status and history: same field shape, secrets redacted, harmless URL byte-identical.
  const got = (await send('GET', `/v1/banks/notes/ingestions/${id}`)).body;
  assert.equal(got.items[0].url, shown);
  assert.equal(got.items[1].url, long);
  assert.deepEqual(leaks(got), []);
  const listed = (await send('GET', '/v1/banks/notes/ingestions')).body;
  assert.equal(listed.ingestions[0].items[0].url, shown);
  assert.deepEqual(leaks(listed), []);

  // Idempotency still compares the real payload: same URL replays, another signature conflicts.
  const again = await post(body, { 'Idempotency-Key': 'signed-1' });
  assert.equal(again.status, 202);
  assert.equal(again.body.id, id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(leaks(again.body), []);
  const other = await post({ items: [{ type: 'url', url: signed.replace('SIGVAL', 'SIGOTHER') }, body.items[1]] }, {
    'Idempotency-Key': 'signed-1',
  });
  assertError(other, 409, 'idempotency_conflict');

  // Internal descriptors are untouched: the stored request and the worker claim carry the real URL.
  const stored = JSON.parse(await fs.readFile(path.join(reqDir('notes', id), 'request.json'), 'utf8'));
  assert.equal(stored.items[0].url, signed);
  const claim = await store.claimBatch({ bank: 'notes', workerId: 'w', leaseMs: 60_000 });
  assert.equal(claim!.requests[0].items[0].url, signed);

  // An item error that quotes the URL (e.g. stored before outcome redaction) is shown redacted too.
  const done = await store.complete(claim!, [
    {
      requestId: id,
      items: [
        { index: 0, status: 'failed', error: { code: 'download_failed', message: `fetch ${signed} → HTTP 403` } },
        { index: 1, status: 'succeeded' },
      ],
    },
  ]);
  assert.deepEqual(leaks(done), []);
  const final = (await send('GET', `/v1/banks/notes/ingestions/${id}`)).body;
  assert.deepEqual(final.items[0].error, { code: 'download_failed', message: `fetch ${shown} → HTTP 403` });
  assert.deepEqual(leaks(final), []);
  assert.equal(JSON.parse(await fs.readFile(path.join(reqDir('notes', id), 'request.json'), 'utf8')).items[0].url, signed);
});

test('public records redact userinfo on URLs that reached the store without the router check', async () => {
  const url = 'https://alice:hunter2@example.com/private.md';
  const { record } = await store.accept({ bank: 'notes', items: [{ kind: 'url', url }] });
  assert.equal(record.items[0].url, 'https://redacted@example.com/private.md');
  const got = (await send('GET', `/v1/banks/notes/ingestions/${record.id}`)).body;
  assert.equal(got.items[0].url, 'https://redacted@example.com/private.md');
  assert.ok(!JSON.stringify(got).includes('hunter2'));
  const stored = JSON.parse(await fs.readFile(path.join(reqDir('notes', record.id), 'request.json'), 'utf8'));
  assert.equal(stored.items[0].url, url);
});
