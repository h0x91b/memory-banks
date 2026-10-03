# AGENTS.md

Memory-bank agents on top of Flue. Two webhook agents:

- **`librarian`** (formerly `curator`) — takes inbox items, lays them out
  into the right place inside a named memory bank, keeps indexes in sync,
  and commits every change to the bank's git repo.
- **`retriever`** — answers one question strictly from the contents of a
  bank, with absolute-path citations for every file it used.

> **Project idea / "why" lives in [IDEA.md](./IDEA.md).** This file is the
> "how": layout, API contract, configuration, and operational notes. Read
> IDEA.md first if you want the design philosophy and motivation; come back
> here for the engineering details.

## Concept (TL;DR)

Multiple named **memory banks** live under a single root (default
`~/.bank-memory/`). Each bank has its own git repo at `<root>/<bank>/.git/`
and the agent operates exclusively inside `<root>/<bank>/fs/` — the `.git/`
dir sits one level outside the agent's sandbox so it physically cannot be
touched. Callers post items (inline text or `file://` / `http(s)://` paths)
to one HTTP endpoint along with the bank name; the agent copies them into
`fs/_raw/`, uses bash / read / write / edit / grep / glob (all routed through
[`just-bash`](https://www.npmjs.com/package/just-bash) sandboxed at `fs/`)
to inspect and lay out the bank, sweeps any leftovers into `fs/_unsorted/`,
and commits via real git from the host side.

## On-disk layout

```
~/.bank-memory/                       (configurable via MEMORY_BANK_ROOT)
└── <bank-name>/                      git repo root
    ├── .git/                         git data — agent NEVER sees this
    ├── .gitignore
    └── fs/                           agent's sandbox root, mounted at "/"
        ├── _raw/                     inbox, populated by the API
        ├── _unsorted/                items the agent (or the safety sweep)
        │                             could not classify
        ├── _index.md                  bank index, maintained by the agent
        └── ...                       folders/files the agent creates
                                      (notes/, projects/, recipes/, …)
```

## Flow per request

1. **Validate** bank name (must match `[a-z0-9][a-z0-9-]*`).
2. **Scaffold** the bank if missing: create `<bank>/fs/_raw/`, `<bank>/fs/_index.md`,
   `<bank>/.gitignore`, then `git init` at `<bank>/`.
3. **Ingest** every `items[]` into `<bank>/fs/_raw/`. `kind: "inline"` writes
   the text directly; `kind: "path"` with a `file://` URI copies, with an
   `http(s)://` URI downloads. Filenames are sanitised and de-duplicated
   (`foo.md`, `foo-1.md`, ...).
4. **Commit** the ingest step (`ingest: N item(s) into fs/_raw/`). The body
   lists each raw file with its observed source — one JSON record per line:
   type (`inline`/`upload`/`file`/`url`/`unknown`), original URI or filename,
   content type; credentials are redacted, unknown facts are left out
   (`src/ingest-provenance.ts`). The same records go into the Librarian
   briefing as read-only context; they are never written into bank files.
5. **Short-circuit** if `fs/_raw/` is empty (no LLM call, return early).
6. **Run the librarian**: the route sends the briefing to a fresh `Librarian`
   agent instance (`init(Librarian).dispatch()` + `read()`). The agent declares
   `useSandbox(bash(createBankBashFactory(...)))`, which gives Flue's built-in
   tools (`bash`, `read`, `write`, `edit`, `grep`, `glob`) routed through
   `just-bash` + `ReadWriteFs` rooted at `<bank>/fs/`. The LLM iterates with
   those tools, then delivers `{ summary: string }` by calling the
   `submit_result` tool.
7. **Sweep** anything still left in `fs/_raw/` into `fs/_unsorted/` (safety
   net so `_raw/` is guaranteed empty after a run).
8. **Diff** via `git status --porcelain -z -uall` (paths get stripped of the
   `fs/` prefix; everything outside `fs/` is dropped from the report).
9. **Commit** the curate step (`curate: <summary>`) if anything changed.
10. **Return** a structured report (`processed`, `skipped`, `commits`, `meta`).

## Layout (code)

- `.flue/app.ts` — route map: `POST /agents/librarian/:id` and
  `POST /agents/retriever/:id`, each running one pipeline synchronously.
  `POST /agents/curator/:id` is a deprecated alias of the librarian route
  (same handler, one run per request). Agent runs go through
  `src/guarded-runs.ts` (also used by the CLI): an archiving/archived bank
  answers `409` with `code: bank_archiving | bank_archived` and is not touched.
  `/v1/*` is the bank management API (`src/banks/`, contract in
  `docs/api/banks.md`): create/list/get/patch/archive/restore, lifecycle state
  under `<MEMORY_BANK_ROOT>/.lifecycle/`. `GET /v1/stats` and
  `GET /v1/banks/:bank/stats` report model spend and HTTP totals for today /
  Monday week / calendar month (`docs/api/stats.md`); every request is
  recorded by `httpStatsMiddleware`. `POST /v1/banks/:bank/ingestions`
  accepts text/URL/file intake durably with `202` and status/history GETs
  (`src/ingestions/`, contract in `docs/api/ingestions.md`); queued requests
  live in `<MEMORY_BANK_ROOT>/.ingestion/` and hold archiving through durable
  holds. The ingestion worker (`src/ingestion-worker/`, started with the
  server, `docs/design/ingestion-worker.md`) batches them per bank into one
  Librarian run. `POST /v1/banks/:bank/query` answers from a read-only
  snapshot of the last completed revision (`src/query/`,
  `docs/api/query.md`). Whole workflow in order: `docs/api/README.md`.
- `src/spend-ledger.ts` — append-only spend/HTTP journal at
  `<MEMORY_BANK_ROOT>/.accounting/ledger.jsonl`, idempotent per execution id;
  `recordAgentCall` wraps each pipeline's agent call. Costs are estimates from
  declared model rates, never an OpenRouter invoice; unknown cost is counted,
  not zeroed.
- `src/spend-stats.ts`, `src/stats-periods.ts`, `src/stats-router.ts` —
  aggregation, DST-aware calendar periods (default `Asia/Jerusalem`), routes.
- `.flue/agents/librarian.ts`, `.flue/agents/retriever.ts` — the `'use agent'`
  functions: model, sandbox, role instructions, structured result.
- `src/librarian.ts` — librarian pipeline: ingest → agent → sweep → commit → report.
- `src/retriever.ts` — retriever pipeline: validate bank, run a read-only
  agent over `<bank>/fs/`, return `{ answer, references[] }` with absolute paths.
- `src/structured-result.ts` — `useStructuredResult()` custom hook
  (`submit_result` tool + data part + finish enforcement + usage metadata)
  and `readStructuredReply()` for the route side.
- `src/model.ts` — model shared by both agents and per-agent reasoning effort.
- `src/request.ts` — request errors, per-request instance ids, `meta` helpers.
- `src/cli.ts`, `scripts/run-cli.mjs` — run a pipeline from the command line
  against an in-process Flue runtime (no HTTP server).
- `.flue/roles/librarian.md` — librarian system prompt.
- `.flue/roles/retriever.md` — retriever system prompt (strict
  no-hallucination rules + absolute-path citation requirement).
- `src/bank.ts` — bank path resolution (`bankRoot`, `bankPath`,
  `bankFsPath`, `rawDir`) and scaffold creation.
- `src/ingest.ts` — copy inline text / files / URLs into `fs/_raw/`.
- `src/git.ts` — `git init` + autocommits at the repo root (`<bank>/`).
- `src/bash-factory.ts` — wraps `just-bash` (`ReadWriteFs` rooted at
  `<bank>/fs/`) into a Flue `BashFactory`.
- `src/changes.ts` — parse `git status --porcelain` output and strip the
  `fs/` prefix so reports talk in agent-side paths.
- `src/sweep.ts` — move leftover `fs/_raw/` files into `fs/_unsorted/`.
- `src/bank-mutation.ts` — one writer per bank (in-process chain + generation
  lock files `<root>/.locks/<bank>/`) for the legacy/CLI Librarian and the ingestion
  worker; records the last completed revision in `<root>/.revisions/<bank>.json`.
- `src/ingestion-worker/` — processes queued ingestions: fixed 60s window per
  bank, batch claim, per-item ingest, one Librarian run, results with commits
  and revision; at-least-once with lease recovery
  (`docs/design/ingestion-worker.md`).
- `src/caller-hints.ts` — renders queued requests' caller `hint`s into the
  Librarian briefing, each tied to its own raw files, as caller context.
- `src/log-types.ts` — minimal `FlueLogger` interface for util modules
  that don't want to import the whole SDK type bundle.
- `scripts/with-env.sh` — loads `.env` and falls back to `$OPENROUTER_FLUE`
  if no `OPENROUTER_API_KEY` is set, then runs the given command.

`.flue/` is Flue's source directory: `app.ts` and the `'use agent'` scan are
resolved from it. Agents are registered by the directive, but served only
through the explicit routes in `.flue/app.ts`.

## API contract

### Librarian

```
POST http://localhost:3583/agents/librarian/<run-id>
Content-Type: application/json

{
  "bank": "personal-notes",
  "items": [
    { "kind": "inline", "content": "...", "filename": "thought.md" },
    { "kind": "path",   "uri": "file:///Users/me/Downloads/article.html" },
    { "kind": "path",   "uri": "https://example.com/page" }
  ],
  "hint": "optional free-text hint for the librarian"
}
```

> **Deprecated alias.** `POST /agents/curator/<run-id>` still works and runs
> the exact same librarian pipeline (it is not a second agent). It exists only
> so clients written before the curator → librarian rename keep working, and
> will be removed once they have moved to `/agents/librarian/`.

`bank` is required. `items` may be empty (the agent will still process
whatever is already sitting in `fs/_raw/`, or short-circuit if it's empty).

### Response

```json
{
  "bank": "personal-notes",
  "summary": "Filed 3 notes under notes/, updated index",
  "processed": [
    { "status": "untracked", "path": "notes/2026-05-13-thought.md" },
    { "status": "modified",  "path": "_index.md" },
    { "status": "deleted",   "path": "_raw/thought.md" }
  ],
  "skipped": [
    { "status": "untracked", "path": "_unsorted/unclear.txt" }
  ],
  "commits": ["a1b2c3d", "e4f5g6h"],
  "bash_calls": 7,
  "meta": { "model": "...", "tokens": { ... }, "cost": { ... } }
}
```

`processed` / `skipped` are derived from `git status` — `git` is the source
of truth, not the LLM's report. Paths are relative to `fs/`. Anything
landing under `_unsorted/` is reported as `skipped`; everything else is
`processed`.

### Retriever

```
POST http://localhost:3583/agents/retriever/<run-id>
Content-Type: application/json

{
  "bank": "personal-notes",
  "question": "What does R2 mean in the ARS rounds?",
  "hint": "optional free-text hint, e.g. 'look under ars/'"
}
```

`bank` and `question` are required. The retriever opens a Flue session over
`<bank>/fs/` with the same `BashFactory` sandbox the librarian uses (it is
read-only by convention — see the role doc — and any unexpected write is
logged after the run via `git status`).

If the bank does not exist on disk, the retriever short-circuits and
returns the "no data" response without calling the LLM.

#### Response

```json
{
  "bank": "personal-notes",
  "answer": "R2 is the second round of evaluation, focused on …",
  "references": [
    {
      "path": "/Users/me/.bank-memory/personal-notes/fs/ars/v5/_index.md",
      "why": "defines the round-naming convention R1/R2/R3"
    },
    {
      "path": "/Users/me/.bank-memory/personal-notes/fs/ars/v5/r2-report.md",
      "why": "contains R2 results and methodology"
    }
  ],
  "meta": {
    "model": "...",
    "tokens": { ... },
    "cost": { ... },
    "bash_calls": 6,
    "unexpected_writes": 0,
    "telemetry": {
      "source": "flue-observe",
      "complete": true,
      "briefing_bytes": 5120,
      "tool_calls": { "read": 3, "grep": 0, "glob": 0, "bash": 6, "other": 0 },
      "read_paths": ["/ars/v5/_index.md", "/ars/v5/r2-report.md", "/ars/v5/_index.md"],
      "bash_heuristic": { "search": 4, "read": 1, "list": 1, "unclassified": 0 },
      "operations": [{ "tool": "bash", "kinds": ["search"] }, { "tool": "read", "path": "/ars/v5/_index.md" }],
      "truncated": false
    }
  }
}
```

`meta.telemetry` (null when the bank is missing) is measurement only — see
`src/retriever-telemetry.ts`. It comes from Flue's `observe()` `tool_start`
events for this agent instance, so `tool_calls` and the ordered `read_paths`
(sandbox paths given to the `read` tool, repeats kept) are exact.
`complete: false` means the observed starts did not match Flue's recorded tool
calls; treat the numbers as a lower bound. `bash` is opaque: a bash call is
only classified by its command words (`rg`/`grep` → search, `cat`/`head`/`sed`
→ read, `ls`/`find` → list) in `bash_heuristic`, and files it touches never
appear in `read_paths`. No file contents, search patterns or command text are
recorded; the stderr log gets a one-line summary plus the read order.
`operations` and `read_paths` are capped at 200 entries (`truncated`).

`references[].path` is always an **absolute filesystem path** on the host —
the caller can `cat` / `read` it directly. If the bank contains nothing
relevant, the retriever returns `answer` exactly equal to
`"No relevant data found in the memory bank."` and `references` as `[]`.

## Commands

```bash
npm run dev                            # vite dev, port $PORT (default 3583)
npm run librarian -- '{"bank":"demo","items":[{"kind":"inline","content":"hello"}]}'
npm run retriever -- '{"bank":"demo","question":"..."}'
npm run build                          # vite build → dist/server.mjs
npm run start                          # node dist/server.mjs (after build), port from $PORT (default 3000)
npm run serve                          # build + run production server on fixed port 47823 (stable URL for skills)
npm run typecheck                      # tsc --noEmit
```

`npm run curator` is a temporary alias of `npm run librarian` (same
pipeline, prints a deprecation note on stderr); it goes away together with
the `/agents/curator/` route alias.

For local dev hit the agent at `POST http://localhost:3583/agents/librarian/<id>`.
For production-style serving (skills, manual testing) use `npm run serve`, then hit `POST http://localhost:47823/agents/<name>/<id>`. The port `47823` is fixed on purpose — skills can hard-code this URL.

## Configuration

- `OPENROUTER_API_KEY` — required, OpenRouter API key. Falls back to
  `$OPENROUTER_FLUE` when `.env` is missing the key.
- `MEMORY_BANK_ROOT` — optional, root directory for all banks. Defaults to
  `~/.bank-memory`. Supports `~` expansion.
- `MEMORY_BANK_ACCOUNTING_DIR` — optional, directory of the spend ledger.
  Defaults to `<MEMORY_BANK_ROOT>/.accounting`.
- `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` — optional, override the git identity
  used for autocommits. Default: `memory-bank librarian <librarian@bank-memory.local>`.
  Existing bank history keeps the old `memory-bank curator` author.

## Constraints / non-goals (v1)

- One Librarian writer per bank (`src/bank-mutation.ts`) for one server per
  root plus CLI runs on one filesystem; not a multi-host lock. Retriever runs
  take no bank lock.
- Local git only — no remote pushes.
- Retriever read-only enforcement is by convention only — the sandbox is
  read/write, so a misbehaving run could mutate files. We detect it via
  `git status` post-run and log a warning, but we don't roll back.
- No vector store / embeddings — both agents reason over raw text and
  filesystem tools.
- Binary inbox items are moved as-is (no OCR / content extraction).

## Key facts about Flue (learned the hard way)

- **Version**: Flue 2.1.0 (`@flue/runtime`, `@flue/vite`, `@flue/cli`), the
  newest release available through the npm mirror used here. Agent code
  imports from `@flue/runtime`; `@flue/sdk` is now only an HTTP client.
- **Model**: `openrouter/openai/gpt-6-luna` for both agents (`src/model.ts`);
  reasoning effort is per agent — librarian `thinkingLevel: 'xhigh'`, retriever
  `'medium'`. The `@earendil-works/pi-ai` 0.83 catalog bundled with
  Flue 2.1.0 predates GPT-6 Luna, so `src/openrouter-provider.ts` re-registers
  the `openrouter` provider with the catalog plus an explicitly declared
  GPT-6 Luna record (reasoning, `xhigh` mapping, pricing copied from pi-ai
  0.87.1). Without it the specifier fails with `Unknown model ID`; with it the
  request carries `reasoning.effort` (`"xhigh"` for the librarian, `"medium"`
  for the retriever). Remove that module once Flue
  ships pi-ai >= 0.87.1 (Flue 2.2.0+).
- **Agents are conversations**: an agent is a synchronous `'use agent'`
  function using hooks; work is sent with `init(Agent, { id }).dispatch()`
  and the reply read with `read()`. Instances persist by id, so every request
  uses a fresh id (`freshInstanceId`) to avoid carrying history between runs.
- **Structured output**: `useStructuredResult(schema)` adds a `submit_result`
  tool whose arguments are validated by the schema and written to the
  `result` data part (`reply.data.result`). Usage arrives as response
  metadata (`reply.metadata.usage`).
- **Custom tool names cannot conflict with built-ins** (`read`, `write`,
  `edit`, `bash`, `grep`, `glob`, `task`). Use `useSandbox(bash(factory))` to
  route the built-ins through your own runtime instead of adding a custom
  tool — that's exactly what `src/bash-factory.ts` does.
- **`bash(factory)` accepts a `BashFactory`** of shape `() => BashLike`.
  `BashLike` has `exec`, `getCwd`, and an `fs` surface with read/write/stat/
  readdir/mkdir/rm/etc. We wrap `just-bash`'s `Bash` + `ReadWriteFs` into
  this shape. Without `useSandbox()` an agent has no file tools at all.
- **Cost/usage**: `usage` includes `input/output/cacheRead/cacheWrite/totalTokens`
  plus `cost.{input,output,cacheRead,cacheWrite,total}` in USD, computed from
  the catalog rates of the model.
- **API key fallback**: npm scripts go through `scripts/with-env.sh`, which
  exports `OPENROUTER_API_KEY=$OPENROUTER_FLUE` only if neither the shell nor
  `.env` defines the key. Built servers never load `.env` themselves.
- **No `await using` in Node 22**: explicit resource management is not
  available at runtime; call `flue.stop()` in `finally` instead.
- **just-bash quirk**: between `exec()` calls, cwd / env / functions reset —
  only the filesystem is shared. The librarian role doc reminds the LLM to
  chain dependent commands with `&&` or use absolute paths.

## Docs

- Homepage: https://flueframework.com/
- README (main): https://github.com/withastro/flue/blob/main/README.md
- Bundled docs for the installed version: `npx flue docs` / `node_modules/@flue/runtime/docs/`
- Migration guide (1.0-beta → 2): https://flueframework.com/docs/guide/migration/
- just-bash: https://github.com/vercel-labs/just-bash
