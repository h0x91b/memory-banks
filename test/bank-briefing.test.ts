// Offline tests of the bank briefing/glossary generator (contract v1,
// docs/design/bank-format.md §5.3, §6) on temporary fixture banks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  buildBankBriefing,
  buildGlossary,
  composeBriefing,
  GLOSSARY_HEADING,
  glossaryTermField,
  OPEN_QUESTIONS_HEADING,
  ROOT_MAP_MISSING,
  summarizeBriefing,
  type BankBriefing,
} from '../src/bank-briefing/index.ts';
import { GLOSSARY_BLOCK_MAX, MAP_MAX } from '../src/bank-format/index.ts';
import { scanBank } from '../src/bank-validator/index.ts';

const scratch = await mkdtemp(join(tmpdir(), 'bank-briefing-test-'));
after(async () => {
  await chmodTree(scratch, 0o755);
  await rm(scratch, { recursive: true, force: true });
});
let counter = 0;

const manifest = (glossary: Record<string, string> = {}, title = 'Some note') =>
  JSON.stringify({ title, keywords: ['note'], glossary });

const MAP = '# family-notes\n\nPersonal notes of one household.\n\n## Folders\n\n- `ml/` — ML experiments\n- `tax/` — Taxes\n';

/** Writes files in the given order; keys ending in `/` are empty folders. Returns the fs/ path. */
async function makeBank(spec: Record<string, string>): Promise<string> {
  const root = join(scratch, `bank-${++counter}`, 'fs');
  await mkdir(root, { recursive: true });
  for (const [key, body] of Object.entries(spec)) {
    if (key.endsWith('/')) {
      await mkdir(join(root, key), { recursive: true });
      continue;
    }
    await mkdir(dirname(join(root, key)), { recursive: true });
    await writeFile(join(root, key), body);
  }
  return root;
}

const glossaryBody = (b: BankBriefing) => b.glossary.slice(GLOSSARY_HEADING.length + 2).split('\n');
const diagCodes = (b: BankBriefing) => b.diagnostics.map((d) => d.code);

async function chmodTree(dir: string, mode: number): Promise<void> {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory()) await chmodTree(join(dir, d.name), mode);
  }
  await chmod(dir, mode);
}

/** Paths, sizes, mtimes and content hashes of everything under `dir`. */
async function snapshot(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(rel, d.name);
    const st = await stat(join(dir, p));
    if (d.isDirectory()) {
      out.push(`${p}/ ${st.mtimeMs}`, ...(await snapshot(dir, p)));
    } else {
      const hash = createHash('sha256').update(await readFile(join(dir, p))).digest('hex');
      out.push(`${p} ${st.size} ${st.mtimeMs} ${hash}`);
    }
  }
  return out;
}

describe('briefing layout', () => {
  const spec = {
    '_index.md': MAP,
    'ml/round-2.md': 'x',
    'ml/round-2.md.manifest.json': manifest({ LIPO: 'Listwise preference optimization variant' }),
    'tax/plan.md': 'x',
    'tax/plan.md.manifest.json': manifest({ LIPO: 'Low-income pension option' }),
    '_open-questions.md': '# Open questions\n\n- Where do receipts go?\n',
  };

  test('librarian: root map verbatim, then glossary, then open questions', async () => {
    const b = await buildBankBriefing(await makeBank(spec), { role: 'librarian' });
    assert.equal(b.rootMap, MAP);
    assert.equal(b.openQuestions, spec['_open-questions.md']);
    assert.equal(
      b.text,
      MAP.trimEnd() +
        '\n\n' +
        `${GLOSSARY_HEADING}\n\n` +
        'LIPO — Listwise preference optimization variant (ml/round-2.md)\n' +
        'LIPO — Low-income pension option (tax/plan.md)\n\n' +
        `${OPEN_QUESTIONS_HEADING}\n\n# Open questions\n\n- Where do receipts go?\n`,
    );
  });

  test('retriever never gets the open questions', async () => {
    const b = await buildBankBriefing(await makeBank(spec), { role: 'retriever' });
    assert.equal(b.openQuestions, null);
    assert.ok(!b.text.includes('Open questions'));
    assert.ok(!b.text.includes('receipts'));
    assert.ok(b.text.startsWith(MAP.trimEnd() + '\n\n' + GLOSSARY_HEADING));
    // composeBriefing enforces it too, whatever the caller passes.
    const composed = composeBriefing({ role: 'retriever', rootMap: MAP, glossary: b.glossary, openQuestions: 'secret' });
    assert.ok(!composed.includes('secret'));
  });

  test('librarian without /_open-questions.md gets no open questions section', async () => {
    const { ['_open-questions.md']: _, ...rest } = spec;
    const b = await buildBankBriefing(await makeBank(rest), { role: 'librarian' });
    assert.equal(b.openQuestions, null);
    assert.ok(!b.text.includes(OPEN_QUESTIONS_HEADING));
    assert.match(summarizeBriefing(b), /open questions none/);
  });

  test('glossary conflicts keep both lines and are reported, not fatal', async () => {
    const b = await buildBankBriefing(await makeBank(spec), { role: 'retriever' });
    assert.equal(b.stats.glossaryConflicts, 1);
    const conflict = b.diagnostics.find((d) => d.code === 'glossary-conflict');
    assert.equal(conflict?.detail, 'LIPO');
    assert.equal(b.stats.glossaryLines, 2);
    assert.equal(
      summarizeBriefing(b),
      'map 2 folders/' + b.stats.mapCodePoints + ' cp; glossary 2 lines from 2/2 manifests, 1 conflict(s)',
    );
  });

  test('same term with the same description in two files: two lines, no conflict', async () => {
    const b = await buildBankBriefing(
      await makeBank({
        '_index.md': MAP,
        'ml/a.md': 'x',
        'ml/a.md.manifest.json': manifest({ RM: 'Reward model' }),
        'tax/b.md': 'x',
        'tax/b.md.manifest.json': manifest({ RM: 'Reward model' }),
      }),
      { role: 'retriever' },
    );
    assert.deepEqual(glossaryBody(b), ['RM — Reward model (ml/a.md)', 'RM — Reward model (tax/b.md)']);
    assert.equal(b.stats.glossaryConflicts, 0);
  });

  test('empty bank (fresh scaffold shape): glossary (none), no diagnostics', async () => {
    const map = '# b\n\nMemory bank index.\n\n## Folders\n';
    const b = await buildBankBriefing(await makeBank({ '_index.md': map, '_raw/': '' }), { role: 'librarian' });
    assert.equal(b.text, `${map}\n${GLOSSARY_HEADING}\n\n(none)\n`);
    assert.deepEqual(b.diagnostics, []);
  });
});

describe('glossary order and Unicode', () => {
  test('sorted by lower-cased NFC term, then term, then path, by code points', async () => {
    const root = await makeBank({
      '_index.md': MAP,
      'z.md': 'x',
      'z.md.manifest.json': manifest({ beta: 'lower b', Zeta: 'Z', API: 'upper', api: 'lower', '😀x': 'astral', 'ﬀ': 'BMP high' }),
      'a.md': 'x',
      'a.md.manifest.json': manifest({ API: 'upper too', Beta: 'upper B' }),
    });
    const b = await buildBankBriefing(root, { role: 'retriever' });
    assert.deepEqual(glossaryBody(b), [
      'API — upper too (a.md)',
      'API — upper (z.md)',
      'api — lower (z.md)',
      'Beta — upper B (a.md)',
      'beta — lower b (z.md)',
      'Zeta — Z (z.md)',
      'ﬀ — BMP high (z.md)', // U+FB00 sorts before U+1F600 by code points (UTF-16 order would invert them)
      '😀x — astral (z.md)',
    ]);
  });

  test('ё terms show both spellings; decomposed input is normalized to NFC', async () => {
    const decomposed = 'ёж'; // ёж typed as е + combining diaeresis
    assert.equal(glossaryTermField('ЁЖ'), 'ЁЖ / ЕЖ');
    assert.equal(glossaryTermField(decomposed), 'ёж / еж');
    assert.equal(glossaryTermField('LIPO'), 'LIPO');

    const fileName = 'проекты/ёжик.md';
    const b = await buildBankBriefing(
      await makeBank({
        '_index.md': MAP,
        [fileName]: 'x',
        [fileName + '.manifest.json']: manifest({ [decomposed]: 'Кодовое имя кормушки для ежей', ЁЖ: 'Hedgehog feeder' }),
      }),
      { role: 'retriever' },
    );
    const [first, second] = glossaryBody(b);
    assert.match(first, /^ЁЖ \/ ЕЖ — Hedgehog feeder \(/);
    assert.match(second, /^ёж \/ еж — Кодовое имя кормушки для ежей \(/);
    // The path is the content file as listed on disk, so the agent can open it.
    assert.ok(first.endsWith(`(${fileName})`) && second.endsWith(`(${fileName})`));
  });

  test('the output does not depend on creation order or Unicode normalization of names', async () => {
    const files: [string, string][] = [
      ['work/x.md', manifest({ Q1: 'First quarter', ЁЖ: 'Hedgehog' })],
      ['ml/y.md', manifest({ q1: 'Quarter one', LIPO: 'Pension option' })],
      ['ёлка.md', manifest({ LIPO: 'Listwise preference optimization' })],
    ];
    const spec = (order: [string, string][], form: 'NFC' | 'NFD') =>
      Object.fromEntries([
        ['_index.md', MAP],
        ...order.flatMap(([p, m]) => [
          [p.normalize(form), 'x'],
          [p.normalize(form) + '.manifest.json', m.normalize(form)],
        ]),
      ]);
    const a = await buildBankBriefing(await makeBank(spec(files, 'NFC')), { role: 'librarian' });
    const again = await buildBankBriefing(await makeBank(spec(files, 'NFC')), { role: 'librarian' });
    const reversed = await buildBankBriefing(await makeBank(spec([...files].reverse(), 'NFC')), { role: 'librarian' });
    assert.equal(again.text, a.text);
    assert.equal(reversed.text, a.text);
    assert.deepEqual(reversed.diagnostics, a.diagnostics);

    // NFD file names (as macOS may produce): terms and descriptions come out identical.
    const nfd = await buildBankBriefing(await makeBank(spec(files, 'NFD')), { role: 'librarian' });
    assert.equal(nfd.glossary.normalize('NFC'), a.glossary);
    const strip = (s: string) => s.replace(/ \([^()]*\)$/gm, '');
    assert.equal(strip(nfd.glossary), strip(a.glossary));
  });
});

describe('invalid manifests are skipped with diagnostics', () => {
  test('bad JSON, schema errors, duplicate keys, BOM, size, orphans', async () => {
    const root = await makeBank({
      '_index.md': MAP,
      'ok.md': 'x',
      'ok.md.manifest.json': manifest({ OK: 'Valid entry' }),
      'json.md': 'x',
      'json.md.manifest.json': '{ "title": "x", "keywords": [], "glossary": { "BAD1": "x" }, }',
      'schema.md': 'x',
      'schema.md.manifest.json': JSON.stringify({ title: 'x', keywords: 'kw', glossary: { BAD2: '' } }),
      'unknown.md': 'x',
      'unknown.md.manifest.json': JSON.stringify({ title: 'x', keywords: [], glossary: { BAD3: 'x' }, summary: 's' }),
      'dup.md': 'x',
      'dup.md.manifest.json': '{ "title": "x", "keywords": [], "glossary": { "BAD4": "a", "BAD4": "b" } }',
      'bom.md': 'x',
      'bom.md.manifest.json': '﻿' + manifest({ BAD5: 'x' }),
      'long.md': 'x',
      'long.md.manifest.json': manifest({ BAD6: 'д'.repeat(101) }),
      'big.md': 'x',
      'big.md.manifest.json': manifest({ BAD7: 'x' }, 't'.repeat(9000)),
      'ghost.md.manifest.json': manifest({ BAD8: 'Orphan' }),
      'no-manifest.md': 'x',
    });
    const b = await buildBankBriefing(root, { role: 'retriever' });
    assert.deepEqual(glossaryBody(b), ['OK — Valid entry (ok.md)']);
    assert.ok(!/BAD\d/.test(b.text));
    assert.deepEqual(
      b.diagnostics.filter((d) => d.code.startsWith('manifest')).map((d) => [d.code, d.path, d.detail]),
      [
        ['manifest-skipped', 'big.md.manifest.json', 'manifest-size'],
        ['manifest-skipped', 'bom.md.manifest.json', 'manifest-json'],
        ['manifest-skipped', 'dup.md.manifest.json', 'manifest-json'],
        ['manifest-orphan', 'ghost.md.manifest.json', undefined],
        ['manifest-skipped', 'json.md.manifest.json', 'manifest-json'],
        ['manifest-skipped', 'long.md.manifest.json', 'manifest-schema'],
        ['manifest-skipped', 'schema.md.manifest.json', 'manifest-schema'],
        ['manifest-skipped', 'unknown.md.manifest.json', 'manifest-schema'],
      ],
    );
    assert.deepEqual(
      [b.stats.manifests, b.stats.manifestsUsed, b.stats.manifestsSkipped],
      [9, 1, 8],
    );
    for (const d of b.diagnostics) assert.ok(!d.message.includes('\n'), d.message);
  });

  test('buildGlossary is pure and order-independent', async () => {
    const root = await makeBank({
      'a.md': 'x',
      'a.md.manifest.json': manifest({ A: 'a' }),
      'b.md': 'x',
      'b.md.manifest.json': '{',
    });
    const { manifests } = await scanBank(root);
    const forward = buildGlossary(manifests);
    const backward = buildGlossary([...manifests].reverse());
    assert.deepEqual(backward, forward);
    assert.equal(forward.block, `${GLOSSARY_HEADING}\n\nA — a (a.md)`);
  });
});

describe('root map handling', () => {
  test('missing root map: placeholder line and a diagnostic, glossary still built', async () => {
    const b = await buildBankBriefing(
      await makeBank({ 'n.md': 'x', 'n.md.manifest.json': manifest({ N: 'n' }) }),
      { role: 'librarian' },
    );
    assert.equal(b.rootMap, null);
    assert.ok(b.text.startsWith(`${ROOT_MAP_MISSING}\n\n${GLOSSARY_HEADING}\n\nN — n (n.md)`));
    assert.ok(diagCodes(b).includes('map-missing'));
  });

  test('an invalid root map is injected verbatim with one map-invalid diagnostic', async () => {
    const bad = '# t\n\nOverview\n\n## Folders\n\n- work/ — no backticks\n## Extra\nfree text\n';
    const b = await buildBankBriefing(await makeBank({ '_index.md': bad, 'work/': '' }), { role: 'retriever' });
    assert.ok(b.text.startsWith(bad.trimEnd() + '\n\n'));
    const d = b.diagnostics.filter((x) => x.code === 'map-invalid');
    assert.equal(d.length, 1);
    assert.match(d[0].detail ?? '', /map-line-syntax/);
  });

  test('a symlinked /_open-questions.md is not followed', async () => {
    const root = await makeBank({ '_index.md': MAP });
    const outside = join(scratch, `outside-${++counter}.md`);
    await writeFile(outside, 'SECRET from outside the bank');
    await symlink(outside, join(root, '_open-questions.md'));
    const b = await buildBankBriefing(root, { role: 'librarian' });
    assert.equal(b.openQuestions, null);
    assert.ok(!b.text.includes('SECRET'));
    assert.ok(diagCodes(b).includes('open-questions-unreadable'));
  });

  test('an unreadable bank root does not throw', async () => {
    const b = await buildBankBriefing(join(scratch, 'does-not-exist'), { role: 'retriever' });
    assert.deepEqual(diagCodes(b), ['scan-failed', 'map-missing']);
    assert.ok(b.text.startsWith(ROOT_MAP_MISSING));
  });
});

describe('large banks are never truncated', () => {
  test('map over MAP_MAX and glossary over GLOSSARY_BLOCK_MAX are injected in full', async () => {
    const folders: string[] = [];
    for (let i = 0; i < 25; i++) {
      const top = `area-${String(i).padStart(2, '0')}/`;
      folders.push(top);
      for (let j = 0; j < 12; j++) folders.push(`${top}topic-${String(j).padStart(2, '0')}/`);
    }
    const mapLines = folders.map((f) => `- \`${f}\` — ${'Описание папки '.repeat(13).trim()} ${f}`);
    const map = `# big\n\nA very large bank.\n\n## Folders\n\n${mapLines.join('\n')}\n`;
    const spec: Record<string, string> = { '_index.md': map };
    const expected: string[] = [];
    for (let i = 0; i < 160; i++) {
      const file = `${folders[(i * 7) % folders.length]}note-${i}.md`;
      const glossary: Record<string, string> = {};
      for (let k = 0; k < 20; k++) {
        const term = `T${String(i).padStart(3, '0')}-${String(k).padStart(2, '0')}`;
        glossary[term] = `Термин номер ${k} из файла ${i}, `.padEnd(100, 'ж');
        expected.push(`${term} — ${glossary[term]} (${file})`);
      }
      spec[file] = 'x';
      spec[file + '.manifest.json'] = manifest(glossary);
    }
    const b = await buildBankBriefing(await makeBank(spec), { role: 'retriever' });

    assert.ok(b.stats.mapCodePoints > MAP_MAX, `map is ${b.stats.mapCodePoints}`);
    assert.ok(b.stats.glossaryCodePoints > GLOSSARY_BLOCK_MAX, `glossary is ${b.stats.glossaryCodePoints}`);
    assert.equal(b.stats.mapEntries, folders.length);
    for (const line of mapLines) assert.ok(b.text.includes(`${line}\n`), line);
    assert.equal(b.stats.glossaryLines, 3200);
    assert.deepEqual(glossaryBody(b), [...expected].sort());
    assert.ok(b.text.endsWith(`${expected.sort().at(-1)}\n`));
    assert.ok(diagCodes(b).includes('map-over-budget'));
    assert.ok(diagCodes(b).includes('glossary-over-budget'));
  });
});

describe('no writes', () => {
  test('generation leaves every file, folder and mtime untouched, even in a read-only bank', async () => {
    const root = await makeBank({
      '_index.md': MAP,
      'ml/a.md': 'x',
      'ml/a.md.manifest.json': manifest({ A: 'a' }),
      'ml/bad.md': 'x',
      'ml/bad.md.manifest.json': '{',
      '_open-questions.md': 'q',
      '_raw/in.md': 'raw',
    });
    const before = await snapshot(join(root, '..'));
    await chmodTree(join(root, '..'), 0o555);
    try {
      await buildBankBriefing(root, { role: 'librarian' });
      await buildBankBriefing(root, { role: 'retriever' });
    } finally {
      await chmodTree(join(root, '..'), 0o755);
    }
    assert.deepEqual(await snapshot(join(root, '..')), before);
  });
});
