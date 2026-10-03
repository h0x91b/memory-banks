import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const BANK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Each bank lives at <root>/<bank-name>/ which is the git repo root.
 * The agent's view of the bank is <root>/<bank-name>/fs/ — see bankFsPath().
 * The .git directory lives at <root>/<bank-name>/.git/ and is intentionally
 * outside the agent's sandbox so it physically cannot be touched.
 */

export function bankRoot(): string {
  const fromEnv = process.env.MEMORY_BANK_ROOT;
  if (fromEnv && fromEnv.trim()) return path.resolve(expandTilde(fromEnv.trim()));
  return path.join(os.homedir(), '.bank-memory');
}

export function bankPath(bank: string): string {
  if (!BANK_NAME_RE.test(bank)) {
    throw new Error(
      `Invalid bank name "${bank}". Must match [a-z0-9][a-z0-9-]* (lowercase ascii, digits, hyphens).`,
    );
  }
  return path.join(bankRoot(), bank);
}

export function bankFsPath(bank: string): string {
  return path.join(bankPath(bank), 'fs');
}

export function rawDir(bank: string): string {
  return path.join(bankFsPath(bank), '_raw');
}

export interface EnsureBankResult {
  created: boolean;
  repoPath: string;
  fsPath: string;
}

export async function ensureBank(bank: string): Promise<EnsureBankResult> {
  const repoPath = bankPath(bank);
  const fsPath = bankFsPath(bank);
  const created = !existsSync(repoPath);

  await fs.mkdir(path.join(fsPath, '_raw'), { recursive: true });

  const indexPath = path.join(fsPath, '_index.md');
  if (!existsSync(indexPath)) {
    await fs.writeFile(indexPath, rootMapScaffold(bank));
  }

  const gitignorePath = path.join(repoPath, '.gitignore');
  if (!existsSync(gitignorePath)) {
    await fs.writeFile(gitignorePath, '# nothing to ignore by default\n');
  }

  return { created, repoPath, fsPath };
}

/**
 * Root map of a brand-new bank: a valid empty map per
 * docs/design/bank-format.md §5.1 (title, overview, empty `## Folders`).
 * Written only when the bank has no `_index.md`; existing maps are never touched.
 */
export function rootMapScaffold(bank: string): string {
  return `# ${bank}\n\nMemory bank index. Curated automatically by the librarian agent.\n\n## Folders\n`;
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
