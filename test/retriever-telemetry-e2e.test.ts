/**
 * End-to-end retriever run against a synthetic bank with a scripted (faux)
 * model — no network, no API keys, no real banks. The pipeline is loaded
 * through Vite's module runner, as scripts/run-cli.mjs does, so `.js`
 * relative imports and `.md` role imports resolve exactly as in the server.
 *
 * Checks: telemetry counts and read order match the scripted tool calls;
 * existing meta fields (bash_calls, unexpected_writes) are intact; the bank is
 * byte-identical afterwards; and the tool results the model sees, plus the
 * final structured result, are identical with and without the telemetry
 * subscriber attached.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const BANK = 'synthetic';
const bankRoot = mkdtempSync(path.join(tmpdir(), 'retriever-telemetry-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
const repoPath = path.join(bankRoot, BANK);
const fsPath = path.join(repoPath, 'fs');

const FILES: Record<string, string> = {
  '_index.md': '# synthetic\n\n- people/ — who is who\n- notes/ — misc notes\n',
  'people/ann.md': '# Ann\n\nAnn lives in Lisbon and plays the cello.\n',
  'people/bob.md': '# Bob\n\nBob works with Ann on the garden project.\n',
  'notes/garden.md': '# Garden\n\nTomatoes planted in April.\n',
};

function writeBank() {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(fsPath, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');
}

/** sha256 over every file path + content under the bank repo, excluding .git internals. */
function snapshot(dir = repoPath): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue;
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else hash.update(path.relative(dir, abs)).update('\0').update(readFileSync(abs)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex');
}

const ANSWER = 'Ann lives in Lisbon.';

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let faux: any;
/** The harness module (faux provider, Flue bootstrap, pipeline), loaded through the runner. */
let fx: any;

/** Scripted model turns; the last step records what the model saw. */
function script(seen: { briefing?: string; toolResults?: string[] }) {
  const toolUse = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });
  return [
    toolUse([fx.fauxToolCall('read', { path: '/_index.md' })]),
    // Two calls in one turn: telemetry orders them by execution start.
    // The built-in `glob` tool is left out on purpose: it runs
    // `find ... 2>/dev/null`, and just-bash's ReadWriteFs turns that redirect
    // into a real `fs/dev/null` file inside the bank, which would mask the
    // "bank unchanged" check below. Its counting is covered by the unit test.
    toolUse([
      fx.fauxToolCall('grep', { pattern: 'Lisbon', path: '/people' }),
      fx.fauxToolCall('read', { path: '/notes/garden.md' }),
    ]),
    toolUse([fx.fauxToolCall('bash', { command: "rg -n 'Ann|Bob' /people | head -5" })]),
    toolUse([fx.fauxToolCall('bash', { command: 'ls /notes' })]),
    toolUse([fx.fauxToolCall('read', { path: 'people/ann.md' })]),
    toolUse([fx.fauxToolCall('read', { path: `${fsPath}/people/ann.md`, offset: 3 })]),
    (context: any) => {
      const messages = context.messages as any[];
      const firstUser = messages.find((m) => m.role === 'user');
      seen.briefing = typeof firstUser.content === 'string'
        ? firstUser.content
        : firstUser.content.map((c: any) => c.text ?? '').join('');
      seen.toolResults = messages
        .filter((m) => m.role === 'toolResult')
        .map((m) => `${m.toolName}:${m.content.map((c: any) => c.text ?? '').join('')}`);
      return toolUse([
        fx.fauxToolCall('submit_result', {
          answer: ANSWER,
          references: [{ path: `${fsPath}/people/ann.md`, why: 'states where Ann lives' }],
        }),
      ]);
    },
  ];
}

before(async () => {
  writeBank();
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
  faux = fx.faux;
  flue = await fx.startFlue();
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

test('retriever telemetry records reads, searches and order without changing the result or the bank', async () => {
  const before = snapshot();
  const seenA: { briefing?: string; toolResults?: string[] } = {};
  faux.setResponses(script(seenA));

  const report = await fx.runRetriever({ bank: BANK, question: 'Where does Ann live?' }, 'telemetry-test');

  assert.equal(faux.getPendingResponseCount(), 0, 'every scripted turn was consumed');
  assert.equal(report.answer, ANSWER);
  assert.deepEqual(report.references, [{ path: `${fsPath}/people/ann.md`, why: 'states where Ann lives' }]);

  // Existing fields keep their meaning.
  assert.equal(report.meta.bash_calls, 2);
  assert.equal(report.meta.unexpected_writes, 0);

  const t = report.meta.telemetry;
  assert.equal(t.source, 'flue-observe');
  assert.equal(t.complete, true, 'observed starts match Flue-recorded tool calls');
  assert.equal(t.briefing_bytes, Buffer.byteLength(seenA.briefing!, 'utf8'));
  assert.deepEqual(t.tool_calls, { read: 4, grep: 1, glob: 0, bash: 2, other: 0 });
  assert.deepEqual(t.read_paths, ['/_index.md', '/notes/garden.md', '/people/ann.md', '/people/ann.md']);
  assert.deepEqual(t.bash_heuristic, { search: 1, read: 1, list: 1, unclassified: 0 });
  assert.deepEqual(t.operations, [
    { tool: 'read', path: '/_index.md' },
    { tool: 'grep', path: '/people' },
    { tool: 'read', path: '/notes/garden.md' },
    { tool: 'bash', kinds: ['search', 'read'] },
    { tool: 'bash', kinds: ['list'] },
    { tool: 'read', path: '/people/ann.md' },
    { tool: 'read', path: '/people/ann.md' },
  ]);
  assert.equal(t.truncated, false);

  // Tools really ran against the bank (the read result carries file content).
  assert.ok(seenA.toolResults!.some((r) => r.startsWith('read:') && r.includes('Lisbon')));
  // (Not asserting on the grep result: in this sandbox the built-in `grep`
  // tool falls back to `grep -rnH`, just-bash rejects `-H`, and Flue reports
  // that failure as "No matches found." — a separate issue from telemetry.)

  // Bank is byte-identical and git-clean.
  assert.equal(snapshot(), before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString(), '');

  // Baseline: same agent, same briefing, no telemetry subscriber attached.
  const seenB: { briefing?: string; toolResults?: string[] } = {};
  faux.setResponses(script(seenB));
  const baseline = await fx.runBaseline(seenA.briefing!, BANK, fsPath);
  assert.deepEqual(seenB.toolResults, seenA.toolResults, 'model saw identical tool results');
  assert.equal(baseline.data.answer, report.answer);
  assert.equal(baseline.toolCalls.filter((name: string) => name === 'bash').length, report.meta.bash_calls);
  assert.equal(snapshot(), before);
});
