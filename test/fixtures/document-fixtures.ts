/**
 * Synthetic ZIP and PDF builders for the sandbox document tests. Everything
 * is generated in memory from literal strings — no real documents, no binary
 * files in the repo.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  /** File content; omit for a directory entry (name ends with `/`). */
  data?: string | Uint8Array;
  /** 0 = stored, 8 = deflate (default), anything else is written as-is. */
  method?: number;
  /** Unix mode for the external attributes, e.g. 0o120777 for a symlink. */
  mode?: number;
  /** General-purpose flag bits (bit 0 = encrypted). */
  flags?: number;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
}

/** Build a ZIP archive (no ZIP64, no data descriptors) from entry specs. */
export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data ?? new Uint8Array());
    const method = e.method ?? (raw.length ? 8 : 0);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const size = e.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const flags = 0x0800 | (e.flags ?? 0); // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Build a minimal PDF. Each page is a list of text lines drawn in Helvetica;
 * `null` makes a page that only paints a filled rectangle — no text at all,
 * the shape of a scanned page as far as text extraction is concerned.
 */
export function buildPdf(pages: Array<string[] | null>): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // 1-based object number
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesObj = add(''); // filled in below
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const ops = lines
      ? ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', ...lines.map((l) => `(${escape(l)}) Tj T*`), 'ET'].join('\n')
      : '0.5 g 72 72 468 648 re f';
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface TarEntrySpec {
  name: string;
  data?: string;
  /** '0' file (default), '5' directory, '2' symlink. */
  type?: '0' | '2' | '5';
  linkname?: string;
}

/** Build an uncompressed ustar archive. Names are written verbatim, unsafe ones included. */
export function buildTar(entries: TarEntrySpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'utf8');
    const h = Buffer.alloc(512);
    const put = (s: string, off: number, len: number) => h.write(s, off, len, 'utf8');
    // Field width minus one digit; the trailing NUL is already there from alloc.
    const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0');
    put(e.name, 0, 100);
    put(octal(e.type === '5' ? 0o755 : 0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(e.type === '0' || !e.type ? data.length : 0, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    h.fill(0x20, 148, 156); // checksum field counts as spaces
    put(e.type ?? '0', 156, 1);
    put(e.linkname ?? '', 157, 100);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h);
    if (data.length) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
