// The real route map (.flue/app.ts) with stats wired in: the HTTP middleware
// records requests, both stats routes are mounted, they use the shared bank
// registry, and archived banks keep their history. Loaded through Vite's module
// runner like agent-routes-lifecycle.test.ts. No model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'stats-app-wiring-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let app: { request(url: string, init?: RequestInit): Promise<Response> };
let ledger: any;

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
  ledger = (await runner.import('/src/spend-ledger.ts')).sharedSpendLedger();
});

after(async () => {
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

const json = (url: string, init?: RequestInit) => app.request(url, init).then(async (r) => ({ status: r.status, body: await r.json() }));
const postJson = (url: string, body?: unknown) =>
  json(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });

test('stats routes are mounted and empty before anything happened', async () => {
  const res = await json('/v1/stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'all_banks');
  assert.equal(res.body.timezone, 'Asia/Jerusalem');
  assert.equal(res.body.periods.today.http.requests, 0, 'stats requests do not count themselves');
});

test('requests are recorded with route pattern and bank; archived bank keeps its history', async () => {
  assert.equal((await postJson('/v1/banks', { id: 'wired', name: 'Wired' })).status, 201);
  await ledger.recordModelCall({
    executionId: 'librarian-x-1', bank: 'wired', agent: 'librarian', model: 'm',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
  });
  assert.equal((await postJson('/v1/banks/wired/archive')).body.status, 'archived');
  // Agent route: bank comes from the body; archived bank answers 409 before any model call.
  assert.equal((await postJson('/agents/retriever/t1', { bank: 'wired', question: 'q' })).status, 409);
  assert.equal((await json('/v1/nope')).status, 404);

  const http = (await ledger.read()).events.filter((e: any) => e.kind === 'http_request');
  assert.deepEqual(
    http.map((e: any) => [e.method, e.route, e.status, e.bank]),
    [
      ['POST', '/v1/banks', 201, null],
      ['POST', '/v1/banks/:bank/archive', 200, 'wired'],
      ['POST', '/agents/retriever/:id', 409, 'wired'],
      ['GET', 'unmatched', 404, null],
    ],
  );

  const bank = await json('/v1/banks/wired/stats');
  assert.equal(bank.status, 200);
  assert.deepEqual(bank.body.bank, { name: 'wired', status: 'archived' });
  assert.equal(bank.body.periods.today.model.estimated_cost_usd, 0.003);
  assert.equal(bank.body.periods.today.http.requests, 2);
  assert.equal(bank.body.periods.today.http.by_status_class['4xx'], 1);

  const missing = await json('/v1/banks/never-existed/stats');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'bank_not_found');
});
