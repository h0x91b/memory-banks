/**
 * Document reading in the bank sandbox (src/sandbox-documents.ts): `unzip`,
 * `pdftotext`, and the `tar` that just-bash already ships.
 *
 * The first part drives the real sandbox (src/bash-factory.ts → just-bash →
 * ReadWriteFs rooted at fs/). The last test runs the real Librarian pipeline
 * with a scripted (faux) model, so the archive and PDF go through ingest,
 * Flue's own `bash` tool, the sweep and the commits. All fixtures are
 * synthetic and built in memory; no network beyond loopback, no API keys.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import { buildPdf, buildTar, buildZip } from './fixtures/document-fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const bankRoot = mkdtempSync(path.join(tmpdir(), 'sandbox-documents-'));
process.env.MEMORY_BANK_ROOT = bankRoot;
delete process.env.MEMORY_BANK_ACCOUNTING_DIR;

const BANK = 'docs';
const repoPath = path.join(bankRoot, BANK);
const fsPath = path.join(repoPath, 'fs');
/** Next to fs/, outside the sandbox: nothing may ever appear here. */
const outsideDir = path.join(bankRoot, 'outside');

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let flue: { stop(): Promise<void> };
let fx: any;
let factory: typeof import('../src/bash-factory.ts');
let docs: typeof import('../src/sandbox-documents.ts');

before(async () => {
  mkdirSync(fsPath, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [
      {
        name: 'markdown-as-text',
        load(id: string) {
          return id.endsWith('.md') ? `export default ${JSON.stringify(readFileSync(id, 'utf8'))};` : null;
        },
      },
    ],
  });
  runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  fx = await runner.import('/test/fixtures/faux-spend-harness.ts');
  factory = await runner.import('/src/bash-factory.ts');
  docs = await runner.import('/src/sandbox-documents.ts');
  flue = await fx.startFlue();
});

after(async () => {
  await flue?.stop();
  await runner?.close();
  await server?.close();
  rmSync(bankRoot, { recursive: true, force: true });
});

const exec = async (command: string) => (await factory.createBankBashFactory({ bank: BANK, bankFsPath: fsPath })()).exec(command);
const put = (rel: string, data: Buffer | string) => {
  const abs = path.join(fsPath, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
};
const sha = (abs: string) => createHash('sha256').update(readFileSync(abs)).digest('hex');
const tree = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => !d.isDirectory())
        .map((d) => path.relative(dir, path.join(d.parentPath, d.name)))
        .sort()
    : [];
const assertNothingOutside = () => {
  assert.deepEqual(tree(outsideDir), [], 'nothing written next to the bank');
  assert.deepEqual(readdirSync(repoPath).sort(), ['fs'], 'nothing written beside fs/');
  assert.equal(existsSync(path.join(bankRoot, 'escape.txt')), false);
};

const SAMPLE_ZIP = () =>
  buildZip([
    { name: 'notes/', data: undefined },
    { name: 'notes/alpha.md', data: '# Alpha\n\nFirst synthetic note.\n' },
    { name: 'notes/beta.txt', data: 'beta '.repeat(200), method: 0 },
    { name: 'inner.zip', data: buildZip([{ name: 'deep.txt', data: 'should stay packed\n' }]) },
    { name: '../escape.txt', data: 'traversal' },
    { name: '/abs.txt', data: 'absolute' },
    { name: 'C:\\win.txt', data: 'drive letter' },
    { name: 'link', data: '/etc/passwd', mode: 0o120777 },
    { name: 'secret.txt', data: 'locked', flags: 0x1 },
  ]);

describe('unzip in the bank sandbox', () => {
  test('is registered next to the built-ins', async () => {
    // `which` finds nothing on ReadWriteFs (no /usr/bin on disk), built-ins included; `command -v` works.
    const r = await exec('command -v unzip pdftotext tar');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, '/usr/bin/unzip\n/usr/bin/pdftotext\n/usr/bin/tar\n');
    assert.match((await exec('unzip --help')).stdout, /Usage: unzip/);
    assert.match((await exec('pdftotext --help')).stdout, /Usage: pdftotext/);
  });

  test('-l lists every entry and marks the ones extraction will skip', async () => {
    put('_raw/sample.zip', SAMPLE_ZIP());
    const r = await exec('unzip -l /_raw/sample.zip');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^Archive: {2}\/_raw\/sample\.zip$/m);
    assert.match(r.stdout, / notes\/alpha\.md$/m);
    assert.match(r.stdout, /^ {7}31 .* notes\/alpha\.md$/m, 'uncompressed size');
    assert.match(r.stdout, / inner\.zip$/m);
    assert.match(r.stdout, /\.\.\/escape\.txt {3}\[skipped on extract: path contains '\.\.'\]/);
    assert.match(r.stdout, /\/abs\.txt {3}\[skipped on extract: absolute path\]/);
    assert.match(r.stdout, /C:\/win\.txt {3}\[skipped on extract: absolute path\]/);
    assert.match(r.stdout, /link {3}\[skipped on extract: symbolic link/);
    assert.match(r.stdout, /secret\.txt {3}\[skipped on extract: encrypted entry/);
    assert.match(r.stdout, / 9 files$/m);
    assert.deepEqual(tree(path.join(fsPath, '_raw')), ['sample.zip'], 'listing writes nothing');
  });

  test('extracts safe entries only, keeps the original, never expands nested archives', async () => {
    const zip = SAMPLE_ZIP();
    put('_raw/sample.zip', zip);
    const before = sha(path.join(fsPath, '_raw/sample.zip'));
    const r = await exec('unzip /_raw/sample.zip -d /docs/sample');
    assert.equal(r.exitCode, 1, 'warnings for the skipped entries');
    assert.match(r.stdout, /inflating: docs\/sample\/notes\/alpha\.md/);
    for (const why of ["path contains '..'", 'absolute path', 'symbolic link', 'encrypted entry']) {
      assert.ok(r.stderr.includes(why), why);
    }
    assert.deepEqual(tree(path.join(fsPath, 'docs/sample')), ['inner.zip', 'notes/alpha.md', 'notes/beta.txt']);
    assert.equal(readFileSync(path.join(fsPath, 'docs/sample/notes/alpha.md'), 'utf8'), '# Alpha\n\nFirst synthetic note.\n');
    assert.equal(readFileSync(path.join(fsPath, 'docs/sample/notes/beta.txt'), 'utf8'), 'beta '.repeat(200));
    assert.equal(sha(path.join(fsPath, '_raw/sample.zip')), before, 'original archive untouched');
    assert.equal(existsSync(path.join(fsPath, 'docs/sample/deep.txt')), false, 'inner.zip not expanded');
    assert.equal(existsSync(path.join(fsPath, 'abs.txt')), false);
    assert.equal(existsSync(path.join(fsPath, 'docs/escape.txt')), false);
    assertNothingOutside();
  });

  test('existing files are kept unless -o, and -n skips quietly', async () => {
    put('_raw/one.zip', buildZip([{ name: 'a.txt', data: 'from zip\n' }]));
    put('keep/a.txt', 'mine\n');
    const kept = await exec('unzip /_raw/one.zip -d /keep');
    assert.equal(kept.exitCode, 2);
    assert.match(kept.stderr, /a\.txt: file exists \(use -o/);
    assert.equal(readFileSync(path.join(fsPath, 'keep/a.txt'), 'utf8'), 'mine\n');
    const quiet = await exec('unzip -n /_raw/one.zip -d /keep');
    assert.equal(quiet.exitCode, 0);
    assert.equal(readFileSync(path.join(fsPath, 'keep/a.txt'), 'utf8'), 'mine\n');
    const over = await exec('unzip -oq /_raw/one.zip -d /keep');
    assert.equal(over.exitCode, 0, over.stderr);
    assert.equal(over.stdout, '');
    assert.equal(readFileSync(path.join(fsPath, 'keep/a.txt'), 'utf8'), 'from zip\n');
  });

  test('a symlink already in the bank cannot carry extraction outside fs/', async () => {
    symlinkSync(outsideDir, path.join(fsPath, 'jump'));
    put('_raw/jump.zip', buildZip([{ name: 'jump/escape.txt', data: 'out\n' }]));
    await exec('unzip /_raw/jump.zip -d /');
    await exec('unzip -o /_raw/jump.zip');
    assertNothingOutside();
    rmSync(path.join(fsPath, 'jump'));
  });

  test('size and entry limits refuse the archive before anything is written', async () => {
    const { zipEntryBytes, zipTotalBytes, zipEntries } = docs.DOCUMENT_LIMITS;
    const cases: Array<[string, Buffer, RegExp]> = [
      ['big-entry', buildZip([{ name: 'ok.txt', data: 'x' }, { name: 'huge.bin', data: 'x', declaredSize: zipEntryBytes + 1 }]), /per-file limit; nothing extracted/],
      [
        'big-total',
        buildZip(Array.from({ length: 3 }, (_, i) => ({ name: `part${i}.bin`, data: 'x', declaredSize: Math.ceil(zipTotalBytes / 2) - 1 }))),
        /uncompressed, more than the .* limit; nothing extracted/,
      ],
      ['many', buildZip(Array.from({ length: zipEntries + 1 }, (_, i) => ({ name: `f${i}.txt`, data: '' }))), /entries, more than the 2000 allowed/],
    ];
    for (const [name, zip, message] of cases) {
      put(`_raw/${name}.zip`, zip);
      const r = await exec(`unzip /_raw/${name}.zip -d /bomb/${name}`);
      assert.equal(r.exitCode, 9, name);
      assert.match(r.stderr, message, name);
      assert.equal(existsSync(path.join(fsPath, 'bomb', name)), false, `${name}: nothing written`);
    }
  });

  test('a header that understates the size cannot inflate past it', async () => {
    // Real content is 1 MiB of zeros; the directory claims 10 bytes.
    put('_raw/liar.zip', buildZip([{ name: 'zeros.bin', data: new Uint8Array(1024 * 1024), declaredSize: 10 }, { name: 'fine.txt', data: 'fine\n' }]));
    const r = await exec('unzip /_raw/liar.zip -d /liar');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /zeros\.bin: .*(size does not match|buffer)/i);
    assert.equal(existsSync(path.join(fsPath, 'liar/zeros.bin')), false);
    assert.equal(readFileSync(path.join(fsPath, 'liar/fine.txt'), 'utf8'), 'fine\n');
  });

  test('not-a-zip and missing files fail clearly', async () => {
    put('_raw/fake.zip', 'just text\n');
    const fake = await exec('unzip -l /_raw/fake.zip');
    assert.equal(fake.exitCode, 9);
    assert.match(fake.stderr, /not a ZIP archive/);
    const missing = await exec('unzip -l /_raw/nope.zip');
    assert.equal(missing.exitCode, 9);
    assert.match(missing.stderr, /cannot open/);
  });
});

describe('pdftotext in the bank sandbox', () => {
  test('prints text with page boundaries, marks pages without text', async () => {
    put('_raw/report.pdf', buildPdf([['Quarterly synthetic report', 'Revenue grew (a little).'], null, ['Appendix: glossary']]));
    const r = await exec('pdftotext /_raw/report.pdf -');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        '--- page 1 of 3 ---',
        'Quarterly synthetic report',
        'Revenue grew (a little).',
        '',
        '--- page 2 of 3 ---',
        '(no extractable text on this page)',
        '',
        '--- page 3 of 3 ---',
        'Appendix: glossary',
        '',
      ].join('\n'),
    );
    assert.match(r.stderr, /no text layer on page\(s\) 2 .*OCR is not available/);
    const range = await exec('pdftotext -f 3 -l 3 /_raw/report.pdf - | head -1');
    assert.equal(range.stdout, '--- page 3 of 3 ---\n');
  });

  test('writes FILE.txt next to the PDF by default and keeps the original', async () => {
    const before = sha(path.join(fsPath, '_raw/report.pdf'));
    const r = await exec('pdftotext /_raw/report.pdf && grep -n Appendix /_raw/report.txt');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^\d+:Appendix: glossary$/m);
    assert.equal(sha(path.join(fsPath, '_raw/report.pdf')), before);
    rmSync(path.join(fsPath, '_raw/report.txt'));
  });

  test('an image-only PDF reports that there is no text and writes nothing', async () => {
    put('_raw/scan.pdf', buildPdf([null, null]));
    const r = await exec('pdftotext /_raw/scan.pdf; echo "rc=$?"');
    assert.match(r.stdout, /rc=3/);
    assert.match(r.stderr, /no extractable text on any of its 2 page\(s\)\. It is most likely a scanned or image-only PDF\. OCR is not available/);
    assert.equal(existsSync(path.join(fsPath, '_raw/scan.txt')), false);
  });

  test('invalid input and bad page ranges fail clearly', async () => {
    put('_raw/broken.pdf', 'not a pdf at all');
    const broken = await exec('pdftotext /_raw/broken.pdf -');
    assert.equal(broken.exitCode, 1);
    assert.match(broken.stderr, /not a valid PDF/);
    const past = await exec('pdftotext -f 9 /_raw/report.pdf -');
    assert.equal(past.exitCode, 99);
    assert.match(past.stderr, /the PDF has 3 page/);
  });
});

describe('tar (built into just-bash) in the bank sandbox', () => {
  test('lists and extracts, refuses traversal and symlinks, keeps absolute names inside', async () => {
    put(
      '_raw/bundle.tar',
      buildTar([
        { name: 'guide/', type: '5' },
        { name: 'guide/intro.md', data: '# Intro\n' },
        { name: '../escape.txt', data: 'traversal' },
        { name: '/abs.txt', data: 'absolute' },
        { name: 'guide/link', type: '2', linkname: '/etc/passwd' },
      ]),
    );
    const list = await exec('tar -tf /_raw/bundle.tar');
    assert.equal(list.exitCode, 0, list.stderr);
    assert.match(list.stdout, /^guide\/intro\.md$/m);
    const x = await exec('mkdir -p /tarx && tar -xf /_raw/bundle.tar -C /tarx');
    assert.notEqual(x.exitCode, 0, 'unsafe members are reported');
    assert.match(x.stderr, /escape\.txt: Path contains '\.\.'/);
    assert.match(x.stderr, /guide\/link: unsafe symlink target/);
    assert.equal(readFileSync(path.join(fsPath, 'tarx/guide/intro.md'), 'utf8'), '# Intro\n');
    assert.equal(existsSync(path.join(fsPath, 'tarx/guide/link')), false);
    assert.equal(existsSync(path.join(fsPath, 'escape.txt')), false);
    assert.ok(tree(path.join(fsPath, 'tarx')).every((f) => !f.startsWith('..')));
    assertNothingOutside();
  });
});

describe('Librarian run with a ZIP and a PDF', () => {
  test("Flue's bash tool lists, extracts and reads them; originals reach the ingest commit", async () => {
    const bank = 'doc-run';
    const fsDir = path.join(bankRoot, bank, 'fs');
    mkdirSync(fsDir, { recursive: true });
    writeFileSync(path.join(fsDir, '_index.md'), `# ${bank}\n\nDocument tools test bank.\n\n## Folders\n\n`);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path.join(bankRoot, bank), stdio: 'pipe' }).toString();
    git('init', '-q', '--initial-branch=main');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');

    const srcDir = mkdtempSync(path.join(tmpdir(), 'doc-src-'));
    const zipFile = path.join(srcDir, 'bundle.zip');
    const pdfFile = path.join(srcDir, 'paper.pdf');
    const scanFile = path.join(srcDir, 'scan.pdf');
    writeFileSync(zipFile, buildZip([{ name: 'chapter-1.md', data: '# Chapter 1\n\nSynthetic chapter text.\n' }]));
    writeFileSync(pdfFile, buildPdf([['Synthetic paper title'], ['Second page body']]));
    writeFileSync(scanFile, buildPdf([null]));

    const toolUse = (calls: unknown[]) => fx.fauxAssistantMessage(calls, { stopReason: 'toolUse' });
    const bashStep = (command: string) => toolUse([fx.fauxToolCall('bash', { command })]);
    const seen: { results?: Array<{ text: string; isError: boolean }> } = {};
    fx.faux.setResponses([
      bashStep('unzip -l /_raw/bundle.zip'),
      bashStep('unzip -q /_raw/bundle.zip -d /_unsorted/bundle && cat /_unsorted/bundle/chapter-1.md'),
      bashStep('pdftotext /_raw/paper.pdf -'),
      bashStep('pdftotext /_raw/scan.pdf -'),
      (context: any) => {
        seen.results = (context.messages as any[])
          .filter((m) => m.role === 'toolResult')
          .map((m) => ({ text: m.content.map((c: any) => c.text ?? '').join(''), isError: !!m.isError }));
        return bashStep('mv /_raw/* /_unsorted/');
      },
      toolUse([fx.fauxToolCall('submit_result', { summary: 'Parked a ZIP and two PDFs' })]),
    ]);

    const report = await fx.runLibrarian(
      { bank, items: [zipFile, pdfFile, scanFile].map((f) => ({ kind: 'path', uri: pathToFileURL(f).href })) },
      'doc-run',
    );
    rmSync(srcDir, { recursive: true, force: true });
    assert.equal(fx.faux.getPendingResponseCount(), 0, 'every scripted turn was consumed');

    const [list, extract, paper, scan] = seen.results!;
    assert.match(list.text, /chapter-1\.md/);
    assert.equal(list.isError, false);
    assert.match(extract.text, /Synthetic chapter text\./);
    assert.match(paper.text, /--- page 1 of 2 ---\nSynthetic paper title/);
    assert.match(paper.text, /--- page 2 of 2 ---\nSecond page body/);
    assert.match(scan.text, /no extractable text .* OCR is not available/s);

    // The originals were committed byte-for-byte at ingest, and survive the run.
    const ingestSha = report.commits[0];
    assert.match(git('ls-tree', '-r', '--name-only', ingestSha), /fs\/_raw\/bundle\.zip/);
    const files = git('ls-files', 'fs').trim().split('\n').sort();
    for (const f of ['fs/_unsorted/bundle.zip', 'fs/_unsorted/paper.pdf', 'fs/_unsorted/scan.pdf', 'fs/_unsorted/bundle/chapter-1.md']) {
      assert.ok(files.includes(f), f);
    }
    const besideFs = readdirSync(path.join(bankRoot, bank)).filter((n) => !['.git', '.gitignore', 'fs'].includes(n));
    assert.deepEqual(besideFs, [], 'nothing extracted beside fs/');
  });
});
