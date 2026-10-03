import { Hono, type Context } from 'hono';
import { runLibrarian } from '../src/librarian.js';
import { runRetriever } from '../src/retriever.js';
import { RequestError } from '../src/request.js';

/**
 * Route map. Both agents keep the original synchronous contract: POST a JSON
 * payload to /agents/<name>/<run-id> and get the full JSON report back once
 * the run finishes. The routes orchestrate host-side work (ingest, git, sweep)
 * around one agent submission each.
 */
const app = new Hono();

async function handle(c: Context, run: (payload: any, runId: string) => Promise<unknown>) {
  const payload = await c.req.json().catch(() => undefined);
  try {
    return c.json(await run(payload, c.req.param('id') ?? 'run'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RequestError) return c.json({ error: message }, 400);
    console.error(err);
    return c.json({ error: message }, 500);
  }
}

app.post('/agents/librarian/:id', (c) => handle(c, runLibrarian));
// Deprecated alias kept for existing clients after the curator → librarian
// rename: same handler, same single run per request. Remove once clients move.
app.post('/agents/curator/:id', (c) => handle(c, runLibrarian));
app.post('/agents/retriever/:id', (c) => handle(c, runRetriever));

export default app;
