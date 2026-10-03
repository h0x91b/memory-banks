# Bank lifecycle API (`/v1/banks`)

Explicit management of memory banks: create, list, read, rename/describe, archive, restore.
Nothing in this API ever deletes or moves a bank's files or git history.

Code: `src/banks/` (`registry.ts` storage + lifecycle, `router.ts` HTTP, `errors.ts` envelope,
`agent-guard.ts` wrapper for agent runs). Mounted in `.flue/app.ts` as `app.route('/v1', createBanksRouter(bankRegistry))`.

## Bank resource

```json
{
  "id": "family-notes",
  "name": "Family notes",
  "description": "Recipes, standups, trip plans.",
  "status": "active",
  "createdAt": "2026-10-03T12:00:00.000Z",
  "updatedAt": "2026-10-03T12:00:00.000Z",
  "archiveRequestedAt": null,
  "archivedAt": null
}
```

| Field | Rules |
|---|---|
| `id` | Stable, never changes. `[a-z0-9][a-z0-9-]*`, 1–200 chars. Same rule as the bank directory name |
| `name` | Mutable. 1–100 characters after trimming, single line. Defaults to `id` |
| `description` | Mutable. 0–1000 characters after trimming, newlines allowed, no other control characters. Defaults to `""` |
| `status` | `active` · `archiving` · `archived` |
| `archiveRequestedAt` | When archive was requested; `null` unless `archiving`/`archived` |
| `archivedAt` | When the bank became `archived`; `null` otherwise |

## Errors

Every error has the same envelope:

```json
{ "error": { "code": "bank_not_found", "message": "Bank \"nope\" not found", "details": { "bank": "nope" } } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_bank_id` | The id in the path or body does not match the id rule. Checked before any disk access |
| 400 | `invalid_json` | Body is not a JSON object |
| 400 | `validation_error` | Missing/unknown field, bad `name`/`description`, bad `status`/`limit` query. `details.field` names it |
| 400 | `invalid_cursor` | `cursor` is malformed or came from a list with a different `status` filter |
| 404 | `not_found` | No `/v1` route for this method and path |
| 404 | `bank_not_found` | No such bank |
| 409 | `bank_exists` | Create of an id that already exists (with or without a lifecycle record) |
| 409 | `bank_archiving` | Restore while still archiving; also returned by the lifecycle guard for new work |
| 409 | `bank_archived` | Returned by the lifecycle guard for new work on an archived bank |
| 500 | `internal_error` | Unexpected failure; details go to the server log only |

Unknown `/v1/*` paths get the envelope with `not_found` from the app-level not-found handler; the router itself
has no catch-all, so other `/v1` routers (stats) can mount alongside it.

## Endpoints

### `POST /v1/banks` — create

```http
POST /v1/banks
{ "id": "family-notes", "name": "Family notes", "description": "Recipes and plans" }
```

`201` → bank resource. Scaffolds `<MEMORY_BANK_ROOT>/<id>/` (`fs/`, `_index.md`, git repo), same as the agents do.
Only `id` is required. Unknown fields → `400 validation_error`. Existing id → `409 bank_exists`.

### `GET /v1/banks` — list

| Query | Default | Values |
|---|---|---|
| `status` | `active` | `active`, `archiving`, `archived`, `all` |
| `limit` | `50` | integer 1–100 |
| `cursor` | — | `nextCursor` from the previous page, same `status` |

`200` →

```json
{ "banks": [ { "id": "alpha", "...": "..." } ], "nextCursor": "eyJhZnRlciI6ImFscGhhIi..." }
```

Sorted by `id` ascending. The cursor is "after this id", so banks created or archived between pages never cause
duplicates or skips of banks that stay in the filter. `nextCursor` is `null` on the last page; a page that
exactly fills `limit` with nothing after it also returns `null`.

### `GET /v1/banks/:bank` — read

`200` → bank resource, whatever its status. `404 bank_not_found`, `400 invalid_bank_id`.

### `PATCH /v1/banks/:bank` — update metadata

```http
PATCH /v1/banks/family-notes
{ "description": "Recipes, standups and trip plans" }
```

`200` → bank resource. Accepts `name` and/or `description`, at least one. `id` and `status` are not patchable
(`400 validation_error`). Allowed in every status.

### `POST /v1/banks/:bank/archive` — archive

No body. Stops new work immediately, waits for work already admitted.

| Situation | Response |
|---|---|
| No operation in flight | `200`, `status: "archived"` |
| Operations still running | `202`, `status: "archiving"`; becomes `archived` when the last one ends |
| Already `archiving` / `archived` | `202` / `200`, unchanged (idempotent) |

Files and git history are untouched. Archived banks stay readable via `GET /v1/banks/:bank` and
`GET /v1/banks?status=archived`.

### `POST /v1/banks/:bank/restore` — restore

No body. `archived` → `active`, `200`. Already `active` → `200`, unchanged. `archiving` → `409 bank_archiving`
(retry once archived). Restore does not re-scaffold or overwrite anything in the bank.

## Storage and existing banks

| Path | What |
|---|---|
| `<root>/<id>/` | The bank. Never written by archive/restore/patch |
| `<root>/.lifecycle/banks/<id>.json` | Lifecycle record, `{"schema": 1, ...resource}`, written atomically (temp + rename) |
| `<root>/.lifecycle/leases/<id>/<lease>.json` | One file per in-flight operation: `{id, bank, kind, pid, startedAt}` |

- A bank is a real directory (not a symlink) under the root, named by the id rule, containing `fs/` or `.git`.
  Symlinks and stray folders are never listed or resolved.
- A bank directory without a record (every bank created before this API) is reported as `active`, `name = id`,
  `description = ""`, `createdAt` from the directory. Its record is written on the first patch/archive. No migration.
- `.lifecycle` and other dot-directories can never collide with bank ids. `.accounting/` is reserved for spend stats.

## Lifecycle guard (for intake / queue / worker code)

`BankRegistry` implements `BankLifecycleGuard` (`src/banks/registry.ts`):

```ts
type BankStatus = 'active' | 'archiving' | 'archived';
type OperationKind = 'intake' | 'curate' | 'query';

interface BankLifecycleGuard {
  lookup(bank: string): Promise<BankStatus | 'missing'>;          // never throws; bad id -> 'missing'
  beginOperation(bank: string, kind: OperationKind): Promise<OperationLease>;
}

interface OperationLease { id: string; bank: string; kind: OperationKind; release(): Promise<void>; }
```

Usage:

```ts
const lease = await registry.beginOperation(bank, 'intake'); // throws ApiError if not active
try {
  // accept material / run the job
} finally {
  await lease.release();                                      // idempotent
}
```

Guarantees:

1. Admission and the archive request are serialised per bank: after `archive` returns, no new lease is granted.
2. `archiving` is persisted before archive returns, so a restart does not reopen the bank.
3. Leases are files. A lease whose process is gone (crash, restart) is stale and ignored, so a half-finished archive
   completes on the next read of that bank.
4. The guard decides admission only. Work admitted before the archive request is allowed to finish.

Who must call it: anything that writes material into a bank or runs an agent over it — intake, the queue worker,
and the agent runs. The agent runs are already wired through `src/guarded-runs.ts`, used by both `.flue/app.ts` and
the CLI (`src/cli.ts`):

| Entry point | Guard kind | Missing bank | Archiving / archived bank |
|---|---|---|---|
| `POST /agents/librarian/:id`, `POST /agents/curator/:id` (alias) | `curate` | scaffolded, then admitted (unchanged behaviour) | `409 {"error": "...", "code": "bank_archiving" \| "bank_archived"}`, bank untouched |
| `POST /agents/retriever/:id` | `query` | runs as before, answers `reason: "bank-missing"` | same `409` |
| `scripts/run-cli.mjs librarian\|retriever` | same as above | same | throws `ApiError`, exit code 1 |

`/agents/*` keep their old error shape `{"error": string}`; the `code` field is added only for lifecycle refusals.
An invalid bank name still reaches the pipeline's own validation and answers `400` as before.

Known limits:

- Serialisation is per process. Two server processes over the same root can race in a window of milliseconds
  between the status check and the lease write. One server per root is the supported setup.
- If a crashed process's pid is reused by an unrelated live process, its stale lease looks live and the bank stays
  `archiving` until that process exits.
