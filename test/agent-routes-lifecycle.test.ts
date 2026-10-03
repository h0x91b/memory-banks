// The real route map (.flue/app.ts) with the lifecycle guard: agent runs on an
// archiving/archived bank are refused before touching the bank, admitted runs
// delay archive, and /v1 is mounted. Loaded through Vite's module runner so
// app.ts, the pipelines and the registry share one module graph, as in the
// server. No model calls: every path exercised here returns before the LLM.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'agent-routes-lifecycle-'));
process.env.MEMORY_BANK_ROOT = bankRoot;

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let app: { request(url: string, init?: RequestInit): Promise<Response> };
let runs: any; // src/guarded-runs.ts from the same module graph as app.ts
let banks: any; // src/banks/index.ts from the same module graph

/** sha256 over every path + content under dir, git internals included. */
function snapshot(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      hash.update(path.relative(dir, abs)).update('\0');
      if (statSync(abs).isDirectory()) walk(abs);
      else hash.update(readFileSync(abs)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex');
}

async function post(url: string, body?: unknown) {
  const res = await app.request(url, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function seedBank(id: string) {
  const fsDir = path.join(bankRoot, id, 'fs');
  mkdirSync(path.join(fsDir, 'notes'), { recursive: true });
  writeFileSync(path.join(fsDir, '_index.md'), `# ${id}\n`);
  writeFileSync(path.join(fsDir, 'notes', 'a.md'), 'keep me\n');
}

before(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [
      {
        name: 'markdown-as-text',
        async load(id: string) {
          return id.endsWith('.md') ? `export default ${JSON.stringify(await readFile(id, 'utf8'))};` : null;
        },
      },
    ],
  });
  runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  app = (await runner.import('/.flue/app.ts')).default;
  runs = await runner.import('/src/guarded-runs.ts');
  banks = await runner.import('/src/banks/index.ts');
});

after(async () => {
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

test('archived bank: librarian, curator alias and retriever are refused with 409 and the bank is untouched', async () => {
  seedBank('frozen');
  assert.equal((await post('/v1/banks/frozen/archive')).body.status, 'archived');
  const before = snapshot(path.join(bankRoot, 'frozen'));

  const item = { kind: 'inline', content: 'new material', filename: 'new.md' };
  for (const url of ['/agents/librarian/t1', '/agents/curator/t1']) {
    const res = await post(url, { bank: 'frozen', items: [item] });
    assert.equal(res.status, 409, url);
    assert.equal(res.body.code, 'bank_archived');
    assert.match(res.body.error, /archived/);
  }
  const q = await post('/agents/retriever/t1', { bank: 'frozen', question: 'anything?' });
  assert.equal(q.status, 409);
  assert.equal(q.body.code, 'bank_archived');

  assert.equal(snapshot(path.join(bankRoot, 'frozen')), before, 'no ingest, no scaffold, no commit');

  // Restore gives access back, files still identical.
  assert.equal((await post('/v1/banks/frozen/restore')).body.status, 'active');
  assert.equal(snapshot(path.join(bankRoot, 'frozen')), before);
});

test('archiving bank refuses new agent runs while an admitted run holds it open', async () => {
  seedBank('closing');
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  let admittedRunFinished = false;
  const admitted = banks.runGuarded(runs.bankRegistry, 'closing', { kind: 'curate' }, async () => {
    await gate;
    admittedRunFinished = true;
    return 'done';
  });
  // Let the admitted run take its lease.
  while (!(await hasLease('closing'))) {
    await new Promise((r) => setTimeout(r, 5));
  }

  const archive = await post('/v1/banks/closing/archive');
  assert.equal(archive.status, 202);
  assert.equal(archive.body.status, 'archiving');

  const refused = await post('/agents/librarian/t2', { bank: 'closing' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'bank_archiving');
  const refusedQ = await post('/agents/retriever/t2', { bank: 'closing', question: 'q' });
  assert.equal(refusedQ.body.code, 'bank_archiving');

  finish();
  assert.equal(await admitted, 'done');
  assert.equal(admittedRunFinished, true, 'work admitted before archive ran to completion');
  assert.equal(await runs.bankRegistry.lookup('closing'), 'archived');
});

async function hasLease(bank: string): Promise<boolean> {
  try {
    return readdirSync(path.join(bankRoot, '.lifecycle', 'leases', bank)).some((n) => n.endsWith('.json'));
  } catch {
    return false;
  }
}

test('active banks still run: librarian auto-creates a bank, retriever answers bank-missing, leases are released', async () => {
  const lib = await post('/agents/librarian/t3', { bank: 'fresh' });
  assert.equal(lib.status, 200, JSON.stringify(lib.body));
  assert.equal(lib.body.bank, 'fresh');
  assert.match(lib.body.summary, /nothing to curate/);
  assert.equal((await post('/v1/banks/fresh/archive')).status, 200, 'no lease left behind');

  const missing = await post('/agents/retriever/t3', { bank: 'ghost', question: 'q' });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.meta.reason, 'bank-missing');
  assert.throws(() => statSync(path.join(bankRoot, 'ghost')), 'retriever must not create banks');

  const bad = await post('/agents/librarian/t3', { bank: '../escape' });
  assert.equal(bad.status, 400, 'pipeline validation still answers invalid names');
});

test('/v1 is mounted; unknown /v1 paths get the JSON envelope, other paths stay plain 404', async () => {
  const created = await post('/v1/banks', { id: 'via-app', name: 'Via app' });
  assert.equal(created.status, 201);
  const list = await app.request('/v1/banks?status=all');
  assert.ok(((await list.json()) as any).banks.some((b: any) => b.id === 'via-app'));

  const unknown = await app.request('/v1/nope');
  assert.equal(unknown.status, 404);
  assert.deepEqual(Object.keys(((await unknown.json()) as any).error).sort(), ['code', 'message']);
  const other = await app.request('/nope');
  assert.equal(other.status, 404);
  assert.equal(await other.text(), '404 Not Found');
});
