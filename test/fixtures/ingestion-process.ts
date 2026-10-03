// One "server process" lifetime for restart tests: builds a fresh registry +
// store against MEMORY_BANK_ROOT, runs one action through the real router,
// prints the result as JSON and exits. Each spawn is a genuine restart.
import { Hono } from 'hono';

import { BankRegistry, createBanksRouter } from '../../src/banks/index.ts';
import { IngestionStore, createIngestionsRouter } from '../../src/ingestions/index.ts';

const [action, bank, arg] = process.argv.slice(2);
const registry = new BankRegistry();
const store = new IngestionStore(registry);
const app = new Hono();
app.route('/v1', createBanksRouter(registry));
app.route('/v1', createIngestionsRouter(store, registry));

async function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }),
  });
  return { status: res.status, body: await res.json() };
}

let out: unknown;
switch (action) {
  case 'post':
    out = await http('POST', `/v1/banks/${bank}/ingestions`, { items: [{ type: 'text', text: arg }] }, {
      'Idempotency-Key': 'restart-key',
    });
    break;
  case 'get-bank':
    await store.recover(bank);
    out = await http('GET', `/v1/banks/${bank}`);
    break;
  case 'list':
    out = await http('GET', `/v1/banks/${bank}/ingestions`);
    break;
  case 'drain': {
    const claim = await store.claimBatch({ bank, workerId: 'child', leaseMs: 60_000 });
    if (claim) {
      await store.complete(
        claim,
        claim.requests.map((r) => ({
          requestId: r.id,
          revision: 'abc123',
          items: r.items.map((i) => ({ index: i.index, status: 'succeeded' as const })),
        })),
      );
    }
    out = { drained: claim?.requests.length ?? 0, bank: await registry.get(bank) };
    break;
  }
  default:
    throw new Error(`unknown action ${action}`);
}
process.stdout.write(JSON.stringify(out));
