/**
 * POST /v1/banks/:bank/query through the real route map (.flue/app.ts) with
 * the real completed-revision record (src/bank-mutation.ts), the real
 * ingestion store, the real retriever pipeline and a scripted (faux) model.
 * No network, no API keys, no real banks. Loaded through Vite's module runner.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'query-app-wiring-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
process.env.MEMORY_BANK_INGESTION_WORKER = 'off';
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;
let app: { request(url: string, init?: RequestInit): Promise<Response> };
let mutation: any;

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function liveWrite(bank: string, rel: string, content: string) {
  const abs = path.join(bankRoot, bank, 'fs', rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function gitCommit(bank: string, message: string) {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: path.join(bankRoot, bank),
      encoding: 'utf8',
    }).trim();
  git('add', '-A');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
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
        load(id: string) {
          return id.endsWith('.md') ? `export default ${JSON.stringify(readFileSync(id, 'utf8'))};` : null;
        },
      },
    ],
  });
  runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  fx = await runner.import('/test/fixtures/faux-retriever-harness.ts');
  flue = await fx.startFlue();
  app = (await runner.import('/.flue/app.ts')).default;
  mutation = await runner.import('/src/bank-mutation.ts');
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

test('a query answers from the revision the writer recorded, not from later live changes', async () => {
  assert.equal((await call('POST', '/v1/banks', { id: 'wired' })).status, 201);

  // A Librarian run under the real bank lock records its completed revision.
  const completed = await mutation.withBankMutation('wired', async (m: any) => {
    liveWrite('wired', 'people/ann.md', '# Ann\n\nAnn lives in Lisbon.\n');
    gitCommit('wired', 'curate: Ann');
    return (await m.markCompleted({ by: 'worker', runId: 'batch-1' })).revision;
  });
  // A later run is mid-flight: committed to the live repo, not completed.
  liveWrite('wired', 'people/ann.md', '# Ann\n\nAnn lives in Porto.\n');
  const uncompleted = gitCommit('wired', 'ingest: 1 item(s) into fs/_raw/');
  assert.notEqual(uncompleted, completed);

  let readResult = '';
  fx.faux.setResponses([
    fx.fauxAssistantMessage([fx.fauxToolCall('read', { path: '/people/ann.md' })], { stopReason: 'toolUse' }),
    (context: any) => {
      readResult = context.messages
        .filter((m: any) => m.role === 'toolResult')
        .map((m: any) => m.content.map((c: any) => c.text ?? '').join(''))
        .join('\n');
      return fx.fauxAssistantMessage(
        [
          fx.fauxToolCall('submit_result', {
            answer: 'Ann lives in Lisbon.',
            references: [{ path: '/people/ann.md', why: 'where Ann lives' }],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    },
  ]);

  const res = await call('POST', '/v1/banks/wired/query', { question: 'Where does Ann live?' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(readResult, /Lisbon/);
  assert.doesNotMatch(readResult, /Porto/);
  assert.equal(res.body.revision, completed);
  assert.deepEqual(res.body.references, [
    { path: path.join(bankRoot, 'wired', 'fs', 'people', 'ann.md'), why: 'where Ann lives' },
  ]);
  assert.equal(res.body.processing.revisionSource, 'worker');
  assert.equal(res.body.processing.provenance, 'verified');
  assert.deepEqual(res.body.processing.pendingIngestions, { queued: 0, running: 0 });
  assert.equal(res.body.meta.unexpected_writes, 0);
  assert.deepEqual(readdirSync(path.join(bankRoot, '.query-snapshots', 'wired')), []);

  // HTTP stats attribute the request to the bank.
  const stats = await call('GET', '/v1/banks/wired/stats');
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
});

test('accepted ingestion is pending, not searchable; a bank without a repo has no revision', async () => {
  // Pre-existing bank directory without a git repo: nothing searchable yet.
  mkdirSync(path.join(bankRoot, 'norepo', 'fs'), { recursive: true });
  writeFileSync(path.join(bankRoot, 'norepo', 'fs', '_index.md'), '# norepo\n');
  const accepted = await call('POST', '/v1/banks/norepo/ingestions', { items: [{ type: 'text', text: 'hello' }] });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));

  const res = await call('POST', '/v1/banks/norepo/query', { question: 'hello?' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.answer, 'No relevant data found in the memory bank.');
  assert.equal(res.body.revision, null);
  assert.equal(res.body.processing.searchable, false);
  assert.equal(res.body.processing.reason, 'no_completed_revision');
  assert.deepEqual(res.body.processing.pendingIngestions, { queued: 1, running: 0 });
});

test('errors use the /v1 envelope', async () => {
  const expectError = async (url: string, body: unknown, status: number, code: string) => {
    const res = await call('POST', url, body);
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.equal(res.body.error.code, code);
  };
  await expectError('/v1/banks/Nope_/query', { question: 'q' }, 400, 'invalid_bank_id');
  await expectError('/v1/banks/ghost/query', { question: 'q' }, 404, 'bank_not_found');
  assert.equal((await call('POST', '/v1/banks', { id: 'gone' })).status, 201);
  await expectError('/v1/banks/gone/query', { question: 'q', path: '/etc' }, 400, 'validation_error');
  assert.equal((await call('POST', '/v1/banks/gone/archive')).body.status, 'archived');
  await expectError('/v1/banks/gone/query', { question: 'q' }, 409, 'bank_archived');
});
