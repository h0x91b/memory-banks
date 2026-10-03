// Offline tests of the read-only bank validator (contract v1,
// docs/design/bank-format.md §2–§8) on temporary fixture banks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import { compareFolderPaths, violation, type Violation } from '../src/bank-format/index.ts';
import {
  compareWithBaseline,
  scanBank,
  validateBank,
  violationKey,
  type BankValidationReport,
} from '../src/bank-validator/index.ts';

const scratch = await mkdtemp(join(tmpdir(), 'bank-validator-test-'));
after(() => rm(scratch, { recursive: true, force: true }));
let counter = 0;

const manifest = (title = 'Some note', glossary: Record<string, string> = {}) =>
  JSON.stringify({ title, keywords: ['note'], glossary });

function mapText(folders: string[], overview = 'Test bank for the validator.'): string {
  const lines = folders.map((f) => `- \`${f}\` — Folder ${f}`);
  return `# test-bank\n\n${overview}\n\n## Folders\n\n${lines.join('\n')}\n`;
}

/**
 * Writes a bank. Keys ending in `/` are folders; a value of `null` on a file
 * key adds `<key>.manifest.json` automatically next to `<key>`. Without a
 * `_index.md` key a matching root map is generated from the folder list.
 */
type Spec = Record<string, string | Uint8Array | null>;
async function makeBank(spec: Spec, { autoMap = true } = {}): Promise<string> {
  const root = join(scratch, `bank-${++counter}`, 'fs');
  await mkdir(root, { recursive: true });
  const folders = new Set<string>();
  for (const [key, body] of Object.entries(spec)) {
    const segs = key.split('/').filter(Boolean);
    for (let i = 1; i < (key.endsWith('/') ? segs.length + 1 : segs.length); i++) {
      const f = segs.slice(0, i).join('/') + '/';
      if (!f.startsWith('_raw/') && !f.startsWith('_unsorted/') && !f.split('/').some((s) => s.startsWith('.'))) {
        folders.add(f);
      }
    }
    if (key.endsWith('/')) {
      await mkdir(join(root, key), { recursive: true });
      continue;
    }
    await mkdir(dirname(join(root, key)), { recursive: true });
    await writeFile(join(root, key), body ?? `content of ${key}`);
    if (body === null) await writeFile(join(root, key + '.manifest.json'), manifest());
  }
  if (autoMap && !('_index.md' in spec)) {
    await writeFile(join(root, '_index.md'), mapText([...folders].sort(compareFolderPaths)));
  }
  return root;
}

const codes = (r: BankValidationReport) => r.violations.map((v) => v.code);
const find = (r: BankValidationReport, code: string) => r.violations.filter((v) => v.code === code);

describe('valid bank', () => {
  test('a contract-shaped bank has no violations', async () => {
    const root = await makeBank({
      'recipes/borscht.md': null,
      'recipes/borscht.html': null,
      'work/standups/2026-10-01.md': null,
      'work/standups/deck.pdf': null,
      'notes.md': null,
      '_open-questions.md': '# Open questions\n',
      '_raw/inbox-item.md': 'raw',
      '_unsorted/deep/odd.bin': 'x',
    });
    const r = await validateBank(root);
    assert.deepEqual(r.violations, []);
    assert.equal(r.errors, 0);
    assert.deepEqual(r.scanned, { folders: 4, contentFiles: 5, manifests: 5 });
  });

  test('a brand-new bank with an empty Folders section is valid', async () => {
    const root = await makeBank({});
    assert.deepEqual((await validateBank(root)).violations, []);
  });

  test('the validator does not modify the bank', async () => {
    const root = await makeBank({ 'a/x.md': '', 'a/.h': 'x', 'b/': '' });
    const before = await snapshot(root);
    await validateBank(root);
    assert.deepEqual(await snapshot(root), before);
  });
});

async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    const p = join(e.parentPath, e.name);
    out.push(p + (e.isFile() ? ':' + (await readFile(p, 'utf8')) : ''));
  }
  return out.sort();
}

describe('classification (§2)', () => {
  test('inboxes are skipped only at the root; _raw deeper is a folder', async () => {
    const root = await makeBank({ '_raw/x.md': 'no manifest', 'a/_raw/y.md': 'no manifest either' });
    const r = await validateBank(root);
    assert.deepEqual(codes(r), ['manifest-missing']);
    assert.equal(r.violations[0].path, 'a/_raw/y.md');
  });

  test('hidden files and folders are errors and their subtree is not walked', async () => {
    const root = await makeBank({ 'recipes/.draft.md': 'x', '.hid/x.md': 'x', 'recipes/ok.md': null });
    const r = await validateBank(root);
    assert.deepEqual(
      find(r, 'hidden-entry').map((v) => v.path),
      ['.hid/', 'recipes/.draft.md'],
    );
    assert.equal(find(r, 'manifest-missing').length, 0);
  });

  test('symlinks are errors, never followed, even when they point outside the bank', async () => {
    const outside = join(scratch, `outside-${++counter}`);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), 'secret');
    await writeFile(join(outside, 'x.md.manifest.json'), '{ not json');
    const root = await makeBank({ 'a/ok.md': null });
    await symlink(outside, join(root, 'a', 'linked-dir'));
    await symlink(join(outside, 'secret.md'), join(root, 'a', 'secret.md'));
    await symlink(join(outside, 'x.md.manifest.json'), join(root, 'a', 'x.md.manifest.json'));
    await symlink(join(outside, 'secret.md'), join(root, '_index.md.tmp'));

    const r = await validateBank(root);
    assert.deepEqual(
      find(r, 'symlink').map((v) => v.path),
      ['_index.md.tmp', 'a/linked-dir', 'a/secret.md', 'a/x.md.manifest.json'],
    );
    // Nothing behind the links was read: no manifest-json, no map line demanded for linked-dir.
    assert.deepEqual(codes(r).filter((c) => c !== 'symlink'), []);
  });

  test('a symlinked root map counts as missing and is not read', async () => {
    const outside = join(scratch, `outside-${++counter}`);
    await mkdir(outside);
    await writeFile(join(outside, 'map.md'), mapText([]));
    const root = await makeBank({}, { autoMap: false });
    await symlink(join(outside, 'map.md'), join(root, '_index.md'));
    const r = await validateBank(root);
    assert.deepEqual(codes(r).sort(), ['map-file-missing', 'symlink']);
  });

  test('a symlinked bank root is refused', async () => {
    const root = await makeBank({});
    const link = root + '-link';
    await symlink(root, link);
    await assert.rejects(validateBank(link), /not a directory \(symlink\)/);
  });

  test('special files are errors', { skip: process.platform === 'win32' }, async () => {
    const root = await makeBank({ 'a/ok.md': null });
    execFileSync('mkfifo', [join(root, 'a', 'pipe')]);
    const r = await validateBank(root);
    assert.deepEqual(codes(r), ['special-file']);
    assert.equal(r.violations[0].path, 'a/pipe');
  });

  test('_index.md below the root is nested-index; _open-questions.md below the root is content', async () => {
    const root = await makeBank({
      'work/standups/_index.md': '# old',
      'work/standups/_open-questions.md': null,
      'work/standups/n.md': null,
    });
    const r = await validateBank(root);
    assert.deepEqual(codes(r), ['nested-index']);
    assert.equal(r.violations[0].path, 'work/standups/_index.md');
    assert.equal(r.violations[0].severity, 'error');
    assert.equal(r.scanned.contentFiles, 2);
  });
});

describe('depth (§3.1)', () => {
  test('depth 3 is fine; depth 4 is reported once, deeper folders are implied', async () => {
    const ok = await makeBank({ 'a/b/c/x.md': null });
    assert.deepEqual((await validateBank(ok)).violations, []);

    const bad = await makeBank({ 'a/b/c/d/e/x.md': null });
    const r = await validateBank(bad);
    assert.deepEqual(codes(r), ['depth-over-limit']);
    assert.deepEqual(r.violations[0], {
      ...violation('depth-over-limit', 'a/b/c/d/', r.violations[0].message, { value: 4, limit: 3 }),
    });
  });
});

describe('width (§3.2)', () => {
  const files = (dir: string, n: number): Spec =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}f${String(i).padStart(2, '0')}.md`, null]));

  test('10 files is fine, 11 is a warning, 20 is a warning, 21 is an error', async () => {
    assert.deepEqual((await validateBank(await makeBank(files('a/', 10)))).violations, []);
    for (const [n, code, severity] of [
      [11, 'width-over-target', 'warning'],
      [20, 'width-over-target', 'warning'],
      [21, 'width-over-limit', 'error'],
    ] as const) {
      const r = await validateBank(await makeBank(files('a/', n)));
      assert.deepEqual(codes(r), [code], `width ${n}`);
      assert.equal(r.violations[0].severity, severity);
      assert.equal(r.violations[0].value, n);
    }
  });

  test('manifests, service files, hidden entries and inboxes do not count', async () => {
    const r = await validateBank(
      await makeBank({ ...files('', 10), '_open-questions.md': 'q', '_raw/a.md': 'x', '.hidden': 'x' }),
    );
    assert.deepEqual(codes(r), ['hidden-entry']);
  });

  test('the root folder follows the same width rules', async () => {
    const r = await validateBank(await makeBank(files('', 21)));
    assert.deepEqual(codes(r), ['width-over-limit']);
    assert.equal(r.violations[0].path, '');
    assert.match(r.violations[0].message, /^\/ has 21 content files/);
  });

  test('depth wins: over 20 at max depth is only a warning', async () => {
    const r = await validateBank(await makeBank(files('a/b/c/', 23)));
    assert.deepEqual(codes(r), ['width-over-limit-at-max-depth']);
    assert.equal(r.violations[0].severity, 'warning');
  });

  test('a folder with neither content nor subfolders is empty-folder; root is never empty', async () => {
    const r = await validateBank(await makeBank({ 'a/': '', 'b/only.md.manifest.json': manifest(), 'c/d/x.md': null }));
    assert.deepEqual(
      r.violations.map((v) => `${v.code} ${v.path}`),
      ['empty-folder a/', 'empty-folder b/', 'manifest-orphan b/only.md.manifest.json'],
    );
  });
});

describe('manifests (§4)', () => {
  test('missing and orphan manifests', async () => {
    const r = await validateBank(
      await makeBank({
        'a/no-manifest.md': 'x',
        'a/gone.md.manifest.json': manifest(),
        'a/sub.manifest.json': manifest(),
        'a/sub/x.md': null,
        '_index.md.manifest.json': manifest(),
        'a/x.md.manifest.json.manifest.json': manifest(),
        'a/x.md': null,
      }),
    );
    assert.deepEqual(
      r.violations.map((v) => `${v.code} ${v.path}`),
      [
        'manifest-orphan _index.md.manifest.json',
        'manifest-orphan a/gone.md.manifest.json',
        'manifest-missing a/no-manifest.md',
        'manifest-orphan a/sub.manifest.json',
        'manifest-orphan a/x.md.manifest.json.manifest.json',
      ],
    );
  });

  test('borscht.md and borscht.html pair separately', async () => {
    const r = await validateBank(
      await makeBank({ 'r/borscht.md': null, 'r/borscht.html': 'x', 'r/borscht.manifest.json': manifest() }),
    );
    assert.deepEqual(
      r.violations.map((v) => `${v.code} ${v.path}`),
      ['manifest-missing r/borscht.html', 'manifest-orphan r/borscht.manifest.json'],
    );
  });

  test('json, schema and size errors come from the shared parser with the manifest path', async () => {
    const r = await validateBank(
      await makeBank({
        'a/json.md': 'x',
        'a/json.md.manifest.json': '{ "title": "x", "keywords": [], "glossary": {}, }',
        'a/bom.md': 'x',
        'a/bom.md.manifest.json': new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(manifest())]),
        'a/schema.md': 'x',
        'a/schema.md.manifest.json': JSON.stringify({ title: 'x', keywords: [], glossary: { LIPO: '' } }),
        'a/big.md': 'x',
        'a/big.md.manifest.json': JSON.stringify({ title: 'x', keywords: ['k'.repeat(9000)], glossary: {} }),
      }),
    );
    assert.deepEqual(
      r.violations.map((v) => `${v.code} ${v.path} ${v.detail ?? ''}`.trim()),
      [
        'manifest-size a/big.md.manifest.json',
        'manifest-json a/bom.md.manifest.json',
        'manifest-json a/json.md.manifest.json',
        'manifest-schema a/schema.md.manifest.json glossary.LIPO',
      ],
    );
  });

  test('pairing compares NFC names: decomposed file name pairs with composed manifest name', async () => {
    const decomposed = 'ёж.md'.normalize('NFD');
    const composed = 'ёж.md'.normalize('NFC');
    assert.notEqual(decomposed, composed);
    const root = await makeBank({ [`a/${decomposed}`]: 'x', [`a/${composed}.manifest.json`]: manifest() });
    const names = await readdir(join(root, 'a'));
    if (!names.includes(decomposed)) return; // filesystem normalized the name itself; nothing to test
    assert.deepEqual((await validateBank(root)).violations, []);
  });
});

describe('glossary conflicts (§6)', () => {
  test('same term, different descriptions is one warning; same description is fine', async () => {
    const r = await validateBank(
      await makeBank({
        'ml/round-2.md': 'x',
        'ml/round-2.md.manifest.json': manifest('Round 2', { LIPO: 'Listwise preference optimization' }),
        'fin/plan.md': 'x',
        'fin/plan.md.manifest.json': manifest('Plan', { LIPO: 'Low-income pension option' }),
        'fin/plan2.md': 'x',
        'fin/plan2.md.manifest.json': manifest('Plan 2', { LIPO: 'Low-income pension option', 'ЁЖ': 'Hedgehog' }),
        'x/ej.md': 'x',
        'x/ej.md.manifest.json': manifest('Hedgehog', { ['ЁЖ'.normalize('NFD')]: 'Hedgehog' }),
      }),
    );
    assert.deepEqual(codes(r), ['glossary-conflict']);
    const [v] = r.violations;
    assert.equal(v.severity, 'warning');
    assert.equal(v.path, '');
    assert.equal(v.detail, 'LIPO');
    assert.equal(v.value, 2);
    assert.match(v.message, /fin\/plan\.md, fin\/plan2\.md, ml\/round-2\.md/);
  });

  test('terms differing only in case are different terms', async () => {
    const r = await validateBank(
      await makeBank({
        'a/x.md': 'x',
        'a/x.md.manifest.json': manifest('X', { Lipo: 'one' }),
        'a/y.md': 'x',
        'a/y.md.manifest.json': manifest('Y', { LIPO: 'two' }),
      }),
    );
    assert.deepEqual(r.violations, []);
  });
});

describe('root map coverage (§5)', () => {
  test('missing root map', async () => {
    const r = await validateBank(await makeBank({ 'a/x.md': null }, { autoMap: false }));
    assert.deepEqual(codes(r), ['map-file-missing']);
  });

  test('missing, stale, reserved and duplicate lines; folders at every depth need a line', async () => {
    const r = await validateBank(
      await makeBank({
        'work/standups/n.md': null,
        'work-x/n.md': null,
        '.hid/x': 'x',
        '_index.md': mapText(['work/', 'work/standups/', 'work/standups/', 'trips/', '_unsorted/', '.hid/']),
      }),
    );
    assert.deepEqual(
      r.violations.map((v) => `${v.code} ${v.path}`),
      [
        'hidden-entry .hid/',
        'map-stale .hid/',
        'map-order _index.md',
        'map-reserved _unsorted/',
        'map-stale trips/',
        'map-missing work-x/',
        'map-duplicate work/standups/',
      ],
    );
  });

  test('coverage compares NFC paths', async () => {
    const r = await validateBank(
      await makeBank({ ['ёж/'.normalize('NFD') + 'n.md']: null, '_index.md': mapText(['ёж/'.normalize('NFC')]) }),
    );
    assert.deepEqual(r.violations, []);
  });

  test('grammar violations come from the shared parser; invalid UTF-8 is map-structure', async () => {
    const r = await validateBank(
      await makeBank({ 'a/x.md': null, '_index.md': '# t\n\noverview\n\n## Folders\n\n- a/ — no backticks\n' }),
    );
    assert.deepEqual(codes(r).sort(), ['map-line-syntax', 'map-missing']);

    const bytes = new Uint8Array([...new TextEncoder().encode(mapText([])), 0xff]);
    const enc = await validateBank(await makeBank({ '_index.md': bytes }));
    assert.deepEqual(
      enc.violations.map((v) => `${v.code} ${v.detail ?? ''}`),
      ['map-line-syntax �', 'map-structure encoding'],
    );

    const bom = await validateBank(await makeBank({ '_index.md': '\uFEFF' + mapText([]) }));
    assert.deepEqual(
      bom.violations.map((v) => `${v.code} ${v.detail}`),
      ['map-structure bom'],
    );
  });
});

describe('report', () => {
  test('violations are sorted by NFC path, then code, then detail', async () => {
    const r = await validateBank(await makeBank({ 'b/x.md': 'x', 'a/y.md': 'x', 'a/.h': 'x' }));
    assert.deepEqual(
      r.violations.map((v) => `${v.path} ${v.code}`),
      ['a/.h hidden-entry', 'a/y.md manifest-missing', 'b/x.md manifest-missing'],
    );
    assert.equal(r.errors, 3);
    assert.equal(r.warnings, 0);
  });

  test('scanBank exposes parsed manifests and the root map for reuse', async () => {
    const root = await makeBank({ 'a/x.md': null, 'a/orphan.md.manifest.json': manifest() });
    const scan = await scanBank(root);
    const paired = scan.manifests.find((m) => m.contentPath === 'a/x.md');
    assert.ok(paired?.result?.ok);
    assert.equal(paired.result.manifest.title, 'Some note');
    assert.equal(scan.manifests.find((m) => m.path === 'a/orphan.md.manifest.json')?.contentPath, null);
    assert.match(new TextDecoder().decode(scan.rootMap!), /^# test-bank/);
  });
});

describe('baseline (§8.2)', () => {
  const w = (n: number) => violation('width-over-limit', 'work/', `work/ has ${n}`, { value: n, limit: 20 });

  test('identity key is code + NFC path + detail; message is ignored', () => {
    const a = violation('manifest-schema', 'ёж.md.manifest.json'.normalize('NFD'), 'one', { detail: 'title' });
    const b = violation('manifest-schema', 'ёж.md.manifest.json'.normalize('NFC'), 'two', { detail: 'title' });
    assert.equal(violationKey(a), violationKey(b));
    assert.notEqual(violationKey(a), violationKey({ ...b, detail: 'keywords' }));
  });

  test('pre-existing errors do not block, new ones do, warnings never block', () => {
    const old = violation('manifest-missing', 'a.md', 'old');
    const fresh = violation('manifest-missing', 'b.md', 'new');
    const warn = violation('width-over-target', 'a/', 'w', { value: 11, limit: 10 });
    const c = compareWithBaseline([old, fresh, warn], [old]);
    assert.deepEqual(
      c.violations.map((v) => v.new),
      [false, true, true],
    );
    assert.deepEqual(c.blocking.map((v) => v.path), ['b.md']);
  });

  test('a worse value under the same key is new; equal or better is not', () => {
    assert.equal(compareWithBaseline([w(23)], [w(22)]).blocking.length, 1);
    assert.equal(compareWithBaseline([w(22)], [w(22)]).blocking.length, 0);
    assert.equal(compareWithBaseline([w(21)], [w(22)]).blocking.length, 0);
  });

  test('occurrences are counted: a second identical violation is new', () => {
    const line = violation('map-line-syntax', '_index.md', 'bad', { detail: '- bad' });
    const c = compareWithBaseline([line, line], [line]);
    assert.deepEqual(
      c.violations.map((v) => v.new),
      [false, true],
    );
  });

  test('moving a legacy file makes its old manifest-missing new (end to end)', async () => {
    const root = await makeBank({ 'a/legacy.md': 'x', 'a/other.md': null, 'b/keep.md': null });
    const baseline = await validateBank(root);
    assert.deepEqual(codes(baseline), ['manifest-missing']);

    // Same bank after a "curator" moved the legacy file into b/.
    await rm(join(root, 'a/legacy.md'));
    await writeFile(join(root, 'b/legacy.md'), 'x');
    const after = await validateBank(root);
    const c = compareWithBaseline(after.violations, baseline.violations);
    assert.deepEqual(c.blocking.map((v) => `${v.code} ${v.path}`), ['manifest-missing b/legacy.md']);
  });

  test('pre-existing nested-index stays non-blocking', async () => {
    const root = await makeBank({ 'a/_index.md': 'old', 'a/x.md': null });
    const baseline = await validateBank(root);
    const c = compareWithBaseline((await validateBank(root)).violations, baseline.violations);
    assert.equal(c.violations.length, 1);
    assert.equal(c.blocking.length, 0);
  });

  test('baselines survive a JSON round trip', async () => {
    const root = await makeBank({ 'a/x.md': 'x' });
    const r = await validateBank(root);
    const restored = JSON.parse(JSON.stringify(r)) as { violations: Violation[] };
    assert.equal(compareWithBaseline(r.violations, restored.violations).blocking.length, 0);
  });
});
