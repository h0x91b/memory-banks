/**
 * The bank sandbox (src/bash-factory.ts) against Flue's real built-in tools.
 *
 * Two regressions this pins down, both invisible to the model:
 *   - the built-in `grep` tool answered "No matches found." for every search,
 *     because its fallback command uses `grep -H`, which just-bash rejects;
 *   - any `2>/dev/null` (the built-in `glob` tool always adds one) created a
 *     real `fs/dev/null` file in the bank.
 *
 * The Flue part drives the actual retriever with a scripted (faux) model, so
 * the tools, their command strings and their result parsing are Flue's own.
 * Everything runs through Vite's module runner, as scripts/run-cli.mjs does.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const BANK = 'sandboxed';
const bankRoot = mkdtempSync(path.join(tmpdir(), 'sandbox-builtins-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
const repoPath = path.join(bankRoot, BANK);
const fsPath = path.join(repoPath, 'fs');

const FILES: Record<string, string> = {
  '_index.md': '# sandboxed\n\n- people/ — who is who\n- notes/ — misc notes\n',
  'people/ann.md': '# Ann\n\nAnn lives in Lisbon.\nАнна живёт в Лиссабоне.\n',
  'people/bob.md': '# Bob\n\nBob works with Ann on the garden project.\n',
  'notes/garden.md': '# Garden\n\nTomatoes planted in April.\n',
};
/** Outside the sandbox root, next to .git: must never be readable or writable. */
const OUTSIDE = path.join(repoPath, 'outside-secret.txt');

function writeBank() {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(fsPath, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  writeFileSync(OUTSIDE, 'top secret\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');
}

/** sha256 over every path + content in the bank repo (fs/ and the file beside .git), excluding .git. */
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

const gitStatus = () => execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: repoPath }).toString();

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
/** Retriever harness (faux provider, Flue bootstrap, pipeline), loaded through the runner. */
let fx: any;
/** src/bash-factory.ts, loaded through the runner. */
let factory: typeof import('../src/bash-factory.ts');

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
  factory = await runner.import('/src/bash-factory.ts');
  flue = await fx.startFlue();
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

describe('adaptFlueGrepFallback', () => {
  test("rewrites only Flue's generated fallback prefix", () => {
    const { adaptFlueGrepFallback: adapt } = factory;
    assert.equal(adapt("grep -rnH -E -- 'a' '/x'"), "grep -rn -E -- 'a' '/x'");
    assert.equal(adapt("grep -rnH -F --include='*.md' -- 'a' '.'"), "grep -rn -F --include='*.md' -- 'a' '.'");
    // Anything else is left for just-bash to accept or reject visibly.
    assert.equal(adapt("grep -rnH 'a' /x"), "grep -rnH 'a' /x");
    assert.equal(adapt("ls; grep -rnH -E -- 'a' /x"), "ls; grep -rnH -E -- 'a' /x");
    assert.equal(adapt("rg -n 'a' /x"), "rg -n 'a' /x");
  });
});

describe('bank sandbox exec', () => {
  const exec = async (command: string) => (await factory.createBankBashFactory({ bank: BANK, bankFsPath: fsPath })()).exec(command);
  const devOnDisk = () => existsSync(path.join(fsPath, 'dev'));

  test('/dev/null redirects and reads never touch the bank', async () => {
    const before = snapshot();
    const cases: Array<[string, string]> = [
      ['echo hi > /dev/null; echo ok', 'ok\n'],
      ['echo hi >> /dev/null; echo ok', 'ok\n'],
      ['ls /missing 2>/dev/null; echo rc=$?', 'rc=2\n'],
      ['ls /missing &> /dev/null; echo done', 'done\n'],
      ["find '/people' -type f -name '*.md' 2>/dev/null | sort", '/people/ann.md\n/people/bob.md\n'],
      ['echo passthrough | tee /dev/null', 'passthrough\n'],
      ['cat /dev/null; echo empty', 'empty\n'],
      ['test -e /dev/null && echo exists', 'exists\n'],
      ['cd /notes && echo rel > ../dev/null; echo ok', 'ok\n'],
    ];
    for (const [command, stdout] of cases) {
      const r = await exec(command);
      assert.equal(r.stdout, stdout, command);
      assert.equal(devOnDisk(), false, `${command} created fs/dev`);
    }
    // Structural operations on the device are refused, not forwarded to disk.
    assert.notEqual((await exec('rm /dev/null')).exitCode, 0);
    assert.notEqual((await exec('mkdir -p /dev/null/x')).exitCode, 0);
    assert.equal(devOnDisk(), false);
    assert.equal(snapshot(), before);
    assert.equal(gitStatus(), '');
  });

  test('sandbox containment is unchanged', async () => {
    const before = snapshot();
    for (const p of ['/../outside-secret.txt', '/../../outside-secret.txt', '/dev/../../outside-secret.txt', '/../.git/HEAD']) {
      const r = await exec(`cat '${p}'`);
      assert.doesNotMatch(r.stdout, /top secret|ref:/, `read escaped via ${p}`);
    }
    // Writes aimed outside the root land inside it (or fail) — never next to .git.
    await exec("echo pwned > /../outside-secret.txt; echo pwned > /dev/../../escape.txt");
    assert.equal(readFileSync(OUTSIDE, 'utf8'), 'top secret\n');
    assert.equal(existsSync(path.join(repoPath, 'escape.txt')), false);
    assert.equal(existsSync(path.join(bankRoot, 'escape.txt')), false);
    // Undo whatever landed inside the root so the bank is back to its seed.
    rmSync(path.join(fsPath, 'outside-secret.txt'), { force: true });
    rmSync(path.join(fsPath, 'escape.txt'), { force: true });
    assert.equal(snapshot(), before);
    assert.equal(gitStatus(), '');
  });
});

describe("Flue's built-in tools in the retriever", () => {
  test('grep, glob and bash return real results and leave the bank untouched', async () => {
    const before = snapshot();
    const seen: { results?: Array<{ tool: string; text: string; isError: boolean }> } = {};
    const toolUse = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });
    const call = (tool: string, args: Record<string, unknown>) => toolUse([fx.fauxToolCall(tool, args)]);
    fx.faux.setResponses([
      call('grep', { pattern: 'Lisbon', path: '/people' }),
      call('grep', { pattern: 'Лиссабон', path: '/people' }),
      call('grep', { pattern: 'no-such-text-anywhere', path: '/' }),
      call('grep', { pattern: 'Lisbon', path: '/people/ann.md' }),
      call('grep', { pattern: 'Tomatoes', include: '*.md' }),
      call('grep', { pattern: 'Lisbon.', literal: true, path: '/people' }),
      call('grep', { pattern: '(', path: '/people' }),
      call('glob', { pattern: '*.md', path: '/people' }),
      call('glob', { pattern: '*.txt' }),
      call('bash', { command: "ls /missing 2>/dev/null; rg -n 'Лиссабон' /people 2>/dev/null" }),
      (context: any) => {
        seen.results = (context.messages as any[])
          .filter((m) => m.role === 'toolResult')
          .map((m) => ({ tool: m.toolName, text: m.content.map((c: any) => c.text ?? '').join(''), isError: !!m.isError }));
        return toolUse([fx.fauxToolCall('submit_result', { answer: 'Ann lives in Lisbon.', references: [] })]);
      },
    ]);

    const report = await fx.runRetriever({ bank: BANK, question: 'Where does Ann live?' }, 'sandbox-builtins');
    assert.equal(fx.faux.getPendingResponseCount(), 0, 'every scripted turn was consumed');

    const r = seen.results!;
    assert.equal(r.length, 10);
    const [en, ru, none, single, include, literal, badRegex, globPeople, globNone, bashRu] = r;
    assert.deepEqual(en, { tool: 'grep', text: '/people/ann.md:3:Ann lives in Lisbon.', isError: false });
    assert.deepEqual(ru, { tool: 'grep', text: '/people/ann.md:4:Анна живёт в Лиссабоне.', isError: false });
    assert.deepEqual(none, { tool: 'grep', text: 'No matches found.', isError: false });
    assert.equal(single.text, '/people/ann.md:3:Ann lives in Lisbon.', 'single-file search keeps the file name');
    assert.equal(include.text, 'notes/garden.md:3:Tomatoes planted in April.');
    assert.equal(literal.text, '/people/ann.md:3:Ann lives in Lisbon.');
    // A genuine failure still surfaces as an error instead of "No matches found."
    assert.equal(badRegex.isError, true);
    assert.match(badRegex.text, /grep failed/);
    assert.deepEqual(globPeople.text.split('\n').sort(), ['/people/ann.md', '/people/bob.md']);
    assert.equal(globNone.text, 'No files found matching pattern.');
    assert.match(bashRu.text, /^\/people\/ann\.md:4:Анна живёт в Лиссабоне\.$/m);

    assert.equal(report.meta.unexpected_writes, 0);
    assert.equal(existsSync(path.join(fsPath, 'dev')), false);
    assert.equal(snapshot(), before);
    assert.equal(gitStatus(), '');
  });
});
