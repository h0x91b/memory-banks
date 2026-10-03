# Ingestion worker

Turns durably queued ingestion requests (`POST /v1/banks/:bank/ingestions`,
`src/ingestions/`) into Librarian runs. Code: `src/ingestion-worker/`
(`worker.ts` scheduling and batch processing, `port.ts` the store interface it
depends on, `runtime.ts` server wiring) and `src/bank-mutation.ts` (bank lock
and completed revision).

## Scheduling: one fixed window per bank

- The window opens at the bank's **oldest queued arrival** and closes
  `60s` later (`MEMORY_BANK_INGESTION_WINDOW_MS` overrides). Later arrivals do
  not push it back: it is not a debounce.
- When it closes the worker takes the bank lock, **then** claims every request
  queued at that moment as one batch. The batch closes at run start.
- Requests arriving while a batch runs stay queued. Their window is measured
  from their own arrival, so if it already elapsed the next batch starts right
  after the current one.
- Different banks are independent and run in parallel.

## One writer per bank

Every mutating Librarian entrypoint runs inside `withBankMutation(bank, …)`:
the legacy `POST /agents/librarian|curator/:id` routes and the CLI (through
`src/guarded-runs.ts`) and every worker batch. The lock is an in-process
promise chain plus generation files `<root>/.locks/<bank>/<n>.json` holding
the owner pid, so a CLI run in another process waits for the server and vice
versa.

Cross-process ownership = having created the highest generation while the one
below it was dead (released or pid gone):

- A stale holder is never deleted to be reclaimed. Reclaimers create the next
  generation with an atomic, exclusive `link(2)`; two reclaimers of the same
  stale generation compete for the same file name, so exactly one wins.
- The highest generation is never deleted (release writes a `released`
  tombstone), so the counter only grows.
- After creating a generation the creator lists again and backs off if a
  higher one exists (its view was stale).

So at most one live owner exists at a time. A recycled pid makes a dead
holder look alive: the lock then waits, it never grants twice.
`test/ingestion-worker.test.ts` races 12 processes on one stale lock and
checks no two are ever inside at once.

Supported mode: **one server per `MEMORY_BANK_ROOT`** plus CLI runs, on one
local filesystem. It is not a multi-host lock.

Worker batches do not call `beginOperation`: the durable hold each accepted
request carries keeps an archiving bank from settling, so an archiving bank is
still drained, and `complete()` releasing the last hold lets it become
archived. New intake on an archiving/archived bank is refused by the intake
API, not here. A bank that is already `archived` or gone fails the batch
(`bank_archived` / `bank_not_found`).

## Batch processing

1. Requests with more than 3 claims (`maxAttempts`) fail with
   `max_attempts_exceeded` without running.
2. Each item goes through the existing ingest step (`src/ingest.ts`), one at a
   time; a failing item records `{code, message}` and the others continue.
   - `text`: the stored bytes as an inline item.
   - `file`: the stored bytes spooled to a temp dir, ingested as a file.
   - `url`: downloaded **by the worker** (http/https only, 60s timeout, 50 MB
     cap), spooled, ingested as a file. Codes: `invalid_url`,
     `download_failed`, `download_too_large`.
   The original descriptor is passed to ingest as `origin` so provenance names
   the URL/filename, not the spool path.
3. One ingest commit for the batch, ending with trailers
   `Ingestion-Batch: <token>` and one `Ingestion-Item: <request>/<index>` per
   ingested item.
4. One Librarian run over `fs/_raw/` (request hints joined).
5. On success the bank's HEAD becomes the completed revision; every request of
   the batch gets `commits` (ingest + curate short shas) and `revision`. If the
   Librarian run fails, ingested items are reported `failed` with
   `curate_failed`; their files stay in `fs/_raw/` and are filed by the bank's
   next run.

## Completed revision

`<root>/.revisions/<bank>.json`, written only by `src/bank-mutation.ts` while
holding the bank lock:

```ts
{ bank, revision: string | null /* 40-hex */, completedAt, by: 'worker' | 'legacy' | 'bootstrap', runId, ingestionIds? }
```

- Advanced only by a run that finished (worker batch whose Librarian run
  succeeded, or a successful legacy/CLI run). Intermediate `ingest:` commits and
  failed or crashed runs never advance it.
- **Baseline**: the first time a bank is locked without a record, before the
  holder runs, the record is set to the newest first-parent commit whose
  subject does not start with `ingest:` (`by: 'bootstrap'` — a pre-existing
  state taken as-is, not a proven completed run), or `revision: null` when the
  bank has no repo or no such commit.
- Readers use `completedRevisions.get(bank)` / `resolve(bank)` (resolve takes
  the lock once to write the baseline for a never-locked bank).

## Crash, lease and replay: at-least-once

- A claim has a lease (5 min) renewed by heartbeat every lease/3. Expired
  claims are re-queued by `reapExpired`, run at startup and on every poll
  (15s), and the batch runs again with `attempts + 1`.
- The lease never creates a second live run of a bank: a reclaimed batch needs
  the bank lock, which the old run holds until it ends. A run that lost its
  claim stops ingesting further items, still commits what it ingested (so the
  trailers exist), skips the Librarian run, does not advance the revision and
  does not report results (`complete()` would reject its token anyway).
- **Replay guarantees**: items whose `Ingestion-Item` trailer is already in the
  bank history are reported `succeeded` with `replayed: true` and not ingested
  again. An item ingested but not yet committed when the process died is
  ingested again (duplicate file in `fs/_raw/`, e.g. `note-1.md`). A Librarian
  run interrupted mid-way is run again over whatever `fs/_raw/` holds. There is
  no exactly-once guarantee.
- Startup calls the store's `recoverAll()` before scanning.

## Server lifecycle

`.flue/app.ts` calls `startIngestionWorker(ingestionStore, bankRegistry)`
(`runtime.ts`), and a `202` from the intake route nudges it (`notify`) so the
bank's window is scheduled at once instead of on the next poll. It starts one worker per
process (idempotent across dev re-imports), waits until the Flue runtime
answers, recovers and schedules. SIGINT/SIGTERM stop scheduling immediately;
a batch still running when the server exits is recovered by its lease on the
next start. `MEMORY_BANK_INGESTION_WORKER=off` disables it.

`test/ingestion-worker-built-server.test.ts` covers the built server end to end
(202 queued -> succeeded with commits and revision, then SIGTERM) with a
scripted model preloaded into the server process (`test/fixtures/openrouter-stub.mjs`).
