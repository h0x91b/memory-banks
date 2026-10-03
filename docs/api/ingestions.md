# Ingestion API (`/v1/banks/:bank/ingestions`)

Accept material for a bank **durably** and answer at once with `202 Accepted`. Nothing here runs a model, fetches a
URL or writes into the bank: the request is stored in a queue outside the bank, and the ingestion worker started with the server processes it
later through the store port described below (batching, retries and replay: `docs/design/ingestion-worker.md`).

Code: `src/ingestions/` (`store.ts` storage + queue port, `router.ts` HTTP). Mounted in `.flue/app.ts` as
`app.route('/v1', createIngestionsRouter(ingestionStore, bankRegistry))`; the store instance lives in
`src/guarded-runs.ts`. Errors use the shared `/v1` envelope from `docs/api/banks.md`.

## `POST /v1/banks/:bank/ingestions` — accept

The bank must exist and be `active`. Two body formats.

### JSON (`Content-Type: application/json`)

```json
{
  "metadata": { "source": "slack" },
  "items": [
    { "type": "text", "text": "# Standup\n...", "filename": "standup.md", "mediaType": "text/markdown", "metadata": {} },
    { "type": "url", "url": "https://example.com/post", "filename": "post.html", "metadata": {} }
  ]
}
```

| Field | Rules |
|---|---|
| `items` | Required, 1–100 entries |
| `items[].type` | `text` or `url`. Files go through multipart |
| `text` | Non-empty string, at most 5 MiB as UTF-8. Stored byte-exact |
| `url` | `http`/`https` only, at most 2048 characters, no `user:pass@`. Stored as a descriptor; the worker fetches it later |
| `filename` | Optional plain name, 1–200 chars, no `/`, `\`, control characters, not `.`/`..` |
| `mediaType` | Optional for `text`, like `text/markdown`; default `text/plain` |
| `metadata` | Optional JSON object on the request and on each item, at most 16 KiB as JSON. Stored as given |

Unknown fields anywhere → `400 validation_error`.

### Multipart (`Content-Type: multipart/form-data`)

| Part | Repeatable | Becomes |
|---|---|---|
| `file` | yes | a `file` item: bytes, browser file name (path stripped), part content type (else `application/octet-stream`). Max 25 MiB each, empty files refused |
| `text` | yes | a `text` item, `text/plain` |
| `url` | yes | a `url` item, same rules as JSON |
| `metadata` | once | JSON object string → request metadata |

Images are plain `file` parts (`image/png`, `image/jpeg`, ...). Item order is: all files, then texts, then urls.
Per-item metadata is JSON-only. Other part names → `400 validation_error`.

### Limits that apply to both

Whole body at most 50 MiB (`413 payload_too_large`); at most 100 items. Any other content type →
`415 unsupported_media_type`.

### Response — always the same shape

```http
HTTP/1.1 202 Accepted
Location: /v1/banks/notes/ingestions/ing_0mfz3k2a1b_3f9c2a7b1d4e

{ "id": "ing_0mfz3k2a1b_3f9c2a7b1d4e", "status": "queued", "status_url": "/v1/banks/notes/ingestions/ing_0mfz3k2a1b_3f9c2a7b1d4e" }
```

`202` is sent only after the payload bytes, the request record and the bank's durable hold are on disk (fsynced) —
see § Storage. A client that got `202` can rely on the request surviving a restart.

### `Idempotency-Key`

Optional header, 1–255 visible ASCII characters, scoped **per bank**.

| Repeat with the same key | Result |
|---|---|
| Same payload | `202` with the **same** `id`, header `Idempotent-Replayed: true`. `status` is the request's current status |
| Different payload | `409 idempotency_conflict`, `details.ingestionId` names the original |
| Same key on another bank | Independent; a new request |

"Same payload" = same request metadata and same items in the same order: type, content hash, filename, media type,
URL, item metadata. Concurrent identical repeats create exactly one request; keys survive restarts. Keys never expire.

### Errors

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_bank_id` | Bad bank id in the path |
| 400 | `invalid_json` | Body is not a JSON object |
| 400 | `validation_error` | Any field rule above, bad `Idempotency-Key`. `details.field` names it |
| 404 | `bank_not_found` | No such bank (banks are created with `POST /v1/banks`, not here) |
| 409 | `bank_archiving` / `bank_archived` | The bank does not accept new work |
| 409 | `idempotency_conflict` | Key reused with a different payload |
| 413 | `payload_too_large` | Body over 50 MiB |
| 415 | `unsupported_media_type` | Not JSON or multipart |

## `GET /v1/banks/:bank/ingestions/:id` — status

`200` → the request resource. Readable for `archiving` and `archived` banks too. Unknown id → `404 ingestion_not_found`.

```json
{
  "id": "ing_0mfz3k2a1b_3f9c2a7b1d4e",
  "bank": "notes",
  "status": "queued",
  "createdAt": "2026-10-03T12:00:00.000Z",
  "updatedAt": "2026-10-03T12:00:00.000Z",
  "startedAt": null,
  "finishedAt": null,
  "attempts": 0,
  "idempotencyKey": "k-1",
  "metadata": { "source": "slack" },
  "items": [
    { "index": 0, "kind": "text", "filename": "standup.md", "mediaType": "text/markdown", "size": 24,
      "sha256": "…", "url": null, "metadata": null, "status": "queued", "error": null },
    { "index": 1, "kind": "url", "filename": null, "mediaType": null, "size": null,
      "sha256": null, "url": "https://example.com/post", "metadata": null, "status": "queued", "error": null }
  ],
  "revision": null,
  "commits": [],
  "error": null
}
```

`items[].url` in status and history (and in an item's `error.message`) is shown
with secret-like query values (`token`, `key`, `sig`, `secret`, `pass`, `auth`,
`credential`, `session` in the name) and any userinfo replaced by `redacted`,
e.g. `?X-Amz-Signature=redacted`. A URL with nothing to redact is returned as
stored. The worker and `Idempotency-Key` matching use the real URL.

| Request `status` | Meaning |
|---|---|
| `queued` | Accepted, waiting for the worker. The only status this API itself produces |
| `running` | Claimed by a worker (`attempts` counts claims) |
| `succeeded` | Every item succeeded |
| `partial` | Some items succeeded, some failed — see `items[].error` |
| `failed` | No item succeeded; `error` may hold a request-level reason |

Item `status`: `queued`, `running`, `succeeded`, `failed`; a failed item carries `error: {code, message}`.
`revision` is the bank revision (git commit) the worker produced, `null` until completed. `commits` lists the
commits the worker made for the request's batch (e.g. ingest + curate), oldest first; `[]` until completed.

## `GET /v1/banks/:bank/ingestions` — history

Newest first.

| Query | Default | Values |
|---|---|---|
| `status` | `all` | `queued`, `running`, `succeeded`, `partial`, `failed`, `all` |
| `limit` | `50` | integer 1–100 |
| `cursor` | — | `nextCursor` from the previous page, same bank and `status` |

`200` → `{ "ingestions": [ <resource>, ... ], "nextCursor": "…" | null }`. A cursor from another bank or filter →
`400 invalid_cursor`. Missing bank → `404 bank_not_found`.

## Storage

All outside every bank's `fs/` sandbox and never inside a bank directory:

| Path | What |
|---|---|
| `<root>/.ingestion/<bank>/requests/<id>/request.json` | Request record (`schema: 1`, payload fingerprint, worker claim) |
| `<root>/.ingestion/<bank>/requests/<id>/items/<index>` | Stored bytes of `text` / `file` items. `url` items have none |
| `<root>/.ingestion/<bank>/staging/<id>/` | A request being written; never acknowledged |
| `<root>/.ingestion/<bank>/idempotency/<sha256(key)>.json` | `{key, requestId, fingerprint}` |
| `<root>/.lifecycle/holds/<bank>/intake-<id>.json` | Durable hold that keeps archive waiting (`docs/api/banks.md`) |

`<root>` is `MEMORY_BANK_ROOT`; `MEMORY_BANK_INGESTION_DIR` moves `.ingestion` elsewhere. Ids are
`ing_<base36 ms>_<12 hex>` and sort in acceptance order.

Accept protocol:

1. Item bytes and `request.json` are written and fsynced into `staging/<id>/` (outside any lock).
2. Under the bank's lifecycle lock (`admitDurableWork`): the bank must be `active`; the hold is written; `staging/<id>`
   is renamed to `requests/<id>`; the idempotency record is written.
3. `202` is sent.

### Archive and accepted work

- New requests on an `archiving` or `archived` bank → `409`. This API never widens what those banks accept.
- Every accepted request holds the bank through its durable hold until it reaches `succeeded`, `partial` or `failed`.
  An archive requested meanwhile answers `202 archiving` and becomes `archived` only after the last hold is released —
  across restarts, because holds are files with no PID.
- `restore` is refused while `archiving`, as before.

### Crash recovery

`IngestionStore.recover(bank)` runs once per bank per process before any read, accept or claim on that bank, and
`.flue/app.ts` runs it before every `/v1/banks/:bank...` request (so before `archive` and bank reads decide on
holds). `recoverAll()` repairs every bank and is meant for server startup. It fixes what a crash can leave:

| Leftover | Repair |
|---|---|
| `staging/<id>` (crash before commit) | Deleted — the client never got `202` |
| Committed non-terminal request without a hold | Hold re-created (first, so the bank cannot settle early) |
| Hold whose request does not exist (crash between hold and rename) | Released — an orphan hold never blocks archive forever |
| Committed request without its idempotency record | Record re-written, so a retry still replays |

## Worker port (used by `src/ingestion-worker/`)

`IngestionStore` implements `IngestionWorkQueue` (`src/ingestions/store.ts`):

```ts
pendingBanks(): Promise<Array<{ bank: string; firstQueuedAt: string }>>;   // banks with queued work, oldest first
pendingCounts(bank): Promise<{ queued: number; running: number }>;
claimBatch({ bank, workerId, leaseMs }): Promise<IngestionBatchClaim | null>; // ALL queued of the bank -> running, one token
heartbeat(claim, leaseMs?): Promise<void>;                                  // throws IngestionClaimLost when fenced out
readItem(claim, requestId, index): Promise<Buffer>;                          // stored bytes; url items throw
complete(claim, outcomes: RequestOutcome[]): Promise<IngestionRecord[]>;    // one outcome per request and item
reapExpired(now?): Promise<number>;                                         // expired running -> queued
recoverAll(): Promise<void>;
```

- `complete` derives the request status from item outcomes, stores `revision`, `commits` (optional, at most 50
  hex shas) and `error`, and releases the holds. A malformed `commits` rejects the whole call before anything is written.
- A stale token (lease reaped, or already completed) gets `IngestionClaimLost` (`code: 'claim_lost'`) everywhere.
- The worker processes claimed work even on an `archiving` bank and must not call `beginOperation` for it: the
  hold, not a lease, is what admits it.

Known limits:

- One writer process per root, like the bank registry (locks are in-process).
- Reads scan `request.json` files; fine for thousands of requests per bank, not millions.
- Idempotency keys and request history are never pruned.
