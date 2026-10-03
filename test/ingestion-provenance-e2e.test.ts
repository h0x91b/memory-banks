/**
 * Source provenance through the real ingestion worker wiring
 * (src/ingestion-worker/runtime.ts): each queued item's ORIGINAL source — not
 * the worker's temporary spool copy — lands in the batch ingest commit body and
 * in the Librarian briefing. Scripted (faux) model, in-memory store fake,
 * injected fetch: no network, no paid calls, no real banks.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import { FakeIngestionStore, ManualClock, settle } from './fixtures/fake-ingestion-store.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'ingestion-provenance-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;

const git = (bank: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: path.join(bankRoot, bank), encoding: 'utf8' }).trim();
const step = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });

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

test('worker batch: original sources reach the ingest commit and the Librarian briefing', async () => {
  await fx.bankRegistry.create({ id: 'prov' });
  const clock = new ManualClock();
  const store = new FakeIngestionStore(clock.now);
  const fetch = async (url: string) =>
    url.endsWith('/gone')
      ? new Response('missing', { status: 404 })
      : new Response('# Page\n', { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  const worker = fx.createIngestionWorker(store, fx.bankRegistry, { clock, fetch, log: () => {} });

  const url = 'https://reader:s3cret@example.test/docs/page?sig=abc&lang=en';
  store.enqueue(
    'prov',
    [
      { index: 0, kind: 'text', filename: 'thought.md', content: 'remember the milk' },
      { index: 1, kind: 'file', filename: 'Scan 01.png', mediaType: 'image/png', content: 'png-bytes' },
      { index: 2, kind: 'url', url },
      { index: 3, kind: 'url', url: 'https://example.test/gone' },
    ],
    { id: 'prov-1' },
  );
  await worker.start();

  const seen: { briefing?: string } = {};
  fx.faux.setResponses([
    (context: any) => {
      const first = (context.messages as any[]).find((m) => m.role === 'user');
      seen.briefing = typeof first.content === 'string' ? first.content : first.content.map((c: any) => c.text ?? '').join('');
      return step([fx.fauxToolCall('bash', { command: 'mkdir -p /_unsorted && mv /_raw/* /_unsorted/' })]);
    },
    step([fx.fauxToolCall('submit_result', { summary: 'parked 3 items' })]),
  ]);
  await clock.advance(60_000);
  await settle();
  await worker.idle();
  await worker.stop();

  const r = store.requests.get('prov-1')!;
  assert.equal(r.status, 'partial', 'the failed download does not drop the other items');
  assert.equal(r.outcome!.commits.length, 2);
  const ingestSha = r.outcome!.commits[0];

  const textRec = '{"type":"inline","name":"thought.md","contentType":"unknown"}';
  const uploadRec = '{"type":"upload","name":"Scan 01.png","contentType":"image/png"}';
  const urlRec =
    '{"type":"url","uri":"https://redacted@example.test/docs/page?sig=redacted&lang=en","contentType":"text/markdown; charset=utf-8"}';

  const body = git('prov', 'log', '-1', '--format=%B', ingestSha);
  assert.equal(
    body,
    [
      'ingest: 3 item(s) into fs/_raw/',
      '',
      'Sources:',
      `- fs/_raw/thought.md <- ${textRec}`,
      `- fs/_raw/Scan_01.png <- ${uploadRec}`,
      `- fs/_raw/page.md <- ${urlRec}`,
      '',
      `Ingestion-Batch: ${r.outcome!.batchId}`,
      'Ingestion-Item: prov-1/0',
      'Ingestion-Item: prov-1/1',
      'Ingestion-Item: prov-1/2',
    ].join('\n'),
  );
  // The replay guard still parses as Git trailers.
  assert.equal(
    git('prov', 'log', '-1', '--format=%(trailers:key=Ingestion-Item,valueonly)', ingestSha),
    'prov-1/0\nprov-1/1\nprov-1/2',
  );
  // Neither the spool directory nor the credentials are recorded anywhere.
  assert.ok(!body.includes('mb-ingest') && !body.includes(tmpdir()) && !body.includes('s3cret'), body);

  const b = seen.briefing!;
  assert.match(b, /## Source provenance \(host-recorded\)/);
  assert.ok(b.includes(`ingest commit \`${ingestSha}\``));
  for (const [name, rec] of [['thought.md', textRec], ['Scan_01.png', uploadRec], ['page.md', urlRec]]) {
    assert.ok(b.includes(`- \`_raw/${name}\` <- ${rec}`), name);
  }
  assert.ok(!b.includes('/gone') && !b.includes('s3cret'));
});
