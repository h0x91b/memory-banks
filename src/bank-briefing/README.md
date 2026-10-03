# Bank briefing generator

Builds what the Librarian and the retriever see about a bank before they start, per
contract v1 (`docs/design/bank-format.md` §5.3, §6). Read-only: it never writes into the
bank and never throws; every problem becomes a diagnostic for the run log.

## Use

```ts
import { buildBankBriefing, summarizeBriefing } from './bank-briefing/index.ts';

const briefing = await buildBankBriefing(fsPath, { role: 'librarian' }); // or 'retriever'
log(summarizeBriefing(briefing));               // one line
for (const d of briefing.diagnostics) log(`${d.code} ${d.message}`);
prompt += briefing.text;                        // inject as-is, never cut
```

`fsPath` is the bank's `fs/` directory (`bankFsPath(bank)`).

## What `briefing.text` contains, in order

1. The root `/_index.md`, verbatim and in full. Missing → the line `(root _index.md is missing)`.
   Invalid → still verbatim, plus one `map-invalid` diagnostic (the validator is the strict one).
2. The glossary block, generated from valid manifest sidecars:

   ```
   ## Glossary (generated from manifests)

   LIPO — Listwise preference optimization variant (ml/round-2.md)
   LIPO — Low-income pension option (tax/plan.md)
   ЁЖ / ЕЖ — Codename of the hedgehog-feeder project (projects/hedgehog/notes.md)
   ```

   One line per (manifest, term); the path is the content file. A term described differently in
   several files keeps every line and adds a `glossary-conflict` diagnostic. Order: lower-cased NFC
   term, then term, then path, by code points. No terms → `(none)`.
3. Librarian only, when the file exists: `## Open questions (/_open-questions.md)` and the file verbatim.
   The retriever never gets it, whatever is passed to `composeBriefing`.

Nothing is truncated, even above `MAP_MAX` / `GLOSSARY_BLOCK_MAX`; those only add
`map-over-budget` / `glossary-over-budget` diagnostics (contract D10).

## Diagnostics

| Code | Meaning |
|---|---|
| `manifest-skipped` | Manifest failed to parse; left out. `detail` = its violation codes |
| `manifest-orphan` | Manifest describes no content file; left out |
| `glossary-conflict` | Same term, different descriptions. `detail` = the term |
| `glossary-over-budget`, `map-over-budget` | Over the size budget, injected in full anyway |
| `map-missing` | No root `_index.md` |
| `map-invalid` | Root map has format errors. `detail` = the codes |
| `open-questions-unreadable` | `/_open-questions.md` is not a regular file (e.g. a symlink) or unreadable |
| `scan-failed` | The bank root could not be walked; glossary says it is unavailable |

## Building blocks

- `buildGlossary(scan.manifests)` — pure, order-independent; for a caller that already ran `scanBank`.
- `composeBriefing({ role, rootMap, glossary, openQuestions })` — pure joining in contract order.
- `glossaryTermField(term)` — the `ЁЖ / ЕЖ` form.

The walker and parsers come from `src/bank-validator` (`scanBank`, `validateScan`) and
`src/bank-format` — this module adds no parsing of its own.
