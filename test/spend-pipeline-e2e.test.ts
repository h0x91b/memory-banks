/**
 * End-to-end spend recording through the real Librarian and retriever
 * pipelines with a scripted (faux) model: no network, no API keys, no real
 * banks, no paid calls. Loaded through Vite's module runner like
 * retriever-telemetry-e2e.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'spend-e2e-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;
const ledgerFile = path.join(bankRoot, '.accounting', 'ledger.jsonl');

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;

const submit = (args: unknown) =>
  fx.fauxAssistantMessage([fx.fauxToolCall('submit_result', args)], { stopReason: 'toolUse' });

function ledgerEvents(): any[] {
  return readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
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
  fx = await runner.import('/test/fixtures/faux-spend-harness.ts');
  flue = await fx.startFlue();
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

test('librarian and retriever runs land in the ledger and in /v1 stats', async () => {
  fx.faux.setResponses([submit({ summary: 'filed one note' })]);
  const lib = await fx.runLibrarian(
    { bank: 'spend', items: [{ kind: 'inline', content: 'hello', filename: 'hello.md' }] },
    'lib-1',
  );
  assert.equal(lib.summary, 'filed one note');

  fx.faux.setResponses([submit({ answer: 'No relevant data found in the memory bank.', references: [] })]);
  const ret = await fx.runRetriever({ bank: 'spend', question: 'anything?' }, 'ret-1');
  assert.equal(ret.answer, 'No relevant data found in the memory bank.');

  const calls = ledgerEvents().filter((e) => e.kind === 'model_call');
  assert.deepEqual(calls.map((e) => [e.agent, e.bank, e.run_id]), [
    ['librarian', 'spend', 'lib-1'],
    ['retriever', 'spend', 'ret-1'],
  ]);
  assert.match(calls[0].id, /^model:librarian-lib-1-[0-9a-f]{8}$/);
  // Ledger tokens are exactly what the pipeline reported in meta.
  assert.equal(calls[0].tokens.total, lib.meta.tokens.total);
  assert.equal(calls[1].tokens.total, ret.meta.tokens.total);
  // The faux model declares no price, so used tokens with $0 must read as missing, not free.
  for (const e of calls) {
    assert.ok(e.tokens.total > 0);
    assert.equal(e.cost_source, 'missing');
    assert.equal(e.cost_usd, null);
  }

  const app = fx.createStatsRouter({ ledger: fx.sharedSpendLedger() });
  const body = await (await app.request('/v1/banks/spend/stats')).json();
  assert.equal(body.periods.today.model.calls, 2);
  assert.equal(body.periods.today.model.calls_missing_cost, 2);
  assert.equal(body.periods.today.model.known_cost_usd, 0);
  assert.deepEqual(Object.keys(body.periods.today.model.by_agent), ['librarian', 'retriever']);
});

test('a run that fails mid-call is still recorded, as missing cost', async () => {
  const before = ledgerEvents().length;
  fx.faux.setResponses([]); // the model has nothing to say: the agent call fails
  await assert.rejects(fx.runRetriever({ bank: 'spend', question: 'fail please' }, 'ret-fail'));
  const added = ledgerEvents().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].run_id, 'ret-fail');
  assert.equal(added[0].tokens, null);
  assert.equal(added[0].cost_source, 'missing');
});
