# Query API (`POST /v1/banks/:bank/query`)

Ask a bank a question. The answer comes from an **immutable snapshot of the bank's last completed
revision** — never from the live `fs/` tree the Librarian may be rewriting at the same moment.
Same retriever, same answer/reference semantics as the legacy `POST /agents/retriever/:id`, which stays
available unchanged.

Code: `src/query/` (`service.ts` flow, `snapshot.ts` read view, `router.ts` HTTP). Mounted in
`.flue/app.ts` under `/v1`.

## Request

```json
{ "question": "When is the dentist appointment?", "hint": "look in health/" }
```

| Field | Rules |
|---|---|
| `question` | Required. Non-empty string after trimming, at most 4000 characters |
| `hint` | Optional string, at most 4000 characters. Passed to the retriever as a navigation hint |

Any other field is rejected with `validation_error`. The caller can never choose what is read: there is no
path, revision or directory parameter.

## Response — `200`

```json
{
  "bank": "family-notes",
  "answer": "The appointment is on 14 October at 09:30.",
  "references": [
    { "path": "/Users/me/.bank-memory/family-notes/fs/health/dentist.md", "why": "appointment date" }
  ],
  "revision": "3f1c0d6a9e1b2c4d5e6f708192a3b4c5d6e7f809",
  "processing": {
    "searchable": true,
    "revisionCompletedAt": "2026-10-03T12:00:00.000Z",
    "revisionSource": "worker",
    "provenance": "verified",
    "pendingIngestions": { "queued": 1, "running": 0 }
  },
  "meta": { "model": "…", "tokens": { }, "cost": { }, "bash_calls": 4, "telemetry": { }, "unexpected_writes": 0, "snapshot_ms": 12 }
}
```

| Field | Meaning |
|---|---|
| `answer` | Same as the legacy retriever. Nothing relevant → the literal `No relevant data found in the memory bank.` |
| `references[].path` | Absolute host path **in the bank's real `fs/`** (`<MEMORY_BANK_ROOT>/<bank>/fs/...`) — the file as it was at `revision`. The temporary snapshot path never appears. The live file may have changed or moved since; `git show <revision>:fs/<path>` in the bank repo gives the cited version |
| `revision` | Full sha of the bank commit the answer was read from. `null` when nothing is searchable yet |
| `processing.searchable` | `false` only when the bank has no completed revision yet |
| `processing.reason` | Present only when `searchable` is `false`: `no_completed_revision` |
| `processing.revisionCompletedAt` | When that revision was recorded as completed |
| `processing.revisionSource` | Who recorded it: `worker` (ingestion worker run), `legacy` (`/agents/librarian` or CLI run), `bootstrap` (state that existed before completed revisions were tracked) |
| `processing.provenance` | `verified` for `worker`/`legacy`; `unverified` for `bootstrap` — accepted as-is, not proven to be a finished Librarian run |
| `processing.pendingIngestions` | Accepted ingestion requests not yet searchable: `queued` + `running`. `null` when the ingestion store is not available |
| `meta` | Retriever model, tokens, cost, tool-call counts and telemetry, as in the legacy route; plus `unexpected_writes` (changes the retriever made to its snapshot — always `0`, the snapshot is read-only) and `snapshot_ms` |

### Searchable vs accepted

Work accepted by the ingestion API is **not** visible to queries until a Librarian run that included it has
completed and recorded a new revision. Until then it is counted in `processing.pendingIngestions`. A query
never shows half-filed state: intermediate commits of a running (or crashed) Librarian run are never
recorded as completed.

### No completed revision yet

A bank that exists but has never completed a run (for example, created moments ago with its first
ingestion still queued) answers `200` with the no-data literal, `references: []`, `revision: null`,
`processing.searchable: false`, `processing.reason: "no_completed_revision"` and the pending counts. The
model is not called and nothing is spent. A pre-existing bank with history but no record yet is recorded
once as a `bootstrap` revision and answered from it (that first query waits for a Librarian run already
holding the bank lock, if any). The bootstrap baseline is chosen by the writer (`src/bank-mutation.ts`),
never by the query side.

## Errors

Same envelope as the rest of `/v1` (`docs/api/banks.md`).

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_bank_id` | `:bank` is not a valid id |
| 400 | `invalid_json` | Body is not a JSON object |
| 400 | `validation_error` | Missing/empty/oversized `question`, bad `hint`, unknown field |
| 404 | `bank_not_found` | No such bank |
| 409 | `bank_archiving` | Archive requested; new queries are refused (queries already running finish) |
| 409 | `bank_archived` | Bank is archived |
| 500 | `snapshot_failed` | The completed revision could not be read from the bank repo. Nothing is left behind and there is no fallback to the live tree |
| 500 | `internal_error` | Anything else, including a retriever/model failure |

## How the snapshot works

1. The lifecycle guard admits the query as a `query` operation (archive waits for it).
2. The completed revision is read from `<root>/.revisions/<bank>.json`, written only by the bank mutation
   lock (`src/bank-mutation.ts`). The query side never writes or picks a revision of its own.
3. `git archive <revision>:fs | tar -x` exports that commit's `fs/` into
   `<root>/.query-snapshots/<bank>/<sha12>-<pid>-<random>/`. Read-only git plumbing: no worktree, clone,
   checkout, index or ref is created in the bank repo.
4. The snapshot is made read-only (files `0444`, directories `0555`), so the retriever cannot create,
   change or delete anything in it regardless of what the model tries.
5. The retriever runs with the snapshot as its sandbox root; references are mapped back to the bank's real
   `fs/` paths.
6. The snapshot directory is deleted when the query ends, success or failure. Directories left by a
   process that died are removed by the next query on that bank.

Each query gets its own snapshot; concurrent queries never share or affect one another.
