/**
 * The real bank sandbox (src/bash-factory.ts: just-bash ReadWriteFs + DevNullFs)
 * rooted at a query snapshot (src/query/snapshot.ts): reads, searches and
 * /dev/null redirects behave normally, every write is refused by the
 * read-only tree, and neither the snapshot nor the live bank changes.
 * Loaded through Vite's module runner because src/ uses `.js` specifiers.
 * No model, no network; throwaway MEMORY_BANK_ROOT.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const BANK = 'sandboxed';
const bankRoot = mkdtempSync(path.join(tmpdir(), 'query-snapshot-sandbox-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
const repoPath = path.join(bankRoot, BANK);

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let sha: string;

function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      hash.update(path.relative(dir, abs)).update('\0');
      if (statSync(abs).isDirectory()) walk(abs);
      else hash.update(readFileSync(abs)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex');
}

before(async () => {
  for (const [rel, content] of Object.entries({
    'fs/_index.md': '# sandboxed\n',
    'fs/notes/a.md': 'v1 alpha\n',
    'fs/notes/keep.md': 'keep\n',
  })) {
    mkdirSync(path.dirname(path.join(repoPath, rel)), { recursive: true });
    writeFileSync(path.join(repoPath, rel), content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'curate: seed');
  sha = git('rev-parse', 'HEAD');

  server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
});

after(async () => {
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

test('the real bank sandbox reads a snapshot normally and cannot write to it', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores permission bits');
  const { createBankBashFactory } = await runner.import('/src/bash-factory.ts');
  const { materializeSnapshot, SNAPSHOTS_DIR } = await runner.import('/src/query/snapshot.ts');
  const live = treeHash(repoPath);

  const snap = await materializeSnapshot(BANK, sha);
  try {
    const sandbox = await createBankBashFactory({ bank: BANK, bankFsPath: snap.dir })();
    const run = async (cmd: string) => {
      const r = await sandbox.exec(cmd);
      return { exit: r.exitCode ?? 0, out: r.stdout ?? '' };
    };

    assert.equal((await run('cat notes/a.md')).out, 'v1 alpha\n');
    assert.match((await run('grep -rn alpha . 2>/dev/null')).out, /notes\/a\.md:1:v1 alpha/);
    assert.match((await run('ls notes')).out, /keep\.md/);
    // (just-bash `find` over ReadWriteFs prints nothing even on a writable tree; not used here.)
    assert.match((await run('ls -R')).out, /\.\/notes:\na\.md\nkeep\.md/);

    for (const cmd of [
      'echo hacked > notes/a.md',
      'echo x >> _index.md',
      'echo x > notes/evil.md',
      'rm notes/keep.md',
      'mkdir notes/sub',
      'mv notes/a.md notes/b.md',
    ]) {
      const r = await run(cmd).catch(() => ({ exit: -1, out: '' }));
      assert.notEqual(r.exit, 0, `"${cmd}" must fail on a read-only snapshot`);
    }
    await assert.rejects(sandbox.fs.writeFile('/notes/evil2.md', 'x'));
    await assert.rejects(sandbox.fs.rm('/notes/keep.md'));

    assert.equal(readFileSync(path.join(snap.dir, 'notes', 'a.md'), 'utf8'), 'v1 alpha\n');
    assert.deepEqual(readdirSync(path.join(snap.dir, 'notes')).sort(), ['a.md', 'keep.md']);
    assert.deepEqual(readdirSync(snap.dir).sort(), ['_index.md', 'notes']);
  } finally {
    await snap.release();
  }
  assert.equal(treeHash(repoPath), live, 'live bank changed');
  assert.equal(existsSync(snap.dir), false);
  assert.deepEqual(readdirSync(path.join(bankRoot, SNAPSHOTS_DIR, BANK)), []);
});
