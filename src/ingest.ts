import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rawDir } from './bank.js';

export type IngestItem =
  | { kind: 'inline'; content: string; filename?: string }
  | { kind: 'path'; uri: string };

export interface IngestResult {
  rawPath: string;
  sourceLabel: string;
}

export async function ingestOne(bank: string, item: IngestItem): Promise<IngestResult> {
  const dir = rawDir(bank);
  await fs.mkdir(dir, { recursive: true });

  if (item.kind === 'inline') {
    const name = uniqueName(dir, item.filename?.trim() || defaultInlineName());
    const dest = path.join(dir, name);
    await fs.writeFile(dest, item.content, 'utf8');
    return { rawPath: dest, sourceLabel: `inline → _raw/${name}` };
  }

  const uri = item.uri;
  if (uri.startsWith('file://')) {
    const src = fileURLToPath(uri);
    const name = uniqueName(dir, path.basename(src));
    const dest = path.join(dir, name);
    await fs.copyFile(src, dest);
    return { rawPath: dest, sourceLabel: `${uri} → _raw/${name}` };
  }

  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`fetch ${uri} → HTTP ${res.status}`);
    const ct = res.headers.get('content-type');
    const name = uniqueName(dir, deriveNameFromUrl(uri, ct));
    const dest = path.join(dir, name);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    return { rawPath: dest, sourceLabel: `${uri} → _raw/${name}` };
  }

  throw new Error(`Unsupported URI scheme: ${uri}. Expected file:// or http(s)://`);
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
