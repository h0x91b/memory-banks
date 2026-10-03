import { Hono, type Context } from 'hono';
import { ApiError, createBanksRouter, errorEnvelope } from '../src/banks/index.ts';
import { bankRegistry, runLibrarianGuarded, runRetrieverGuarded } from '../src/guarded-runs.js';
import { RequestError } from '../src/request.js';

/**
 * Route map. Both agents keep the original synchronous contract: POST a JSON
 * payload to /agents/<name>/<run-id> and get the full JSON report back once
 * the run finishes. The routes orchestrate host-side work (ingest, git, sweep)
 * around one agent submission each. Agent runs go through the bank lifecycle
 * guard: an archiving/archived bank answers 409 instead of running.
 *
 * /v1/* is the bank management API (docs/api/banks.md).
 */
const app = new Hono();

async function handle(c: Context, run: (payload: any, runId: string) => Promise<unknown>) {
  const payload = await c.req.json().catch(() => undefined);
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

app.route('/v1', createBanksRouter(bankRegistry));
app.notFound((c) =>
  c.req.path.startsWith('/v1/')
    ? c.json(errorEnvelope(new ApiError('not_found', `No route for ${c.req.method} ${c.req.path}`)), 404)
    : c.text('404 Not Found', 404),
);

export default app;
