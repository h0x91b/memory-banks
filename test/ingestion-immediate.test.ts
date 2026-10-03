// `immediate: true` scheduling in the ingestion worker: the bank's next batch
// skips the window but still runs one at a time per bank. In-memory store and
// a manual clock; real banks on a temp root (git, files), fake ingest/curate:
// no model, no network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'ingestion-immediate-'));
process.env.MEMORY_BANK_ROOT = root;

const { ensureBank, rawDir } = await import('../src/bank.ts');
const { gitCommitAll, gitEnsureRepo } = await import('../src/git.ts');
const { IngestionWorker } = await import('../src/ingestion-worker/worker.ts');
const { formatAdmission } = await import('../src/ingestions/admission-log.ts');
const { FakeIngestionStore, ManualClock, settle } = await import('./fixtures/fake-ingestion-store.ts');

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

type Worker = InstanceType<typeof IngestionWorker>;
const MIN = 60_000;
let bankSeq = 0;

async function newBank(): Promise<string> {
  const bank = `imm-${++bankSeq}`;
  await gitEnsureRepo((await ensureBank(bank)).repoPath);
  return bank;
}

async function fakeIngest(bank: string, item: any) {
  const dir = rawDir(bank);
  await fs.mkdir(dir, { recursive: true });
  let dest = path.join(dir, item.filename ?? 'inline.md');
  for (let i = 1; existsSync(dest); i++) dest = path.join(dir, `${i}-${item.filename ?? 'inline.md'}`);
  await fs.writeFile(dest, item.content);
  return { rawPath: dest };
}

function setup() {
  const clock = new ManualClock();
  current = clock;
  const store = new FakeIngestionStore(clock.now);
  const gates: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let curates = 0;
  const curate = async (bank: string) => {
    active++;
    maxActive = Math.max(maxActive, active);
    curates++;
    try {
      await new Promise<void>((r) => gates.push(r));
      const raw = readdirSync(rawDir(bank));
      const notes = path.join(root, bank, 'fs', 'notes');
      mkdirSync(notes, { recursive: true });
      for (const f of raw) await fs.rename(path.join(rawDir(bank), f), path.join(notes, f));
      const sha = await gitCommitAll(path.join(root, bank), `curate: filed ${raw.length}`);
      return { commits: sha ? [sha] : [] };
    } finally {
      active--;
    }
  };
  const worker = new IngestionWorker({
    store,
    curate,
    ingest: fakeIngest,
    clock,
    leaseMs: 5 * MIN,
    pollMs: 10 * MIN,
    log: () => {},
  } as any);
  return {
    clock,
    store,
    worker,
    gates,
    curates: () => curates,
    maxActive: () => maxActive,
    /** Release every held curate and let the worker settle. */
    async releaseAll() {
      while (gates.length) gates.shift()!();
      await drain(worker);
    },
  };
}

const text = (content: string) => ({ index: 0, kind: 'text' as const, filename: `${content}.md`, content });

async function drain(worker: Worker) {
  await settle();
  await worker.idle();
}

/** The manual clock fires even 0ms timers only through advance(): advance(0) runs what is due without moving time. */
let current: InstanceType<typeof ManualClock> | null = null;

async function waitFor(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  const frozen = current?.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await current?.advance(0);
    await new Promise((r) => setTimeout(r, 10));
  }
  if (frozen !== undefined) assert.equal(current!.now(), frozen, 'waitFor never moves the clock');
}

test('default (no immediate): the 60s window is unchanged', async () => {
  const s = setup();
  const bank = await newBank();
  await s.worker.start();
  s.store.enqueue(bank, [text('plain')], { id: 'p1' });
  s.worker.notify(bank);
  await drain(s.worker);
  await s.clock.advance(MIN - 1);
  await drain(s.worker);
  assert.equal(s.store.claims.length, 0, 'nothing before 60s');
  await s.clock.advance(1);
  await waitFor(() => s.curates() === 1, 'batch at 60s');
  await s.releaseAll();
  assert.equal(s.store.requests.get('p1')!.status, 'succeeded');
  await s.worker.stop();
});

test('immediate alone: claimed at once, no clock advance', async () => {
  const s = setup();
  const bank = await newBank();
  await s.worker.start();
  s.store.enqueue(bank, [text('now')], { id: 'i1', immediate: true });
  s.worker.notify(bank);
  await waitFor(() => s.curates() === 1, 'immediate batch');
  assert.equal(s.store.claims.length, 1);
  assert.deepEqual(s.store.claims[0].requests.map((r) => r.id), ['i1']);
  assert.equal(s.store.claims[0].requests[0].immediate, true);
  await s.releaseAll();
  assert.equal(s.store.requests.get('i1')!.status, 'succeeded');
  await s.worker.stop();
});

test('immediate with pending work: cuts the open window short and takes the older queued items too', async () => {
  const s = setup();
  const bank = await newBank();
  await s.worker.start();
  s.store.enqueue(bank, [text('old')], { id: 'q1' });
  s.worker.notify(bank);
  await drain(s.worker);
  await s.clock.advance(20_000);
  assert.deepEqual(s.worker.state().waiting, [bank], 'window armed for 60s');

  s.store.enqueue(bank, [text('urgent')], { id: 'q2', immediate: true });
  s.worker.notify(bank);
  await waitFor(() => s.curates() === 1, 'immediate batch');
  assert.deepEqual(s.store.claims[0].requests.map((r) => r.id), ['q1', 'q2'], 'one batch with everything queued');
  await s.releaseAll();

  // The superseded 60s timer must not launch a second, empty batch at t=60s.
  await s.clock.advance(MIN);
  await drain(s.worker);
  assert.equal(s.store.claims.length, 1);
  assert.equal(s.curates(), 1);
  await s.worker.stop();
});

test('immediate while the bank is busy: waits for the running batch, then starts right after; never two at once', async () => {
  const s = setup();
  const bank = await newBank();
  await s.worker.start();
  s.store.enqueue(bank, [text('first')], { id: 'r1' });
  s.worker.notify(bank);
  await drain(s.worker);
  await s.clock.advance(MIN);
  await waitFor(() => s.curates() === 1, 'first batch running');

  s.store.enqueue(bank, [text('second')], { id: 'r2', immediate: true });
  s.worker.notify(bank);
  await settle();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.store.claims.length, 1, 'no second claim while the first batch runs');
  assert.equal(s.store.requests.get('r2')!.status, 'queued');
  const timing = await s.worker.queueTiming(bank);
  assert.equal(timing.immediate, true);
  assert.equal(timing.batchRunning, true);
  assert.equal(timing.eligibleAt, new Date(s.clock.now()).toISOString());
  assert.equal(
    formatAdmission({ bank, id: 'ing_r2', status: 'queued', itemCount: 1, replayed: false }, timing, s.clock.now()),
    "ing_r2 accepted (1 item), status queued; immediate requested for this bank's queue, batch window skipped, " +
      'eligible to start now; a Librarian batch is running for this bank, the next one waits for it',
  );

  s.gates.shift()!(); // first batch finishes and releases the bank lock
  await waitFor(() => s.curates() === 2, 'immediate batch right after, without advancing the clock');
  assert.deepEqual(s.store.claims[1].requests.map((r) => r.id), ['r2']);
  await s.releaseAll();
  assert.equal(s.maxActive(), 1, 'one Librarian per bank');
  assert.equal(s.store.requests.get('r1')!.status, 'succeeded');
  assert.equal(s.store.requests.get('r2')!.status, 'succeeded');
  await s.worker.stop();
});

test('restart: a queued immediate request runs at startup, not after a fresh window', async () => {
  const s = setup();
  const bank = await newBank();
  // Accepted by a previous process that died before its batch started.
  s.store.enqueue(bank, [text('survivor')], { id: 'x1', immediate: true });
  await s.worker.start();
  await waitFor(() => s.curates() === 1, 'batch right after start');
  await s.releaseAll();
  assert.equal(s.store.requests.get('x1')!.status, 'succeeded');
  await s.worker.stop();
});

test('restart: an interrupted immediate batch is reaped and rerun without waiting a window', async () => {
  const s = setup();
  const bank = await newBank();
  const r = s.store.enqueue(bank, [text('crashed')], { id: 'x2', immediate: true });
  // A dead process had claimed it; the lease ran out.
  r.status = 'running';
  r.attempts = 1;
  r.token = 'dead';
  r.leaseUntil = s.clock.now() - 1;
  await s.worker.start();
  await waitFor(() => s.curates() === 1, 'rerun after reap');
  await s.releaseAll();
  assert.equal(s.store.requests.get('x2')!.status, 'succeeded');
  assert.equal(s.store.requests.get('x2')!.attempts, 2);
  await s.worker.stop();
});

test('replay of a finished immediate request does not flush unrelated queued work', async () => {
  const s = setup();
  const bank = await newBank();
  await s.worker.start();
  s.store.enqueue(bank, [text('done')], { id: 'f1', immediate: true });
  s.worker.notify(bank);
  await waitFor(() => s.curates() === 1, 'immediate batch');
  await s.releaseAll();
  assert.equal(s.store.requests.get('f1')!.status, 'succeeded');

  await s.clock.advance(1_000);
  s.store.enqueue(bank, [text('later')], { id: 'f2' });
  s.worker.notify(bank);
  await drain(s.worker);
  // The idempotent replay of f1 answers 202 and notifies the worker again.
  s.worker.notify(bank);
  await drain(s.worker);
  assert.equal(s.store.claims.length, 1, 'f2 waits for its own window');
  const timing = await s.worker.queueTiming(bank);
  assert.equal(timing.immediate, false);
  assert.match(
    formatAdmission({ bank, id: 'ing_f1', status: 'succeeded', itemCount: 1, replayed: true }, timing, s.clock.now()),
    /^ing_f1 idempotent replay \(no new work\), status succeeded$/,
  );

  await s.clock.advance(MIN - 1);
  await drain(s.worker);
  assert.equal(s.store.claims.length, 1);
  await s.clock.advance(1);
  await waitFor(() => s.curates() === 2, 'f2 at its own window close');
  await s.releaseAll();
  await s.worker.stop();
});

test('admission log: an immediate request already claimed before the timing lookup says so', () => {
  const none = { windowMs: MIN, firstQueuedAt: null, eligibleAt: null, immediate: false, batchRunning: true };
  const e = { bank: 'b', id: 'ing_i', status: 'queued' as const, itemCount: 2, replayed: false };
  assert.equal(
    formatAdmission({ ...e, immediate: true }, none, 0),
    'ing_i accepted (2 items), status queued; immediate requested, batch window skipped, already picked up by the worker',
  );
  assert.equal(formatAdmission(e, none, 0), 'ing_i accepted (2 items), status queued', 'plain request unchanged');
  assert.equal(
    formatAdmission({ ...e, immediate: true, status: 'succeeded', replayed: true }, none, 0),
    'ing_i idempotent replay (no new work), status succeeded',
    'a finished replay promises nothing',
  );
});

test('immediate on one bank does not touch another bank\'s window', async () => {
  const s = setup();
  const slow = await newBank();
  const fast = await newBank();
  await s.worker.start();
  s.store.enqueue(slow, [text('slow')], { id: 'b1' });
  s.store.enqueue(fast, [text('fast')], { id: 'b2', immediate: true });
  s.worker.notify();
  await waitFor(() => s.curates() === 1, 'fast bank batch');
  assert.equal(s.store.claims[0].bank, fast);
  assert.deepEqual(s.worker.state().waiting, [slow]);
  await s.releaseAll();
  await s.clock.advance(MIN);
  await waitFor(() => s.curates() === 2, 'slow bank at 60s');
  await s.releaseAll();
  await s.worker.stop();
});
