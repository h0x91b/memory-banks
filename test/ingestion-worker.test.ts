// Ingestion worker scheduling, exclusion, recovery and results, against an
// in-memory store and a manual clock. Real banks on a temp root (git, files),
// fake ingest/curate steps: no model, no network.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'ingestion-worker-'));
process.env.MEMORY_BANK_ROOT = root;

const { ensureBank, rawDir } = await import('../src/bank.ts');
const { gitCommitAll, gitEnsureRepo } = await import('../src/git.ts');
const { completedRevisions, withBankMutation } = await import('../src/bank-mutation.ts');
const { IngestionWorker } = await import('../src/ingestion-worker/worker.ts');
const { FakeIngestionStore, ManualClock, settle } = await import('./fixtures/fake-ingestion-store.ts');

type Worker = InstanceType<typeof IngestionWorker>;
const MIN = 60_000;
let bankSeq = 0;

async function newBank(prefix = 'bank'): Promise<string> {
  const bank = `${prefix}-${++bankSeq}`;
  const { repoPath } = await ensureBank(bank);
  await gitEnsureRepo(repoPath);
  return bank;
}

function git(bank: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: path.join(root, bank), encoding: 'utf8' }).trim();
}

/** Minimal stand-in for src/ingest.ts: writes the item into fs/_raw/. */
async function fakeIngest(bank: string, item: any) {
  const dir = rawDir(bank);
  await fs.mkdir(dir, { recursive: true });
  let name: string;
  let body: Buffer;
  if (item.kind === 'inline') {
    name = item.filename ?? 'inline.md';
    body = Buffer.from(item.content);
  } else {
    const src = fileURLToPath(item.uri);
    name = path.basename(src);
    body = await fs.readFile(src);
  }
  let dest = path.join(dir, name);
  for (let i = 1; existsSync(dest); i++) dest = path.join(dir, `${i}-${name}`);
  await fs.writeFile(dest, body);
  return { rawPath: dest, sourceLabel: `${item.kind} → _raw/${path.basename(dest)}` };
}

interface CurateCall {
  bank: string;
  runId: string;
  hint?: string;
  ctx: any;
  raw: string[];
  release: () => void;
  fail: (err: Error) => void;
}

/** Curate step that files _raw/ into notes/ and commits; can be held open by the test. */
function makeCurate(opts: { hold?: boolean } = {}) {
  const calls: CurateCall[] = [];
  let active = 0;
  let maxActive = 0;
  const curate = async (bank: string, runId: string, hint: string | undefined, ctx: any) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const raw = readdirSync(rawDir(bank)).sort();
      let release!: () => void;
      let fail!: (err: Error) => void;
      const gate = new Promise<void>((res, rej) => {
        release = res;
        fail = rej;
      });
      calls.push({ bank, runId, hint, ctx, raw, release, fail });
      if (opts.hold) await gate;
      const notes = path.join(root, bank, 'fs', 'notes');
      mkdirSync(notes, { recursive: true });
      for (const f of raw) await fs.rename(path.join(rawDir(bank), f), path.join(notes, f));
      const sha = await gitCommitAll(path.join(root, bank), `curate: filed ${raw.length}`);
      return { commits: sha ? [sha] : [] };
    } finally {
      active--;
    }
  };
  return { curate, calls, maxActive: () => maxActive };
}

function setup(over: Record<string, unknown> = {}) {
  const clock = new ManualClock();
  const store = new FakeIngestionStore(clock.now);
  const c = makeCurate(over.hold ? { hold: true } : {});
  const worker = new IngestionWorker({
    store,
    curate: c.curate,
    ingest: fakeIngest,
    clock,
    leaseMs: 5 * MIN,
    pollMs: 10 * MIN,
    log: () => {},
    ...over,
  } as any);
  return { clock, store, worker, ...c };
}

const text = (index: number, content: string, filename = `t${index}.md`) => ({
  index,
  kind: 'text' as const,
  filename,
  content,
});

async function waitFor(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function drain(worker: Worker) {
  await settle();
  await worker.idle();
}

test('fixed 60s window from the first arrival; later arrivals do not push it', async () => {
  const { clock, store, worker, calls } = setup();
  const bank = await newBank();
  await worker.start();
  store.enqueue(bank, [text(0, 'a')], { id: 'r1' });
  worker.notify(bank);
  await drain(worker);

  await clock.advance(30_000);
  store.enqueue(bank, [text(0, 'b')], { id: 'r2' });
  worker.notify(bank);
  await drain(worker);

  await clock.advance(29_999);
  await drain(worker);
  assert.equal(store.claims.length, 0, 'nothing runs before the window closes');

  await clock.advance(1);
  await drain(worker);
  assert.equal(store.claims.length, 1, 'window closed exactly 60s after r1, despite r2');
  assert.deepEqual(store.claims[0].requests.map((r) => r.id), ['r1', 'r2']);
  assert.equal(calls.length, 1);
  assert.equal(store.requests.get('r1')!.status, 'succeeded');
  assert.equal(store.requests.get('r2')!.status, 'succeeded');
  await worker.stop();
});

test('arrivals during a run wait for the next batch, windowed from their own arrival', async () => {
  const { clock, store, worker, calls } = setup({ hold: true });
  const bank = await newBank();
  await worker.start();
  store.enqueue(bank, [text(0, 'a')], { id: 'a1' });
  worker.notify(bank);
  await drain(worker);
  await clock.advance(MIN);
  await waitFor(() => calls.length === 1, 'first curate');

  await clock.advance(1_000); // t = 61s, batch 1 still running
  store.enqueue(bank, [text(0, 'late')], { id: 'a2' });
  worker.notify(bank);
  await settle();
  calls[0].release();
  await drain(worker);
  assert.deepEqual(store.claims[0].requests.map((r) => r.id), ['a1'], 'batch closed at run start');
  assert.equal(store.requests.get('a2')!.status, 'queued');

  await clock.advance(MIN - 1); // a2 arrived at 61s: its window closes at 121s
  await drain(worker);
  assert.equal(store.claims.length, 1);
  await clock.advance(1);
  await waitFor(() => calls.length === 2, 'second curate');
  calls[1].release();
  await drain(worker);
  assert.deepEqual(store.claims[1].requests.map((r) => r.id), ['a2']);
  assert.equal(store.requests.get('a2')!.status, 'succeeded');
  await worker.stop();
});

test('different banks run in parallel', async () => {
  const { clock, store, worker, calls, maxActive } = setup({ hold: true });
  const b1 = await newBank();
  const b2 = await newBank();
  await worker.start();
  store.enqueue(b1, [text(0, 'one')]);
  store.enqueue(b2, [text(0, 'two')]);
  worker.notify();
  await drain(worker);
  await clock.advance(MIN);
  await waitFor(() => calls.length === 2, 'both banks curating at once');
  assert.equal(maxActive(), 2);
  assert.deepEqual(worker.state().running, [b1, b2].sort());
  calls.forEach((c) => c.release());
  await drain(worker);
  await worker.stop();
});

test('same bank: a held mutation lock (legacy run) delays the claim; the batch closes when it starts', async () => {
  const { clock, store, worker, calls } = setup();
  const bank = await newBank();
  await worker.start();
  store.enqueue(bank, [text(0, 'x')], { id: 'l1' });
  worker.notify(bank);
  await drain(worker);

  let releaseLegacy!: () => void;
  const legacyDone = withBankMutation(bank, () => new Promise<void>((r) => (releaseLegacy = r)));
  await settle();
  await clock.advance(MIN);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.claims.length, 0, 'worker waits for the legacy run');
  store.enqueue(bank, [text(0, 'y')], { id: 'l2' }); // arrives while the worker waits for the lock
  releaseLegacy();
  await legacyDone;
  await drain(worker);
  assert.deepEqual(store.claims[0].requests.map((r) => r.id), ['l1', 'l2']);
  assert.equal(calls.length, 1);
  await worker.stop();
});

test('same bank across processes: the lock file blocks the worker until the other process exits', async () => {
  const { clock, store, worker } = setup();
  const bank = await newBank();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { withBankMutation } = await import(${JSON.stringify(new URL('../src/bank-mutation.ts', import.meta.url).href)});
       await withBankMutation(${JSON.stringify(bank)}, async () => { process.stdout.write('locked\\n'); await new Promise(r => setTimeout(r, 1500)); });`,
    ],
    { env: { ...process.env, MEMORY_BANK_ROOT: root }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((res) => child.stdout!.once('data', () => res()));
  await worker.start();
  store.enqueue(bank, [text(0, 'x')]);
  worker.notify(bank);
  await drain(worker);
  await clock.advance(MIN);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(store.claims.length, 0, 'still waiting for the other process');
  await new Promise((r) => child.once('exit', r));
  await waitFor(() => store.completes === 1, 'batch after the other process released');
  await worker.stop();
});

async function deadPid(): Promise<number> {
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => dead.once('exit', r));
  return dead.pid!;
}

function writeGeneration(bank: string, generation: number, body: object) {
  const dir = path.join(root, '.locks', bank);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${String(generation).padStart(12, '0')}.json`), JSON.stringify(body));
}

test('a lock left by a dead process is superseded by the next generation', async () => {
  const bank = await newBank();
  writeGeneration(bank, 5, { pid: await deadPid(), token: 'stale', acquiredAt: '' });
  assert.equal(await withBankMutation(bank, async () => 'ran'), 'ran');
  const files = readdirSync(path.join(root, '.locks', bank)).filter((n) => n.endsWith('.json'));
  assert.deepEqual(files, ['000000000006.json'], 'stale generation swept, own tombstone kept');
});

test('a live holder in another process is never superseded, whatever is below it', async () => {
  const bank = await newBank();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 800)']);
  writeGeneration(bank, 1, { pid: await deadPid(), token: 'stale', acquiredAt: '' });
  writeGeneration(bank, 3, { pid: sleeper.pid, token: 'live', acquiredAt: '' });
  const t0 = Date.now();
  let entered = 0;
  const run = withBankMutation(bank, async () => {
    entered = Date.now();
  });
  await new Promise((r) => sleeper.once('exit', r));
  await run;
  assert.ok(entered - t0 >= 600, `waited for the live holder (${entered - t0}ms)`);
});

// The previous delete-then-recreate reclaim let two of these children own the
// bank at once (measured: 88 overlaps in 15 rounds of 12 reclaimers); the
// generation lock had none.
test('competing reclaimers of one stale lock: never more than one live owner', async () => {
  const bank = await newBank();
  writeGeneration(bank, 1, { pid: await deadPid(), token: 'stale', acquiredAt: '' });
  const work = mkdtempSync(path.join(tmpdir(), 'reclaim-race-'));
  const go = path.join(work, 'go');
  const inside = path.join(work, 'inside');
  const violations = path.join(work, 'violations');
  const mod = JSON.stringify(new URL('../src/bank-mutation.ts', import.meta.url).href);
  const script = `
    import fs from 'node:fs';
    const { withBankMutation } = await import(${mod});
    while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 1));
    for (let i = 0; i < 2; i++) {
      await withBankMutation(${JSON.stringify(bank)}, async () => {
        try { fs.writeFileSync(${JSON.stringify(inside)}, String(process.pid), { flag: 'wx' }); }
        catch { fs.appendFileSync(${JSON.stringify(violations)}, process.pid + '\\n'); return; }
        await new Promise((r) => setTimeout(r, 20));
        fs.rmSync(${JSON.stringify(inside)});
      });
    }`;
  const children = Array.from({ length: 12 }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, MEMORY_BANK_ROOT: root },
      stdio: ['ignore', 'ignore', 'inherit'],
    }),
  );
  await new Promise((r) => setTimeout(r, 400)); // let every child load and wait at the barrier
  writeFileSync(go, '');
  const codes = await Promise.all(children.map((c) => new Promise((r) => c.once('exit', r))));
  assert.deepEqual(codes, Array(12).fill(0));
  assert.ok(!existsSync(violations), `two owners at once: ${existsSync(violations) ? readFileSync(violations, 'utf8') : ''}`);
  const files = readdirSync(path.join(root, '.locks', bank)).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(root, '.locks', bank, files[0]), 'utf8')).released, true);
});

test('per-item failure keeps the other items and requests; results carry commits and revision', async () => {
  const fetch = async (url: string) =>
    url.endsWith('/ok')
      ? new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } })
      : new Response('nope', { status: 404 });
  const { clock, store, worker, calls } = setup({ fetch });
  const bank = await newBank();
  await worker.start();
  store.enqueue(
    bank,
    [
      text(0, 'kept'),
      { index: 1, kind: 'url', url: 'https://example.test/missing' },
      { index: 2, kind: 'url', url: 'https://example.test/ok' },
      { index: 3, kind: 'url', url: 'file:///etc/passwd' },
    ],
    { id: 'p1', metadata: { hint: 'file under notes', source: 'test-suite' } },
  );
  store.enqueue(bank, [{ index: 0, kind: 'file', filename: 'doc.bin', content: 'BIN' }], { id: 'p2' });
  worker.notify(bank);
  await drain(worker);
  await clock.advance(MIN);
  await drain(worker);

  const p1 = store.requests.get('p1')!;
  assert.equal(p1.status, 'partial');
  assert.deepEqual(
    p1.outcome!.items.map((i) => [i.index, i.status, i.error?.code ?? null]),
    [
      [0, 'succeeded', null],
      [1, 'failed', 'download_failed'],
      [2, 'succeeded', null],
      [3, 'failed', 'invalid_url'],
    ],
  );
  assert.equal(p1.outcome!.items[2].source, 'https://example.test/ok');
  assert.equal(p1.outcome!.items[2].rawPath, '_raw/ok.html');
  assert.equal(store.requests.get('p2')!.status, 'succeeded');

  const head = git(bank, 'rev-parse', 'HEAD');
  assert.equal(p1.outcome!.revision, head);
  assert.equal(p1.outcome!.commits.length, 2, 'ingest + curate');
  const rec = await completedRevisions.get(bank);
  assert.equal(rec!.revision, head);
  assert.equal(rec!.by, 'worker');
  assert.deepEqual(rec!.ingestionIds, ['p1', 'p2']);
  const ingestMsg = git(bank, 'log', '-1', '--format=%B', 'HEAD~1');
  assert.match(ingestMsg, /^ingest: 3 item\(s\)/);
  assert.match(ingestMsg, /Ingestion-Item: p1\/2/);
  // The Librarian step gets this batch's origins and ingest commit.
  assert.equal(calls[0].hint, 'file under notes');
  assert.equal(calls[0].ctx.ingestCommit, git(bank, 'rev-parse', '--short', 'HEAD~1'));
  assert.deepEqual(
    calls[0].ctx.provenance.map((e: any) => [e.rawName, e.source.kind, e.source.url ?? e.source.filename]),
    [
      ['t0.md', 'text', 't0.md'],
      ['ok.html', 'url', 'https://example.test/ok'],
      ['doc.bin', 'file', 'doc.bin'],
    ],
  );
  await worker.stop();
});

test('URL item outcomes redact credentials and signed query values, keep host/path/plain params', async () => {
  const SECRETS = ['hunter2', 'SIGSECRET', 'TOKSECRET', 'p4ss', 'BIGKEY', 'AKIAEXAMPLE'];
  const okUrl = 'https://alice:hunter2@example.test/ok?X-Amz-Signature=SIGSECRET&X-Amz-Credential=AKIAEXAMPLE&page=2';
  const missingUrl = 'https://example.test/missing?token=TOKSECRET&lang=en';
  const credsUrl = 'https://bob:p4ss@example.test/creds.html';
  const bigUrl = 'https://example.test/big.txt?api_key=BIGKEY';
  const fetch = async (url: string) => {
    if (url === okUrl) return new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } });
    if (url === bigUrl) return new Response('x'.repeat(64), { headers: { 'content-type': 'text/plain' } });
    if (url === credsUrl) return globalThis.fetch(url); // real Node fetch: rejects and echoes the full URL
    return new Response('nope', { status: 404 });
  };
  const { clock, store, worker } = setup({ fetch, downloadMaxBytes: 16 });
  const bank = await newBank();
  await worker.start();
  store.enqueue(
    bank,
    [
      { index: 0, kind: 'url', url: okUrl },
      { index: 1, kind: 'url', url: missingUrl },
      { index: 2, kind: 'url', url: credsUrl },
      { index: 3, kind: 'url', url: bigUrl },
    ],
    { id: 'sec' },
  );
  worker.notify(bank);
  await drain(worker);
  await clock.advance(MIN);
  await drain(worker);

  const items = store.requests.get('sec')!.outcome!.items;
  assert.deepEqual(
    items.map((i) => [i.index, i.status, i.error?.code ?? null]),
    [
      [0, 'succeeded', null],
      [1, 'failed', 'download_failed'],
      [2, 'failed', 'download_failed'],
      [3, 'failed', 'download_too_large'],
    ],
  );
  const published = JSON.stringify(items);
  for (const s of SECRETS) assert.ok(!published.includes(s), `outcome leaks ${s}: ${published}`);
  // Source identity stays useful: host, path and non-secret params survive.
  assert.equal(
    items[0].source,
    'https://redacted@example.test/ok?X-Amz-Signature=redacted&X-Amz-Credential=redacted&page=2',
  );
  assert.equal(items[0].rawPath, '_raw/ok.html');
  assert.equal(items[1].source, 'https://example.test/missing?token=redacted&lang=en');
  assert.equal(items[1].error!.message, 'fetch https://example.test/missing?token=redacted&lang=en → HTTP 404');
  assert.equal(items[2].source, 'https://redacted@example.test/creds.html');
  assert.match(items[2].error!.message, /includes credentials: https:\/\/redacted@example\.test\/creds\.html$/);
  assert.match(items[3].error!.message, /^fetch https:\/\/example\.test\/big\.txt\?api_key=redacted: body exceeds 16 bytes$/);
  // The stored descriptor is untouched: a retry still downloads the real URL.
  assert.equal(store.requests.get('sec')!.items[0].url, okUrl);
  await worker.stop();
});

test('curate failure: requests fail, completed revision is not advanced', async () => {
  const clock = new ManualClock();
  const store = new FakeIngestionStore(clock.now);
  const worker = new IngestionWorker({
    store,
    clock,
    ingest: fakeIngest,
    curate: async () => {
      throw new Error('model unavailable');
    },
    log: () => {},
  });
  const bank = await newBank();
  const before = await completedRevisions.resolve(bank);
  await worker.start();
  store.enqueue(bank, [text(0, 'x')], { id: 'cf' });
  worker.notify(bank);
  await drain(worker);
  await clock.advance(MIN);
  await drain(worker);
  const r = store.requests.get('cf')!;
  assert.equal(r.status, 'failed');
  assert.equal(r.outcome!.error!.code, 'curate_failed');
  assert.equal(r.outcome!.revision, null);
  assert.match(git(bank, 'log', '-1', '--format=%s'), /^ingest:/, 'the ingest commit landed');
  assert.deepEqual(await completedRevisions.get(bank), before, 'ingest-only HEAD not promoted');
  await worker.stop();
});

test('restart replay: expired claim is re-queued, already-ingested items are not ingested twice', async () => {
  const { clock, store, worker } = setup();
  const bank = await newBank();
  const req = store.enqueue(bank, [text(0, 'first', 'one.md'), text(1, 'second', 'two.md')], { id: 'rr' });
  // A previous process claimed the batch, ingested item 0, committed, then died.
  const dead = await store.claimBatch({ bank, workerId: 'dead', leaseMs: 5 * MIN });
  await fakeIngest(bank, { kind: 'inline', content: 'first', filename: 'one.md' });
  await gitCommitAll(path.join(root, bank), `ingest: 1 item(s) into fs/_raw/\n\nIngestion-Batch: ${dead!.token}\nIngestion-Item: rr/0`);

  await worker.start();
  await drain(worker);
  assert.equal(req.status, 'running', 'lease not expired yet: not stolen');
  // Lease expires at 5 min; the next poll (10 min) reaps it, and since the
  // request arrived 10 min ago its window is long closed: it runs at once.
  await clock.advance(10 * MIN);
  await drain(worker);
  assert.equal(req.status, 'succeeded');
  assert.equal(req.attempts, 2);
  assert.deepEqual(req.outcome!.items.map((i) => [i.index, !!i.replayed]), [
    [0, true],
    [1, false],
  ]);
  const notes = readdirSync(path.join(root, bank, 'fs', 'notes')).sort();
  assert.deepEqual(notes, ['one.md', 'two.md'], 'no duplicate of item 0');
  await worker.stop();
});

test('attempts exhausted: the request fails without running again', async () => {
  const { clock, store, worker, calls } = setup({ maxAttempts: 3 });
  const bank = await newBank();
  const r = store.enqueue(bank, [text(0, 'x')], { attempts: 3 });
  await worker.start();
  await clock.advance(MIN);
  await drain(worker);
  assert.equal(r.status, 'failed');
  assert.equal(r.outcome!.error!.code, 'max_attempts_exceeded');
  assert.equal(calls.length, 0);
  await worker.stop();
});

test('lost claim: results are not reported, revision not advanced, the batch runs again', async () => {
  const { clock, store, worker, calls } = setup({ hold: true, heartbeatMs: 1_000 });
  const bank = await newBank();
  const before = await completedRevisions.resolve(bank);
  const r = store.enqueue(bank, [text(0, 'x')]);
  await worker.start();
  await clock.advance(MIN);
  await waitFor(() => calls.length === 1, 'curate started');
  store.fenceOut = true;
  await clock.advance(1_000); // heartbeat fails -> claim lost
  calls[0].release();
  await drain(worker);
  assert.equal(store.completes, 0);
  assert.deepEqual(await completedRevisions.get(bank), before);
  store.fenceOut = false;
  await store.reapExpired(Infinity);
  assert.equal(r.status, 'queued');
  await worker.stop();
});

test('archiving bank is drained (holds released); archived bank fails the batch', async () => {
  const statuses = new Map<string, any>();
  const { clock, store, worker } = setup({ bankStatus: async (b: string) => statuses.get(b) ?? 'active' });
  const draining = await newBank();
  const gone = await newBank();
  statuses.set(draining, 'archiving');
  statuses.set(gone, 'archived');
  await worker.start();
  store.enqueue(draining, [text(0, 'x')], { id: 'd1' });
  store.enqueue(gone, [text(0, 'y')], { id: 'g1' });
  worker.notify();
  await drain(worker);
  await clock.advance(MIN);
  await drain(worker);
  assert.equal(store.requests.get('d1')!.status, 'succeeded');
  assert.equal(store.holds(draining), 0);
  assert.equal(store.requests.get('g1')!.status, 'failed');
  assert.equal(store.requests.get('g1')!.outcome!.error!.code, 'bank_archived');
  await worker.stop();
});

test('baseline: first lock records a non-ingest HEAD as bootstrap; a crashed legacy ingest is skipped', async () => {
  const bank = await newBank();
  const good = git(bank, 'rev-parse', 'HEAD');
  writeFileSync(path.join(rawDir(bank), 'half.md'), 'half');
  await gitCommitAll(path.join(root, bank), 'ingest: 1 item(s) into fs/_raw/');
  const rec = await completedRevisions.resolve(bank);
  assert.equal(rec!.by, 'bootstrap');
  assert.equal(rec!.revision, good, 'ingest-only HEAD is not the baseline');

  // A fresh repo whose only commit is an ingest commit has no safe baseline.
  const bare = `bare-${++bankSeq}`;
  mkdirSync(path.join(root, bare, 'fs'), { recursive: true });
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: path.join(root, bare) });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'ingest: x'], {
    cwd: path.join(root, bare),
  });
  assert.equal((await completedRevisions.resolve(bare))!.revision, null);
  assert.equal(await completedRevisions.resolve('no-such-bank'), null);
});
