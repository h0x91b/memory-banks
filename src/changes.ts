import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Change {
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'other';
  /** Path relative to the bank's fs/ root (the agent's view). */
  path: string;
  /** Original path, for renames/copies, also relative to fs/. */
  from?: string;
}

/**
 * Run git status against the repo root. Paths get stripped of the leading
 * `fs/` segment so reports talk in the same terms the agent does. Anything
 * outside `fs/` (e.g. .gitignore, README at the repo root) is dropped from
 * the report — those are managed by us, not the agent.
 */
export async function readGitChanges(repoPath: string): Promise<Change[]> {
  const { stdout } = await exec('git', ['status', '--porcelain=v1', '-z', '-uall'], {
    cwd: repoPath,
  });
  return parsePorcelainZ(stdout);
}

function parsePorcelainZ(raw: string): Change[] {
  const out: Change[] = [];
  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    if (!entry) {
      i += 1;
      continue;
    }
    const code = entry.slice(0, 2);
    const rawPath = entry.slice(3);
    let rawFrom: string | undefined;
    if (code[0] === 'R' || code[0] === 'C') {
      rawFrom = tokens[i + 1];
      i += 2;
    } else {
      i += 1;
    }
    const stripped = stripFsPrefix(rawPath);
    const strippedFrom = rawFrom !== undefined ? stripFsPrefix(rawFrom) : undefined;
    if (stripped === null) continue; // outside fs/ — ignore (.gitignore, README, etc.)
    out.push({
      status: mapStatus(code),
      path: stripped,
      ...(strippedFrom !== null && strippedFrom !== undefined ? { from: strippedFrom } : {}),
    });
  }
  return out;
}

function stripFsPrefix(p: string): string | null {
  if (p === 'fs') return '';
  if (p.startsWith('fs/')) return p.slice(3);
  return null;
}

function mapStatus(code: string): Change['status'] {
  if (code === '??') return 'untracked';
  const c = code[0] === ' ' ? code[1] : code[0];
  switch (c) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'other';
  }
}
