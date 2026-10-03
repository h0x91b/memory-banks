// The console line logged when an ingestion is accepted (202): new request vs
// idempotent replay, the configured batching window measured from the bank's
// oldest queued request, the "a batch is running" caveat, and that no payload,
// URL, file name, metadata or Idempotency-Key reaches the log. Throwaway
// MEMORY_BANK_ROOT; no models, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hono } from 'hono';

const root = mkdtempSync(path.join(tmpdir(), 'ingestion-admission-log-'));
process.env.MEMORY_BANK_ROOT = root;
delete process.env.MEMORY_BANK_INGESTION_DIR;

const { BankRegistry } = await import('../src/banks/index.ts');
const { IngestionStore, createIngestionsRouter, createAdmissionLogger, formatAdmission } = await import(
  '../src/ingestions/index.ts'
);
const { ensureBank } = await import('../src/bank.ts');
const { gitEnsureRepo } = await import('../src/git.ts');
const { IngestionWorker } = await import('../src/ingestion-worker/worker.ts');
const { FakeIngestionStore, ManualClock, settle } = await import('./fixtures/fake-ingestion-store.ts');

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-03T10:00:00Z');

test('router reports each 202 after it is durable: new request, then replay of the same id', async () => {
  const registry = new BankRegistry();
  const store = new IngestionStore(registry);
  await registry.create({ id: 'admit' });
  const events: any[] = [];
  const durable: boolean[] = [];
  const app = new Hono();
  app.route(
    '/v1',
    createIngestionsRouter(store, registry, {
      onAccepted: async (e) => {
        durable.push((await store.get(e.bank, e.id))?.status === 'queued');
        events.push(e);
      },
    }),
  );
  const post = (body: unknown, key?: string) =>
    app.request('/v1/banks/admit/ingestions', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    });

  const body = { items: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
  const first = await post(body, 'k-1');
  const replay = await post(body, 'k-1');
  const invalid = await post({ items: [] });
  await settle();

  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(invalid.status, 400);
  const id = ((await first.json()) as any).id;
  assert.deepEqual(events, [
    { bank: 'admit', id, status: 'queued', itemCount: 2, replayed: false },
    { bank: 'admit', id, status: 'queued', itemCount: 2, replayed: true },
  ]);
  assert.deepEqual(durable, [true, true], 'the stored record exists when the hook runs');
});

test('a failing hook never changes the 202', async () => {
  const registry = new BankRegistry();
  const store = new IngestionStore(registry);
  await registry.create({ id: 'hookfail' });
  const app = new Hono();
  app.route('/v1', createIngestionsRouter(store, registry, { onAccepted: () => Promise.reject(new Error('boom')) }));
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const res = await app.request('/v1/banks/hookfail/ingestions', {
      method: 'POST',
      body: JSON.stringify({ items: [{ type: 'text', text: 'x' }] }),
      headers: { 'content-type': 'application/json' },
    });
    await settle();
    assert.equal(res.status, 202);
    assert.equal(errors.length, 1);
  } finally {
    console.error = origError;
  }
});

test('worker queueTiming: configured window from the oldest queued arrival, later arrivals do not move it', async () => {
  const clock = new ManualClock(T0);
  const store = new FakeIngestionStore(clock.now);
  const worker = new IngestionWorker({
    store,
    clock,
    windowMs: 90_000,
    pollMs: 3_600_000,
    ingest: async () => ({}) as any,
    curate: async () => ({ commits: [] }),
    log: () => {},
  });
  assert.deepEqual(await worker.queueTiming('empty'), {
    windowMs: 90_000,
    firstQueuedAt: null,
    eligibleAt: null,
    batchRunning: false,
  });
  store.enqueue('b', [{ index: 0, kind: 'text' } as any]);
  await clock.advance(30_000);
  store.enqueue('b', [{ index: 0, kind: 'text' } as any]);
  const t = await worker.queueTiming('b');
  assert.equal(t.firstQueuedAt, '2026-10-03T10:00:00.000Z');
  assert.equal(t.eligibleAt, '2026-10-03T10:01:30.000Z');
  assert.equal(
    formatAdmission({ bank: 'b', id: 'ing_x', status: 'queued', itemCount: 1, replayed: false }, t, clock.now()),
    'ing_x accepted (1 item), status queued; 90s batch window from oldest queued request at 10:00:00Z, earliest start 10:01:30Z (in 60s)',
  );
});

test('worker queueTiming reports a running batch so the log does not promise the window close', async () => {
  const bank = 'busy-bank';
  await gitEnsureRepo((await ensureBank(bank)).repoPath);
  const clock = new ManualClock(T0);
  const store = new FakeIngestionStore(clock.now);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let curating = false;
  const worker = new IngestionWorker({
    store,
    clock,
    windowMs: 60_000,
    pollMs: 3_600_000,
    ingest: async () => {
      curating = true;
      await gate;
      throw new Error('released');
    },
    curate: async () => ({ commits: [] }),
    log: () => {},
  });
  await worker.start();
  store.enqueue(bank, [{ index: 0, kind: 'text', filename: 'a.md', content: 'a' }]);
  worker.notify(bank);
  await settle();
  await clock.advance(60_000);
  for (let i = 0; i < 200 && !curating; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(curating, 'first batch claimed and held mid-run');
  assert.deepEqual(worker.state().running, [bank]);

  store.enqueue(bank, [{ index: 0, kind: 'text', filename: 'b.md', content: 'b' }]);
  const t = await worker.queueTiming(bank);
  assert.equal(t.batchRunning, true);
  assert.equal(t.eligibleAt, '2026-10-03T10:02:00.000Z');
  const line = formatAdmission({ bank, id: 'ing_y', status: 'queued', itemCount: 1, replayed: false }, t, clock.now());
  assert.match(line, /earliest start 10:02:00Z \(in 60s\); a Librarian batch is running for this bank, the next one waits for it$/);
  release();
  await worker.stop();
});

test('formatAdmission: replay, finished replay, overdue window, worker off', () => {
  const timing = { windowMs: 60_000, firstQueuedAt: '2026-10-03T10:00:00.000Z', eligibleAt: '2026-10-03T10:01:00.000Z', batchRunning: false };
  const replay = { bank: 'b', id: 'ing_r', status: 'queued' as const, itemCount: 3, replayed: true };
  assert.equal(
    formatAdmission(replay, timing, T0 + 10_000),
    'ing_r idempotent replay (no new work), status queued; 60s batch window from oldest queued request at 10:00:00Z, earliest start 10:01:00Z (in 50s)',
  );
  assert.equal(formatAdmission({ ...replay, status: 'succeeded' }, timing, T0), 'ing_r idempotent replay (no new work), status succeeded');
  assert.match(formatAdmission({ ...replay, replayed: false }, timing, T0 + 61_000), /, eligible to start now$/);
  assert.match(formatAdmission({ ...replay, replayed: false }, null, T0), /ingestion worker is off in this process/);
});

test('the logged line carries no payload, URL, file name, metadata or Idempotency-Key', async () => {
  const registry = new BankRegistry();
  const store = new IngestionStore(registry);
  await registry.create({ id: 'secret-bank' });
  const lines: string[] = [];
  const clock = new ManualClock(T0);
  const worker = new IngestionWorker({
    store,
    clock,
    pollMs: 3_600_000,
    ingest: async () => ({}) as any,
    curate: async () => ({ commits: [] }),
    log: () => {},
  });
  const logger = createAdmissionLogger((bank) => worker.queueTiming(bank), {
    log: (bank, message) => lines.push(`[${bank}] ${message}`),
  });
  const done: Promise<void>[] = [];
  const app = new Hono();
  app.route('/v1', createIngestionsRouter(store, registry, { onAccepted: (e) => void done.push(logger(e)) }));
  const secrets = [
    'TOP-SECRET-DOCUMENT-BODY',
    'sig=SIGNATURE-VALUE',
    'X-Amz-Credential',
    'private-report.md',
    'metadata-secret-value',
    'idem-SECRET-KEY',
  ];
  const res = await app.request('/v1/banks/secret-bank/ingestions', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        { type: 'text', text: 'TOP-SECRET-DOCUMENT-BODY', filename: 'private-report.md' },
        { type: 'url', url: 'https://example.com/f.pdf?X-Amz-Credential=abc&sig=SIGNATURE-VALUE' },
      ],
      metadata: { note: 'metadata-secret-value' },
    }),
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'idem-SECRET-KEY' },
  });
  assert.equal(res.status, 202);
  await settle();
  await Promise.all(done);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[secret-bank\] ing_\w+ accepted \(2 items\), status queued; 60s batch window from oldest queued request at /);
  for (const s of secrets) assert.ok(!lines[0].includes(s), `log must not contain ${s}: ${lines[0]}`);
});
