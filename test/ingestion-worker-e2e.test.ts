/**
 * Queued ingestion -> terminal through the real wiring: src/ingestion-worker/
 * runtime.ts with the real ingestOne and Librarian pipeline on a scripted
 * (faux) model, against the in-memory store fake. No network, no paid calls,
 * no real banks. The legacy route shares the bank lock and revision record.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import { FakeIngestionStore, ManualClock, settle } from './fixtures/fake-ingestion-store.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'ingestion-e2e-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;

const submit = (args: unknown) =>
  fx.fauxAssistantMessage([fx.fauxToolCall('submit_result', args)], { stopReason: 'toolUse' });
const git = (bank: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: path.join(bankRoot, bank), encoding: 'utf8' }).trim();

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
        load(id: string) {
          return id.endsWith('.md') ? `export default ${JSON.stringify(readFileSync(id, 'utf8'))};` : null;
        },
      },
    ],
  });
  runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  fx = await runner.import('/test/fixtures/faux-ingestion-harness.ts');
  flue = await fx.startFlue();
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

test('queued text + url items reach a terminal status through the real ingest and Librarian', async () => {
  await fx.bankRegistry.create({ id: 'inbox' });
  const clock = new ManualClock();
  const store = new FakeIngestionStore(clock.now);
  const fetch = async (url: string) =>
    url.endsWith('/gone')
      ? new Response('missing', { status: 404 })
      : new Response('# Page\nbody', { headers: { 'content-type': 'text/markdown' } });
  const worker = fx.createIngestionWorker(store, fx.bankRegistry, { clock, fetch, log: () => {} });
  store.enqueue(
    'inbox',
    [
      { index: 0, kind: 'text', filename: 'thought.md', content: 'remember the milk' },
      { index: 1, kind: 'url', url: 'https://example.test/page' },
      { index: 2, kind: 'url', url: 'https://example.test/gone' },
    ],
    { id: 'e2e-1', metadata: { hint: 'shopping' } },
  );
  await worker.start();

  // The Librarian moves both raw files into notes/ and submits.
  fx.faux.setResponses([
    fx.fauxAssistantMessage([fx.fauxToolCall('bash', { command: 'mkdir -p notes && mv _raw/* notes/' })], {
      stopReason: 'toolUse',
    }),
    submit({ summary: 'filed 2 notes' }),
  ]);
  await clock.advance(60_000);
  await settle();
  await worker.idle();

  const r = store.requests.get('e2e-1')!;
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.outcome!.items.map((i: any) => [i.index, i.status, i.error?.code ?? null]), [
    [0, 'succeeded', null],
    [1, 'succeeded', null],
    [2, 'failed', 'download_failed'],
  ]);
  assert.deepEqual(readdirSync(path.join(bankRoot, 'inbox', 'fs', 'notes')).sort(), ['page.md', 'thought.md']);
  assert.equal(readdirSync(path.join(bankRoot, 'inbox', 'fs', '_raw')).length, 0);
  const head = git('inbox', 'rev-parse', 'HEAD');
  assert.equal(r.outcome!.revision, head);
  assert.match(git('inbox', 'log', '-1', '--format=%s'), /^curate: filed 2 notes/);
  assert.equal(r.outcome!.commits.length, 2);
  const rec = await fx.completedRevisions.get('inbox');
  assert.deepEqual([rec.revision, rec.by, rec.ingestionIds], [head, 'worker', ['e2e-1']]);
  await worker.stop();

  // A legacy direct run takes the same lock and advances the same record.
  fx.faux.setResponses([submit({ summary: 'nothing new' })]);
  await fx.runLibrarianGuarded({ bank: 'inbox', items: [{ kind: 'inline', content: 'x', filename: 'x.md' }] }, 'legacy-1');
  const after = await fx.completedRevisions.get('inbox');
  assert.equal(after.by, 'legacy');
  assert.equal(after.revision, git('inbox', 'rev-parse', 'HEAD'));
  assert.ok(!existsSync(path.join(bankRoot, '.locks', 'inbox.lock')), 'lock released');
});
