import { crc32, inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { defineCommand, type Command, type ExecResult, type IFileSystem } from 'just-bash';

/**
 * Document-reading commands for the bank sandbox (src/bash-factory.ts):
 * `unzip` and `pdftotext`. just-bash 3.x ships `tar` (with gzip/bzip2/xz/zstd)
 * but neither of these, so the Librarian could not look inside the two most
 * common attachment formats.
 *
 * Both run in the host process on bytes read through the sandbox filesystem
 * and write only through it, so containment is still ReadWriteFs's job; the
 * rules here are the archive-specific ones it cannot know about.
 */

/** Hard caps. Exported so tests and the role doc talk about the same numbers. */
export const DOCUMENT_LIMITS = {
  /** Largest ZIP file `unzip` will open. */
  zipArchiveBytes: 100 * 1024 * 1024,
  /** Most entries (files + directories) one archive may hold. */
  zipEntries: 2000,
  /** Largest single decompressed file. */
  zipEntryBytes: 50 * 1024 * 1024,
  /** Sum of all decompressed files in one `unzip` call. */
  zipTotalBytes: 100 * 1024 * 1024,
  /** Largest PDF `pdftotext` will open. */
  pdfBytes: 50 * 1024 * 1024,
  /** Most pages extracted in one call; the rest are reported, not read. */
  pdfPages: 500,
  /** Most characters of text one call produces. */
  pdfTextChars: 5 * 1024 * 1024,
} as const;

const ok = (stdout: string, stderr = '', exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });
const fail = (cmd: string, message: string, exitCode = 1): ExecResult => ok('', `${cmd}: ${message}\n`, exitCode);
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- unzip ----

export interface ZipEntry {
  /** Name as stored, with `\` turned into `/`. */
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  modified: Date;
}

/** Why an entry is not extracted, or null when it is safe to write. */
export function unsafeZipEntryReason(e: ZipEntry): string | null {
  if (!e.name || e.name.includes('\0')) return 'empty or invalid name';
  if (e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name)) return 'absolute path';
  if (e.name.split('/').includes('..')) return "path contains '..'";
  if (e.isSymlink) return 'symbolic link (not extracted)';
  if (e.flags & 0x1) return 'encrypted entry (not supported)';
  if (!e.isDirectory && e.method !== 0 && e.method !== 8) return `compression method ${e.method} (only stored and deflate are supported)`;
  return null;
}

function dosDate(date: number, time: number): Date {
  return new Date(
    1980 + (date >> 9),
    ((date >> 5) & 0xf) - 1,
    date & 0x1f,
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

/** Parse the central directory. Throws on anything that is not a plain ZIP. */
export function readZipDirectory(buf: Uint8Array): ZipEntry[] {
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: 22 bytes + up to 64 KiB of comment, scanned backwards.
  let eocd = -1;
  for (let i = view.length - 22; i >= Math.max(0, view.length - 22 - 0xffff); i--) {
    if (view.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = view.readUInt16LE(eocd + 10);
  const cdSize = view.readUInt32LE(eocd + 12);
  const cdOffset = view.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  if (view.readUInt16LE(eocd + 4) !== 0 || view.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('multi-part (spanned) archives are not supported');
  }
  if (count > DOCUMENT_LIMITS.zipEntries) {
    throw new Error(`archive has ${count} entries, more than the ${DOCUMENT_LIMITS.zipEntries} allowed`);
  }
  if (cdOffset + cdSize > eocd) throw new Error('corrupt central directory');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || view.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const madeBy = view.readUInt16LE(p + 4) >> 8;
    const flags = view.readUInt16LE(p + 8);
    const method = view.readUInt16LE(p + 10);
    const time = view.readUInt16LE(p + 12);
    const date = view.readUInt16LE(p + 14);
    const crc = view.readUInt32LE(p + 16);
    const compressedSize = view.readUInt32LE(p + 20);
    const size = view.readUInt32LE(p + 24);
    const nameLen = view.readUInt16LE(p + 28);
    const extraLen = view.readUInt16LE(p + 30);
    const commentLen = view.readUInt16LE(p + 32);
    const external = view.readUInt32LE(p + 38);
    const localHeaderOffset = view.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported');
    }
    const rawName = view.subarray(p + 46, p + 46 + nameLen);
    // Bit 11 = UTF-8; otherwise CP437, which matches ASCII for every name that matters here.
    const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    entries.push({
      name,
      isDirectory: name.endsWith('/') || (unixMode & 0o170000) === 0o040000 || (external & 0x10) !== 0,
      isSymlink: (unixMode & 0o170000) === 0o120000,
      method,
      flags,
      crc,
      compressedSize,
      size,
      localHeaderOffset,
      modified: dosDate(date, time),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry, checking its size and CRC against the directory. */
function readZipEntryData(buf: Buffer, e: ZipEntry): Buffer {
  const h = e.localHeaderOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new Error('corrupt local header');
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new Error('truncated entry');
  const body = buf.subarray(start, end);
  // maxOutputLength makes zlib stop at the declared size, so a lying header cannot inflate past it.
  const data = e.method === 0 ? body : inflateRawSync(body, { maxOutputLength: Math.max(1, e.size) });
  if (data.length !== e.size) throw new Error('size does not match the archive directory');
  if (crc32(data) !== e.crc) throw new Error('CRC mismatch (corrupt entry)');
  return data;
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const two = (n: number) => String(n).padStart(2, '0');
const listDate = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

function listZip(archive: string, entries: ZipEntry[]): string {
  const lines = [`Archive:  ${archive}`, '  Length      Date    Time    Name', '---------  ---------- -----   ----'];
  let total = 0;
  for (const e of entries) {
    total += e.size;
    const why = unsafeZipEntryReason(e);
    lines.push(`${pad(e.size, 9)}  ${listDate(e.modified)}   ${e.name}${why ? `   [skipped on extract: ${why}]` : ''}`);
  }
  lines.push('---------                     -------', `${pad(total, 9)}                     ${entries.length} file${entries.length === 1 ? '' : 's'}`);
  return `${lines.join('\n')}\n`;
}

async function isDir(fs: IFileSystem, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

const UNZIP_USAGE = `Usage: unzip [-l] [-o|-n] [-q] ARCHIVE.zip [MEMBER...] [-d DIR]
  -l       list entries without extracting
  -d DIR   extract into DIR (created if missing; default: current directory)
  -o       overwrite existing files
  -n       never overwrite existing files (skip them quietly)
  -q       quiet: do not print each extracted file
Without -o or -n an existing file is kept and reported as skipped.
Supported: stored and deflate entries. Not supported: encryption, ZIP64,
multi-part archives, other compression methods. Symlinks and entries with
absolute or '..' paths are never extracted. Nested archives are extracted as
plain files and are not expanded.
`;

export const unzipCommand: Command = defineCommand('unzip', async (args, ctx) => {
  let list = false;
  let overwrite: 'ask' | 'always' | 'never' = 'ask';
  let quiet = false;
  let dest: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return ok(UNZIP_USAGE);
    if (a === '-d') {
      dest = args[++i];
      if (dest === undefined) return fail('unzip', '-d needs a directory', 10);
    } else if (/^-[loqn]+$/.test(a)) {
      for (const f of a.slice(1)) {
        if (f === 'l') list = true;
        else if (f === 'o') overwrite = 'always';
        else if (f === 'n') overwrite = 'never';
        else quiet = true;
      }
    } else if (a.startsWith('-') && a !== '-') {
      return fail('unzip', `unsupported option ${a}\n${UNZIP_USAGE}`, 10);
    } else positional.push(a);
  }
  const [archive, ...members] = positional;
  if (!archive) return fail('unzip', `missing archive\n${UNZIP_USAGE}`, 10);

  const archivePath = ctx.fs.resolvePath(ctx.cwd, archive);
  let buf: Buffer;
  try {
    const st = await ctx.fs.stat(archivePath);
    if (!st.isFile) return fail('unzip', `${archive}: not a regular file`, 9);
    if (st.size > DOCUMENT_LIMITS.zipArchiveBytes) {
      return fail('unzip', `${archive}: ${st.size} bytes, larger than the ${DOCUMENT_LIMITS.zipArchiveBytes}-byte limit`, 9);
    }
    buf = Buffer.from(await ctx.fs.readFileBuffer(archivePath));
  } catch (e) {
    return fail('unzip', `cannot open ${archive}: ${errMessage(e)}`, 9);
  }

  let entries: ZipEntry[];
  try {
    entries = readZipDirectory(buf);
  } catch (e) {
    return fail('unzip', `${archive}: ${errMessage(e)}`, 9);
  }
  if (members.length) {
    const wanted = new Set(members);
    entries = entries.filter((e) => wanted.has(e.name));
    const missing = members.filter((m) => !entries.some((e) => e.name === m));
    if (missing.length && !entries.length) return fail('unzip', `${archive}: no such member(s): ${missing.join(', ')}`, 11);
  }
  if (list) return ok(listZip(archive, entries));

  // Bound the work before writing anything: the directory's sizes are checked
  // here and then enforced while inflating, so a lying header fails per entry.
  const safe = entries.filter((e) => !unsafeZipEntryReason(e));
  const total = safe.reduce((n, e) => n + (e.isDirectory ? 0 : e.size), 0);
  const tooBig = safe.find((e) => e.size > DOCUMENT_LIMITS.zipEntryBytes);
  if (tooBig) {
    return fail('unzip', `${archive}: ${tooBig.name} is ${tooBig.size} bytes, larger than the ${DOCUMENT_LIMITS.zipEntryBytes}-byte per-file limit; nothing extracted`, 9);
  }
  if (total > DOCUMENT_LIMITS.zipTotalBytes) {
    return fail('unzip', `${archive}: ${total} bytes uncompressed, more than the ${DOCUMENT_LIMITS.zipTotalBytes}-byte limit; nothing extracted`, 9);
  }

  const root = ctx.fs.resolvePath(ctx.cwd, dest ?? '.');
  const out: string[] = [`Archive:  ${archive}`];
  const warnings: string[] = [];
  try {
    await ctx.fs.mkdir(root, { recursive: true });
  } catch (e) {
    return fail('unzip', `cannot create ${dest}: ${errMessage(e)}`, 9);
  }
  let extracted = 0;
  for (const e of entries) {
    if (ctx.signal?.aborted) return fail('unzip', 'aborted', 130);
    const why = unsafeZipEntryReason(e);
    if (why) {
      warnings.push(`unzip: skipping ${JSON.stringify(e.name)}: ${why}`);
      continue;
    }
    const rel = posix.normalize(e.name).replace(/\/+$/, '');
    if (rel === '.' || rel === '') continue;
    const target = posix.join(root, rel);
    try {
      if (e.isDirectory) {
        await ctx.fs.mkdir(target, { recursive: true });
        if (!quiet) out.push(`   creating: ${posix.relative(ctx.cwd, target) || target}/`);
        continue;
      }
      if (await ctx.fs.exists(target)) {
        if (await isDir(ctx.fs, target)) {
          warnings.push(`unzip: skipping ${e.name}: a directory with that name exists`);
          continue;
        }
        if (overwrite === 'never') continue;
        if (overwrite === 'ask') {
          warnings.push(`unzip: skipping ${e.name}: file exists (use -o to overwrite, -n to skip quietly)`);
          continue;
        }
      }
      const data = readZipEntryData(buf, e);
      await ctx.fs.mkdir(posix.dirname(target), { recursive: true });
      await ctx.fs.writeFile(target, data);
      extracted++;
      if (!quiet) out.push(`  inflating: ${posix.relative(ctx.cwd, target) || target}`);
    } catch (err) {
      warnings.push(`unzip: ${e.name}: ${errMessage(err)}`);
    }
  }
  const stdout = quiet ? '' : `${out.join('\n')}\n`;
  const stderr = warnings.length ? `${warnings.join('\n')}\n` : '';
  return ok(stdout, stderr, warnings.length ? (extracted ? 1 : 2) : 0);
});

// ------------------------------------------------------------ pdftotext ----

const PDFTOTEXT_USAGE = `Usage: pdftotext [-f FIRST] [-l LAST] FILE.pdf [OUT.txt | -]
  -f N   first page to extract (default 1)
  -l N   last page to extract (default: last page)
  OUT    output file (default: FILE with .pdf replaced by .txt); '-' prints to stdout
Each page starts with a line "--- page N of TOTAL ---". A page with no text
layer is marked "(no extractable text on this page)". If no selected page has
text the PDF is scanned or image-only: nothing is written and the exit code is
3. OCR is not available. Encrypted PDFs are not supported.
`;

/** Text of every page in [first, last], one entry per page (empty string = no text layer). */
async function extractPdfPages(
  data: Uint8Array,
  first: number,
  last: number | undefined,
  signal?: AbortSignal,
): Promise<{ total: number; first: number; pages: string[]; truncated: string | null }> {
  // Loaded on first use: pdf.js is ~1.6 MB and most runs never see a PDF.
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(data, {
    // Text only: no font loading and no system font lookups. (The bundled pdf.js 5
    // has no eval/new Function path left, which was the CVE-2024-4367 vector.)
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const total = doc.numPages;
    if (first > total) throw new RangeError(`-f ${first} but the PDF has ${total} page(s)`);
    const end = Math.min(last ?? total, total);
    const pages: string[] = [];
    let chars = 0;
    let truncated: string | null = null;
    for (let n = first; n <= end; n++) {
      if (signal?.aborted) throw new Error('aborted');
      if (pages.length >= DOCUMENT_LIMITS.pdfPages) {
        truncated = `stopped after ${DOCUMENT_LIMITS.pdfPages} pages (limit); pages ${n}-${end} not extracted, use -f ${n} to continue`;
        break;
      }
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      page.cleanup();
      text = text.replace(/[ \t]+\n/g, '\n').trim();
      if (chars + text.length > DOCUMENT_LIMITS.pdfTextChars) {
        truncated = `stopped at page ${n}: more than ${DOCUMENT_LIMITS.pdfTextChars} characters of text (limit); use -f ${n} to continue`;
        break;
      }
      chars += text.length;
      pages.push(text);
    }
    return { total, first, pages, truncated };
  } finally {
    await doc.loadingTask.destroy();
  }
}

function pageNumber(v: string | undefined): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 ? n : null;
}

export const pdftotextCommand: Command = defineCommand('pdftotext', async (args, ctx) => {
  let first = 1;
  let last: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return ok(PDFTOTEXT_USAGE);
    if (a === '-f' || a === '-l') {
      const n = pageNumber(args[++i]);
      if (n === null) return fail('pdftotext', `${a} needs a page number >= 1`, 99);
      if (a === '-f') first = n;
      else last = n;
    } else if (a.startsWith('-') && a !== '-') {
      return fail('pdftotext', `unsupported option ${a}\n${PDFTOTEXT_USAGE}`, 99);
    } else positional.push(a);
  }
  const [input, output, extra] = positional;
  if (!input || extra !== undefined) return fail('pdftotext', `expected FILE.pdf [OUT.txt | -]\n${PDFTOTEXT_USAGE}`, 99);
  if (last !== undefined && last < first) return fail('pdftotext', `-l ${last} is before -f ${first}`, 99);

  const inputPath = ctx.fs.resolvePath(ctx.cwd, input);
  let data: Uint8Array;
  try {
    const st = await ctx.fs.stat(inputPath);
    if (!st.isFile) return fail('pdftotext', `${input}: not a regular file`, 1);
    if (st.size > DOCUMENT_LIMITS.pdfBytes) {
      return fail('pdftotext', `${input}: ${st.size} bytes, larger than the ${DOCUMENT_LIMITS.pdfBytes}-byte limit`, 1);
    }
    data = new Uint8Array(await ctx.fs.readFileBuffer(inputPath));
  } catch (e) {
    return fail('pdftotext', `cannot open ${input}: ${errMessage(e)}`, 1);
  }

  let result: Awaited<ReturnType<typeof extractPdfPages>>;
  try {
    result = await extractPdfPages(data, first, last, ctx.signal);
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'PasswordException') return fail('pdftotext', `${input}: encrypted PDF, text cannot be extracted`, 1);
    if (e instanceof RangeError) return fail('pdftotext', `${input}: ${e.message}`, 99);
    if (name === 'InvalidPDFException') return fail('pdftotext', `${input}: not a valid PDF (${errMessage(e)})`, 1);
    return fail('pdftotext', `${input}: ${errMessage(e)}`, 1);
  }
  const { total, pages, truncated } = result;

  if (!pages.some((t) => t.length > 0)) {
    const range = pages.length === total ? `any of its ${total} page(s)` : `pages ${first}-${first + pages.length - 1} of ${total}`;
    return fail(
      'pdftotext',
      `${input}: no extractable text on ${range}. It is most likely a scanned or image-only PDF. OCR is not available here, so its contents cannot be read; describe it only from its name and context.`,
      3,
    );
  }

  const text = pages
    .map((t, i) => `--- page ${first + i} of ${total} ---\n${t.length ? t : '(no extractable text on this page)'}\n`)
    .join('\n');
  const notes: string[] = [];
  const empty = pages.flatMap((t, i) => (t.length ? [] : [first + i]));
  if (empty.length) notes.push(`pdftotext: note: no text layer on page(s) ${empty.join(', ')} (scanned or image-only; OCR is not available)`);
  if (truncated) notes.push(`pdftotext: warning: ${truncated}`);
  const stderr = notes.length ? `${notes.join('\n')}\n` : '';

  if (output === '-') return ok(text, stderr);
  const outName = output ?? (/\.pdf$/i.test(input) ? input.replace(/\.pdf$/i, '.txt') : `${input}.txt`);
  try {
    await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outName), text);
  } catch (e) {
    return fail('pdftotext', `cannot write ${outName}: ${errMessage(e)}`, 2);
  }
  return ok('', stderr);
});

/** The commands added to every bank sandbox. */
export const documentCommands: Command[] = [unzipCommand, pdftotextCommand];
