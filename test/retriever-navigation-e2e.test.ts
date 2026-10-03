/**
 * Retriever pipeline against the synthetic navigation bank
 * (test/fixtures/navigation-bank) with a scripted (faux) model — no network,
 * no API keys, no real banks.
 *
 * This checks PLUMBING only: what the briefing contains (full root map +
 * generated glossary, never the Librarian's open questions), that scripted
 * tool calls really run against the bank, and that citations, telemetry,
 * accounting and the read-only guarantee survive. The faux model's answers
 * are written by this test, so nothing here measures search quality.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_FS = path.join(ROOT, 'test/fixtures/navigation-bank/fs');
const BANK = 'navigation';
const bankRoot = mkdtempSync(path.join(tmpdir(), 'retriever-navigation-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;
const repoPath = path.join(bankRoot, BANK);
const fsPath = path.join(repoPath, 'fs');
const ledgerFile = path.join(bankRoot, '.accounting', 'ledger.jsonl');

/** Librarian-only file: its text must never reach the retriever. */
const OPEN_QUESTIONS_SENTINEL = 'OPEN-QUESTION-SENTINEL-7f3a: who owns the boiler warranty?';
const EMPTY_ANSWER = 'No relevant data found in the memory bank.';

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;

function seedBank() {
  mkdirSync(repoPath, { recursive: true });
  cpSync(FIXTURE_FS, fsPath, { recursive: true });
  writeFileSync(path.join(fsPath, '_open-questions.md'), `# Open questions\n\n- ${OPEN_QUESTIONS_SENTINEL}\n`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');
}

const toolUse = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });

interface Seen {
  briefing?: string;
  toolResults?: string[];
}

/** Last scripted step: record what the model saw, then submit `result`. */
function finish(seen: Seen, result: unknown) {
  return (context: any) => {
    const messages = context.messages as any[];
    const firstUser = messages.find((m) => m.role === 'user');
    seen.briefing = typeof firstUser.content === 'string'
      ? firstUser.content
      : firstUser.content.map((c: any) => c.text ?? '').join('');
    seen.toolResults = messages
      .filter((m) => m.role === 'toolResult')
      .map((m) => `${m.toolName}:${m.content.map((c: any) => c.text ?? '').join('')}`);
    return toolUse([fx.fauxToolCall('submit_result', result)]);
  };
}

function ledgerCalls(runId: string): any[] {
  if (!existsSync(ledgerFile)) return [];
  return readFileSync(ledgerFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'model_call' && e.run_id === runId);
}

before(async () => {
  seedBank();
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

test('multi-topic run: full map + glossary briefing, targeted search, absolute citations, telemetry, ledger', async () => {
  const seen: Seen = {};
  // Scenario `dacha-weekend-and-car-service`: two unrelated topics, Russian question.
  fx.faux.setResponses([
    // Topic 1 and 2 searched independently, each scoped to the folder the map points at.
    toolUse([
      fx.fauxToolCall('bash', { command: "rg -l -i 'выходн|17' /home/dacha/" }),
      fx.fauxToolCall('bash', { command: "rg -l -i 'ТО|service' /home/car/" }),
    ]),
    toolUse([
      fx.fauxToolCall('read', { path: '/home/dacha/autumn-checklist.md' }),
      fx.fauxToolCall('read', { path: '/home/car/service-log.csv' }),
    ]),
    finish(seen, {
      answer: 'Scripted answer about the dacha weekend and the car service.',
      references: [
        // Three spellings the model might use; all must come back absolute.
        { path: '/home/dacha/autumn-checklist.md', why: 'what to bring' },
        { path: 'home/car/service-log.csv', why: 'booked service date' },
        { path: `${fsPath}/home/dacha/autumn-checklist.md`, why: 'already absolute' },
      ],
    }),
  ]);

  const report = await fx.runRetriever(
    {
      bank: BANK,
      question: 'Что нужно привезти на дачу на выходные 17–18 октября и на какое число записана машина на ТО?',
    },
    'nav-multi',
  );
  assert.equal(fx.faux.getPendingResponseCount(), 0, 'every scripted turn was consumed');

  // Briefing: the whole root map, verbatim, plus the generated glossary.
  const b = seen.briefing!;
  const rootMap = readFileSync(path.join(FIXTURE_FS, '_index.md'), 'utf8').replace(/\n+$/, '');
  assert.ok(b.includes(rootMap), 'root _index.md is injected in full, not cut to 30 lines');
  assert.ok(b.includes('- `work/projects/kestrel/` — Project Kestrel: overview and standups'), 'deepest map line present');
  assert.ok(b.includes('## Glossary (generated from manifests)'));
  const pto = b.split('\n').filter((l) => l.startsWith('PTO — '));
  assert.equal(pto.length, 2, 'ambiguous PTO keeps one line per meaning');
  assert.ok(pto.some((l) => l.endsWith('(home/dacha/tractor-notes.md)')));
  assert.ok(pto.some((l) => l.endsWith('(work/hr/pto-policy-2026.md)')));
  assert.ok(!b.includes(OPEN_QUESTIONS_SENTINEL), 'retriever never sees /_open-questions.md');
  assert.ok(!b.includes('## Open questions'), 'no open-questions section for the retriever');
  assert.ok(!b.includes('Top lines of every'), 'old per-folder index wording is gone');
  assert.ok(b.includes(`\`${fsPath}\``), 'host prefix for citations is in the briefing');

  // Scripted tools really ran against the copied bank.
  assert.ok(seen.toolResults!.some((r) => r.startsWith('bash:') && r.includes('/home/dacha/autumn-checklist.md')));
  assert.ok(seen.toolResults!.some((r) => r.startsWith('read:') && r.includes('2026')));

  // Citations come back as absolute host paths of content files.
  assert.deepEqual(report.references.map((r: any) => r.path), [
    path.join(fsPath, 'home/dacha/autumn-checklist.md'),
    path.join(fsPath, 'home/car/service-log.csv'),
    path.join(fsPath, 'home/dacha/autumn-checklist.md'),
  ]);

  // Existing meta keeps its shape and meaning.
  assert.equal(report.meta.bash_calls, 2);
  assert.equal(report.meta.unexpected_writes, 0);
  const t = report.meta.telemetry;
  assert.equal(t.complete, true);
  assert.equal(t.briefing_bytes, Buffer.byteLength(b, 'utf8'));
  assert.deepEqual(t.tool_calls, { read: 2, grep: 0, glob: 0, bash: 2, other: 0 });
  assert.deepEqual(t.read_paths, ['/home/dacha/autumn-checklist.md', '/home/car/service-log.csv']);

  // Accounting: one model call in the ledger for this run, matching meta.
  const calls = ledgerCalls('nav-multi');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, 'retriever');
  assert.equal(calls[0].bank, BANK);
  assert.equal(calls[0].tokens.total, report.meta.tokens.total);

  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString(), '');
});

test('decomposed ё: the explicit pattern from the role doc finds the NFD primary file', async () => {
  const seen: Seen = {};
  fx.faux.setResponses([
    toolUse([fx.fauxToolCall('bash', { command: 'rg -l "(ё|е\\p{M}?)жик" /home/' })]),
    toolUse([fx.fauxToolCall('bash', { command: 'rg -l "ёжика|ежика" /home/garden/' })]),
    finish(seen, { answer: EMPTY_ANSWER, references: [] }),
  ]);
  await fx.runRetriever({ bank: BANK, question: 'Чем кормить ежика осенью?' }, 'nav-nfd');
  const [explicit, naive] = seen.toolResults!;
  assert.ok(explicit.includes('/home/garden/hedgehog-feeder.md\n') || explicit.endsWith('/home/garden/hedgehog-feeder.md'),
    `explicit pattern hits the content file: ${explicit}`);
  // Documents why the role doc forbids the naive form: it only reaches the manifest.
  assert.ok(!naive.split('\n').includes('/home/garden/hedgehog-feeder.md'), `naive pattern misses NFD file: ${naive}`);
});

test('no-data answer keeps the exact literal and empty references', async () => {
  const seen: Seen = {};
  fx.faux.setResponses([finish(seen, { answer: EMPTY_ANSWER, references: [] })]);
  const report = await fx.runRetriever({ bank: BANK, question: 'What is the Wi-Fi password at the dacha?' }, 'nav-none');
  assert.equal(report.answer, EMPTY_ANSWER);
  assert.deepEqual(report.references, []);
  assert.equal(report.meta.unexpected_writes, 0);
});

test('missing bank returns the literal without calling the model', async () => {
  const before = ledgerCalls('nav-missing').length;
  const report = await fx.runRetriever({ bank: 'no-such-bank', question: 'anything?' }, 'nav-missing');
  assert.equal(report.answer, EMPTY_ANSWER);
  assert.deepEqual(report.references, []);
  assert.equal(report.meta.reason, 'bank-missing');
  assert.equal(ledgerCalls('nav-missing').length, before);
});
