/**
 * The query service with the REAL retriever pipeline (src/query/retrieve.ts ->
 * runRetrieverAt) and a scripted (faux) model: the agent's tools read the
 * completed-revision snapshot while a fake Librarian rewrites the live bank,
 * the model is only ever shown the real bank path, references come back as
 * real bank paths, writes into the snapshot fail, and the run lands in the
 * spend ledger. No network, no API keys, no real banks. Loaded through Vite's
 * module runner like the other pipeline e2e tests.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const BANK = 'snapshotted';
const bankRoot = mkdtempSync(path.join(tmpdir(), 'query-retriever-e2e-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;
const repoPath = path.join(bankRoot, BANK);
const liveFs = path.join(repoPath, 'fs');

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();

function write(rel: string, content: string) {
  mkdirSync(path.dirname(path.join(liveFs, rel)), { recursive: true });
  writeFileSync(path.join(liveFs, rel), content);
}

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;
let completed: string;

before(async () => {
  write('_index.md', '# snapshotted\n\n- people/ — who is who\n');
  write('people/ann.md', '# Ann\n\nAnn lives in Lisbon.\n');
  write('people/bob.md', '# Bob\n\nBob is Ann\'s neighbour.\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'curate: seed');
  completed = git('rev-parse', 'HEAD');

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
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

test('real retriever answers from the completed snapshot while the live bank changes', async () => {
  const { queryBank, SNAPSHOTS_DIR } = await runner.import('/src/query/index.ts');
  const { retrieveFromSnapshot } = await runner.import('/src/query/retrieve.ts');
  const { BankRegistry } = await runner.import('/src/banks/index.ts');

  const seen: { briefing?: string; toolResults?: string[] } = {};
  const toolUse = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });
  fx.faux.setResponses([
    () => {
      // A Librarian run lands mid-query: Ann moved, a new person appears.
      write('people/ann.md', '# Ann\n\nAnn lives in Porto.\n');
      write('people/cid.md', '# Cid\n\nNew.\n');
      git('add', '-A');
      git('commit', '-qm', 'curate: Ann moved');
      return toolUse([fx.fauxToolCall('read', { path: '/people/ann.md' })]);
    },
    toolUse([fx.fauxToolCall('bash', { command: 'ls /people; echo hacked > /people/ann.md; rm /people/bob.md' })]),
    toolUse([fx.fauxToolCall('grep', { pattern: 'Ann', path: '/people' })]),
    (context: any) => {
      const messages = context.messages as any[];
      const firstUser = messages.find((m) => m.role === 'user');
      seen.briefing =
        typeof firstUser.content === 'string' ? firstUser.content : firstUser.content.map((c: any) => c.text ?? '').join('');
      seen.toolResults = messages
        .filter((m) => m.role === 'toolResult')
        .map((m) => `${m.toolName}:${m.content.map((c: any) => c.text ?? '').join('')}`);
      return toolUse([
        fx.fauxToolCall('submit_result', {
          answer: 'Ann lives in Lisbon.',
          references: [
            { path: `${liveFs}/people/ann.md`, why: 'where Ann lives' },
            { path: '/people/bob.md', why: 'neighbour' },
          ],
        }),
      ]);
    },
  ]);

  const result = await queryBank(
    {
      guard: new BankRegistry(),
      revisions: { resolve: async () => ({ bank: BANK, revision: completed, completedAt: 'c', by: 'worker', runId: 'r' }) },
      retrieve: retrieveFromSnapshot,
    },
    BANK,
    { question: 'Where does Ann live?' },
  );

  // The agent read the completed revision, not the live rewrite.
  const reads = seen.toolResults!.join('\n');
  assert.match(reads, /Ann lives in Lisbon/);
  assert.doesNotMatch(reads, /Porto|cid\.md/);
  // The model was shown the real bank path only.
  assert.ok(seen.briefing!.includes(liveFs), 'briefing must name the real bank path');
  assert.ok(!seen.briefing!.includes(SNAPSHOTS_DIR), 'snapshot path leaked into the briefing');

  assert.equal(result.revision, completed);
  assert.equal(result.answer, 'Ann lives in Lisbon.');
  assert.deepEqual(
    result.references.map((r: any) => r.path),
    [`${liveFs}/people/ann.md`, `${liveFs}/people/bob.md`],
  );
  assert.ok(!JSON.stringify(result).includes(SNAPSHOTS_DIR));
  assert.equal(result.meta.unexpected_writes, 0, 'the bash write/rm must have failed on the read-only snapshot');
  assert.ok(result.meta.model, 'retriever meta kept');
  assert.ok(result.meta.telemetry, 'telemetry kept');
  assert.equal(result.meta.bash_calls, 1);

  // Live bank holds exactly the Librarian's commit; nothing of ours.
  assert.equal(readFileSync(path.join(liveFs, 'people', 'ann.md'), 'utf8'), '# Ann\n\nAnn lives in Porto.\n');
  assert.ok(existsSync(path.join(liveFs, 'people', 'bob.md')));
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(readdirSync(path.join(bankRoot, SNAPSHOTS_DIR, BANK)), []);

  // Accounting kept: the run is in the spend ledger under this bank.
  const ledger = readFileSync(path.join(bankRoot, '.accounting', 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(ledger.some((e) => e.bank === BANK && e.agent === 'retriever'), JSON.stringify(ledger.slice(-2)));
});
