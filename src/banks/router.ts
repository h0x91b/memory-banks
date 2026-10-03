// /v1 bank lifecycle routes. A self-contained Hono app with paths relative to
// the /v1 prefix; mount with `app.route('/v1', createBanksRouter())`.
// Request/response contract: docs/api/banks.md.

import { Hono, type Context } from 'hono';

import { ApiError, errorEnvelope } from './errors.ts';
import {
  BankRegistry,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  assertBankId,
  isValidBankId,
  type BankStatusFilter,
} from './registry.ts';

const STATUS_FILTERS: readonly BankStatusFilter[] = ['active', 'archiving', 'archived', 'all'];
const CREATE_KEYS = new Set(['id', 'name', 'description']);
const PATCH_KEYS = new Set(['name', 'description']);

export function createBanksRouter(registry: BankRegistry = new BankRegistry()): Hono {
  const router = new Hono();

  router.post('/banks', (c) =>
    handle(c, async () => {
      const body = await readObject(c, CREATE_KEYS);
      if (body.id === undefined) throw new ApiError('validation_error', 'id is required', { field: 'id' });
      assertBankId(body.id);
      const bank = await registry.create({
        id: body.id,
        name: body.name as string | undefined,
        description: body.description as string | undefined,
      });
      return c.json(bank, 201);
    }),
  );

  router.get('/banks', (c) =>
    handle(c, async () => {
      const status = (c.req.query('status') ?? 'active') as BankStatusFilter;
      if (!STATUS_FILTERS.includes(status)) {
        throw new ApiError('validation_error', `status must be one of ${STATUS_FILTERS.join(', ')}`, {
          field: 'status',
        });
      }
      const limitRaw = c.req.query('limit');
      const limit = limitRaw === undefined ? LIST_LIMIT_DEFAULT : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX || !/^\d+$/.test(limitRaw ?? '1')) {
        throw new ApiError('validation_error', `limit must be an integer 1-${LIST_LIMIT_MAX}`, { field: 'limit' });
      }
      const cursor = c.req.query('cursor');
      const after = cursor === undefined ? undefined : decodeCursor(cursor, status);
      const { banks, nextAfter } = await registry.list({ status, limit, after });
      return c.json({ banks, nextCursor: nextAfter === null ? null : encodeCursor(nextAfter, status) });
    }),
  );

  router.get('/banks/:bank', (c) => handle(c, async () => c.json(await registry.require(param(c)))));

  router.patch('/banks/:bank', (c) =>
    handle(c, async () => {
      const bank = param(c);
      const body = await readObject(c, PATCH_KEYS);
      if (body.name === undefined && body.description === undefined) {
        throw new ApiError('validation_error', 'Provide at least one of name, description');
      }
      return c.json(
        await registry.update(bank, {
          name: body.name as string | undefined,
          description: body.description as string | undefined,
        }),
      );
    }),
  );

  router.post('/banks/:bank/archive', (c) =>
    handle(c, async () => {
      const record = await registry.archive(param(c));
      return c.json(record, record.status === 'archiving' ? 202 : 200);
    }),
  );

  router.post('/banks/:bank/restore', (c) => handle(c, async () => c.json(await registry.restore(param(c)))));

  return router;
}

async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return c.json(errorEnvelope(err), err.status);
    console.error(err);
    return c.json(errorEnvelope(new ApiError('internal_error', 'Internal error')), 500);
  }
}

function param(c: Context): string {
  const bank = c.req.param('bank');
  assertBankId(bank);
  return bank;
}

async function readObject(c: Context, allowed: Set<string>): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError('invalid_json', 'Request body must be a JSON object');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('invalid_json', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new ApiError('validation_error', `Unknown field(s): ${unknown.join(', ')}`, { fields: unknown });
  }
  return body as Record<string, unknown>;
}

// Cursor = base64url of {"after": <last id>, "status": <filter>}. Opaque to
// clients; bound to the filter so it cannot be replayed against another list.
function encodeCursor(after: string, status: BankStatusFilter): string {
  return Buffer.from(JSON.stringify({ after, status })).toString('base64url');
}

function decodeCursor(cursor: string, status: BankStatusFilter): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed?.status === status && isValidBankId(parsed?.after)) return parsed.after;
  } catch {
    // fall through
  }
  throw new ApiError('invalid_cursor', 'cursor is malformed or belongs to a different status filter');
}
