# Bank format contract (v1)

Status: **contract v1, implemented.** This document fixes the on-disk format of a memory bank. It is followed by
the format library (`src/bank-format/`), the validator (`src/bank-validator/`), the briefing and glossary generator
(`src/bank-briefing/`), the bank scaffold (`src/bank.ts`), the Librarian's `submit_result` gate
(`src/librarian-gate.ts`, §9) and the Librarian/retriever roles (`.flue/roles/`). Existing banks are not migrated.

Every rule carries its provenance:

| Tag | Meaning |
|---|---|
| **[DECIDED]** | Explicit user decision. Change only with the user. |
| **[RECOMMENDED]** | Recommended in the design discussion, not confirmed verbatim by the user. Default until changed. |
| **[PROPOSED]** | Detail introduced by this contract to remove ambiguity. Default until changed. |
| **[COORDINATOR]** | Chosen by the coordinator task (Seq 5) and announced to the user; not an explicit user decision. |

All RECOMMENDED, PROPOSED and COORDINATOR rules are the **v1 implementation defaults**. Changing one later is a
contract change, not an implementation detail.

Defaults are collected as named constants in §10; implementations must use those names.

---

## 1. Scope and vocabulary

- **Bank root** — the bank's `fs/` directory (`<MEMORY_BANK_ROOT>/<bank>/fs/`). Agents see it mounted at `/`.
- **Path** — POSIX, relative to the bank root, no leading `/`, no `./`, no `//`, no `.` or `..` segments.
  Folder paths end with `/` (`work/standups/`); file paths do not (`work/standups/2026-10-01.md`).
  The root folder itself is the empty path; in messages it is written `/`.
- **Folder depth** — number of segments in a folder path. Root = 0, `work/` = 1, `a/b/c/` = 3.
- **Content file** — a user-content file of any type (`.md`, `.html`, `.txt`, `.pdf`, images, other binaries).
- **Service file / folder** — anything the format itself defines (§2). Never content.
- **Manifest** — a JSON sidecar describing exactly one content file (§4).
- **Root map** — the root `_index.md`: bank overview plus one line per folder (§5).
- **Violation** — one validator finding with a severity, `error` or `warning` (§8).

Out of scope: runtime code, prompts, API shape, renaming curator → Librarian, migration of existing banks.

---

## 2. Classification of every entry

The validator walks the bank root and classifies each entry by the **first** matching row.

| # | Entry | Class | Manifest? | Counts for width? | Gets a map line? |
|---|---|---|---|---|---|
| 1 | `_raw/`, `_unsorted/` **at the root only**, with everything inside | Inbox (service) — skipped entirely | no | no | no |
| 2 | Name starting with `.` (file or folder, any depth) | Violation `hidden-entry` | — | — | — |
| 3 | Symlink (any target) — not followed | Violation `symlink` | — | — | — |
| 4 | Anything that is neither a regular file nor a directory | Violation `special-file` | — | — | — |
| 5 | `_index.md` at the root | Root map (service) | no | no | — |
| 6 | `_index.md` in any other folder | Violation `nested-index` **[DECIDED: `_index.md` only at the root]** | — | — | — |
| 7 | `_open-questions.md` at the root | Curator's open questions (service, §5.3) **[COORDINATOR]** | no | no | no |
| 8 | File whose name ends in `.manifest.json` | Manifest (service) | no | no | — |
| 9 | Any other directory | Folder | no | — | yes |
| 10 | Any other regular file | Content file | **yes** | yes | — |

Notes:

- Row 1 is **[DECIDED]** in spirit (inboxes are excluded today, `src/index-scan.ts:26`); "root only" is
  **[PROPOSED]**: a folder named `_raw` deeper in the tree is an ordinary folder.
- Rows 2–4 are **[PROPOSED]**. Hidden entries are an error because the retriever cannot find them: `rg` in the
  sandbox skips hidden files by default (verified on just-bash 3.0.0: `rg -l needle` returned only `vis.md`;
  `.dot.md` and `.hid/x.md` appeared only with `--hidden`).
- Names starting with `_` are **not** reserved beyond rows 1 and 5–7. `_open-questions.md` below the root is ordinary content. An imported `_notes.md` is content.
- Content files are allowed directly in the root folder **[PROPOSED]**; they follow the same width and manifest rules.
- A user file whose name happens to end in `.manifest.json` is classified as a manifest (row 8), will usually be an
  orphan (§4.4), and must be renamed by the curator. Known edge case, accepted **[PROPOSED]**.

### Example tree

```
_index.md                         root map (service)
_raw/inbox-item.md                inbox — ignored
_unsorted/odd.bin                 inbox — ignored
work/                             folder, depth 1, width 0
work/standups/                    folder, depth 2, width 2
work/standups/2026-10-01.md       content
work/standups/2026-10-01.md.manifest.json
work/standups/deck.pdf            content (binary)
work/standups/deck.pdf.manifest.json
work/standups/_index.md           violation nested-index
recipes/borscht.md                content
recipes/borscht.md.manifest.json
recipes/borscht.html              content — distinct from borscht.md
recipes/borscht.html.manifest.json
recipes/.draft.md                 violation hidden-entry
```

---

## 3. Structure limits

### 3.1 Depth **[DECIDED]**

- Every folder must have depth ≤ `MAX_DEPTH` (3). `a/b/c/` is allowed, `a/b/c/d/` is not.
- Violation `depth-over-limit` (error), reported once per folder at depth `MAX_DEPTH + 1` (its subtree is implied).
- Files have no depth of their own; they live in a folder. A file in `a/b/c/` is fine.

### 3.2 Width

- **Width of a folder** = number of **content files directly inside it** (rows 10 of §2).
  Not counted: manifests **[DECIDED]**, service files, subfolders, entries that are violations
  (hidden, symlink, special) **[PROPOSED]**.
- If width > `WIDTH_TARGET` (10) → warning `width-over-target` **[DECIDED target 10]**.
- If width > `WIDTH_LIMIT` (20) → error `width-over-limit` **[RECOMMENDED hard 20]**.
- **Depth wins over width [DECIDED].** A folder at depth `MAX_DEPTH` cannot be split into subfolders, so for such a
  folder width > 20 is downgraded to warning `width-over-limit-at-max-depth` **[PROPOSED interpretation]**.
- The number of subfolders is not limited **[PROPOSED]**.
- Empty folder (no content files, no subfolders) → warning `empty-folder` **[PROPOSED]**.

---

## 4. Manifest sidecar **[DECIDED: one JSON sidecar per content file]**

### 4.1 Name and location

- Content file `D/NAME` → manifest `D/NAME.manifest.json`, same folder, full original name including its extension.
  `borscht.md` and `borscht.html` therefore never collide. Suffix spelling `.manifest.json` is **[RECOMMENDED]**
  (user said "same name + .manifest or similar").
- Moving or renaming a content file means moving or renaming its manifest with it.
- Folders, service files and inbox files never have manifests.

### 4.2 Encoding and syntax

- UTF-8 without BOM. A BOM is an error (`JSON.parse` rejects it anyway).
- Strict JSON: no comments, no trailing commas. **Duplicate keys at any level are an error** — note that
  `JSON.parse('{"a":1,"a":2}')` silently returns `{"a":2}`, so the implementation needs an explicit duplicate check.
- File size ≤ `MANIFEST_MAX_BYTES` (8192) **[PROPOSED]**.
- The validator parses with plain `JSON.parse`; to be safe against a key named `__proto__`, consumers must store
  glossary entries in a `Map` or `Object.create(null)`, never by assignment into `{}`.

### 4.3 Schema

Exactly three top-level keys; unknown keys are an error (valibot `strictObject`) **[PROPOSED strictness]**.

| Field | Type | Rules | Provenance |
|---|---|---|---|
| `title` | string | 1–`TITLE_MAX` (120) code points; single line; English | field DECIDED; limits and language PROPOSED (English follows the existing "intermediate files in English" rule in `curator.md`) |
| `keywords` | string[] | 0–`KEYWORDS_MAX` (30) items; each 1–`KEYWORD_MAX` (60) code points; single line; original language **plus** spelling variants (`ё`/`е`) **plus** English equivalents; no descriptions | field DECIDED; limits PROPOSED |
| `glossary` | object `{term: description}` | 0–`GLOSSARY_ENTRIES_MAX` (20) entries; term 1–`TERM_MAX` (40) code points; description 1–`GLOSSARY_DESC_MAX` (**100**) code points | field and 100 DECIDED; other limits PROPOSED |

Rules for every string in a manifest **[PROPOSED]**: no leading/trailing whitespace; no control characters
(U+0000–U+001F, U+007F) and no U+2028/U+2029, so every value fits on one line of the generated glossary.
A term must not contain the separator ` — `.

Glossary content rules **[DECIDED]**:

- Only abbreviations, codenames and project names a language model cannot know, or that have several meanings.
- The description comes **only from the file's own text**. If the text does not define the term, the term goes into
  `keywords` only. Never invent an expansion. The validator cannot check this; it is a curator-prompt rule.
- Description language: English, either a translation or a tight paraphrase of the definition in the text
  **[PROPOSED]**.
- `keywords` and `glossary` may both be empty (e.g. an image with no text); `title` may not.

### 4.4 Presence and orphans **[DECIDED]**

| Situation | Violation |
|---|---|
| Content file `D/X` without `D/X.manifest.json` | `manifest-missing` (error) |
| `D/X.manifest.json` where `D/X` does not exist | `manifest-orphan` (error) |
| `D/X.manifest.json` where `D/X` is a folder, a service file or another manifest | `manifest-orphan` (error) |
| Not UTF-8, BOM, or not valid JSON, or duplicate key | `manifest-json` (error) |
| Valid JSON, wrong shape or limits | `manifest-schema` (error), message names the field, e.g. `glossary.LIPO` |
| Larger than `MANIFEST_MAX_BYTES` | `manifest-size` (error) |

Pairing compares names after NFC normalization (§7), so a file and a manifest written with different Unicode
normalization still pair.

### 4.5 Examples

Valid — Russian note:

```json
{
  "title": "Borscht recipe with roasted beets",
  "keywords": ["борщ", "свёкла", "свекла", "beet", "borscht", "recipe"],
  "glossary": {}
}
```

Valid — the same term in two files with two meanings (both are kept, see §6):

```json
{
  "title": "Reward-model experiments, round 2",
  "keywords": ["LIPO", "DPO", "reward model"],
  "glossary": { "LIPO": "Listwise preference optimization variant tested as a DPO replacement in round 2" }
}
```

Valid — binary with no text:

```json
{ "title": "Team photo from the offsite", "keywords": ["offsite", "photo"], "glossary": {} }
```

Invalid:

```jsonc
// manifest-json: comment and trailing comma (this block itself is jsonc only to show them)
{ "title": "x", "keywords": [], "glossary": {}, }
```

```json
{ "title": "x", "keywords": [], "glossary": {}, "summary": "..." }
```
→ `manifest-schema`: unknown key `summary`.

```json
{ "title": "x", "keywords": "borscht", "glossary": { "LIPO": "" } }
```
→ `manifest-schema`: `keywords` is not an array; `glossary.LIPO` is empty.

```json
{ "title": "x", "keywords": [], "glossary": { "LIPO": "a", "LIPO": "b" } }
```
→ `manifest-json`: duplicate key `LIPO` (plain `JSON.parse` would silently keep `"b"`).

```json
{ "title": "x", "keywords": [], "glossary": { "LIPO": "Listwise preference optimization variant that was tested in round two as a direct replacement for DPO" } }
```
→ `manifest-schema`: `glossary.LIPO` is 101 code points (limit 100).

---

## 5. Root map: `/_index.md`

### 5.1 Grammar

The root `_index.md` is the only map file and is injected **in full** into both agents' briefings **[DECIDED]**.
Exact layout **[PROPOSED]**, LF line endings, UTF-8 without BOM:

```
# <bank title>

<overview: one or more lines of plain text>

## Folders

- `<folder path>` — <description>
- `<folder path>` — <description>
```

| Part | Rule |
|---|---|
| Line 1 | `# ` followed by a title, 1–80 code points |
| Overview | Every line between line 1 and `## Folders`. At least one non-blank line; no `#` headings; total ≤ `OVERVIEW_MAX` (600) code points, line breaks not counted. What the bank is for and what kinds of things it holds |
| `## Folders` | Exactly one such line, exactly this text |
| After `## Folders` | Every non-blank line until end of file is a map line. No other sections |
| Map line | Regex `` ^- `([^`\n]+/)` — (.+)$ ``. The separator is space, U+2014 EM DASH, space |
| Path | A folder path per §1, ends with `/`, no backticks |
| Description | 1–`FOLDER_DESC_MAX` (**200**, **[RECOMMENDED]**; user range 200–300) code points, trimmed, no control characters. Only the description is limited, not the whole line, so deep paths do not eat the budget **[PROPOSED]**. English. Says what lives there and what to ask it |
| Order | Depth-first pre-order: a folder, then its subtree; siblings sorted by NFC code points of the segment. Wrong order is only a warning |
| Size | Whole file over `MAP_MAX` (40 000) code points → warning **[PROPOSED]** |

Why the order is defined by segments and not by the plain string: a naive sort gives
`work-x/`, `work/`, `work/standups/` (because `-` sorts before `/`), which tears `work/` away from its child.

### 5.2 Coverage **[DECIDED]**

Exactly one line per existing folder at every depth (inboxes excluded), and no line for anything else.

| Situation | Violation |
|---|---|
| Folder exists, no line | `map-missing` (error) |
| Line for a path that is not an existing folder | `map-stale` (error) |
| Two lines for one path | `map-duplicate` (error) |
| Line for `_raw/`, `_unsorted/` or anything inside them | `map-reserved` (error) |
| Line breaks the regex, or path is malformed | `map-line-syntax` (error) |
| Description over the limit | `map-desc-too-long` (error) |
| Missing `# ` line, missing or repeated `## Folders`, heading inside the overview, empty overview, overview over limit | `map-structure` (error) |
| Root `_index.md` missing | `map-file-missing` (error) |
| Wrong order | `map-order` (warning) |
| File over `MAP_MAX` | `map-size` (warning) |

A bank with no folders is valid with an empty `## Folders` section; the scaffold (`src/bank.ts`) writes exactly
that, so a brand-new bank is valid.

### 5.3 Open questions file: `/_open-questions.md` **[COORDINATOR]**

- Optional service file at the root, written and read only by the curator (Librarian). It holds the "Open
  questions" that used to live inside folder `_index.md` files (`curator.md:103-129`).
- Excluded from the root map, manifests and width counts; never injected into the retriever briefing. Injected in
  full into the curator briefing when present.
- Free markdown; v1 validator checks nothing inside it.
- Existing unanswered questions must be preserved: when the curator removes a legacy folder `_index.md`, it first
  moves that index's unanswered open questions into `/_open-questions.md`. No bulk migration of real banks now.

### 5.4 Examples

Valid:

```
# family-notes

Personal notes of one household: recipes, work standups, trip plans. Mostly Russian, some English.

## Folders

- `recipes/` — Home recipes in Russian: soups, baking, preserves; ingredient lists and cooking times
- `work/` — Work notes grouped by kind; see subfolders
- `work/standups/` — Daily work standups Oct 2026: Flue migration, sandbox checks, model switch
- `work-x/` — Side project X: design sketches and a pitch deck
```

Invalid, one violation per line:

```
- work/standups/ — Daily standups                     map-line-syntax: path not in backticks
- `work/standups` — Daily standups                    map-line-syntax: folder path must end with /
- `work/standups/` - Daily standups                   map-line-syntax: separator must be " — " (U+2014)
- `trips/` — Trip plans                               map-stale: trips/ does not exist
- `_unsorted/` — Things to triage                     map-reserved
```

Plus `map-missing` if, say, `work-x/` exists but has no line.

---

## 6. Generated glossary **[DECIDED: generated by code from manifests, never written by an LLM]**

Built on every agent run from all **valid** manifests (invalid ones are skipped and counted in the run log; the
generator never fails a run). Injected into both briefings after the root map **[DECIDED]**.

Format **[PROPOSED]**:

```
## Glossary (generated from manifests)

LIPO — Listwise preference optimization variant tested as a DPO replacement in round 2 (ml/rm/round-2.md)
LIPO — Internal codename for the low-income pension option in the 2025 tax plan (finance/taxes/2025-plan.md)
ЁЖ / ЕЖ — Codename of the hedgehog-feeder project (projects/hedgehog/notes.md)
```

| Rule | Detail |
|---|---|
| One line per (manifest, term) | `TERM — description (path)`, path = the **content** file, relative, per §1 |
| Same term, different meanings | Separate lines with their paths — this is the disambiguation **[DECIDED]** |
| Same term, different descriptions | Also a validator warning `glossary-conflict` (never an error) **[RECOMMENDED]** |
| `ё` in a term | Term field becomes `<term> / <term with ё→е, Ё→Е>` so a search for either spelling is obvious **[PROPOSED form; variants DECIDED]** |
| Sort | By `term.normalize('NFC').toLowerCase()`, then term by code points, then path by code points |
| No escaping | Not needed: §4.3 forbids line breaks and control characters, and the path is always the last `(...)` |
| No terms | Header followed by the line `(none)` |
| Size | Over `GLOSSARY_BLOCK_MAX` (60 000) code points → still injected in full, warning in the run log **[PROPOSED; see D10]** |

The briefing for both agents is **[DECIDED]**: root `_index.md` verbatim, no line cut (the 30-line cut in
`src/index-scan.ts` must not apply to it), then the glossary block. If the root map is missing, the briefing says
`(root _index.md is missing)`; if it is invalid, it is still injected verbatim — the generator is tolerant, the
validator is strict **[PROPOSED]**. Folder-level `_index.md` files do not exist in the format and are never injected
**[DECIDED]**.

---

## 7. Unicode and string rules **[DECIDED: lengths are Unicode code points]**

- **Length** = number of code points of the NFC-normalized string: `[...s.normalize('NFC')].length`.
  Not bytes, not UTF-16 `.length`.
- Why NFC matters: `ё` typed on macOS can arrive decomposed as `е` + U+0308. Measured: the same visible `ёж` gave
  3 code points raw and 2 after NFC. Without normalizing, the same text would pass or fail depending on how it was
  typed.
- Emoji with modifiers count by code points: `👍🏽` = 2 (UTF-16 `.length` = 4). Accepted.
- **Path comparison** (map coverage, manifest pairing, ordering) uses NFC forms. The filesystem name is kept as is.
- **Case**: all comparisons are case-sensitive, except the glossary sort key (§6).
- Forbidden in every limited string: U+0000–U+001F, U+007F, U+2028, U+2029.

---

## 8. Violations and baseline

### 8.1 Violation record **[PROPOSED]**

```ts
interface Violation {
  code: string;            // e.g. 'width-over-limit'
  severity: 'error' | 'warning';
  path: string;            // folder/file the finding is about; '' for the root
  detail?: string;         // e.g. glossary term or manifest field: 'glossary.LIPO'
  value?: number;          // measured value, e.g. 23
  limit?: number;          // e.g. 20
  message: string;         // actionable, one line: 'work/standups/ has 23 content files (limit 20)'
}
```

Identity key = `code + '\0' + NFC(path) + '\0' + (detail ?? '')`.

### 8.2 New vs pre-existing **[DECIDED: fail only on new violations]**

- **Baseline** = `validateBank()` on the bank as it is before the curator starts (after ingest into `_raw/`,
  which is ignored anyway).
- A violation from the final check is **new** when its identity key is absent from the baseline, **or** it has a
  `value` greater than the baseline's value for the same key (`width-over-limit` 22 → 23 is new; "not worse than
  before") **[PROPOSED]**.
- Only **new errors** block. Pre-existing errors and all warnings are reported, never block.
- Consequence to be aware of **[PROPOSED, intentional]**: a file the curator moves gets a new path, so its old
  `manifest-missing` becomes a new violation. Touching a legacy file means bringing it up to format.

### 8.3 All codes

| Code | Severity | Section |
|---|---|---|
| `hidden-entry`, `symlink`, `special-file` | error | §2 |
| `nested-index` | error (pre-existing ones in old banks are baseline warnings, §8.2) | §2 |
| `depth-over-limit` | error | §3.1 |
| `width-over-limit` | error | §3.2 |
| `width-over-limit-at-max-depth`, `width-over-target`, `empty-folder` | warning | §3.2 |
| `manifest-missing`, `manifest-orphan`, `manifest-json`, `manifest-schema`, `manifest-size` | error | §4.4 |
| `map-file-missing`, `map-structure`, `map-line-syntax`, `map-missing`, `map-stale`, `map-duplicate`, `map-reserved`, `map-desc-too-long` | error | §5.2 |
| `map-order`, `map-size` | warning | §5.2 |
| `glossary-conflict` | warning | §6 |

---

## 9. Curator gate in `submit_result` **[DECIDED: ≤ ~3 rejections, then accept with warnings]**

Exact behavior **[PROPOSED]**:

1. Before the agent starts: compute the baseline (§8.2). Rejection counter = 0.
2. On every `submit_result` call: run the validator, split violations into blocking (new errors) and the rest.
3. No blocking violations → record the result, attach all remaining violations as warnings, end the turn.
4. Blocking violations and counter < `MAX_REJECTIONS` (3) → increment the counter and **throw**. Flue shows a tool
   error to the model; `useAgentFinish` in `src/structured-result.ts` already keeps the agent working while no
   successful `submit_result` exists. Message:

   ```
   Bank validation failed (rejection 2 of 3): 2 new violations.
   - [width-over-limit] work/standups/: has 23 content files (limit 20)
   - [manifest-missing] recipes/borscht.html: no recipes/borscht.html.manifest.json
   Fix these and call submit_result again.
   ```

   At most `REJECTION_LIST_MAX` (20) lines, then `…and N more`. On rejection 3 the last line becomes:
   `The next submit_result will be accepted even with violations; fix what you can.`
5. Blocking violations and counter = 3 → the **4th** call is accepted: result recorded, status
   `accepted-with-violations`, every violation attached, turn ends. So: at most 4 calls, 3 of them rejected.
6. If the validator itself throws (bug, unreadable file): accept, status `validator-error`, log the exception. A
   validator bug must never trap the curator in a loop.
7. Statuses: `passed` · `accepted-with-violations` · `validator-error`. They appear in the run log and in the
   curate response as an **additive** field `meta.validation` **[COORDINATOR]**; every existing response field
   stays unchanged:

   ```json
   "meta": {
     "model": "...", "tokens": {}, "cost": {},
     "validation": {
       "status": "accepted-with-violations",
       "violations": [
         { "code": "width-over-limit", "severity": "error", "path": "work/standups/", "value": 23, "limit": 20,
           "message": "work/standups/ has 23 content files (limit 20)", "new": true }
       ]
     }
   }
   ```

   `violations` holds every violation of the final check as a §8.1 record plus `new: boolean` (§8.2) **[PROPOSED]**;
   for `validator-error` it is empty. `meta.validation` is absent when the curator agent did not run (empty
   `_raw/` early return).

The retriever is never gated.

---

## 10. Constants

| Constant | Value | Provenance |
|---|---|---|
| `MAX_DEPTH` | 3 | DECIDED |
| `WIDTH_TARGET` | 10 | DECIDED |
| `WIDTH_LIMIT` | 20 | RECOMMENDED |
| `GLOSSARY_DESC_MAX` | 100 | DECIDED |
| `FOLDER_DESC_MAX` | 200 | RECOMMENDED (user range 200–300) |
| `MAX_REJECTIONS` | 3 | DECIDED ("~3") |
| `MANIFEST_SUFFIX` | `.manifest.json` | RECOMMENDED |
| `TITLE_MAX` | 120 | PROPOSED |
| `KEYWORDS_MAX` / `KEYWORD_MAX` | 30 / 60 | PROPOSED |
| `GLOSSARY_ENTRIES_MAX` / `TERM_MAX` | 20 / 40 | PROPOSED |
| `MANIFEST_MAX_BYTES` | 8192 | PROPOSED |
| `OVERVIEW_MAX` | 600 | PROPOSED |
| `MAP_MAX` | 40 000 | PROPOSED (warning only) |
| `GLOSSARY_BLOCK_MAX` | 60 000 | PROPOSED (warning only) |
| `REJECTION_LIST_MAX` | 20 | PROPOSED |
| `INBOX_DIRS` | `_raw`, `_unsorted` (root only) | PROPOSED "root only" |

---

## 11. Resolved choices

No open blockers remain for v1.

| ID | Question | Resolution | Provenance |
|---|---|---|---|
| — | Keep folder-level `_index.md`? | No: `_index.md` only at the root, `nested-index` below it | DECIDED |
| B1 | Where do the curator's open questions live? | Root `/_open-questions.md`, curator only (§5.3) | COORDINATOR |
| B2 | Where does the gate status surface? | Additive `meta.validation {status, violations}` in the curator result (§9) | COORDINATOR |

v1 defaults adopted as listed (change = contract change):

| ID | Default |
|---|---|
| D1 | Suffix `.manifest.json` |
| D2 | Folder description limit 200 code points, description only, not the whole line |
| D3 | Inboxes `_raw/`, `_unsorted/` only at the root |
| D4 | Content files allowed in the root folder |
| D5 | Hidden entries and symlinks are errors |
| D6 | Width counts content files only; over 20 at depth 3 is a warning |
| D7 | Manifest: exactly three keys, English title, field limits from §10 |
| D8 | Map order and map size are warnings only |
| D9 | `ё` terms shown as `ЁЖ / ЕЖ` in the glossary; keywords carry both spellings (curator-prompt rule) |
| D10 | Glossary and map are injected in full even above their size budgets (warning only); truncation policy decided after retriever telemetry |
| D11 | "New" includes a worse value for the same key and anything at a moved path |
| D12 | Validator crash → accept with `validator-error` |
