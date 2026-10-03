// Offline checks of the synthetic navigation bank (test/fixtures/navigation-bank):
// the bank is valid under the production validator, and every path and
// evidence snippet of the ground truth is really in the files it names.
// No model runs here; answer quality is a separate live evaluation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MANIFEST_SUFFIX, ROOT_MAP_FILE, nfc } from '../src/bank-format/index.ts';
import { scanBank, validateBank } from '../src/bank-validator/index.ts';
import {
  NAVIGATION_SCENARIOS,
  type ExpectedFact,
  type NavigationScenario,
  type NavigationTheme,
} from './fixtures/navigation-bank/scenarios.ts';

const ROOT = fileURLToPath(new URL('./fixtures/navigation-bank/fs/', import.meta.url));
const ALL_THEMES: readonly NavigationTheme[] = [
  'ru-en',
  'yo-e',
  'nfc',
  'ambiguous-abbreviation',
  'multi-topic',
  'reference-chain',
  'no-answer',
  'primary-file-only',
  'binary-without-text',
];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const scan = await scanBank(ROOT);
const contentFiles = new Set(scan.contentFiles);
const bytes = async (p: string) => readFile(join(ROOT, p));
const text = async (p: string) => (await bytes(p)).toString('utf8');
const manifestOf = async (p: string) => JSON.parse(await text(p + MANIFEST_SUFFIX));

/** Every file a retriever could read: content, manifests and the root map, as NFC text. */
async function wholeBank(): Promise<Map<string, string>> {
  const paths = [...scan.contentFiles, ...scan.manifests.map((m) => m.path), ROOT_MAP_FILE];
  return new Map(await Promise.all(paths.map(async (p) => [p, nfc(await text(p))] as const)));
}

function factsOf(s: NavigationScenario): ExpectedFact[] {
  return s.expected.kind === 'not-in-bank' ? [] : s.expected.facts;
}

function isPng(b: Buffer): boolean {
  return b.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** PNG chunk types in file order; text lives only in tEXt, zTXt and iTXt. */
function pngChunkTypes(b: Buffer): string[] {
  const types: string[] = [];
  for (let at = 8; at + 8 <= b.length; ) {
    const length = b.readUInt32BE(at);
    types.push(b.toString('latin1', at + 4, at + 8));
    at += 12 + length;
  }
  return types;
}

describe('navigation bank fixture', () => {
  test('passes the production validator with only the intended PTO glossary conflict', async () => {
    const report = await validateBank(ROOT);
    assert.equal(report.errors, 0, JSON.stringify(report.violations, null, 2));
    assert.deepEqual(
      report.violations.map((v) => [v.code, v.severity, v.path, v.detail]),
      [['glossary-conflict', 'warning', '', 'PTO']],
    );
  });

  test('holds about 20 content files in several formats, each with a manifest', () => {
    assert.ok(scan.contentFiles.length >= 18 && scan.contentFiles.length <= 24, String(scan.contentFiles.length));
    const extensions = new Set(scan.contentFiles.map((p) => p.slice(p.lastIndexOf('.'))));
    for (const ext of ['.md', '.txt', '.html', '.csv', '.json', '.ics', '.png']) {
      assert.ok(extensions.has(ext), `no ${ext} file`);
    }
    const described = new Set(scan.manifests.map((m) => m.contentPath));
    for (const p of scan.contentFiles) assert.ok(described.has(p), `${p} has no manifest`);
  });
});

describe('navigation scenarios', () => {
  test('ids are unique and every theme is covered', () => {
    const ids = NAVIGATION_SCENARIOS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    const covered = new Set(NAVIGATION_SCENARIOS.flatMap((s) => s.themes));
    for (const theme of ALL_THEMES) assert.ok(covered.has(theme), `theme ${theme} has no scenario`);
  });

  for (const s of NAVIGATION_SCENARIOS) {
    describe(s.id, () => {
      test('every cited file is a content file and contains its evidence', async () => {
        for (const f of factsOf(s)) {
          assert.ok(contentFiles.has(f.source), `${f.source} is not a content file of the bank`);
          assert.ok(f.evidence.length > 0, `fact "${f.fact}" has no evidence`);
          const body = nfc(await text(f.source));
          for (const e of f.evidence) assert.ok(body.includes(nfc(e)), `${f.source} lacks "${e}"`);
        }
        for (const p of [...(s.wrongSources ?? []), ...(s.pointers ?? [])]) {
          assert.ok(contentFiles.has(p), `${p} is not a content file of the bank`);
        }
      });

      if (s.expected.kind === 'answer') {
        test('expects at least one fact', () => assert.ok(factsOf(s).length > 0));
      }

      if (s.themes.includes('ru-en')) {
        test('question and some cited file are in different languages', async () => {
          const cyrillic = (t: string) => /[Ѐ-ӿ]/.test(t);
          const sources = factsOf(s).map((f) => f.source);
          const evidence = factsOf(s).flatMap((f) => f.evidence);
          assert.equal(cyrillic(s.question), s.language === 'ru');
          const other = s.language === 'ru' ? evidence.some((e) => !cyrillic(e)) : evidence.some(cyrillic);
          assert.ok(other, `no evidence in the other language among ${sources.join(', ')}`);
        });
      }

      if (s.themes.includes('yo-e')) {
        test('question and source spell the word differently (е vs ё)', async () => {
          assert.ok(s.spelling, 'yo-e scenario needs a spelling pair');
          const { question, source } = s.spelling;
          assert.equal(nfc(question).replaceAll('ё', 'е'), nfc(source).replaceAll('ё', 'е'));
          assert.notEqual(nfc(question), nfc(source));
          assert.ok(nfc(s.question).includes(nfc(question)));
          const body = nfc(await text(factsOf(s)[0].source));
          assert.ok(body.includes(nfc(source)) && !body.includes(nfc(question)));
        });
      }

      if (s.themes.includes('nfc')) {
        test('cited text is stored decomposed and matches only after NFC', async () => {
          let decomposedOnly = 0;
          for (const f of factsOf(s)) {
            const raw = await text(f.source);
            assert.notEqual(raw, nfc(raw), `${f.source} is already NFC`);
            decomposedOnly += f.evidence.filter((e) => !raw.includes(nfc(e))).length;
          }
          assert.ok(decomposedOnly > 0, 'every evidence snippet matches without NFC');
        });
      }

      if (s.themes.includes('ambiguous-abbreviation')) {
        test('the abbreviation has a different glossary meaning in each wrong source', async () => {
          assert.ok(s.term && s.wrongSources?.length, 'needs a term and wrong sources');
          assert.ok(s.question.includes(s.term));
          const meaning = async (p: string) => (await manifestOf(p)).glossary[s.term!] as string | undefined;
          const right = await meaning(factsOf(s)[0].source);
          assert.ok(right, `${factsOf(s)[0].source} does not define ${s.term}`);
          for (const p of s.wrongSources) {
            const wrong = await meaning(p);
            assert.ok(wrong && wrong !== right, `${p} does not define ${s.term} differently`);
            assert.ok(!factsOf(s).some((f) => f.source === p), `${p} is both right and wrong`);
          }
        });
      }

      if (s.themes.includes('multi-topic')) {
        test('facts come from at least two different files', () => {
          assert.ok(new Set(factsOf(s).map((f) => f.source)).size >= 2);
        });
      }

      if (s.themes.includes('reference-chain')) {
        test('each pointer names the source but does not hold the evidence', async () => {
          assert.ok(s.pointers?.length, 'reference-chain scenario needs pointers');
          for (const p of s.pointers) {
            const body = nfc(await text(p));
            assert.ok(
              factsOf(s).some((f) => body.includes(f.source.slice(f.source.lastIndexOf('/') + 1))),
              `${p} does not point to any source`,
            );
            for (const e of factsOf(s).flatMap((f) => f.evidence)) {
              assert.ok(!body.includes(nfc(e)), `${p} already holds "${e}"`);
            }
          }
        });
      }

      if (s.themes.includes('primary-file-only')) {
        test('evidence is absent from every manifest and the root map', async () => {
          const bank = await wholeBank();
          for (const [p, body] of bank) {
            if (contentFiles.has(p)) continue;
            for (const e of factsOf(s).flatMap((f) => f.evidence)) {
              assert.ok(!body.includes(nfc(e)), `${p} leaks "${e}"`);
            }
          }
        });
      }

      if (s.expected.kind === 'not-in-bank') {
        const { absentTerms } = s.expected;
        test('no file in the bank contains any absent term', async () => {
          assert.ok(absentTerms.length > 0);
          for (const [p, body] of await wholeBank()) {
            for (const t of absentTerms) {
              assert.ok(!body.toLowerCase().includes(nfc(t).toLowerCase()), `${p} contains "${t}"`);
            }
          }
        });
      }

      if (s.expected.kind === 'content-unavailable') {
        const { unreadable } = s.expected;
        test('the unreadable file is a PNG with no text chunks', async () => {
          assert.ok(s.themes.includes('binary-without-text'));
          assert.ok(contentFiles.has(unreadable));
          const b = await bytes(unreadable);
          assert.ok(isPng(b), `${unreadable} is not a PNG`);
          const types = pngChunkTypes(b);
          assert.equal(types.at(-1), 'IEND');
          for (const t of ['tEXt', 'zTXt', 'iTXt', 'eXIf']) assert.ok(!types.includes(t), `${unreadable} has ${t}`);
          assert.deepEqual((await manifestOf(unreadable)).glossary, {});
        });
      }
    });
  }
});
