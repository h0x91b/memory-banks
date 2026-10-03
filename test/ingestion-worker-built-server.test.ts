/**
 * The built server (vite build -> dist/server.mjs) takes an ingestion from
 * 202 queued to a terminal status on its own: intake API, durable store,
 * worker started by the server, real ingest + Librarian pipeline. The model is
 * a scripted stub preloaded into the server process (no network, no paid
 * call); MEMORY_BANK_INGESTION_WINDOW_MS shortens the batching window.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const work = mkdtempSync(path.join(tmpdir(), 'ingestion-built-'));
// Inside the repo so the bundle resolves its external packages from node_modules.
const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.ingestion-built-'));
const bankRoot = path.join(work, 'banks');
let child: ChildProcess;
let base: string;
let output = '';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer().listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', path.join(ROOT, 'test/fixtures/openrouter-stub.mjs'), path.join(outDir, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MEMORY_BANK_ROOT: bankRoot,
      MEMORY_BANK_ACCOUNTING_DIR: path.join(work, 'accounting'),
      MEMORY_BANK_INGESTION_WINDOW_MS: '300',
      OPENROUTER_API_KEY: 'stub-key-not-real',
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
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
  rmSync(work, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

test('202 queued -> succeeded with commits and the completed revision, then a clean SIGTERM', async () => {
  assert.equal((await call('POST', '/v1/banks', { id: 'built' })).status, 201);
  const accepted = await call('POST', '/v1/banks/built/ingestions', {
    metadata: { hint: 'file it' },
    items: [{ type: 'text', text: 'remember the milk', filename: 'milk.md' }],
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.body.status, 'queued');

  let record: any;
  for (let i = 0; i < 300; i++) {
    record = (await call('GET', accepted.body.status_url)).body;
    if (!['queued', 'running'].includes(record.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(record.status, 'succeeded', `${JSON.stringify(record)}\n${output}`);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(bankRoot, 'built'), encoding: 'utf8' }).trim();
  assert.equal(record.revision, head);
  assert.equal(record.commits.length, 2, 'ingest + curate');
  assert.deepEqual(readdirSync(path.join(bankRoot, 'built', 'fs', 'notes')).sort(), ['milk.md', 'milk.md.manifest.json']);

  child.kill('SIGTERM');
  const code = await new Promise((r) => child.once('exit', (c) => r(c)));
  assert.equal(code, 143, output);
});
