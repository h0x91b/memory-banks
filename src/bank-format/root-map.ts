// Root map `/_index.md`: grammar parser (contract §5.1, the text-only part of
// §5.2). Coverage against the real folder list (`map-missing`, `map-stale`)
// needs the filesystem and belongs to the validator; `map-file-missing` too.
import {
  FOLDER_DESC_MAX,
  FOLDERS_HEADING,
  INBOX_DIRS,
  MAP_MAX,
  MAP_TITLE_MAX,
  OVERVIEW_MAX,
  ROOT_MAP_FILE,
} from './constants.ts';
import { compareFolderPaths, isValidFolderPath, pathSegments } from './paths.ts';
import { codePointLength, hasForbiddenChars, nfc } from './text.ts';
import { violation, type Violation } from './violations.ts';

/** Map line regex from §5.1; separator is space, U+2014 EM DASH, space. */
export const MAP_LINE_RE = /^- `([^`\n]+\/)` — (.+)$/;

export interface RootMapEntry {
  /** Folder path exactly as written (not normalized), ends with `/`. */
  path: string;
  /** Trimmed description. */
  description: string;
  /** 1-based line number in the file. */
  line: number;
}

export interface RootMap {
  /** Text after `# `, or `null` when line 1 is not a valid title line. */
  title: string | null;
  /** Overview lines joined with `\n`, outer blank lines removed. */
  overview: string;
  /**
   * Usable map lines in file order: syntactically valid, not reserved, first
   * occurrence of each NFC path. Lines with an over-long description are kept.
   */
  entries: RootMapEntry[];
  /** Grammar violations; never `map-missing`, `map-stale` or `map-file-missing`. */
  violations: Violation[];
}

/**
 * Parses the root map text. Tolerant: always returns whatever it could read,
 * with every grammar problem as a violation. File-level violations carry
 * `path: '_index.md'`; per-line ones carry the folder path when one could be
 * read, otherwise `_index.md` with the offending line as `detail`.
 */
export function parseRootMap(input: string): RootMap {
  const violations: Violation[] = [];
  const structure = (message: string, extra: Pick<Violation, 'detail' | 'value' | 'limit'> = {}) =>
    violations.push(violation('map-structure', ROOT_MAP_FILE, message, extra));

  const size = codePointLength(input);
  if (size > MAP_MAX) {
    violations.push(
      violation('map-size', ROOT_MAP_FILE, `${ROOT_MAP_FILE} is ${size} code points (budget ${MAP_MAX})`, {
        value: size,
        limit: MAP_MAX,
      }),
    );
  }

  let text = input;
  if (text.startsWith('\uFEFF')) {
    structure(`${ROOT_MAP_FILE} starts with a byte order mark (BOM)`, { detail: 'bom' });
    text = text.slice(1);
  }
  if (text.includes('\r')) {
    structure(`${ROOT_MAP_FILE} must use LF line endings`, { detail: 'crlf' });
    text = text.replace(/\r\n?/g, '\n');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  let title: string | null = null;
  const titleMatch = /^# (.*)$/.exec(lines[0] ?? '');
  const rawTitle = titleMatch?.[1].trim() ?? '';
  const titleLength = codePointLength(rawTitle);
  if (!titleMatch || rawTitle === '' || hasForbiddenChars(rawTitle) || titleLength > MAP_TITLE_MAX) {
    structure(
      titleMatch && titleLength > MAP_TITLE_MAX
        ? `title is ${titleLength} code points (limit ${MAP_TITLE_MAX})`
        : `line 1 must be "# <bank title>"`,
      { detail: 'title' },
    );
  } else {
    title = rawTitle;
  }

  const headingLines = lines.flatMap((l, i) => (l === FOLDERS_HEADING ? [i] : []));
  if (headingLines.length === 0) structure(`missing "${FOLDERS_HEADING}" line`, { detail: 'folders-heading' });
  if (headingLines.length > 1) {
    structure(`"${FOLDERS_HEADING}" appears ${headingLines.length} times (exactly once allowed)`, {
      detail: 'folders-heading',
    });
  }
  const foldersAt = headingLines[0] ?? lines.length;

  const overviewLines = lines.slice(1, foldersAt);
  for (const l of overviewLines) {
    if (l.startsWith('#')) structure(`heading inside the overview: "${l}"`, { detail: 'overview-heading' });
  }
  if (overviewLines.every((l) => l.trim() === '')) structure('overview is empty', { detail: 'overview' });
  const overviewLength = overviewLines.reduce((n, l) => n + codePointLength(l), 0);
  if (overviewLength > OVERVIEW_MAX) {
    structure(`overview is ${overviewLength} code points (limit ${OVERVIEW_MAX})`, {
      detail: 'overview',
      value: overviewLength,
      limit: OVERVIEW_MAX,
    });
  }
  const overview = overviewLines.join('\n').trim();

  const entries: RootMapEntry[] = [];
  const seen = new Set<string>();
  for (let i = foldersAt + 1; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.trim() === '' || raw === FOLDERS_HEADING) continue;
    if (raw.startsWith('#')) {
      structure(`line ${lineNo}: no other sections allowed after "${FOLDERS_HEADING}"`, { detail: raw });
      continue;
    }
    const syntax = (why: string) =>
      violations.push(
        violation('map-line-syntax', ROOT_MAP_FILE, `line ${lineNo}: ${why}: ${raw}`, { detail: raw }),
      );
    const m = MAP_LINE_RE.exec(raw);
    if (!m) {
      syntax('expected "- `<folder>/` — <description>"');
      continue;
    }
    const [, path, rawDescription] = m;
    if (path === '' || !isValidFolderPath(path)) {
      syntax(`malformed folder path "${path}"`);
      continue;
    }
    const description = rawDescription.trim();
    if (description === '' || hasForbiddenChars(description)) {
      syntax('description is empty or has control characters');
      continue;
    }
    if (INBOX_DIRS.includes(pathSegments(path)[0])) {
      violations.push(
        violation('map-reserved', path, `line ${lineNo}: ${path} is an inbox and must not be in the map`),
      );
      continue;
    }
    const key = nfc(path);
    if (seen.has(key)) {
      violations.push(violation('map-duplicate', path, `line ${lineNo}: second line for ${path}`));
      continue;
    }
    seen.add(key);
    const descLength = codePointLength(description);
    if (descLength > FOLDER_DESC_MAX) {
      violations.push(
        violation(
          'map-desc-too-long',
          path,
          `line ${lineNo}: description of ${path} is ${descLength} code points (limit ${FOLDER_DESC_MAX})`,
          { value: descLength, limit: FOLDER_DESC_MAX },
        ),
      );
    }
    entries.push({ path, description, line: lineNo });
  }

  const outOfOrder = entries.findIndex((e, k) => k > 0 && compareFolderPaths(entries[k - 1].path, e.path) > 0);
  if (outOfOrder > 0) {
    const e = entries[outOfOrder];
    violations.push(
      violation(
        'map-order',
        ROOT_MAP_FILE,
        `line ${e.line}: ${e.path} is out of order (expected depth-first, siblings sorted by code points)`,
      ),
    );
  }

  return { title, overview, entries, violations };
}
