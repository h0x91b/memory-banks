// Bank-relative paths (contract §1) and per-entry classification (§2). Pure
// string functions: nothing here touches the filesystem.
import {
  INBOX_DIRS,
  MANIFEST_SUFFIX,
  OPEN_QUESTIONS_FILE,
  ROOT_MAP_FILE,
} from './constants.ts';
import { compareCodePoints, hasForbiddenChars, nfc } from './text.ts';

function segmentsValid(segments: string[]): boolean {
  return segments.every(
    (s) => s !== '' && s !== '.' && s !== '..' && !s.includes('\\') && !hasForbiddenChars(s),
  );
}

/**
 * Folder path per §1: relative, ends with `/`, no empty, `.` or `..` segments.
 * The root folder is the empty string.
 */
export function isValidFolderPath(p: string): boolean {
  if (p === '') return true;
  if (!p.endsWith('/') || p.startsWith('/')) return false;
  return segmentsValid(p.slice(0, -1).split('/'));
}

/** File path per §1: relative, does not end with `/`, no empty, `.` or `..` segments. */
export function isValidFilePath(p: string): boolean {
  if (p === '' || p.endsWith('/') || p.startsWith('/')) return false;
  return segmentsValid(p.split('/'));
}

/** Path segments without the trailing slash: `a/b/` → `['a', 'b']`, root → `[]`. */
export function pathSegments(p: string): string[] {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  return trimmed === '' ? [] : trimmed.split('/');
}

/** Folder depth: root = 0, `work/` = 1, `a/b/c/` = 3. */
export function folderDepth(folderPath: string): number {
  return pathSegments(folderPath).length;
}

/** Folder that directly contains a file or folder path; `''` for root-level entries. */
export function parentFolder(p: string): string {
  const segments = pathSegments(p);
  return segments.length <= 1 ? '' : segments.slice(0, -1).join('/') + '/';
}

/** `recipes/borscht.md` → `recipes/borscht.md.manifest.json`. */
export function manifestPathFor(contentPath: string): string {
  return contentPath + MANIFEST_SUFFIX;
}

export function isManifestPath(p: string): boolean {
  return p.endsWith(MANIFEST_SUFFIX);
}

/** Inverse of manifestPathFor; `null` when the path is not a manifest name. */
export function contentPathForManifest(manifestPath: string): string | null {
  if (!isManifestPath(manifestPath)) return null;
  const content = manifestPath.slice(0, -MANIFEST_SUFFIX.length);
  return content === '' || content.endsWith('/') ? null : content;
}

/**
 * Root map order (§5.1): depth-first pre-order, siblings by NFC code points of
 * the segment. Equivalent to comparing segment lists lexicographically, a
 * parent sorting before its children.
 */
export function compareFolderPaths(a: string, b: string): number {
  const sa = pathSegments(nfc(a));
  const sb = pathSegments(nfc(b));
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const d = compareCodePoints(sa[i], sb[i]);
    if (d !== 0) return d;
  }
  return sa.length - sb.length;
}

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other';

/**
 * Class of one bank entry, first matching row of §2. The four violation
 * classes carry the violation code they produce.
 */
export type EntryClass =
  | 'inbox'
  | 'hidden-entry'
  | 'symlink'
  | 'special-file'
  | 'root-map'
  | 'nested-index'
  | 'open-questions'
  | 'manifest'
  | 'folder'
  | 'content';

/**
 * Classifies an entry by its bank-relative path and filesystem kind (from
 * lstat, so symlinks are not followed). A trailing `/` on folder paths is
 * optional here. Inbox wins over everything, so a walker can skip its subtree.
 */
export function classifyEntry(p: string, kind: EntryKind): EntryClass {
  const segments = pathSegments(p);
  const insideInbox = segments.length > 1 || kind === 'dir';
  if (insideInbox && INBOX_DIRS.includes(segments[0])) return 'inbox';
  if (segments.some((s) => s.startsWith('.'))) return 'hidden-entry';
  if (kind === 'symlink') return 'symlink';
  if (kind === 'other') return 'special-file';
  if (kind === 'dir') return 'folder';
  const name = segments[segments.length - 1] ?? '';
  const atRoot = segments.length === 1;
  if (name === ROOT_MAP_FILE) return atRoot ? 'root-map' : 'nested-index';
  if (name === OPEN_QUESTIONS_FILE && atRoot) return 'open-questions';
  if (isManifestPath(name)) return 'manifest';
  return 'content';
}
