# AGENTS.md

Memory-bank agents on top of Flue. Two webhook agents:

- **`curator`** — takes inbox items, lays them out into the right place
  inside a named memory bank, keeps indexes in sync, and commits every
  change to the bank's git repo.
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
4. **Commit** the ingest step (`ingest: N item(s) into fs/_raw/`).
5. **Short-circuit** if `fs/_raw/` is empty (no LLM call, return early).
6. **Run the curator**: the route sends the briefing to a fresh `Curator`
   agent instance (`init(Curator).dispatch()` + `read()`). The agent declares
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

- `.flue/app.ts` — route map: `POST /agents/curator/:id` and
  `POST /agents/retriever/:id`, each running one pipeline synchronously.
- `.flue/agents/curator.ts`, `.flue/agents/retriever.ts` — the `'use agent'`
  functions: model, sandbox, role instructions, structured result.
- `src/curator.ts` — curator pipeline: ingest → agent → sweep → commit → report.
- `src/retriever.ts` — retriever pipeline: validate bank, run a read-only
  agent over `<bank>/fs/`, return `{ answer, references[] }` with absolute paths.
- `src/structured-result.ts` — `useStructuredResult()` custom hook
  (`submit_result` tool + data part + finish enforcement + usage metadata)
  and `readStructuredReply()` for the route side.
- `src/model.ts` — model and reasoning effort shared by both agents.
- `src/request.ts` — request errors, per-request instance ids, `meta` helpers.
- `src/cli.ts`, `scripts/run-cli.mjs` — run a pipeline from the command line
  against an in-process Flue runtime (no HTTP server).
- `.flue/roles/curator.md` — curator system prompt.
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
- `src/log-types.ts` — minimal `FlueLogger` interface for util modules
  that don't want to import the whole SDK type bundle.
- `scripts/with-env.sh` — loads `.env` and falls back to `$OPENROUTER_FLUE`
  if no `OPENROUTER_API_KEY` is set, then runs the given command.

`.flue/` is Flue's source directory: `app.ts` and the `'use agent'` scan are
resolved from it. Agents are registered by the directive, but served only
through the explicit routes in `.flue/app.ts`.

## API contract

### Curator

```
POST http://localhost:3583/agents/curator/<run-id>
Content-Type: application/json

{
  "bank": "personal-notes",
  "items": [
    { "kind": "inline", "content": "...", "filename": "thought.md" },
    { "kind": "path",   "uri": "file:///Users/me/Downloads/article.html" },
    { "kind": "path",   "uri": "https://example.com/page" }
  ],
  "hint": "optional free-text hint for the curator"
}
```

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
`<bank>/fs/` with the same `BashFactory` sandbox the curator uses (it is
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
    "unexpected_writes": 0
  }
}
```

`references[].path` is always an **absolute filesystem path** on the host —
the caller can `cat` / `read` it directly. If the bank contains nothing
relevant, the retriever returns `answer` exactly equal to
`"No relevant data found in the memory bank."` and `references` as `[]`.

## Commands

```bash
npm run dev                            # vite dev, port $PORT (default 3583)
npm run curator -- '{"bank":"demo","items":[{"kind":"inline","content":"hello"}]}'
npm run retriever -- '{"bank":"demo","question":"..."}'
npm run build                          # vite build → dist/server.mjs
npm run start                          # node dist/server.mjs (after build), port from $PORT (default 3000)
npm run serve                          # build + run production server on fixed port 47823 (stable URL for skills)
npm run typecheck                      # tsc --noEmit
```

For local dev hit the agent at `POST http://localhost:3583/agents/curator/<id>`.
For production-style serving (skills, manual testing) use `npm run serve`, then hit `POST http://localhost:47823/agents/<name>/<id>`. The port `47823` is fixed on purpose — skills can hard-code this URL.

## Configuration

- `OPENROUTER_API_KEY` — required, OpenRouter API key. Falls back to
  `$OPENROUTER_FLUE` when `.env` is missing the key.
- `MEMORY_BANK_ROOT` — optional, root directory for all banks. Defaults to
  `~/.bank-memory`. Supports `~` expansion.
- `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` — optional, override the git identity
  used for autocommits. Default: `memory-bank curator <curator@bank-memory.local>`.

## Constraints / non-goals (v1)

- Single-threaded — no locks; concurrent calls to the same bank may race.
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
- **Model**: `openrouter/openai/gpt-5.6-luna` with `thinkingLevel: 'xhigh'`
  (`src/model.ts`). It is in the OpenRouter catalog of the bundled
  `@earendil-works/pi-ai` 0.83, so reasoning and pricing metadata are real and
  the request carries `reasoning.effort: "xhigh"`. A model missing from the
  catalog fails with `Unknown model ID` unless declared on a custom provider
  (`setProvider(createProvider(...))`) with explicit metadata.
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
  only the filesystem is shared. The curator role doc reminds the LLM to
  chain dependent commands with `&&` or use absolute paths.

## Docs

- Homepage: https://flueframework.com/
- README (main): https://github.com/withastro/flue/blob/main/README.md
- Bundled docs for the installed version: `npx flue docs` / `node_modules/@flue/runtime/docs/`
- Migration guide (1.0-beta → 2): https://flueframework.com/docs/guide/migration/
- just-bash: https://github.com/vercel-labs/just-bash
