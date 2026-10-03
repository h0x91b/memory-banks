# Navigation bank fixture

A small synthetic memory bank in the v1 format (`docs/design/bank-format.md`) plus questions with known answers,
for checking how well the retriever finds things. All people, projects, codes and amounts are invented.

| Path | What it is |
|---|---|
| `fs/` | The bank root as an agent would see it: 20 content files, one `.manifest.json` per file, root `_index.md` |
| `scenarios.ts` | Ground truth: `NAVIGATION_SCENARIOS`, typed questions with expected facts and citations |
| `../../navigation-bank.test.ts` | Offline test: the bank passes `validateBank`, and every path and evidence snippet in `scenarios.ts` is real |

## What the bank holds

Content formats: `.md`, `.txt`, `.html`, `.csv`, `.json`, `.ics`, `.png`. Notes are in Russian and English.

The only validator finding is one intended warning, `glossary-conflict` for `PTO`: it means "power take-off" in
`home/dacha/tractor-notes.md` and "paid time off" in `work/hr/pto-policy-2026.md`.

## Scenario format

Each scenario has a `question`, its `language`, the `themes` it exercises, and `expected`:

| `expected.kind` | A correct answer |
|---|---|
| `answer` | States every `facts[].fact` and cites every `facts[].source` |
| `not-in-bank` | Says the bank does not hold the answer and invents nothing; none of `absentTerms` occurs anywhere in the bank |
| `content-unavailable` | Cites `unreadable`, says its content is not available as text, does not describe it; may state `facts` |

`facts[].evidence` are verbatim snippets of the source (compared after NFC) — they let a checker or a human verify
the ground truth, not the wording an answer must use. Optional fields: `wrongSources` (a citation of these is
wrong), `term` (the shared abbreviation), `pointers` (files that only point to the source), `spelling` (`е`/`ё` pair).

Scenarios check answer content only. They say nothing about how many hops, reads or tool calls a retriever uses.

## Themes

| Theme | Scenario ids |
|---|---|
| `ru-en` — question and source in different languages | `borscht-beets`, `blini-batter-rest`, `lisbon-booking-code`, `pto-mower-speed`, `dacha-weekend-and-car-service` |
| `yo-e` — `ежика` in the question, `ёжика` in the file | `hedgehog-food` |
| `nfc` — source stored decomposed (NFD) | `hedgehog-food` |
| `ambiguous-abbreviation` — `PTO` with two meanings | `pto-balance`, `pto-mower-speed` |
| `multi-topic` — two unrelated topics in one question | `dacha-weekend-and-car-service` |
| `reference-chain` — one file points to the one with the answer | `lisbon-booking-code`, `kestrel-budget` |
| `no-answer` | `dacha-wifi-password`, `lisbon-hotel-address` |
| `primary-file-only` — answer absent from manifests and the map | `kestrel-budget`, `boiler-pressure` |
| `binary-without-text` — a PNG with no text chunks | `retro-whiteboard` |

## Editing rules

- `home/garden/hedgehog-feeder.md` is stored in NFD on purpose. Re-save it decomposed, e.g.
  `node -e 'const f=process.argv[1],fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").normalize("NFD"))' <file>`.
- `work/retro/whiteboard-2026-09-14.png` must stay a PNG with no `tEXt`/`zTXt`/`iTXt`/`eXIf` chunks, and its
  content must never be described in a manifest or a scenario.
- Any new file needs a manifest and, for a new folder, a line in `fs/_index.md`. Run
  `node --test test/navigation-bank.test.ts` after every change.
