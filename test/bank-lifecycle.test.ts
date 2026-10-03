// Offline smoke test of the local bank lifecycle: create a bank on disk, put it
// under git, see an edit reported in the agent's fs/ terms, commit it. No model
// calls, no network, no API keys; banks live in a throwaway MEMORY_BANK_ROOT.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { parseRootMap } from '../src/bank-format/index.ts';
import { bankPath, ensureBank, rootMapScaffold } from '../src/bank.ts';
import { validateBank } from '../src/bank-validator/index.ts';
import { readGitChanges } from '../src/changes.ts';
import { gitCommitAll, gitEnsureRepo } from '../src/git.ts';

let root: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-banks-test-'));
  process.env.MEMORY_BANK_ROOT = root;
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('bank names outside [a-z0-9][a-z0-9-]* are rejected', () => {
  for (const bad of ['', 'Upper', '-lead', '../escape', 'a/b', 'a_b']) {
    assert.throws(() => bankPath(bad), /Invalid bank name/, bad);
  }
  assert.equal(bankPath('ok-bank-1'), path.join(root, 'ok-bank-1'));
});

test('a new bank passes the bank format validator', async () => {
  assert.deepEqual(parseRootMap(rootMapScaffold('fresh')).violations, []);
  const { fsPath } = await ensureBank('fresh');
  assert.equal(await fs.readFile(path.join(fsPath, '_index.md'), 'utf8'), rootMapScaffold('fresh'));
  assert.deepEqual((await validateBank(fsPath)).violations, []);
});

test('ensureBank never rewrites an existing root map', async () => {
  const { fsPath } = await ensureBank('kept');
  const custom = '# kept\n\nHand-written overview.\n\n## Folders\n';
  await fs.writeFile(path.join(fsPath, '_index.md'), custom);
  await ensureBank('kept');
  assert.equal(await fs.readFile(path.join(fsPath, '_index.md'), 'utf8'), custom);
});

test('a new bank is scaffolded, committed, and reports edits relative to fs/', async () => {
  const first = await ensureBank('smoke');
  assert.equal(first.created, true);
  assert.equal(first.repoPath, path.join(root, 'smoke'));
  assert.match(await fs.readFile(path.join(first.fsPath, '_index.md'), 'utf8'), /^# smoke\n/);

  await gitEnsureRepo(first.repoPath);
  assert.deepEqual(await readGitChanges(first.repoPath), []);
  assert.equal((await ensureBank('smoke')).created, false);

  await fs.writeFile(path.join(first.fsPath, 'notes.md'), 'hello\n');
  await fs.appendFile(path.join(first.fsPath, '_index.md'), '- notes.md\n');
  await fs.writeFile(path.join(first.repoPath, 'outside.md'), 'not part of the agent view\n');

  const changes = await readGitChanges(first.repoPath);
  assert.deepEqual(
    changes.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { status: 'modified', path: '_index.md' },
      { status: 'untracked', path: 'notes.md' },
    ],
  );

  const sha = await gitCommitAll(first.repoPath, 'smoke edit');
  assert.match(sha ?? '', /^[0-9a-f]{4,}$/);
  assert.deepEqual(await readGitChanges(first.repoPath), []);
  assert.equal(await gitCommitAll(first.repoPath, 'nothing to commit'), null);
});
