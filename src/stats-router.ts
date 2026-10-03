import { randomUUID } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { BANK_NAME_RE } from './bank.ts';
import type { LedgerReadResult, SpendRecorder } from './spend-ledger.ts';
import { buildStats } from './spend-stats.ts';
import { DEFAULT_TIMEZONE, normalizeTimezone } from './stats-periods.ts';

/**
 * Bank state as owned by the bank lifecycle module (`BankRegistry.lookup`).
 * Stats never keep their own bank list; they only ask this port.
 * `archiving` / `archived` banks keep their full spend history.
 */
export type BankLookupState = 'active' | 'archiving' | 'archived' | 'missing';

export interface BankLookup {
  lookup(bank: string): Promise<BankLookupState>;
}

/**
 * Same envelope and codes as the bank lifecycle API (`src/banks/errors.ts`):
 * `{ error: { code, message, details? } }`. Kept local until both modules
 * share a branch; swap for `ApiError` + `errorEnvelope` at wiring time.
 */
function apiError(code: 'invalid_bank_id' | 'validation_error' | 'bank_not_found', message: string, details: Record<string, unknown>) {
  return { error: { code, message, details } };
}

export interface StatsRouterOptions {
  ledger: { read(): Promise<LedgerReadResult> };
  /** Bank lifecycle registry. Without it, `bank.status` is `unknown` and unknown banks are not 404. */
  banks?: BankLookup;
  defaultTimezone?: string;
  now?: () => Date;
}

/**
 * `GET /v1/stats` (all banks) and `GET /v1/banks/:bank/stats` (one bank).
 * Optional `?timezone=<IANA name>`; default Asia/Jerusalem.
 */
export function createStatsRouter(opts: StatsRouterOptions): Hono {
  const app = new Hono();
  const now = opts.now ?? (() => new Date());
  const fallbackTz = opts.defaultTimezone ?? DEFAULT_TIMEZONE;

  const badTimezone = (raw: string | undefined) =>
    Response.json(
      apiError('validation_error', `Unknown timezone "${raw}": use an IANA name like Europe/Berlin`, { field: 'timezone' }),
      { status: 400 },
    );
  const resolveTz = (raw: string | undefined) => (raw === undefined || raw === '' ? fallbackTz : normalizeTimezone(raw));

  app.get('/v1/stats', async (c) => {
    const timezone = resolveTz(c.req.query('timezone'));
    if (!timezone) return badTimezone(c.req.query('timezone'));
    const { events, skippedLines } = await opts.ledger.read();
    return c.json({ scope: 'all_banks', ...buildStats(events, { timezone, now: now(), skippedLines }) });
  });

  app.get('/v1/banks/:bank/stats', async (c) => {
    const bank = c.req.param('bank');
    if (!BANK_NAME_RE.test(bank)) {
      return c.json(apiError('invalid_bank_id', `Invalid bank id "${bank}": must match [a-z0-9][a-z0-9-]*`, { bank }), 400);
    }
    const timezone = resolveTz(c.req.query('timezone'));
    if (!timezone) return badTimezone(c.req.query('timezone'));
    const { events, skippedLines } = await opts.ledger.read();
    const status = opts.banks ? await opts.banks.lookup(bank) : 'unknown';
    if (status === 'missing' && !events.some((e) => e.bank === bank)) {
      return c.json(apiError('bank_not_found', `Bank "${bank}" not found`, { bank }), 404);
    }
    return c.json({
      scope: 'bank',
      bank: { name: bank, status },
      ...buildStats(events, { bank, timezone, now: now(), skippedLines }),
    });
  });

  return app;
}

const BANK_IN_PATH = /^\/v1\/banks\/([a-z0-9][a-z0-9-]*)(?:\/|$)/;
const STATS_PATH = /^\/v1\/(?:banks\/[^/]+\/)?stats\/?$/;

export interface HttpStatsOptions {
  /** Requests to leave out. Default: the stats endpoints themselves. */
  skip?: (path: string) => boolean;
  /** Bank a request belongs to. Default: `:bank` from `/v1/banks/:bank/...`, else none. */
  bankOf?: (path: string) => string | null;
  now?: () => number;
}

/**
 * Hono middleware that records one `http_request` event per handled request:
 * method, matched route pattern (not the raw path, so run ids and bank names
 * do not explode cardinality; `unmatched` for 404s with no route), status,
 * duration and bank. A failure to record
 * is logged and never changes the response.
 */
export function httpStatsMiddleware(recorder: SpendRecorder, opts: HttpStatsOptions = {}): MiddlewareHandler {
  const skip = opts.skip ?? ((p: string) => STATS_PATH.test(p));
  const bankOf = opts.bankOf ?? ((p: string) => BANK_IN_PATH.exec(p)?.[1] ?? null);
  const clock = opts.now ?? Date.now;
  const middleware: MiddlewareHandler = async (c, next) => {
    const path = c.req.path;
    if (skip(path)) return next();
    const t0 = clock();
    let thrown = false;
    try {
      await next();
    } catch (err) {
      thrown = true;
      throw err;
    } finally {
      const status = thrown ? 500 : c.res.status;
      const handlers = matchedRoutes(c).filter((r) => r.handler !== middleware && r.method !== 'ALL');
      const route = handlers.at(-1)?.path ?? 'unmatched';
      try {
        await recorder.recordHttpRequest({
          requestId: randomUUID(),
          bank: bankOf(path),
          method: c.req.method,
          route,
          status,
          durationMs: clock() - t0,
        });
      } catch (err) {
        console.error('[stats] failed to record http request', err);
      }
    }
  };
  return middleware;
}
