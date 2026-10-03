# Spend and HTTP statistics API

Model spend and HTTP request totals for today, the current week and the
current calendar month. Code: `src/stats-router.ts` (routes, HTTP middleware),
`src/spend-ledger.ts` (journal), `src/spend-stats.ts` (aggregation),
`src/stats-periods.ts` (calendar boundaries).

> Status: the module and routes exist and are tested offline; they are not yet
> mounted in `.flue/app.ts` and the pipelines do not record spend yet. See
> "Wiring" below.

## Endpoints

```
GET /v1/stats                       all banks, archived ones included
GET /v1/banks/:bank/stats           one bank
```

Query parameter `timezone` — an IANA zone name (`Europe/Berlin`,
`America/New_York`, `UTC`). Default `Asia/Jerusalem`. Fixed offsets such as
`+02:00` are rejected because they carry no DST rules.

| Status | `error.code` | When |
|---|---|---|
| 200 | — | Stats returned (also when nothing was recorded yet — all totals 0, `accounting_since: null`) |
| 400 | `invalid_bank_id` | Bank id does not match `[a-z0-9][a-z0-9-]*` |
| 400 | `validation_error` | Unknown timezone; `details.field` is `timezone` |
| 404 | `bank_not_found` | Bank route only: the bank registry says `missing` **and** the ledger has no history for it |

Errors use the shared `/v1` envelope from `docs/api/banks.md`:
`{ "error": { "code": "...", "message": "...", "details": { ... } } }`.

A bank that was archived — or even removed from the registry — still returns
its history; `bank.status` says what the registry currently reports
(`active`, `archiving`, `archived`, `missing`, or `unknown` when no registry
is wired).

## Periods

| Period | From (inclusive) | To (exclusive) |
|---|---|---|
| `today` | 00:00 local today | 00:00 local tomorrow |
| `week` | 00:00 local on Monday of the current week | 00:00 local next Monday |
| `month` | 00:00 local on the 1st | 00:00 local on the 1st of next month |

- Boundaries are computed in the requested timezone and returned in UTC. Events
  are stored in UTC, so changing `timezone` moves the boundaries, never the data.
- DST is honoured: a spring-forward day is 23 hours, a fall-back day 25. Where
  DST skips midnight (e.g. `America/Santiago`), the day starts at the first
  local time that exists.
- Monday-start calendar weeks are the current working default. It has not been
  confirmed as a product decision.

## Example

```
GET /v1/banks/personal-notes/stats?timezone=Asia/Jerusalem
```

```json
{
  "scope": "bank",
  "bank": { "name": "personal-notes", "status": "active" },
  "currency": "USD",
  "timezone": "Asia/Jerusalem",
  "week_starts_on": "monday",
  "generated_at": "2026-10-03T12:00:00.000Z",
  "coverage": {
    "accounting_since": "2026-09-29T10:00:00.000Z",
    "ledger_since": "2026-09-27T20:59:59.000Z",
    "cost_basis": "estimated_cost_usd is computed from the model's declared per-token rates ...",
    "skipped_ledger_lines": 0
  },
  "periods": {
    "today": {
      "start": "2026-10-02T21:00:00.000Z",
      "end": "2026-10-03T21:00:00.000Z",
      "model": {
        "calls": 3,
        "reported_cost_usd": 0,
        "estimated_cost_usd": 0.12,
        "known_cost_usd": 0.12,
        "calls_with_reported_cost": 0,
        "calls_with_estimated_cost": 2,
        "calls_missing_cost": 1,
        "tokens": { "input": 1800, "output": 200, "cacheRead": 0, "cacheWrite": 0, "total": 2000 },
        "calls_missing_usage": 1,
        "by_agent": {
          "librarian": { "calls": 2, "estimated_cost_usd": 0.1, "calls_missing_cost": 1, "...": "same fields" },
          "retriever": { "calls": 1, "estimated_cost_usd": 0.02, "calls_missing_cost": 0, "...": "same fields" }
        }
      },
      "http": {
        "requests": 2,
        "by_status_class": { "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 1, "other": 0 },
        "duration_ms": { "total": 400, "avg": 200, "max": 300 }
      }
    },
    "week": { "...": "same shape" },
    "month": { "...": "same shape" }
  }
}
```

`GET /v1/stats` has the same shape with `"scope": "all_banks"` and no `bank`.

## What the money numbers mean

| Field | Meaning |
|---|---|
| `estimated_cost_usd` | Returned token usage × the model's **declared** per-token rates. Flue 2.1.0 / pi-ai 0.83 always compute cost this way (`calculateCost`); it is **not** what OpenRouter billed |
| `reported_cost_usd` | Costs the provider itself returned as billed. Always 0 today: nothing in the current stack passes OpenRouter's billed cost through |
| `known_cost_usd` | `reported + estimated` |
| `calls_missing_cost` | Calls whose cost is unknown — the run failed before returning usage, or tokens were used with no declared price. **Not counted as $0**; the real spend is higher than `known_cost_usd` by an unknown amount whenever this is above 0 |
| `coverage.accounting_since` | First recorded event in scope. Nothing earlier is known; spend from before the ledger existed is never reconstructed |
| `coverage.skipped_ledger_lines` | Unreadable journal lines (e.g. a write torn by a crash). Skipped, never guessed |

## Storage

- Append-only JSON Lines at `<MEMORY_BANK_ROOT>/.accounting/ledger.jsonl`
  (override the directory with `MEMORY_BANK_ACCOUNTING_DIR`). Outside every
  bank's `fs/` sandbox, so agents cannot see or edit it; bank names cannot start
  with `.`, so it never collides with a bank; bank archive does not touch it.
- Each event has an idempotency `id`. Recording the same execution twice keeps
  the first copy only — on write and again on read, so two processes (server
  and CLI) writing the same id at once still count it once.
- The whole file is read per stats request. Fine for thousands of events; a
  rollup or index is needed if it grows into the millions.

## Wiring (pending)

| Where | What to add |
|---|---|
| `.flue/app.ts` | `const ledger = new SpendLedger();` `app.use('*', httpStatsMiddleware(ledger));` before the routes, and `app.route('/', createStatsRouter({ ledger, banks: new BankRegistry() }))` (`src/banks/index.ts`); swap the local `apiError` helper for the shared `ApiError` envelope |
| Librarian pipeline, after `agent.read()` | `ledger.recordModelCall({ executionId: instanceId, bank, agent: 'librarian', runId, model: MODEL_ID, usage })` |
| Retriever pipeline, after `agent.read()` | the same with `agent: 'retriever'` |
| Both pipelines, when the agent call throws | the same with `usage: null`, so the paid-but-failed attempt shows up as `calls_missing_cost` |

`executionId` must be unique per paid attempt: the fresh agent instance id
(`freshInstanceId`) already is. A retried HTTP request gets a new instance id
and is counted again — correctly, it was paid again.
