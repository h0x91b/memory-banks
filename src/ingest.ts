import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rawDir } from './bank.ts';
import { sourceFromDescriptor, type IngestOriginDescriptor, type IngestSource } from './ingest-provenance.ts';

export type IngestItem =
  | { kind: 'inline'; content: string; filename?: string }
  | { kind: 'path'; uri: string };

export interface IngestResult {
  rawPath: string;
  sourceLabel: string;
  /** Final filename inside fs/_raw/ (after sanitizing and dedup). */
  rawName: string;
  /** Where the bytes came from — see ingest-provenance.ts. */
  source: IngestSource;
}

export interface IngestOptions {
  /**
   * Original descriptor of the item when `item` is only a local spool copy
   * (e.g. a durable intake worker). Recorded as the source instead of the
   * spool path, and its filename/URL names the file in _raw/.
   */
  origin?: IngestOriginDescriptor;
}

export async function ingestOne(
  bank: string,
  item: IngestItem,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const dir = rawDir(bank);
  await fs.mkdir(dir, { recursive: true });
  const origin = opts.origin ? sourceFromDescriptor(opts.origin) : undefined;
  const originName = origin ? nameFromSource(origin) : undefined;

  if (item.kind === 'inline') {
    const given = item.filename?.trim() || undefined;
    const name = uniqueName(dir, originName ?? given ?? defaultInlineName());
    const dest = path.join(dir, name);
    await fs.writeFile(dest, item.content, 'utf8');
    const source = origin ?? { type: 'inline' as const, name: given };
    return { rawPath: dest, sourceLabel: `${labelOf(source)} → _raw/${name}`, rawName: name, source };
  }

  const uri = item.uri;
  if (uri.startsWith('file://')) {
    const src = fileURLToPath(uri);
    const name = uniqueName(dir, originName ?? path.basename(src));
    const dest = path.join(dir, name);
    await fs.copyFile(src, dest);
    const source = origin ?? { type: 'file' as const, uri, name: path.basename(src) };
    return { rawPath: dest, sourceLabel: `${labelOf(source)} → _raw/${name}`, rawName: name, source };
  }

  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`fetch ${uri} → HTTP ${res.status}`);
    const ct = res.headers.get('content-type');
    const name = uniqueName(dir, originName ?? deriveNameFromUrl(uri, ct));
    const dest = path.join(dir, name);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    const source = origin
      ? { ...origin, contentType: origin.contentType ?? ct?.trim() ?? undefined }
      : { type: 'url' as const, uri, contentType: ct?.trim() || undefined };
    return { rawPath: dest, sourceLabel: `${labelOf(source)} → _raw/${name}`, rawName: name, source };
  }

  throw new Error(`Unsupported URI scheme: ${uri}. Expected file:// or http(s)://`);
}

function nameFromSource(s: IngestSource): string | undefined {
  if (s.name) return s.name;
  if (s.uri) {
    try {
      return deriveNameFromUrl(s.uri, s.contentType ?? null);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function labelOf(s: IngestSource): string {
  return s.uri ?? (s.name ? `${s.type} (${s.name})` : s.type);
}

function defaultInlineName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `inline-${stamp}.md`;
}

function deriveNameFromUrl(url: string, contentType: string | null): string {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop() ?? 'download';
  if (path.extname(last)) return sanitize(last);
  const ext = guessExt(contentType);
  return sanitize(`${last}${ext}`);
}

function guessExt(ct: string | null): string {
  if (!ct) return '';
  const lc = ct.toLowerCase();
  if (lc.includes('text/html')) return '.html';
  if (lc.includes('text/markdown')) return '.md';
  if (lc.includes('text/plain')) return '.txt';
  if (lc.includes('application/json')) return '.json';
  if (lc.includes('application/pdf')) return '.pdf';
  if (lc.includes('image/png')) return '.png';
  if (lc.includes('image/jpeg')) return '.jpg';
  return '';
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'download';
}

function uniqueName(dir: string, name: string): string {
  let candidate = sanitize(name);
  let i = 1;
  while (existsSync(path.join(dir, candidate))) {
    const ext = path.extname(candidate);
    const base = ext ? candidate.slice(0, -ext.length) : candidate;
    const baseStripped = base.replace(/-\d+$/, '');
    candidate = `${baseStripped}-${i}${ext}`;
    i++;
  }
  return candidate;
}
