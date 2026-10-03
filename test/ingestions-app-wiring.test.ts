// The real route map (.flue/app.ts) with ingestion mounted: 202 intake through
// the full middleware stack, stats keep recording the route pattern and bank,
// and the recovery middleware repairs an orphan hold before archive settles.
// Loaded through Vite's module runner like stats-app-wiring.test.ts. No models.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'ingest-app-wiring-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;
delete process.env.MEMORY_BANK_INGESTION_DIR;

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
          return id.endsWith('.md') ? `export default ${JSON.stringify(await fs.readFile(id, 'utf8'))};` : null;
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

const call = (url: string, init?: RequestInit) =>
  app.request(url, init).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const postJson = (url: string, body?: unknown) =>
  call(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });

test('ingestion routes are mounted, recorded by stats, and archive waits for accepted work', async () => {
  assert.equal((await postJson('/v1/banks', { id: 'wired' })).status, 201);
  const accepted = await postJson('/v1/banks/wired/ingestions', { items: [{ type: 'text', text: 'hello' }] });
  assert.equal(accepted.status, 202);
  assert.equal((await call(accepted.body.status_url)).body.status, 'queued');
  assert.equal((await call('/v1/banks/wired/ingestions')).body.ingestions.length, 1);
  assert.equal((await postJson('/v1/banks/wired/archive')).body.status, 'archiving');

  const http = (await ledger.read()).events.filter((e: any) => e.kind === 'http_request');
  assert.deepEqual(
    http.map((e: any) => [e.method, e.route, e.status, e.bank]),
    [
      ['POST', '/v1/banks', 201, null],
      ['POST', '/v1/banks/:bank/ingestions', 202, 'wired'],
      ['GET', '/v1/banks/:bank/ingestions/:id', 200, 'wired'],
      ['GET', '/v1/banks/:bank/ingestions', 200, 'wired'],
      ['POST', '/v1/banks/:bank/archive', 202, 'wired'],
    ],
  );
});

test('an orphan hold left by a crash is repaired before archive decides', async () => {
  assert.equal((await postJson('/v1/banks', { id: 'crashed' })).status, 201);
  const holds = path.join(bankRoot, '.lifecycle', 'holds', 'crashed');
  await fs.mkdir(holds, { recursive: true });
  const ref = 'ing_0000000000_000000000000';
  await fs.writeFile(
    path.join(holds, `intake-${ref}.json`),
    JSON.stringify({ id: `intake-${ref}`, bank: 'crashed', kind: 'intake', ref, createdAt: new Date().toISOString() }),
  );
  await fs.mkdir(path.join(bankRoot, '.ingestion', 'crashed'), { recursive: true });
  // First touch of this bank in this process: the middleware recovers it, so archive completes.
  assert.equal((await postJson('/v1/banks/crashed/archive')).body.status, 'archived');
});
