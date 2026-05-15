import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'memory-bank curator',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'curator@bank-memory.local',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'memory-bank curator',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'curator@bank-memory.local',
};

export async function gitEnsureRepo(bankPath: string): Promise<void> {
  if (existsSync(path.join(bankPath, '.git'))) return;
  await exec('git', ['init', '--initial-branch=main'], { cwd: bankPath });
  await exec('git', ['add', '-A'], { cwd: bankPath });
  await exec('git', ['commit', '-m', 'init bank', '--allow-empty'], {
    cwd: bankPath,
    env: COMMIT_ENV,
  });
}

export async function gitCommitAll(bankPath: string, message: string): Promise<string | null> {
  await exec('git', ['add', '-A'], { cwd: bankPath });
  const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: bankPath });
  if (!status.trim()) return null;
  await exec('git', ['commit', '-m', message], { cwd: bankPath, env: COMMIT_ENV });
  const { stdout: sha } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: bankPath });
  return sha.trim();
}
