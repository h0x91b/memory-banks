// Offline unit tests of the shared bank format module (contract v1,
// docs/design/bank-format.md): manifest schema/parser, root map grammar,
// Unicode lengths, path rules and entry classification.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyEntry,
  codePointLength,
  compareFolderPaths,
  contentPathForManifest,
  findDuplicateKey,
  folderDepth,
  GLOSSARY_DESC_MAX,
  isValidFilePath,
  isValidFolderPath,
  manifestPathFor,
  parentFolder,
  parseManifest,
  parseRootMap,
  type ManifestParseResult,
  type Violation,
} from '../src/bank-format/index.ts';

const json = (o: unknown) => JSON.stringify(o);

function failures(r: ManifestParseResult): Violation[] {
  assert.equal(r.ok, false, 'expected the manifest to be rejected');
  return r.ok ? [] : r.violations;
}

function codes(vs: Violation[]): string[] {
  return vs.map((v) => v.code);
}

describe('Unicode length', () => {
  test('counts code points of the NFC form', () => {
    assert.equal(codePointLength('ёж'), 2);
    assert.equal(codePointLength('\u0435\u0308ж'), 2); // ёж with ё decomposed: 3 code points raw
    assert.equal(codePointLength('👍🏽'), 2); // UTF-16 length is 4
  });
});

describe('manifest', () => {
  test('accepts the contract examples', () => {
    const r = parseManifest(
      json({
        title: 'Borscht recipe with roasted beets',
        keywords: ['борщ', 'свёкла', 'свекла', 'beet', 'borscht', 'recipe'],
        glossary: {},
      }),
    );
    assert.ok(r.ok);
    assert.equal(r.manifest.keywords.length, 6);
    assert.equal(r.manifest.glossary.size, 0);

    const lipo = parseManifest(
      json({
        title: 'Reward-model experiments, round 2',
        keywords: ['LIPO'],
        glossary: { LIPO: 'Listwise preference optimization variant tested as a DPO replacement in round 2' },
      }),
    );
    assert.ok(lipo.ok);
    assert.match(lipo.manifest.glossary.get('LIPO')!, /^Listwise/);
  });

  test('reads raw bytes and rejects BOM and invalid UTF-8', () => {
    const body = json({ title: 'x', keywords: [], glossary: {} });
    assert.ok(parseManifest(new TextEncoder().encode(body)).ok);

    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)]);
    assert.deepEqual(codes(failures(parseManifest(bom))), ['manifest-json']);
    assert.deepEqual(codes(failures(parseManifest('\uFEFF' + body))), ['manifest-json']);

    const bad = new Uint8Array([0x7b, 0xff, 0x7d]);
    assert.deepEqual(codes(failures(parseManifest(bad))), ['manifest-json']);
  });

  test('rejects comments and trailing commas', () => {
    const vs = failures(parseManifest('{ "title": "x", "keywords": [], "glossary": {}, }', 'a.md.manifest.json'));
    assert.deepEqual(codes(vs), ['manifest-json']);
    assert.equal(vs[0].path, 'a.md.manifest.json');
    assert.equal(vs[0].severity, 'error');
  });

  test('duplicate keys are manifest-json at any level', () => {
    const vs = failures(parseManifest('{ "title": "x", "keywords": [], "glossary": { "LIPO": "a", "LIPO": "b" } }'));
    assert.deepEqual(codes(vs), ['manifest-json']);
    assert.match(vs[0].message, /duplicate key "LIPO"/);
    assert.deepEqual(codes(failures(parseManifest('{"title":"x","title":"y","keywords":[],"glossary":{}}'))), [
      'manifest-json',
    ]);
  });

  test('duplicate scan decodes escapes and ignores equal keys in different objects', () => {
    assert.equal(findDuplicateKey('{"a":{"k":1},"b":{"k":2}}'), null);
    assert.equal(findDuplicateKey('[{"k":1},{"k":2}]'), null);
    assert.equal(findDuplicateKey('{"A":1,"\\u0041":2}'), 'A');
    assert.equal(findDuplicateKey('{"s":"has \\" quote, }","s":1}'), 's');
    assert.equal(findDuplicateKey('{"x":[1,{"y":1,"y":2}]}'), 'y');
  });

  test('unknown keys and wrong types are manifest-schema with the field named', () => {
    const unknown = failures(parseManifest(json({ title: 'x', keywords: [], glossary: {}, summary: '...' })));
    assert.deepEqual(codes(unknown), ['manifest-schema']);
    assert.equal(unknown[0].detail, 'summary');
    assert.match(unknown[0].message, /summary is not an allowed key/);

    const wrong = failures(parseManifest(json({ title: 'x', keywords: 'borscht', glossary: { LIPO: '' } })));
    assert.deepEqual(codes(wrong), ['manifest-schema', 'manifest-schema']);
    assert.deepEqual(wrong.map((v) => v.detail).sort(), ['glossary.LIPO', 'keywords']);

    const missing = failures(parseManifest(json({ title: 'x', keywords: [] })));
    assert.deepEqual(
      missing.map((v) => v.detail),
      ['glossary'],
    );
    assert.match(missing[0].message, /glossary is missing/);
    for (const notObject of ['[]', '"x"', 'null']) {
      assert.deepEqual(codes(failures(parseManifest(notObject))), ['manifest-schema'], notObject);
    }
  });

  test('glossary description limit is 100 code points, counted after NFC', () => {
    const at = 'a'.repeat(GLOSSARY_DESC_MAX);
    assert.ok(parseManifest(json({ title: 'x', keywords: [], glossary: { LIPO: at } })).ok);

    const over = failures(parseManifest(json({ title: 'x', keywords: [], glossary: { LIPO: at + 'b' } })));
    assert.equal(over[0].detail, 'glossary.LIPO');
    assert.match(over[0].message, /101 code points \(limit 100\)/);

    // 100 decomposed ё = 200 UTF-16 units raw, 100 code points after NFC.
    const decomposed = '\u0435\u0308'.repeat(GLOSSARY_DESC_MAX);
    assert.ok(parseManifest(json({ title: 'x', keywords: [], glossary: { ЁЖ: decomposed } })).ok);
  });

  test('string rules: empty, edge whitespace, control characters, separator in term', () => {
    const bad: Array<[unknown, string]> = [
      [{ title: '', keywords: [], glossary: {} }, 'title'],
      [{ title: ' x', keywords: [], glossary: {} }, 'title'],
      [{ title: 'a\nb', keywords: [], glossary: {} }, 'title'],
      [{ title: 'a\u2028b', keywords: [], glossary: {} }, 'title'],
      [{ title: 'x', keywords: ['ok', 'tab\there'], glossary: {} }, 'keywords.1'],
      [{ title: 'x', keywords: [], glossary: { 'A — B': 'desc' } }, 'glossary.A — B'],
    ];
    for (const [manifest, field] of bad) {
      const vs = failures(parseManifest(json(manifest)));
      assert.deepEqual(
        vs.map((v) => v.detail),
        [field],
        json(manifest),
      );
    }
  });

  test('count limits for keywords and glossary entries', () => {
    const kw = Array.from({ length: 31 }, (_, i) => `k${i}`);
    assert.equal(failures(parseManifest(json({ title: 'x', keywords: kw, glossary: {} })))[0].detail, 'keywords');
    const gl = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`T${i}`, 'd']));
    assert.equal(failures(parseManifest(json({ title: 'x', keywords: [], glossary: gl })))[0].detail, 'glossary');
    assert.ok(parseManifest(json({ title: 'x', keywords: kw.slice(0, 30), glossary: {} })).ok);
  });

  test('terms named like Object.prototype members are kept, not dropped', () => {
    const text = '{"title":"x","keywords":[],"glossary":{"__proto__":"p","constructor":"c","prototype":"t"}}';
    const r = parseManifest(text);
    assert.ok(r.ok);
    assert.deepEqual([...r.manifest.glossary.keys()], ['__proto__', 'constructor', 'prototype']);
    assert.equal(r.manifest.glossary.get('constructor'), 'c');
  });

  test('size limit is checked on bytes before parsing', () => {
    const big = json({ title: 'x', keywords: [], glossary: {}, pad: 'я'.repeat(4100) }); // > 8192 bytes
    const vs = failures(parseManifest(big));
    assert.deepEqual(codes(vs), ['manifest-size']);
    assert.equal(vs[0].limit, 8192);
  });
});

describe('paths and classification', () => {
  test('folder and file path grammar', () => {
    for (const ok of ['', 'work/', 'a/b/c/', 'рецепты/']) assert.ok(isValidFolderPath(ok), ok);
    for (const bad of ['/work/', 'work', './work/', 'a//b/', 'a/../b/', '../', 'a/./']) {
      assert.ok(!isValidFolderPath(bad), bad);
    }
    assert.ok(isValidFilePath('work/standups/2026-10-01.md'));
    for (const bad of ['', 'work/', '/a.md', 'a/../b.md', 'a//b.md']) assert.ok(!isValidFilePath(bad), bad);
    assert.equal(folderDepth(''), 0);
    assert.equal(folderDepth('a/b/c/'), 3);
    assert.equal(parentFolder('work/standups/x.md'), 'work/standups/');
    assert.equal(parentFolder('x.md'), '');
  });

  test('manifest pairing keeps the full name with extension', () => {
    assert.equal(manifestPathFor('recipes/borscht.html'), 'recipes/borscht.html.manifest.json');
    assert.equal(contentPathForManifest('recipes/borscht.md.manifest.json'), 'recipes/borscht.md');
    assert.equal(contentPathForManifest('recipes/borscht.md'), null);
    assert.equal(contentPathForManifest('recipes/.manifest.json'), null);
  });

  test('classifyEntry follows the §2 rows in order', () => {
    const cases: Array<[string, Parameters<typeof classifyEntry>[1], string]> = [
      ['_raw', 'dir', 'inbox'],
      ['_unsorted/odd.bin', 'file', 'inbox'],
      ['_raw/.hidden', 'file', 'inbox'],
      ['work/_raw', 'dir', 'folder'],
      ['recipes/.draft.md', 'file', 'hidden-entry'],
      ['.git', 'dir', 'hidden-entry'],
      ['work/link', 'symlink', 'symlink'],
      ['work/fifo', 'other', 'special-file'],
      ['_index.md', 'file', 'root-map'],
      ['work/standups/_index.md', 'file', 'nested-index'],
      ['_open-questions.md', 'file', 'open-questions'],
      ['work/_open-questions.md', 'file', 'content'],
      ['work/a.md.manifest.json', 'file', 'manifest'],
      ['work/standups', 'dir', 'folder'],
      ['notes.md', 'file', 'content'],
      ['work/_notes.md', 'file', 'content'],
    ];
    for (const [p, kind, expected] of cases) assert.equal(classifyEntry(p, kind), expected, p);
  });

  test('folder order is by segment, so a parent stays next to its children', () => {
    const sorted = ['work-x/', 'work/standups/', 'work/', 'recipes/'].sort(compareFolderPaths);
    assert.deepEqual(sorted, ['recipes/', 'work/', 'work/standups/', 'work-x/']);
    // Code point order, not UTF-16: U+FF5E sorts before U+1F600.
    assert.ok(compareFolderPaths('～/', '\u{1F600}/') < 0);
  });
});

const VALID_MAP = `# family-notes

Personal notes of one household: recipes, work standups, trip plans. Mostly Russian, some English.

## Folders

- \`recipes/\` — Home recipes in Russian: soups, baking, preserves; ingredient lists and cooking times
- \`work/\` — Work notes grouped by kind; see subfolders
- \`work/standups/\` — Daily work standups Oct 2026: Flue migration, sandbox checks, model switch
- \`work-x/\` — Side project X: design sketches and a pitch deck
`;

describe('root map', () => {
  test('parses the contract example with no violations', () => {
    const map = parseRootMap(VALID_MAP);
    assert.deepEqual(map.violations, []);
    assert.equal(map.title, 'family-notes');
    assert.match(map.overview, /^Personal notes/);
    assert.deepEqual(
      map.entries.map((e) => [e.path, e.line]),
      [
        ['recipes/', 7],
        ['work/', 8],
        ['work/standups/', 9],
        ['work-x/', 10],
      ],
    );
  });

  test('empty bank: an empty Folders section is valid', () => {
    const map = parseRootMap('# empty\n\nNothing here yet.\n\n## Folders\n');
    assert.deepEqual(map.violations, []);
    assert.deepEqual(map.entries, []);
  });

  test('the legacy scaffold (no Folders heading) is a structure error', () => {
    const map = parseRootMap('# b\n\nMemory bank index. Curated automatically by the curator agent.\n');
    assert.deepEqual(codes(map.violations), ['map-structure']);
    assert.equal(map.violations[0].detail, 'folders-heading');
  });

  test('invalid map lines from the contract, one violation each', () => {
    const lines = [
      ['- work/standups/ — Daily standups', 'map-line-syntax'],
      ['- `work/standups` — Daily standups', 'map-line-syntax'],
      ['- `work/standups/` - Daily standups', 'map-line-syntax'],
      ['- `_unsorted/` — Things to triage', 'map-reserved'],
      ['- `_raw/sub/` — Inside an inbox', 'map-reserved'],
      ['- `../up/` — Escapes the bank', 'map-line-syntax'],
      ['- `/abs/` — Absolute path', 'map-line-syntax'],
    ];
    for (const [line, code] of lines) {
      const map = parseRootMap(`# t\n\nOverview.\n\n## Folders\n\n${line}\n`);
      assert.deepEqual(codes(map.violations), [code], line);
      assert.deepEqual(map.entries, [], line);
    }
  });

  test('duplicates compare NFC forms and keep only the first line', () => {
    const map = parseRootMap('# t\n\nO.\n\n## Folders\n\n- `ёж/` — first\n- `\u0435\u0308ж/` — second\n');
    assert.deepEqual(codes(map.violations), ['map-duplicate']);
    assert.deepEqual(
      map.entries.map((e) => e.description),
      ['first'],
    );
  });

  test('folder description limit is 200 code points; the line is still an entry', () => {
    const ok = parseRootMap(`# t\n\nO.\n\n## Folders\n\n- \`a/\` — ${'д'.repeat(200)}\n`);
    assert.deepEqual(ok.violations, []);
    const over = parseRootMap(`# t\n\nO.\n\n## Folders\n\n- \`a/\` — ${'д'.repeat(201)}\n`);
    assert.deepEqual(codes(over.violations), ['map-desc-too-long']);
    assert.equal(over.violations[0].value, 201);
    assert.equal(over.entries.length, 1);
  });

  test('wrong order is a single warning', () => {
    const map = parseRootMap('# t\n\nO.\n\n## Folders\n\n- `work-x/` — x\n- `work/` — w\n- `work/s/` — s\n');
    assert.deepEqual(codes(map.violations), ['map-order']);
    assert.equal(map.violations[0].severity, 'warning');
  });

  test('structure errors: title, headings, overview, extra sections, line endings', () => {
    const cases: Array<[string, string]> = [
      ['no title\n\nO.\n\n## Folders\n', 'title'],
      [`# ${'t'.repeat(81)}\n\nO.\n\n## Folders\n`, 'title'],
      ['# t\n\n\n## Folders\n', 'overview'],
      [`# t\n\n${'o'.repeat(601)}\n\n## Folders\n`, 'overview'],
      ['# t\n\nO.\n## Sub\n\n## Folders\n', 'overview-heading'],
      ['# t\n\nO.\n\n## Folders\n\n## Folders\n', 'folders-heading'],
      ['# t\n\nO.\n\n## Folders\n\n## Notes\n', '## Notes'],
      ['# t\r\n\r\nO.\r\n\r\n## Folders\r\n', 'crlf'],
      ['\uFEFF# t\n\nO.\n\n## Folders\n', 'bom'],
    ];
    for (const [text, detail] of cases) {
      const map = parseRootMap(text);
      assert.deepEqual(
        map.violations.map((v) => [v.code, v.detail]),
        [['map-structure', detail]],
        JSON.stringify(text),
      );
    }
  });

  test('overview limit ignores line breaks', () => {
    const overview = `${'o'.repeat(300)}\n${'o'.repeat(300)}`;
    assert.deepEqual(parseRootMap(`# t\n\n${overview}\n\n## Folders\n`).violations, []);
  });

  test('a map over MAP_MAX is only a size warning', () => {
    const lines = Array.from({ length: 220 }, (_, i) => `- \`f${String(i).padStart(3, '0')}/\` — ${'d'.repeat(180)}`);
    const map = parseRootMap(`# t\n\nO.\n\n## Folders\n\n${lines.join('\n')}\n`);
    assert.deepEqual(codes(map.violations), ['map-size']);
    assert.equal(map.violations[0].severity, 'warning');
    assert.equal(map.entries.length, 220);
  });
});
