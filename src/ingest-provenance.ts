// Source provenance for ingested items: where each file in fs/_raw/ came from.
//
// Provenance is host-owned data. It is recorded in the bank's ingest Git commit
// body and handed to the Librarian as read-only context; it is never written
// into bank files. Only facts the host actually observed are recorded — an
// unknown field stays absent and renders as "unknown", nothing is guessed.

export type IngestSourceType = 'inline' | 'upload' | 'file' | 'url' | 'unknown';

export interface IngestSource {
  type: IngestSourceType;
  /** Original external URI (file:// or http(s)://). Absent for inline/upload content. */
  uri?: string;
  /** Original filename as supplied by the client, before sanitizing/dedup. */
  name?: string;
  /** Media type as declared by the client or reported by the server. */
  contentType?: string;
}

/**
 * Original item descriptor as kept by a durable intake store, so a worker that
 * hands ingestOne() a temporary spool copy can still record the real source.
 * Structural on purpose: it mirrors the intake API vocabulary (text/file/url)
 * without importing the store.
 */
export interface IngestOriginDescriptor {
  kind: 'text' | 'file' | 'url';
  filename?: string | null;
  url?: string | null;
  mediaType?: string | null;
}

export interface IngestProvenance {
  /** Final filename inside fs/_raw/ (after sanitizing and dedup). */
  rawName: string;
  source: IngestSource;
}

const MAX_VALUE_CHARS = 1000;
const SENSITIVE_PARAM_RE = /token|key|sig|secret|pass|auth|credential|session/i;

export function sourceFromDescriptor(d: IngestOriginDescriptor): IngestSource {
  const name = clean(d.filename);
  const contentType = clean(d.mediaType);
  if (d.kind === 'url') {
    const uri = clean(d.url);
    return uri ? { type: 'url', uri, name, contentType } : { type: 'unknown', name, contentType };
  }
  return { type: d.kind === 'file' ? 'upload' : 'inline', name, contentType };
}

const SOURCE_TYPES: ReadonlySet<string> = new Set(['inline', 'upload', 'file', 'url', 'unknown']);

/**
 * Accept a source from a loosely typed caller (e.g. a worker port typed
 * `unknown`): an IngestSource, or an original intake descriptor. Anything that is not a recognisable IngestSource is recorded
 * as type "unknown" rather than guessed.
 */
export function toIngestSource(v: unknown): IngestSource {
  if (!v || typeof v !== 'object') return { type: 'unknown' };
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  if (o.type === undefined && (o.kind === 'text' || o.kind === 'file' || o.kind === 'url')) {
    return sourceFromDescriptor({ kind: o.kind, filename: str(o.filename), url: str(o.url), mediaType: str(o.mediaType) });
  }
  if (typeof o.type !== 'string' || !SOURCE_TYPES.has(o.type)) return { type: 'unknown' };
  return { type: o.type as IngestSourceType, uri: str(o.uri), name: str(o.name), contentType: str(o.contentType) };
}

/**
 * Remove credentials before a URI is persisted or shown to a model:
 * userinfo (user:pass@) and values of query parameters that look like secrets.
 * Unparseable input is returned unchanged apart from length clamping.
 */
export function redactUri(uri: string): string {
  return clamp(redactUrlSecrets(uri));
}

/**
 * Same redaction without length clamping, for projections that must keep a
 * URL whole (API records, job outcomes). A URL with nothing to redact, or one
 * that does not parse, is returned byte-for-byte.
 */
export function redactUrlSecrets(uri: string): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return uri;
  }
  let changed = false;
  if (u.username || u.password) {
    u.username = 'redacted';
    u.password = '';
    changed = true;
  }
  for (const key of [...u.searchParams.keys()]) {
    if (SENSITIVE_PARAM_RE.test(key)) {
      u.searchParams.set(key, 'redacted');
      changed = true;
    }
  }
  return changed ? u.toString() : uri;
}

/** Replace a URL (as given, or as normalised by `new URL`) inside free text with its redacted form. */
export function redactUrlIn(text: string, uri: string): string {
  const shown = redactUrlSecrets(uri);
  const forms = [uri];
  try {
    forms.push(new URL(uri).href);
  } catch {
    // unparseable: only the raw form can appear
  }
  return forms.reduce((t, f) => (f === shown ? t : t.split(f).join(shown)), text);
}

/** One JSON object per entry: control characters are escaped, so a hostile URI or filename cannot forge extra lines. */
export function provenanceRecord(p: IngestProvenance): string {
  const s = p.source;
  const record: Record<string, string> = { type: s.type };
  if (s.uri) record.uri = redactUri(s.uri);
  if (s.name) record.name = clamp(s.name);
  record.contentType = s.contentType ? clamp(s.contentType) : 'unknown';
  return JSON.stringify(record);
}

/**
 * Full ingest commit message: unchanged subject line, a per-file source list,
 * and caller-supplied Git trailers (e.g. a worker's replay guard) kept as the
 * final paragraph so `git interpret-trailers` still finds them.
 */
export function formatIngestCommitMessage(
  entries: IngestProvenance[],
  opts: { trailers?: string[] } = {},
): string {
  const parts = [`ingest: ${entries.length} item(s) into fs/_raw/`];
  if (entries.length) {
    parts.push(['Sources:', ...entries.map((p) => `- fs/_raw/${p.rawName} <- ${provenanceRecord(p)}`)].join('\n'));
  }
  const trailers = (opts.trailers ?? []).filter((t) => t.trim());
  if (trailers.length) parts.push(trailers.join('\n'));
  return parts.join('\n\n');
}

/** Briefing section for the Librarian; empty string when nothing was ingested in this run. */
export function formatProvenanceForBriefing(entries: IngestProvenance[], ingestCommit: string | null): string {
  if (entries.length === 0) return '';
  const where = ingestCommit ? `ingest commit \`${ingestCommit}\`` : 'the ingest commit';
  const lines = [
    '## Source provenance (host-recorded)',
    `Where the files ingested in this run came from. Already recorded in ${where}; read-only facts for your decisions — do not copy them into bank files. Files in \`_raw/\` not listed here have unknown source.`,
    '',
    ...entries.map((p) => `- \`_raw/${p.rawName}\` <- ${provenanceRecord(p)}`),
  ];
  return lines.join('\n');
}

function clean(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function clamp(v: string): string {
  return v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}…` : v;
}
