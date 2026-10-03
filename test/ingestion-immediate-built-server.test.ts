/**
 * `immediate: true` through the built server (vite build -> dist/server.mjs):
 * real HTTP intake, durable store, the worker started by the server, real
 * ingest + Librarian on a scripted OpenRouter stub (no network, no paid call).
 * The batching window is set to 10 minutes, so anything that finishes within
 * the test did so because it skipped the window.
 *
 * 1. Restart: a server with the worker off accepts an immediate request and
 *    stops; the next server runs it at startup without waiting a window.
 * 2. A plain request stays queued; an immediate one arriving later flushes
 *    both in one batch, and the admission log says so.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const work = mkdtempSync(path.join(tmpdir(), 'ingestion-immediate-built-'));
// Inside the repo so the bundle resolves its external packages from node_modules.
const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.ingestion-immediate-built-'));
const bankRoot = path.join(work, 'banks');
const TEN_MIN = String(10 * 60_000);

interface Server {
  child: ChildProcess;
  base: string;
  output: () => string;
}
let current: Server | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer().listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['--import', path.join(ROOT, 'test/fixtures/openrouter-stub.mjs'), path.join(outDir, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MEMORY_BANK_ROOT: bankRoot,
      MEMORY_BANK_ACCOUNTING_DIR: path.join(work, 'accounting'),
      MEMORY_BANK_INGESTION_WINDOW_MS: TEN_MIN,
      OPENROUTER_API_KEY: 'stub-key-not-real',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/v1/banks`);
      break;
    } catch {
      if (i > 200) throw new Error(`server did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  current = { child, base, output: () => output };
  return current;
}

async function stopServer(s: Server): Promise<void> {
  if (s.child.exitCode !== null) return;
  const exited = new Promise((r) => s.child.once('exit', r));
  s.child.kill('SIGTERM');
  await exited;
}

async function call(s: Server, method: string, url: string, body?: unknown) {
  const res = await fetch(`${s.base}${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function waitTerminal(s: Server, statusUrl: string, ms = 20_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const record = (await call(s, 'GET', statusUrl)).body;
    if (!['queued', 'running'].includes(record.status)) return record;
    if (Date.now() - t0 > ms) throw new Error(`still ${record.status} after ${ms}ms\n${s.output()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
});

after(async () => {
  if (current && current.child.exitCode === null) {
    current.child.kill('SIGKILL');
    await new Promise((r) => current!.child.once('exit', r));
  }
  rmSync(work, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

test('restart: an immediate request accepted before a restart runs at startup, not after the 10 min window', async () => {
  const off = await startServer({ MEMORY_BANK_INGESTION_WORKER: 'off' });
  assert.equal((await call(off, 'POST', '/v1/banks', { id: 'restart' })).status, 201);
  const accepted = await call(off, 'POST', '/v1/banks/restart/ingestions', {
    immediate: true,
    items: [{ type: 'text', text: 'carried over', filename: 'carried.md' }],
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.body.status, 'queued');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call(off, 'GET', accepted.body.status_url)).body.status, 'queued', 'worker off: nothing ran');
  await stopServer(off);

  const on = await startServer({});
  const record = await waitTerminal(on, accepted.body.status_url);
  assert.equal(record.status, 'succeeded', JSON.stringify(record));
  assert.equal(record.immediate, true);
  assert.equal(record.commits.length, 2, 'ingest + curate');
  await stopServer(on);
});

test('a plain request waits for the window; an immediate arrival flushes both in one batch', async () => {
  const s = await startServer({});
  assert.equal((await call(s, 'POST', '/v1/banks', { id: 'flush' })).status, 201);
  const plain = await call(s, 'POST', '/v1/banks/flush/ingestions', {
    items: [{ type: 'text', text: 'not urgent', filename: 'plain.md' }],
  });
  assert.equal(plain.status, 202);
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal((await call(s, 'GET', plain.body.status_url)).body.status, 'queued', 'default window still applies');

  const urgent = await call(s, 'POST', '/v1/banks/flush/ingestions', {
    immediate: true,
    items: [{ type: 'text', text: 'urgent', filename: 'urgent.md' }],
  });
  assert.equal(urgent.status, 202);
  assert.equal(urgent.body.status, 'queued', 'POST stays asynchronous');

  const u = await waitTerminal(s, urgent.body.status_url);
  const p = await waitTerminal(s, plain.body.status_url);
  assert.equal(u.status, 'succeeded', JSON.stringify(u));
  assert.equal(p.status, 'succeeded', JSON.stringify(p));
  assert.deepEqual(p.commits, u.commits, 'one batch: the same ingest + curate commits');
  assert.equal(u.revision, p.revision);
  assert.ok(!('immediate' in p), 'the plain request keeps its own default');

  const line = s.output().split('\n').find((l) => l.includes(urgent.body.id) && l.includes('accepted'));
  assert.ok(line, `admission line for ${urgent.body.id}\n${s.output()}`);
  // Which one depends on whether the worker claimed it before the timing lookup; both are true.
  assert.match(line!, /immediate requested(?: for this bank's queue)?, batch window skipped, (?:eligible to start now|already picked up by the worker)/);
  await stopServer(s);
});
