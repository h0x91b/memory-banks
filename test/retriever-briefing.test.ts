/**
 * Pure checks on the retriever's first message and its role doc: no model,
 * no sandbox. The pipeline-level checks live in retriever-navigation-e2e.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRetrieverBriefing } from '../src/retriever-briefing.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROLE = readFileSync(path.join(ROOT, '.flue/roles/retriever.md'), 'utf8');
const EMPTY_ANSWER = 'No relevant data found in the memory bank.';

const MAP = '# b\n\nOverview.\n\n## Folders\n\n- `a/` — A\n';
const GLOSSARY = '## Glossary (generated from manifests)\n\nPTO — paid time off (work/hr/pto.md)\n';

test('briefing injects the bank briefing verbatim between markers, after the host prefix', () => {
  const text = buildRetrieverBriefing({
    bank: 'b',
    question: 'Сколько дней PTO?',
    fsPath: '/host/b/fs',
    hint: '  look in work  ',
    bankBriefing: `${MAP}\n${GLOSSARY}\n\n`,
  });
  assert.ok(text.includes(`<bank-briefing>\n${MAP}\n${GLOSSARY.replace(/\n+$/, '')}\n</bank-briefing>`));
  assert.ok(text.includes('## Question\nСколько дней PTO?'));
  assert.ok(text.includes('## Hint from the caller\nlook in work'));
  assert.ok(text.indexOf('`/host/b/fs`') < text.indexOf('<bank-briefing>'));
  assert.ok(!/Top lines of every/.test(text));
});

test('briefing omits an empty hint', () => {
  const text = buildRetrieverBriefing({ bank: 'b', question: 'q', fsPath: '/f', hint: '   ', bankBriefing: MAP });
  assert.ok(!text.includes('Hint from the caller'));
});

test('role doc keeps the exact no-data literal', () => {
  assert.ok(ROLE.includes(`\`${EMPTY_ANSWER}\``));
  assert.ok(ROLE.includes(`"answer": "${EMPTY_ANSWER}"`));
});

test('role doc separates "no relevant source" from "source found, field missing"', () => {
  // Coordinator decision (Seq5): the literal is only for no relevant source;
  // a found document lacking the field is cited with an explicit "not in it".
  assert.match(ROLE, /The literal is for "no relevant source at all"/);
  assert.match(ROLE, /does not\s+contain it and cite the document/);
});

test('role doc navigates by root map and glossary, not by nested indexes or a hop budget', () => {
  assert.match(ROLE, /root map/i);
  assert.match(ROLE, /glossary/i);
  assert.match(ROLE, /no\s+`_index\.md` files inside folders/);
  assert.doesNotMatch(ROLE, /1–3 calls|5–10 tool calls|Budget for `rg`/);
  assert.match(ROLE, /There is no fixed budget of tool calls/);
});

test('role doc covers manifests-as-signposts, binaries, abbreviations and Cyrillic search', () => {
  assert.match(ROLE, /manifest is a\s+\*\*signpost\*\*/);
  assert.match(ROLE, /Cite the content file, never its manifest/);
  assert.match(ROLE, /Never describe the contents of a binary file/);
  assert.match(ROLE, /Never invent an expansion of an abbreviation/);
  assert.match(ROLE, /Never use `-w` or `\\b` with Cyrillic/);
  assert.ok(ROLE.includes('(ё|е\\p{M}?)'));
  assert.doesNotMatch(ROLE, /open questions/i);
});
