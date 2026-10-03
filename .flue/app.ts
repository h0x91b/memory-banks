import { Hono, type Context } from 'hono';
import { ApiError, createBanksRouter, errorEnvelope, isValidBankId } from '../src/banks/index.ts';
import { bankRegistry, ingestionStore, runLibrarianGuarded, runRetrieverGuarded } from '../src/guarded-runs.js';
import { createIngestionsRouter } from '../src/ingestions/index.ts';
import { RequestError } from '../src/request.js';
import { sharedSpendLedger } from '../src/spend-ledger.js';
import { createStatsRouter, httpStatsMiddleware, tagRequestBank } from '../src/stats-router.js';

/**
 * Route map. Both agents keep the original synchronous contract: POST a JSON
 * payload to /agents/<name>/<run-id> and get the full JSON report back once
 * the run finishes. The routes orchestrate host-side work (ingest, git, sweep)
 * around one agent submission each. Agent runs go through the bank lifecycle
 * guard: an archiving/archived bank answers 409 instead of running.
 *
 * /v1/* is the bank management API (docs/api/banks.md), durable ingestion
 * (docs/api/ingestions.md) plus spend and HTTP statistics (docs/api/stats.md). Every request is recorded in the spend
 * ledger by the middleware registered before the routes.
 */
const app = new Hono();
app.use('*', httpStatsMiddleware(sharedSpendLedger()));

async function handle(c: Context, run: (payload: any, runId: string) => Promise<unknown>) {
  const payload = await c.req.json().catch(() => undefined);
  tagRequestBank(c, payload?.bank);
  try {
    return c.json(await run(payload, c.req.param('id') ?? 'run'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RequestError) return c.json({ error: message }, 400);
    if (err instanceof ApiError) return c.json({ error: message, code: err.code }, err.status);
    console.error(err);
    return c.json({ error: message }, 500);
  }
}

app.post('/agents/librarian/:id', (c) => handle(c, runLibrarianGuarded));
// Deprecated alias kept for existing clients after the curator → librarian
// rename: same handler, same single run per request. Remove once clients move.
app.post('/agents/curator/:id', (c) => handle(c, runLibrarianGuarded));
app.post('/agents/retriever/:id', (c) => handle(c, runRetrieverGuarded));

// A crash can leave an ingestion hold without its request; repair a bank's
// ingestion state before any lifecycle decision about it (archive settles on holds).
app.use('/v1/banks/:bank/*', async (c, next) => {
  await recoverIngestions(c.req.param('bank'));
  return next();
});
app.use('/v1/banks/:bank', async (c, next) => {
  await recoverIngestions(c.req.param('bank'));
  return next();
});
app.route('/v1', createBanksRouter(bankRegistry));
app.route('/v1', createIngestionsRouter(ingestionStore, bankRegistry));
app.route('/', createStatsRouter({ ledger: sharedSpendLedger(), banks: bankRegistry }));
app.notFound((c) =>
  c.req.path.startsWith('/v1/')
    ? c.json(errorEnvelope(new ApiError('not_found', `No route for ${c.req.method} ${c.req.path}`)), 404)
    : c.text('404 Not Found', 404),
);

async function recoverIngestions(bank: string | undefined) {
  if (!isValidBankId(bank)) return;
  try {
    await ingestionStore.recover(bank);
  } catch (err) {
    // Never fail the request on repair: the worst case is archive waiting longer.
    console.error(err);
  }
}

export default app;
