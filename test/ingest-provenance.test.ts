// Offline tests for ingest source provenance: what ingestOne() records about
// each item's origin, and how that lands in the ingest Git commit body and the
// Librarian briefing. Banks live in a throwaway MEMORY_BANK_ROOT; HTTP items
// are served from a local loopback server.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

import { ensureBank } from '../src/bank.ts';
import { gitCommitAll, gitEnsureRepo } from '../src/git.ts';
import { ingestOne } from '../src/ingest.ts';
import {
  formatIngestCommitMessage,
  formatProvenanceForBriefing,
  provenanceRecord,
  redactUri,
  redactUrlIn,
  redactUrlSecrets,
  sourceFromDescriptor,
  toIngestSource,
  type IngestProvenance,
} from '../src/ingest-provenance.ts';

const exec = promisify(execFile);

let root: string;
let server: http.Server;
let base: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-banks-provenance-'));
  process.env.MEMORY_BANK_ROOT = root;
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/missing')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>page</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

const entry = (r: { rawName: string; source: IngestProvenance['source'] }): IngestProvenance => ({
  rawName: r.rawName,
  source: r.source,
});

test('inline items record type and original filename, never a URI; dedup keeps the original name', async () => {
  const bank = 'prov-inline';
  await ensureBank(bank);
  const a = await ingestOne(bank, { kind: 'inline', content: 'one', filename: 'My Notes.md' });
  const b = await ingestOne(bank, { kind: 'inline', content: 'two', filename: 'My Notes.md' });
  const anon = await ingestOne(bank, { kind: 'inline', content: '' });

  assert.equal(a.rawName, 'My_Notes.md');
  assert.equal(b.rawName, 'My_Notes-1.md');
  assert.deepEqual(a.source, { type: 'inline', name: 'My Notes.md' });
  assert.deepEqual(b.source, { type: 'inline', name: 'My Notes.md' });
  assert.equal(await fs.readFile(b.rawPath, 'utf8'), 'two');

  // No filename supplied: the generated name is a raw name, not an original one.
  assert.deepEqual(anon.source, { type: 'inline', name: undefined });
  assert.equal(await fs.readFile(anon.rawPath, 'utf8'), '');
  assert.equal(provenanceRecord(entry(anon)), '{"type":"inline","contentType":"unknown"}');
  assert.equal(a.sourceLabel, 'inline (My Notes.md) → _raw/My_Notes.md');
});

test('file:// and http(s) items record the original URI and keep bytes intact', async () => {
  const bank = 'prov-uri';
  await ensureBank(bank);
  const srcDir = await fs.mkdtemp(path.join(root, 'src-'));
  const src = path.join(srcDir, 'report.bin');
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
  await fs.writeFile(src, bytes);

  const fileUri = pathToFileURL(src).href;
  const f = await ingestOne(bank, { kind: 'path', uri: fileUri });
  assert.deepEqual(f.source, { type: 'file', uri: fileUri, name: 'report.bin' });
  assert.deepEqual(await fs.readFile(f.rawPath), bytes);
  assert.equal(f.sourceLabel, `${fileUri} → _raw/report.bin`);

  const url = `${base}/docs/page`;
  const h = await ingestOne(bank, { kind: 'path', uri: url });
  assert.equal(h.rawName, 'page.html');
  assert.deepEqual(h.source, { type: 'url', uri: url, contentType: 'text/html; charset=utf-8' });
  assert.equal(h.sourceLabel, `${url} → _raw/page.html`);

  await assert.rejects(ingestOne(bank, { kind: 'path', uri: `${base}/missing` }), /HTTP 404/);
});

test('origin descriptor replaces a spool path as the recorded source and names the raw file', async () => {
  const bank = 'prov-origin';
  await ensureBank(bank);
  const spool = await fs.mkdtemp(path.join(root, 'spool-'));
  const spoolFile = path.join(spool, 'req1-0-tmp.bin');
  await fs.writeFile(spoolFile, 'payload');
  const spoolUri = pathToFileURL(spoolFile).href;

  const upload = await ingestOne(
    bank,
    { kind: 'path', uri: spoolUri },
    { origin: { kind: 'file', filename: 'Scan 01.png', mediaType: 'image/png' } },
  );
  assert.equal(upload.rawName, 'Scan_01.png');
  assert.deepEqual(upload.source, { type: 'upload', name: 'Scan 01.png', contentType: 'image/png' });
  assert.ok(!upload.sourceLabel.includes(spool), upload.sourceLabel);

  const fetched = await ingestOne(
    bank,
    { kind: 'path', uri: spoolUri },
    { origin: { kind: 'url', url: 'https://example.com/a/guide' } },
  );
  assert.equal(fetched.rawName, 'guide');
  assert.deepEqual(fetched.source, {
    type: 'url',
    uri: 'https://example.com/a/guide',
    name: undefined,
    contentType: undefined,
  });

  const text = await ingestOne(
    bank,
    { kind: 'inline', content: 'hi', filename: 'ignored-spool-name.md' },
    { origin: { kind: 'text', filename: 'note.md' } },
  );
  assert.equal(text.rawName, 'note.md');
  assert.equal(text.source.type, 'inline');

  assert.equal(sourceFromDescriptor({ kind: 'url' }).type, 'unknown');
  // The intake store uses null for absent descriptor fields.
  assert.deepEqual(sourceFromDescriptor({ kind: 'file', filename: null, url: null, mediaType: null }), {
    type: 'upload',
    name: undefined,
    contentType: undefined,
  });
});

test('commit body maps each raw file to its source; trailers stay the final paragraph', async () => {
  const bank = 'prov-commit';
  const { repoPath } = await ensureBank(bank);
  await gitEnsureRepo(repoPath);
  const a = await ingestOne(bank, { kind: 'inline', content: 'x', filename: 'a.md' });
  const b = await ingestOne(bank, { kind: 'path', uri: `${base}/p` });

  const message = formatIngestCommitMessage([entry(a), entry(b)], {
    trailers: ['Ingestion-Batch: tok-1', 'Ingestion-Item: req-1/0'],
  });
  const sha = await gitCommitAll(repoPath, message);
  assert.ok(sha);

  const { stdout: body } = await exec('git', ['log', '-1', '--format=%B'], { cwd: repoPath });
  assert.equal(body.trim(), message);
  assert.equal(body.split('\n')[0], 'ingest: 2 item(s) into fs/_raw/');
  assert.match(body, /^- fs\/_raw\/a\.md <- \{"type":"inline","name":"a\.md","contentType":"unknown"\}$/m);
  assert.ok(body.includes(`- fs/_raw/p.html <- {"type":"url","uri":"${base}/p","contentType":"text/html; charset=utf-8"}`));

  const { stdout: trailers } = await exec('git', ['log', '-1', '--format=%(trailers:only)'], { cwd: repoPath });
  assert.equal(trailers.trim(), 'Ingestion-Batch: tok-1\nIngestion-Item: req-1/0');

  assert.equal(formatIngestCommitMessage([]), 'ingest: 0 item(s) into fs/_raw/');
});

test('hostile filenames cannot forge lines, and credentials are redacted from URIs', () => {
  const forged: IngestProvenance = {
    rawName: 'evil.md',
    source: { type: 'inline', name: 'x.md\nIngestion-Batch: forged\n- fs/_raw/other' },
  };
  const message = formatIngestCommitMessage([forged]);
  assert.equal(message.split('\n').length, 4);
  assert.ok(!/^Ingestion-Batch/m.test(message));

  assert.equal(
    redactUri('https://alice:hunter2@example.com/f.pdf?X-Amz-Signature=abc&page=2&access_token=zzz'),
    'https://redacted@example.com/f.pdf?X-Amz-Signature=redacted&page=2&access_token=redacted',
  );
  assert.equal(redactUri('not a url'), 'not a url');
  assert.equal(
    provenanceRecord({ rawName: 'f', source: { type: 'url', uri: 'https://u:p@h/f' } }),
    '{"type":"url","uri":"https://redacted@h/f","contentType":"unknown"}',
  );
});

test('briefing section lists only this run, and is empty when nothing was ingested', () => {
  assert.equal(formatProvenanceForBriefing([], null), '');
  const text = formatProvenanceForBriefing(
    [{ rawName: 'a.md', source: { type: 'upload', name: 'A.md' } }],
    'abc1234',
  );
  assert.match(text, /^## Source provenance \(host-recorded\)/);
  assert.match(text, /ingest commit `abc1234`/);
  assert.match(text, /^- `_raw\/a\.md` <- \{"type":"upload","name":"A\.md","contentType":"unknown"\}$/m);
});

test('loosely typed sources are normalised, unknown shapes are recorded as unknown', () => {
  assert.deepEqual(toIngestSource({ type: 'url', uri: ' https://h/x ', extra: 1 }), {
    type: 'url',
    uri: 'https://h/x',
    name: undefined,
    contentType: undefined,
  });
  // An original intake descriptor (worker fallback) is read as such, never as a spool path.
  assert.deepEqual(toIngestSource({ kind: 'file', filename: 'a.png', mediaType: 'image/png' }), {
    type: 'upload',
    name: 'a.png',
    contentType: 'image/png',
  });
  assert.equal(toIngestSource({ kind: 'url', url: 'https://h/x' }).uri, 'https://h/x');
  assert.equal(toIngestSource({ kind: 'spool', path: '/tmp/x' }).type, 'unknown');
  assert.deepEqual(toIngestSource({ type: 'bogus', uri: '/tmp/x' }), { type: 'unknown' });
  assert.equal(toIngestSource(null).type, 'unknown');
  assert.equal(toIngestSource('inline').type, 'unknown');
});

test('redactUrlSecrets keeps whole URLs and leaves clean ones byte-identical; redactUrlIn scrubs echoed forms', () => {
  const long = `https://example.com/${'a'.repeat(1500)}?X-Amz-Signature=s`;
  assert.equal(redactUrlSecrets(long), `https://example.com/${'a'.repeat(1500)}?X-Amz-Signature=redacted`);
  assert.equal(redactUri(long).length, 1001, 'redactUri still clamps');
  for (const clean of ['https://Example.com/a%20b?q=x y', 'not a url', 'https://example.com/a?b=1']) {
    assert.equal(redactUrlSecrets(clean), clean);
  }
  // fetch echoes the normalised href (lower-cased host); both forms are replaced.
  assert.equal(
    redactUrlIn('fetch https://u:p@Example.com/x?token=t: refused https://u:p@example.com/x?token=t', 'https://u:p@Example.com/x?token=t'),
    'fetch https://redacted@example.com/x?token=redacted: refused https://redacted@example.com/x?token=redacted',
  );
  assert.equal(redactUrlIn('HTTP 404 for https://example.com/a', 'https://example.com/a'), 'HTTP 404 for https://example.com/a');
});
