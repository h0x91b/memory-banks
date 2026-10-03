/**
 * Source provenance through a whole Librarian run with a scripted (faux)
 * model: the ingest commit body records where each raw file came from, and the
 * Librarian's briefing carries the same facts — both for items the run ingests
 * itself and for items a caller (the ingestion worker) ingested beforehand.
 * No network beyond loopback, no API keys, no real banks.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'librarian-provenance-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;
let origin: http.Server;
let base: string;

before(async () => {
  origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/markdown' }).end('# Remote page\n');
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

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
  fx = await runner.import('/test/fixtures/faux-spend-harness.ts');
  flue = await fx.startFlue();
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  rmSync(bankRoot, { recursive: true, force: true });
});

const fsOf = (bank: string) => path.join(bankRoot, bank, 'fs');
const git = (bank: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: path.join(bankRoot, bank), stdio: 'pipe' }).toString();

function seedBank(bank: string): void {
  mkdirSync(fsOf(bank), { recursive: true });
  writeFileSync(path.join(fsOf(bank), '_index.md'), `# ${bank}\n\nProvenance test bank.\n\n## Folders\n\n`);
  git(bank, 'init', '-q', '--initial-branch=main');
  git(bank, 'add', '-A');
  git(bank, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');
}

const toolUse = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });
const bashStep = (command: string) => toolUse([fx.fauxToolCall('bash', { command })]);
const submit = (summary: string) => toolUse([fx.fauxToolCall('submit_result', { summary })]);

/** First step: capture the briefing, then park everything in _unsorted/. */
function captureBriefing(sink: { briefing?: string }) {
  return (context: any) => {
    const first = (context.messages as any[]).find((m) => m.role === 'user');
    sink.briefing = typeof first.content === 'string' ? first.content : first.content.map((c: any) => c.text ?? '').join('');
    return bashStep('mkdir -p /_unsorted && mv /_raw/* /_unsorted/');
  };
}

test('items ingested by the run: commit body and briefing carry the same source facts', async () => {
  const bank = 'prov-legacy';
  seedBank(bank);
  const seen: { briefing?: string } = {};
  fx.faux.setResponses([captureBriefing(seen), submit('Parked both items')]);

  const url = `${base}/guides/setup`;
  const report = await fx.runLibrarian(
    { bank, items: [{ kind: 'inline', filename: 'Notes 1.md', content: 'hello\n' }, { kind: 'path', uri: url }] },
    'prov-legacy',
  );

  // Response shape unchanged: ingest + curate commits.
  assert.equal(report.commits.length, 2);
  const ingestSha = report.commits[0];
  const body = git(bank, 'log', '-1', '--format=%B', ingestSha).trim();
  const inlineRec = '{"type":"inline","name":"Notes 1.md","contentType":"unknown"}';
  const urlRec = `{"type":"url","uri":"${url}","contentType":"text/markdown"}`;
  assert.equal(
    body,
    ['ingest: 2 item(s) into fs/_raw/', '', 'Sources:', `- fs/_raw/Notes_1.md <- ${inlineRec}`, `- fs/_raw/setup.md <- ${urlRec}`].join('\n'),
  );

  assert.match(seen.briefing!, /## Source provenance \(host-recorded\)/);
  assert.ok(seen.briefing!.includes(`ingest commit \`${ingestSha}\``), 'names the ingest commit');
  assert.ok(seen.briefing!.includes(`- \`_raw/Notes_1.md\` <- ${inlineRec}`));
  assert.ok(seen.briefing!.includes(`- \`_raw/setup.md\` <- ${urlRec}`));
  // Provenance is context only: nothing about it lands in bank files.
  for (const f of git(bank, 'ls-files', 'fs').trim().split('\n')) {
    const text = readFileSync(path.join(bankRoot, bank, f), 'utf8');
    assert.ok(!text.includes('"type":"inline"') && !text.includes('Source provenance'), f);
  }
});

test('items a worker ingested before the run reach the briefing from the run context', async () => {
  const bank = 'prov-worker';
  seedBank(bank);
  // The worker already placed and committed these; the Librarian runs with no items.
  mkdirSync(path.join(fsOf(bank), '_raw'), { recursive: true });
  writeFileSync(path.join(fsOf(bank), '_raw', 'Scan_01.png'), 'png-bytes');
  writeFileSync(path.join(fsOf(bank), '_raw', 'guide'), 'guide');
  writeFileSync(path.join(fsOf(bank), '_raw', 'old.md'), 'left from an earlier run');
  git(bank, 'add', '-A');
  git(bank, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'ingest: 3 item(s) into fs/_raw/');
  const workerSha = git(bank, 'rev-parse', '--short', 'HEAD').trim();

  const seen: { briefing?: string } = {};
  fx.faux.setResponses([captureBriefing(seen), submit('Parked worker items')]);
  await fx.runLibrarian({ bank, items: [] }, 'prov-worker', {
    ingestCommit: workerSha,
    provenance: [
      { rawName: 'Scan_01.png', source: { type: 'upload', name: 'Scan 01.png', contentType: 'image/png' } },
      // Worker fallback: the original descriptor itself, never the spool path.
      { rawName: 'guide', source: { kind: 'url', url: 'https://user:pw@example.com/a/guide', mediaType: null } },
      { rawName: 'gone.md', source: { type: 'inline', name: 'gone.md' } },
      { rawName: 'odd.bin', source: { path: '/tmp/mb-ingest-x/odd.bin' } },
    ],
  });

  const b = seen.briefing!;
  assert.ok(b.includes(`ingest commit \`${workerSha}\``));
  assert.ok(b.includes('- `_raw/Scan_01.png` <- {"type":"upload","name":"Scan 01.png","contentType":"image/png"}'));
  assert.ok(b.includes('- `_raw/guide` <- {"type":"url","uri":"https://redacted@example.com/a/guide","contentType":"unknown"}'));
  // Files not in _raw/ are not claimed; files without known source are simply not listed.
  assert.ok(!b.includes('gone.md'));
  assert.ok(!b.includes('odd.bin') && !b.includes('/tmp/mb-ingest'));
  assert.ok(!/`_raw\/old\.md` <-/.test(b));
  assert.match(b, /not listed here have unknown source/);
});

test('no provenance section when nothing with a known source is in _raw/', async () => {
  const bank = 'prov-none';
  seedBank(bank);
  mkdirSync(path.join(fsOf(bank), '_raw'), { recursive: true });
  writeFileSync(path.join(fsOf(bank), '_raw', 'old.md'), 'old');
  git(bank, 'add', '-A');
  git(bank, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'leftover');

  const seen: { briefing?: string } = {};
  fx.faux.setResponses([captureBriefing(seen), submit('Parked leftover')]);
  const report = await fx.runLibrarian({ bank, items: [] }, 'prov-none');
  assert.equal(report.commits.length, 1, 'curate commit only, no ingest commit');
  assert.ok(!seen.briefing!.includes('Source provenance'));
});
