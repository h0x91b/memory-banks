import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Walk a bank's `fs/` root and collect the first N non-blank lines of every
 * `_index.md` we find (excluding `_raw/` and `_unsorted/` inboxes). The result
 * is a compact "table of contents" suitable for inlining into LLM briefings so
 * the agent doesn't burn tokens orienting itself before getting to real work.
 *
 * Format (one section per index file):
 *
 *     ## <relative/path/to/_index.md>
 *     <up to N non-blank lines>
 *
 * Returns an empty string if no index files exist.
 */
export interface CollectOptions {
  /** Max non-blank lines to keep from each _index.md. Defaults to 30. */
  linesPerFile?: number;
  /** Folder names to skip during the walk. Defaults to ['_raw', '_unsorted']. */
  skipFolders?: string[];
}

export async function collectIndexes(fsPath: string, opts: CollectOptions = {}): Promise<string> {
  const lines = opts.linesPerFile ?? 30;
  const skip = new Set(opts.skipFolders ?? ['_raw', '_unsorted']);
  const found: string[] = [];
  await walk(fsPath, fsPath, skip, found);
  if (found.length === 0) return '';

  const parts: string[] = [];
  for (const rel of found.sort()) {
    const abs = path.join(fsPath, rel);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const top = pickTopLines(content, lines);
    if (!top.trim()) continue;
    parts.push(`### ${rel}`);
    parts.push(top.trimEnd());
    parts.push('');
  }
  return parts.join('\n');
}

async function walk(root: string, dir: string, skip: Set<string>, acc: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (skip.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (st.isFile() && name === '_index.md') {
      acc.push(path.relative(root, abs));
    } else if (st.isDirectory()) {
      await walk(root, abs, skip, acc);
    }
  }
}

function pickTopLines(content: string, n: number): string {
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    if (out.length >= n) break;
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') continue;
    out.push(line);
  }
  return out.join('\n');
}
