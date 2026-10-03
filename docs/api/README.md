# Using the bank API — from a new bank to an answer

The short path through the whole HTTP API. Each step links to the full contract; this page only shows the order
and what to expect. Every `/v1` error uses one envelope: `{ "error": { "code", "message", "details" } }`.

| Step | Call | Contract |
|---|---|---|
| 1. Start the server | `npm run serve` (build + `dist/server.mjs` on port 47823) | `AGENTS.md` § Commands |
| 2. Create a bank | `POST /v1/banks` | `docs/api/banks.md` |
| 3. Send material | `POST /v1/banks/:bank/ingestions` → `202` | `docs/api/ingestions.md` |
| 4. Wait for processing | `GET /v1/banks/:bank/ingestions/:id` | `docs/api/ingestions.md`, `docs/design/ingestion-worker.md` |
| 5. Ask a question | `POST /v1/banks/:bank/query` | `docs/api/query.md` |
| 6. Check spend | `GET /v1/banks/:bank/stats`, `GET /v1/stats` | `docs/api/stats.md` |
| 7. Archive / restore | `POST /v1/banks/:bank/archive`, `.../restore` | `docs/api/banks.md` |

## 1. Start the server

```sh
cp .env.example .env          # set OPENROUTER_API_KEY; optional MEMORY_BANK_ROOT (default ~/.bank-memory)
npm run serve                 # http://localhost:47823
```

One server per `MEMORY_BANK_ROOT`. The ingestion worker starts with the server.

## 2. Create a bank

```sh
curl -s -X POST localhost:47823/v1/banks -H 'content-type: application/json' \
  -d '{"id":"family-notes","name":"Family notes"}'
```

`201` with the bank resource. The bank directory, its git repo and an empty valid root map are created.

## 3. Send material

Text and URLs as JSON, files (including images) as multipart. The answer is always `202` with a status URL —
nothing is processed yet, but the request is on disk and survives a restart.

```sh
curl -s -X POST localhost:47823/v1/banks/family-notes/ingestions \
  -H 'content-type: application/json' -H 'Idempotency-Key: standup-2026-10-01' \
  -d '{"items":[{"type":"text","text":"# Standup\nLaunch moved to 14 Oct.","filename":"standup.md","mediaType":"text/markdown"}]}'

curl -s -X POST localhost:47823/v1/banks/family-notes/ingestions \
  -F file=@receipt.pdf -F file=@whiteboard.png -F url=https://example.com/post \
  -F 'hint=Receipts from the Lisbon trip, for the 2026 tax return'
```

`hint` (optional, both formats) tells the Librarian why you sent this material; it applies to that request's own
items only.

Retrying with the same `Idempotency-Key` and the same payload returns the same request id
(`Idempotent-Replayed: true`); the same key with a different payload is `409 idempotency_conflict`.

## 4. Wait for processing

The worker collects a bank's requests for a fixed window (default 60 s from the oldest queued arrival,
`MEMORY_BANK_INGESTION_WINDOW_MS`), then runs one Librarian batch over all of them. Banks run in parallel; one bank
runs one batch at a time, and requests that arrive during a batch go into the next one.

```sh
curl -s localhost:47823/v1/banks/family-notes/ingestions/ing_...
```

`status` goes `queued` → `running` → `succeeded` | `partial` | `failed`. On success, `revision` is the bank commit
the batch produced. What the batch guarantees:

- the original bytes of every item are committed to the bank's git history before the Librarian runs, with each
  item's source (inline text, upload, URL — secrets in URLs redacted) listed in that ingest commit;
- the Librarian's result is checked by the format validator (`docs/design/bank-format.md` §9): every content file
  needs a manifest and the root map must list every folder. New errors send the Librarian back to fix them, up to 3
  times; after that the result is accepted with the violations. The ingestion status does not show this outcome —
  it is in the server log (`validate` lines).

## 5. Ask a question

```sh
curl -s -X POST localhost:47823/v1/banks/family-notes/query \
  -H 'content-type: application/json' -d '{"question":"When is the launch?"}'
```

The answer is read from a read-only snapshot of the bank's **last completed revision**, never from files a running
batch is still rewriting:

| Field | Meaning |
|---|---|
| `answer` | The answer, or exactly `No relevant data found in the memory bank.` |
| `references[].path` | Absolute path in the bank's `fs/` as of `revision` |
| `revision` | The completed revision the answer came from |
| `processing.pendingIngestions` | Accepted requests not searchable yet (`queued` + `running`) |
| `processing.searchable: false` | The bank has no completed revision yet; the model is not called |

## 6. Check spend

```sh
curl -s 'localhost:47823/v1/banks/family-notes/stats?timezone=Europe/Berlin'
curl -s localhost:47823/v1/stats
```

Totals for today, the current Monday-start week and the calendar month, in the requested timezone (default
`Asia/Jerusalem`). Money is `estimated_cost_usd` — tokens × the model's declared rates, not an OpenRouter invoice;
`calls_missing_cost` counts calls whose cost is unknown. History survives restarts and archiving.

## 7. Archive and restore

```sh
curl -s -X POST localhost:47823/v1/banks/family-notes/archive
curl -s -X POST localhost:47823/v1/banks/family-notes/restore
```

Archive refuses new intake and queries at once (`409 bank_archiving`) but still processes requests that were
already accepted: the bank answers `202 archiving` until they finish, then becomes `archived`. Restore (`archived`
→ `active`) changes no file and no history. Nothing in the API ever deletes a bank.

## Checking a build end to end

`scripts/acceptance/run.mjs` builds the server, starts it on a temporary `MEMORY_BANK_ROOT` and walks steps 2–7
with a scripted model (no network, no cost), including a crash/restart and the default 60 s window. It stops only
the server process it started.

```sh
node scripts/acceptance/run.mjs --out /tmp/acceptance     # full chain, ~5 min, results-stub.json
node scripts/acceptance/run.mjs --window-ms 3000          # same, short window, for quick iteration
node scripts/acceptance/run.mjs --mode live --env-file .env   # one real Librarian ingest + two real queries
```
