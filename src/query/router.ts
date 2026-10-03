// POST /v1/banks/:bank/query. A self-contained Hono app with paths relative to
// the /v1 prefix; mount with `app.route('/v1', createQueryRouter(deps))`.
// Request/response contract: docs/api/query.md.

import { Hono } from 'hono';

import { ApiError, assertBankId, errorEnvelope } from '../banks/index.ts';
import { parseQueryBody, queryBank, type QueryDeps } from './service.ts';

export function createQueryRouter(deps: QueryDeps): Hono {
  const router = new Hono();

  router.post('/banks/:bank/query', async (c) => {
    try {
      const bank = c.req.param('bank');
      assertBankId(bank);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ApiError('invalid_json', 'Request body must be a JSON object');
      }
      return c.json(await queryBank(deps, bank, parseQueryBody(body)));
    } catch (err) {
      if (err instanceof ApiError) return c.json(errorEnvelope(err), err.status);
      console.error(err);
      return c.json(errorEnvelope(new ApiError('internal_error', 'Internal error')), 500);
    }
  });

  return router;
}
