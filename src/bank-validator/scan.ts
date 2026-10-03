// Read-only walk of a bank's fs/ directory (contract §2). Never follows
// symlinks, never opens anything outside the bank root, never writes. The
// validator builds on the result; a briefing/glossary generator can reuse it
// to get the parsed manifests and the root map text.
import { constants as fsc } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  classifyEntry,
  contentPathForManifest,
  folderDepth,
  nfc,
  parseManifest,
  violation,
  type EntryKind,
  type ManifestParseResult,
  type Violation,
} from '../bank-format/index.ts';

export interface ScannedFolder {
  /** Bank-relative folder path ending with `/`; the root is `''`. */
  path: string;
  depth: number;
  /** Content files directly inside (§3.2 width). */
  contentFiles: number;
  /** Subfolders directly inside, inboxes and violating entries excluded. */
  subfolders: number;
}

export interface ScannedManifest {
  /** Bank-relative manifest path as on disk. */
  path: string;
  /** Content file it describes, as on disk; `null` when it is an orphan (§4.4). */
  contentPath: string | null;
  /** Parse result; `null` for orphans, which are not parsed. */
  result: ManifestParseResult | null;
}

export interface BankScan {
  /** Every folder including the root, depth-first in directory-listing order. */
  folders: ScannedFolder[];
  /** Content file paths as on disk. */
  contentFiles: string[];
  manifests: ScannedManifest[];
  /** Raw bytes of the root `_index.md`, or `null` when it is not a regular file at the root. */
  rootMap: Uint8Array | null;
  /** Violations found while walking: hidden-entry, symlink, special-file, nested-index. */
  violations: Violation[];
}

/** Display form of a bank path in messages: the root is `/`. */
export function shown(p: string): string {
  return p === '' ? '/' : p;
}

/**
 * Walks the bank root and classifies every entry. Throws when `fsPath` itself
 * is not a directory (a symlinked root is refused too) or a directory cannot
 * be listed; a gate treats that as `validator-error` (§9).
 */
export async function scanBank(fsPath: string): Promise<BankScan> {
  const rootStat = await lstat(fsPath);
  if (!rootStat.isDirectory()) {
    throw new Error(`bank root ${fsPath} is not a directory${rootStat.isSymbolicLink() ? ' (symlink)' : ''}`);
  }

  const scan: BankScan = { folders: [], contentFiles: [], manifests: [], rootMap: null, violations: [] };
  const manifestPaths: string[] = [];

  const walk = async (folder: string): Promise<void> => {
    const record: ScannedFolder = { path: folder, depth: folderDepth(folder), contentFiles: 0, subfolders: 0 };
    scan.folders.push(record);
    const dirents = await readdir(join(fsPath, folder), { withFileTypes: true });
    const subfolders: string[] = [];
    for (const d of dirents) {
      const kind: EntryKind = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
      const rel = folder + d.name;
      const shownPath = kind === 'dir' ? rel + '/' : rel;
      switch (classifyEntry(rel, kind)) {
        case 'inbox':
          break;
        case 'hidden-entry':
          scan.violations.push(
            violation('hidden-entry', shownPath, `${shownPath} is hidden (name starts with "."); rename or remove it`),
          );
          break;
        case 'symlink':
          scan.violations.push(violation('symlink', rel, `${rel} is a symlink; replace it with a real file or folder`));
          break;
        case 'special-file':
          scan.violations.push(
            violation('special-file', rel, `${rel} is neither a regular file nor a folder; remove it`),
          );
          break;
        case 'nested-index':
          scan.violations.push(
            violation('nested-index', rel, `${rel}: _index.md is allowed only at the root; move its content to the root map`),
          );
          break;
        case 'root-map':
          scan.rootMap = await readNoFollow(join(fsPath, rel));
          break;
        case 'open-questions':
          break;
        case 'manifest':
          manifestPaths.push(rel);
          break;
        case 'folder':
          record.subfolders++;
          subfolders.push(rel + '/');
          break;
        case 'content':
          record.contentFiles++;
          scan.contentFiles.push(rel);
          break;
      }
    }
    for (const sub of subfolders) await walk(sub);
  };
  await walk('');

  const contentByNfc = new Map(scan.contentFiles.map((p) => [nfc(p), p]));
  for (const path of manifestPaths) {
    const target = contentPathForManifest(path);
    const contentPath = target === null ? null : (contentByNfc.get(nfc(target)) ?? null);
    const result = contentPath === null ? null : parseManifest(await readNoFollow(join(fsPath, path)), path);
    scan.manifests.push({ path, contentPath, result });
  }
  return scan;
}

/**
 * Reads a regular file without following a symlink at the last component, so
 * an entry swapped for a symlink after listing cannot leak data from outside
 * the bank. Parent folders were reached through real directories only.
 */
async function readNoFollow(path: string): Promise<Uint8Array> {
  const handle = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
