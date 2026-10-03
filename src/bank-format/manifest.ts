// Manifest sidecar: schema and parser (contract §4.2–§4.4).
import * as v from 'valibot';
import {
  GLOSSARY_DESC_MAX,
  GLOSSARY_ENTRIES_MAX,
  KEYWORD_MAX,
  KEYWORDS_MAX,
  MANIFEST_MAX_BYTES,
  SEPARATOR,
  TERM_MAX,
  TITLE_MAX,
} from './constants.ts';
import { codePointLength, hasEdgeWhitespace, hasForbiddenChars } from './text.ts';
import { violation, type Violation } from './violations.ts';

/** A string limited by §4.3: 1..max code points (NFC), no edge whitespace, no forbidden characters. */
function limitedString(max: number) {
  return v.pipe(
    v.string('must be a string'),
    v.check((s) => s.length > 0, 'must not be empty'),
    v.check(
      (s) => codePointLength(s) <= max,
      (issue) => `is ${codePointLength(issue.input)} code points (limit ${max})`,
    ),
    v.check((s) => !hasEdgeWhitespace(s), 'must not start or end with whitespace'),
    v.check((s) => !hasForbiddenChars(s), 'must not contain control characters or line breaks'),
  );
}

const TermSchema = v.pipe(
  limitedString(TERM_MAX),
  v.check((s) => !s.includes(SEPARATOR), `must not contain "${SEPARATOR}"`),
);

/**
 * The glossary is turned into a Map before validation: a plain object (and
 * valibot's `record`, which silently drops keys named `__proto__`,
 * `constructor` and `prototype`) cannot hold every term safely.
 */
const GlossarySchema = v.pipe(
  v.custom<Record<string, unknown>>(
    (x) => typeof x === 'object' && x !== null && !Array.isArray(x),
    'must be an object',
  ),
  v.transform((o) => new Map(Object.entries(o))),
  v.map(TermSchema, limitedString(GLOSSARY_DESC_MAX)),
  v.check(
    (m) => m.size <= GLOSSARY_ENTRIES_MAX,
    (issue) => `has ${issue.input.size} entries (limit ${GLOSSARY_ENTRIES_MAX})`,
  ),
);

export const ManifestSchema = v.strictObject({
  title: limitedString(TITLE_MAX),
  keywords: v.pipe(
    v.array(limitedString(KEYWORD_MAX), 'must be an array'),
    v.check(
      (a) => a.length <= KEYWORDS_MAX,
      (issue) => `has ${issue.input.length} items (limit ${KEYWORDS_MAX})`,
    ),
  ),
  glossary: GlossarySchema,
});

/** Parsed manifest. `glossary` is a Map so that any term, `__proto__` included, is safe. */
export type Manifest = v.InferOutput<typeof ManifestSchema>;

export type ManifestParseResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; violations: Violation[] };

/**
 * Parses one manifest file. Pass the raw bytes when reading from disk so that
 * UTF-8 validity and a BOM are detected; a string is treated as already
 * decoded. `manifestPath` only fills `Violation.path`.
 *
 * Checks in order, stopping at the first failing stage: size (`manifest-size`),
 * encoding and strict JSON incl. duplicate keys (`manifest-json`), then shape
 * and limits (`manifest-schema`, one violation per failing field, `detail` =
 * dotted field such as `glossary.LIPO` or `keywords.3`).
 */
export function parseManifest(input: Uint8Array | string, manifestPath = ''): ManifestParseResult {
  const fail = (...violations: Violation[]): ManifestParseResult => ({ ok: false, violations });
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;

  if (bytes.length > MANIFEST_MAX_BYTES) {
    return fail(
      violation(
        'manifest-size',
        manifestPath,
        `${manifestPath || 'manifest'} is ${bytes.length} bytes (limit ${MANIFEST_MAX_BYTES})`,
        { value: bytes.length, limit: MANIFEST_MAX_BYTES },
      ),
    );
  }

  const jsonError = (why: string) =>
    fail(violation('manifest-json', manifestPath, `${manifestPath || 'manifest'}: ${why}`));

  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      return jsonError('not valid UTF-8');
    }
  }
  if (text.startsWith('\uFEFF')) return jsonError('starts with a byte order mark (BOM)');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return jsonError(`invalid JSON (${(e as Error).message})`);
  }
  const duplicate = findDuplicateKey(text);
  if (duplicate) return jsonError(`duplicate key ${JSON.stringify(duplicate)}`);

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail(violation('manifest-schema', manifestPath, `${manifestPath || 'manifest'}: must be a JSON object`));
  }
  const result = v.safeParse(ManifestSchema, data, { abortPipeEarly: true });
  if (result.success) return { ok: true, manifest: result.output };

  return fail(
    ...result.issues.map((issue) => {
      const field = issueField(issue);
      // strict_object reports both unknown keys (expected `never`) and missing ones.
      const message =
        issue.type !== 'strict_object'
          ? issue.message
          : issue.expected === 'never'
            ? 'is not an allowed key (only title, keywords, glossary)'
            : 'is missing';
      return violation(
        'manifest-schema',
        manifestPath,
        `${manifestPath || 'manifest'}: ${field || '(root)'} ${message}`,
        field ? { detail: field } : {},
      );
    }),
  );
}

/** Dotted field path of a valibot issue; map keys and object keys are used as-is. */
function issueField(issue: v.BaseIssue<unknown>): string {
  return (issue.path ?? []).map((item) => String((item as { key: unknown }).key)).join('.');
}

/**
 * First object key that appears twice in one object, at any depth, or `null`.
 * `JSON.parse` silently keeps the last value, so duplicates are found by a
 * separate scan. Expects text that `JSON.parse` already accepted.
 */
export function findDuplicateKey(text: string): string | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const readString = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): string | null => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return null;
      }
      for (;;) {
        ws();
        const key = readString();
        if (seen.has(key)) return key;
        seen.add(key);
        ws();
        i++; // ':'
        const dup = value();
        if (dup !== null) return dup;
        ws();
        if (text[i++] === '}') return null; // else ','
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return null;
      }
      for (;;) {
        const dup = value();
        if (dup !== null) return dup;
        ws();
        if (text[i++] === ']') return null; // else ','
      }
    }
    if (c === '"') {
      readString();
      return null;
    }
    while (i < text.length && !',]} \t\n\r'.includes(text[i])) i++;
    return null;
  };
  return value();
}
