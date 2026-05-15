import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface SweptItem {
  source: string;
  placed_at: string;
  kind: 'file' | 'dir';
}

/**
 * Move anything left in <fsPath>/_raw/ into <fsPath>/_unsorted/ as a safety net
 * so the inbox is guaranteed empty after a curator run. Handles both files and
 * directories — a directory is moved as a single unit, keeping its internal
 * structure intact.
 */
export async function sweepRawToUnsorted(fsPath: string): Promise<SweptItem[]> {
  const rawDir = path.join(fsPath, '_raw');
  const unsortedDir = path.join(fsPath, '_unsorted');
  const swept: SweptItem[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(rawDir);
  } catch {
    return swept;
  }
  if (entries.length === 0) return swept;

  await fs.mkdir(unsortedDir, { recursive: true });
  for (const name of entries.sort()) {
    const src = path.join(rawDir, name);
    let st;
    try {
      st = await fs.stat(src);
    } catch {
      continue;
    }
    const isFile = st.isFile();
    const isDir = st.isDirectory();
    if (!isFile && !isDir) continue;
    const destName = uniqueName(unsortedDir, name);
    const dest = path.join(unsortedDir, destName);
    await fs.rename(src, dest);
    swept.push({ source: name, placed_at: `_unsorted/${destName}`, kind: isFile ? 'file' : 'dir' });
  }
  return swept;
}

function uniqueName(dir: string, name: string): string {
  let candidate = name;
  let i = 1;
  while (existsSync(path.join(dir, candidate))) {
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    candidate = `${base}-${i}${ext}`;
    i++;
  }
  return candidate;
}
