/**
 * End-to-end Librarian runs through the submit_result validation gate
 * (contract §9) with a scripted (faux) model: no network, no API keys, no real
 * banks. Loaded through Vite's module runner like spend-pipeline-e2e.test.ts.
 *
 * The gate runs inside the tool: a rejected submit is a tool error the model
 * sees, the files it fixes afterwards are what the next submit validates, and
 * only the accepted result is recorded, swept and committed.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'librarian-gate-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;

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

// ---------- bank helpers ----------

const fsOf = (bank: string) => path.join(bankRoot, bank, 'fs');
const git = (bank: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: path.join(bankRoot, bank), stdio: 'pipe' }).toString();

const manifest = (title: string) => JSON.stringify({ title, keywords: [title.toLowerCase()], glossary: {} });

function rootMap(bank: string, folders: Record<string, string>): string {
  const lines = Object.entries(folders).map(([p, d]) => `- \`${p}\` — ${d}`);
  return `# ${bank}\n\nSynthetic bank for gate tests.\n\n## Folders\n\n${lines.join('\n')}\n`;
}

/** Writes a committed bank: `files` maps bank-relative paths to content. */
function seedBank(bank: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(fsOf(bank), rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(bank, 'init', '-q', '--initial-branch=main');
  git(bank, 'add', '-A');
  git(bank, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');
}

/** A note plus its manifest. */
const note = (rel: string, title: string) => ({ [rel]: `# ${title}\n`, [`${rel}.manifest.json`]: manifest(title) });

// ---------- scripted model ----------

const toolUse = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });
const bashStep = (command: string) => toolUse([fx.fauxToolCall('bash', { command })]);
const submit = (summary: string) => toolUse([fx.fauxToolCall('submit_result', { summary })]);

/** Records every submit_result tool result the model has seen so far. */
function submitResults(context: any): Array<{ isError: boolean; text: string }> {
  return (context.messages as any[])
    .filter((m) => m.role === 'toolResult' && m.toolName === 'submit_result')
    .map((m) => ({ isError: Boolean(m.isError), text: m.content.map((c: any) => c.text ?? '').join('') }));
}

/** A step that captures what the model saw, then issues the next response. */
function observe(sink: { results?: Array<{ isError: boolean; text: string }> }, next: () => unknown) {
  return (context: any) => {
    sink.results = submitResults(context);
    return next();
  };
}

const inline = (filename: string, content: string) => ({ kind: 'inline', filename, content });

// ---------- tests ----------

test('rejected submit lets the model fix files in the same run, then accepts with passed', async () => {
  const bank = 'gate-fix';
  seedBank(bank, { '_index.md': rootMap(bank, { 'notes/': 'Short notes' }), ...note('notes/a.md', 'Note A') });

  const seen: { results?: Array<{ isError: boolean; text: string }> } = {};
  fx.faux.setResponses([
    bashStep('mv /_raw/b.md /notes/b.md'),
    submit('Filed b.md under notes/'),
    observe(seen, () => bashStep(`echo '${manifest('Note B')}' > /notes/b.md.manifest.json`)),
    submit('Filed b.md under notes/ with manifest'),
  ]);

  const report = await fx.runLibrarian({ bank, items: [inline('b.md', '# Note B\n')] }, 'gate-fix');

  assert.equal(fx.faux.getPendingResponseCount(), 0);
  assert.equal(seen.results!.length, 1);
  assert.equal(seen.results![0].isError, true, 'first submit is a tool error the model sees');
  assert.match(seen.results![0].text, /^Bank validation failed \(rejection 1 of 3\): 1 new violation\./);
  assert.match(seen.results![0].text, /- \[manifest-missing\] notes\/b\.md: no notes\/b\.md\.manifest\.json/);
  assert.match(seen.results![0].text, /Fix these and call submit_result again\.$/);

  // Only the accepted result is recorded.
  assert.equal(report.summary, 'Filed b.md under notes/ with manifest');
  assert.equal(report.meta.validation.status, 'passed');
  assert.deepEqual(report.meta.validation.violations, []);

  // Existing response fields are intact.
  assert.equal(report.bash_calls, 2);
  assert.equal(typeof report.meta.model, 'string');
  assert.ok(report.meta.tokens.total > 0);
  assert.ok(report.meta.cost);
  const changed = report.processed.map((c: any) => c.path);
  assert.ok(changed.includes('notes/b.md') && changed.includes('notes/b.md.manifest.json'), changed.join(','));
  assert.equal(report.commits.length, 2, 'ingest commit + curate commit');
  assert.equal(git(bank, 'status', '--porcelain'), '');
  assert.equal(git(bank, 'log', '-1', '--format=%s').trim(), 'curate: Filed b.md under notes/ with manifest');
});

test('three rejections, then the fourth submit is accepted with violations; leftovers are swept', async () => {
  const bank = 'gate-four';
  seedBank(bank, { '_index.md': rootMap(bank, { 'notes/': 'Short notes' }), ...note('notes/a.md', 'Note A') });

  const seen: { results?: Array<{ isError: boolean; text: string }> } = {};
  fx.faux.setResponses([
    bashStep('mv /_raw/b.md /notes/b.md'),
    submit('try 1'),
    submit('try 2'),
    submit('try 3'),
    observe(seen, () => submit('try 4')),
  ]);

  const report = await fx.runLibrarian(
    { bank, items: [inline('b.md', '# Note B\n'), inline('left.md', 'left behind\n')] },
    'gate-four',
  );

  assert.equal(fx.faux.getPendingResponseCount(), 0, 'exactly four submits');
  assert.deepEqual(seen.results!.map((r) => r.isError), [true, true, true]);
  assert.match(seen.results![1].text, /rejection 2 of 3/);
  assert.match(seen.results![2].text, /rejection 3 of 3/);
  assert.match(
    seen.results![2].text,
    /The next submit_result will be accepted even with violations; fix what you can\.$/,
  );

  assert.equal(report.summary, 'try 4');
  assert.equal(report.meta.validation.status, 'accepted-with-violations');
  const missing = report.meta.validation.violations.find((v: any) => v.code === 'manifest-missing');
  assert.deepEqual(
    { path: missing.path, severity: missing.severity, new: missing.new },
    { path: 'notes/b.md', severity: 'error', new: true },
  );

  // Sweep and git still run after an accepted-with-violations result.
  assert.deepEqual(report.skipped.map((c: any) => c.path), ['_unsorted/left.md']);
  assert.ok(existsSync(path.join(fsOf(bank), '_unsorted/left.md')));
  assert.equal(git(bank, 'status', '--porcelain'), '');
});

test('pre-existing violations from the baseline do not block', async () => {
  const bank = 'gate-legacy';
  seedBank(bank, {
    // Legacy layout: no manifests, a nested index, folder missing from the map.
    '_index.md': rootMap(bank, { 'notes/': 'Short notes' }),
    ...note('notes/a.md', 'Note A'),
    'legacy/old.md': 'old\n',
    'legacy/_index.md': '# legacy\n',
  });

  fx.faux.setResponses([
    bashStep(`mv /_raw/b.md /notes/b.md && echo '${manifest('Note B')}' > /notes/b.md.manifest.json`),
    submit('Filed b.md'),
  ]);
  const report = await fx.runLibrarian({ bank, items: [inline('b.md', '# Note B\n')] }, 'gate-legacy');

  assert.equal(fx.faux.getPendingResponseCount(), 0, 'accepted on the first submit');
  assert.equal(report.meta.validation.status, 'passed');
  const codes = report.meta.validation.violations.map((v: any) => `${v.code}:${v.path}:${v.new}`).sort();
  assert.deepEqual(codes, [
    'manifest-missing:legacy/old.md:false',
    'map-missing:legacy/:false',
    'nested-index:legacy/_index.md:false',
  ]);
});

test('a pre-existing violation that gets worse blocks', async () => {
  const bank = 'gate-worse';
  const big: Record<string, string> = {};
  for (let i = 1; i <= 21; i++) Object.assign(big, note(`big/n${String(i).padStart(2, '0')}.md`, `Big ${i}`));
  seedBank(bank, {
    '_index.md': rootMap(bank, { 'big/': 'Too many notes', 'notes/': 'Short notes' }),
    ...note('notes/a.md', 'Note A'),
    ...big,
  });

  const seen: { results?: Array<{ isError: boolean; text: string }> } = {};
  fx.faux.setResponses([
    bashStep(`mv /_raw/b.md /big/b.md && echo '${manifest('Note B')}' > /big/b.md.manifest.json`),
    submit('Filed b.md under big/'),
    observe(seen, () => bashStep('mv /big/b.md /notes/b.md && mv /big/b.md.manifest.json /notes/b.md.manifest.json')),
    submit('Filed b.md under notes/'),
  ]);
  const report = await fx.runLibrarian({ bank, items: [inline('b.md', '# Note B\n')] }, 'gate-worse');

  assert.equal(fx.faux.getPendingResponseCount(), 0);
  assert.equal(seen.results![0].isError, true);
  assert.match(seen.results![0].text, /- \[width-over-limit\] big\/ has 22 content files \(limit 20\)/);

  assert.equal(report.meta.validation.status, 'passed');
  const width = report.meta.validation.violations.find((v: any) => v.code === 'width-over-limit');
  assert.deepEqual({ value: width.value, new: width.new }, { value: 21, new: false }, 'back to the baseline value');
});

test('a validator crash at submit accepts the result with validator-error', async () => {
  const bank = 'gate-crash';
  seedBank(bank, { '_index.md': rootMap(bank, { 'notes/': 'Short notes' }), ...note('notes/a.md', 'Note A') });
  const locked = path.join(fsOf(bank), 'notes', 'locked');

  try {
    fx.faux.setResponses([
      () => {
        // An unlistable folder makes the validator walk throw.
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        return submit('Nothing filed');
      },
    ]);
    const report = await fx.runLibrarian({ bank, items: [inline('b.md', '# Note B\n')] }, 'gate-crash');

    assert.equal(fx.faux.getPendingResponseCount(), 0, 'accepted on the first submit, no loop');
    assert.equal(report.summary, 'Nothing filed');
    assert.deepEqual(report.meta.validation, { status: 'validator-error', violations: [] });
  } finally {
    if (existsSync(locked)) chmodSync(locked, 0o755);
  }
});

test('a validator crash at baseline accepts the first submit with validator-error', async () => {
  const bank = 'gate-crash-baseline';
  seedBank(bank, { '_index.md': rootMap(bank, { 'notes/': 'Short notes' }), ...note('notes/a.md', 'Note A') });
  const notes = path.join(fsOf(bank), 'notes');
  chmodSync(notes, 0o000);

  try {
    fx.faux.setResponses([
      () => {
        chmodSync(notes, 0o755); // baseline already failed; let the rest of the run see a normal bank
        return submit('Nothing filed');
      },
    ]);
    const report = await fx.runLibrarian({ bank, items: [inline('b.md', '# Note B\n')] }, 'gate-crash-baseline');

    assert.equal(fx.faux.getPendingResponseCount(), 0);
    assert.deepEqual(report.meta.validation, { status: 'validator-error', violations: [] });
  } finally {
    chmodSync(notes, 0o755);
  }
});

test('meta.validation is absent when _raw/ is empty and no agent runs', async () => {
  const bank = 'gate-empty';
  seedBank(bank, { '_index.md': rootMap(bank, {}) });
  fx.faux.setResponses([]);
  const report = await fx.runLibrarian({ bank, items: [] }, 'gate-empty');
  assert.equal(report.summary, '_raw/ is empty — nothing to curate.');
  assert.equal(report.meta, undefined);
  assert.equal('validation' in (report.meta ?? {}), false);
});

test('gated runs still land in the spend ledger with the reported tokens', async () => {
  const ledger = path.join(bankRoot, '.accounting', 'ledger.jsonl');
  const calls = readFileSync(ledger, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'model_call' && e.agent === 'librarian');
  // One ledger call per Librarian run that reached the agent (six above), whatever the gate did.
  assert.deepEqual(
    calls.map((e) => e.run_id),
    ['gate-fix', 'gate-four', 'gate-legacy', 'gate-worse', 'gate-crash', 'gate-crash-baseline'],
  );
  for (const e of calls) assert.ok(e.tokens?.total > 0, `${e.run_id} tokens recorded`);
});
