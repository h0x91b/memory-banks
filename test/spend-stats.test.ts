// Offline tests for spend/HTTP accounting and the stats API: no model calls,
// no network, no API keys. Every ledger lives in a throwaway temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import type { PromptUsage } from '@flue/runtime';

import { SpendLedger, costFromUsage, recordAgentCall, sharedSpendLedger } from '../src/spend-ledger.ts';
import { computePeriods, normalizeTimezone } from '../src/stats-periods.ts';
import { createStatsRouter, httpStatsMiddleware, type BankLookupState } from '../src/stats-router.ts';

let dir: string;
let n = 0;
const freshLedger = () => new SpendLedger(path.join(dir, `ledger-${++n}`, 'ledger.jsonl'));

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-banks-stats-'));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function usage(costTotal: number, tokens = 1000): PromptUsage {
  return {
    input: tokens - 100,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

const iso = (d: Date) => d.toISOString();
const hours = (p: { start: Date; end: Date }) => (p.end.getTime() - p.start.getTime()) / 3_600_000;

describe('calendar periods', () => {
  test('day, Monday week and month in Asia/Jerusalem summer time', () => {
    const p = computePeriods(new Date('2026-10-03T12:00:00Z'), 'Asia/Jerusalem'); // Saturday
    assert.equal(iso(p.today.start), '2026-10-02T21:00:00.000Z');
    assert.equal(iso(p.today.end), '2026-10-03T21:00:00.000Z');
    assert.equal(iso(p.week.start), '2026-09-27T21:00:00.000Z'); // Monday 28 Sep, 00:00 +03
    assert.equal(iso(p.week.end), '2026-10-04T21:00:00.000Z');
    assert.equal(iso(p.month.start), '2026-09-30T21:00:00.000Z');
    // October contains the switch back to +02, so the month ends at 00:00 +02.
    assert.equal(iso(p.month.end), '2026-10-31T22:00:00.000Z');
  });

  test('local date, not UTC date, decides the day', () => {
    // 22:30 UTC on 3 Oct is already 01:30 on 4 Oct in Jerusalem — a Sunday.
    const p = computePeriods(new Date('2026-10-03T22:30:00Z'), 'Asia/Jerusalem');
    assert.equal(iso(p.today.start), '2026-10-03T21:00:00.000Z');
    assert.equal(iso(p.week.start), '2026-09-27T21:00:00.000Z'); // Sunday still belongs to Monday 28 Sep
    const utc = computePeriods(new Date('2026-10-03T22:30:00Z'), 'UTC');
    assert.equal(iso(utc.today.start), '2026-10-03T00:00:00.000Z');
  });

  test('Monday itself starts a new week', () => {
    const p = computePeriods(new Date('2026-09-28T00:00:00Z'), 'UTC');
    assert.equal(iso(p.week.start), '2026-09-28T00:00:00.000Z');
    assert.equal(iso(p.week.end), '2026-10-05T00:00:00.000Z');
  });

  test('new year: month and week roll over the year boundary', () => {
    const p = computePeriods(new Date('2026-12-31T22:30:00Z'), 'Asia/Jerusalem'); // 1 Jan 2027, 00:30 +02
    assert.equal(iso(p.today.start), '2026-12-31T22:00:00.000Z');
    assert.equal(iso(p.month.start), '2026-12-31T22:00:00.000Z');
    assert.equal(iso(p.month.end), '2027-01-31T22:00:00.000Z');
    assert.equal(iso(p.week.start), '2026-12-27T22:00:00.000Z'); // Monday 28 Dec 2026
    assert.equal(iso(p.week.end), '2027-01-03T22:00:00.000Z');
    const dec = computePeriods(new Date('2026-12-15T10:00:00Z'), 'UTC');
    assert.equal(iso(dec.month.end), '2027-01-01T00:00:00.000Z');
  });

  test('DST: spring-forward day is 23h, fall-back day is 25h', () => {
    const spring = computePeriods(new Date('2026-03-27T12:00:00Z'), 'Asia/Jerusalem');
    assert.equal(iso(spring.today.start), '2026-03-26T22:00:00.000Z');
    assert.equal(hours(spring.today), 23);
    const fall = computePeriods(new Date('2026-10-25T12:00:00Z'), 'Asia/Jerusalem');
    assert.equal(iso(fall.today.start), '2026-10-24T21:00:00.000Z');
    assert.equal(hours(fall.today), 25);
  });

  test('DST that skips midnight: the day starts at the first existing minute', () => {
    // Santiago jumps 00:00 -04 → 01:00 -03 on 6 Sep 2026.
    const p = computePeriods(new Date('2026-09-06T15:00:00Z'), 'America/Santiago');
    assert.equal(iso(p.today.start), '2026-09-06T04:00:00.000Z');
    assert.equal(hours(p.today), 23);
  });

  test('timezone validation', () => {
    assert.equal(normalizeTimezone('Europe/Berlin'), 'Europe/Berlin');
    assert.equal(normalizeTimezone('Mars/Olympus'), null);
    assert.equal(normalizeTimezone('+02:00'), null);
    assert.equal(normalizeTimezone(''), null);
  });
});

describe('ledger recording', () => {
  test('same execution recorded twice counts once; separate attempts both count', async () => {
    const ledger = freshLedger();
    const base = { bank: 'alpha', agent: 'librarian', model: 'openai/gpt-6-luna' };
    assert.deepEqual(await ledger.recordModelCall({ ...base, executionId: 'run-1', usage: usage(0.01) }), { recorded: true });
    assert.deepEqual(await ledger.recordModelCall({ ...base, executionId: 'run-1', usage: usage(0.01) }), { recorded: false });
    await ledger.recordModelCall({ ...base, executionId: 'run-1-retry', usage: usage(0.02) });
    const { events } = await ledger.read();
    assert.equal(events.length, 2);
  });

  test('concurrent duplicate writes from two processes are de-duplicated on read', async () => {
    const a = freshLedger();
    const b = new SpendLedger(a.file);
    const input = { executionId: 'x', bank: 'alpha', agent: 'retriever', model: 'm', usage: usage(0.5) };
    await Promise.all([a.recordModelCall(input), b.recordModelCall(input)]);
    const lines = (await fs.readFile(a.file, 'utf8')).trim().split('\n');
    assert.ok(lines.length >= 1);
    assert.equal((await a.read()).events.length, 1);
  });

  test('missing cost is never zero', () => {
    assert.deepEqual(costFromUsage(null), { cost_source: 'missing', cost_usd: null });
    assert.deepEqual(costFromUsage(usage(0, 500)), { cost_source: 'missing', cost_usd: null }); // tokens but no price
    assert.deepEqual(costFromUsage(usage(Number.NaN)), { cost_source: 'missing', cost_usd: null });
    assert.deepEqual(costFromUsage(usage(0, 0)), { cost_source: 'estimated', cost_usd: 0 }); // nothing used
    assert.deepEqual(costFromUsage(usage(0.25)), { cost_source: 'estimated', cost_usd: 0.25 });
    assert.deepEqual(costFromUsage(usage(0.25), 'reported'), { cost_source: 'reported', cost_usd: 0.25 });
  });

  test('survives restart: a new instance sees old events and still de-duplicates', async () => {
    const first = freshLedger();
    await first.recordModelCall({ executionId: 'e1', bank: 'alpha', agent: 'librarian', model: 'm', usage: usage(0.1) });
    await first.recordHttpRequest({ requestId: 'h1', bank: 'alpha', method: 'POST', route: '/r', status: 200, durationMs: 12 });
    const restarted = new SpendLedger(first.file);
    assert.deepEqual(
      await restarted.recordModelCall({ executionId: 'e1', bank: 'alpha', agent: 'librarian', model: 'm', usage: usage(0.1) }),
      { recorded: false },
    );
    assert.equal((await restarted.read()).events.length, 2);
  });

  test('a torn line is skipped and reported, not guessed', async () => {
    const ledger = freshLedger();
    await ledger.recordModelCall({ executionId: 'ok', bank: 'alpha', agent: 'librarian', model: 'm', usage: usage(0.1) });
    await fs.appendFile(ledger.file, '{"v":1,"kind":"model_call","id":"model:to');
    const { events, skippedLines } = await new SpendLedger(ledger.file).read();
    assert.equal(events.length, 1);
    assert.equal(skippedLines, 1);
  });

  test('default ledger path is outside every bank, under MEMORY_BANK_ROOT/.accounting', async () => {
    const prevRoot = process.env.MEMORY_BANK_ROOT;
    const prevDir = process.env.MEMORY_BANK_ACCOUNTING_DIR;
    process.env.MEMORY_BANK_ROOT = path.join(dir, 'root');
    delete process.env.MEMORY_BANK_ACCOUNTING_DIR;
    try {
      assert.equal(new SpendLedger().file, path.join(dir, 'root', '.accounting', 'ledger.jsonl'));
      process.env.MEMORY_BANK_ACCOUNTING_DIR = path.join(dir, 'acct');
      assert.equal(new SpendLedger().file, path.join(dir, 'acct', 'ledger.jsonl'));
    } finally {
      if (prevRoot === undefined) delete process.env.MEMORY_BANK_ROOT;
      else process.env.MEMORY_BANK_ROOT = prevRoot;
      if (prevDir === undefined) delete process.env.MEMORY_BANK_ACCOUNTING_DIR;
      else process.env.MEMORY_BANK_ACCOUNTING_DIR = prevDir;
    }
  });
});

describe('stats API', () => {
  const NOW = new Date('2026-10-03T12:00:00Z'); // Saturday, Jerusalem +03
  const banks = (states: Record<string, BankLookupState>) => ({
    lookup: async (b: string) => states[b] ?? 'missing',
  });

  async function seeded() {
    const ledger = freshLedger();
    const call = (id: string, bank: string, agent: string, at: string, u: PromptUsage | null) =>
      ledger.recordModelCall({ executionId: id, bank, agent, model: 'openai/gpt-6-luna', usage: u, at: new Date(at) });
    await call('a-today', 'alpha', 'librarian', '2026-10-03T08:00:00Z', usage(0.1));
    await call('a-today', 'alpha', 'librarian', '2026-10-03T08:00:00Z', usage(0.1)); // duplicate write
    await call('a-today-ret', 'alpha', 'retriever', '2026-10-03T09:00:00Z', usage(0.02));
    await call('a-failed', 'alpha', 'librarian', '2026-10-03T10:00:00Z', null); // failed run, no usage
    await call('b-week', 'beta', 'retriever', '2026-09-29T10:00:00Z', usage(0.3)); // Tuesday
    await call('b-month', 'beta', 'librarian', '2026-10-01T05:00:00Z', usage(1)); // Thursday, same week
    await call('a-prev-week', 'alpha', 'librarian', '2026-09-27T20:59:59Z', usage(5)); // Sunday 23:59:59 +03
    await call('a-prev-month', 'alpha', 'librarian', '2026-09-30T20:00:00Z', usage(7)); // 30 Sep 23:00 +03
    await ledger.recordHttpRequest({ requestId: 'h1', bank: 'alpha', method: 'POST', route: '/v1/banks/:bank/ask', status: 200, durationMs: 100, at: new Date('2026-10-03T08:00:00Z') });
    await ledger.recordHttpRequest({ requestId: 'h2', bank: 'alpha', method: 'POST', route: '/v1/banks/:bank/ask', status: 500, durationMs: 300, at: new Date('2026-10-03T09:00:00Z') });
    return ledger;
  }

  test('no data: zero totals, null coverage, nothing invented', async () => {
    const app = createStatsRouter({ ledger: freshLedger(), now: () => NOW });
    const res = await app.request('/v1/stats');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.currency, 'USD');
    assert.equal(body.timezone, 'Asia/Jerusalem');
    assert.equal(body.week_starts_on, 'monday');
    assert.equal(body.coverage.accounting_since, null);
    assert.equal(body.periods.today.model.calls, 0);
    assert.equal(body.periods.month.model.known_cost_usd, 0);
    assert.equal(body.periods.month.http.requests, 0);
    assert.equal(body.periods.month.http.duration_ms.avg, null);
  });

  test('global totals across banks, per period', async () => {
    const app = createStatsRouter({ ledger: await seeded(), now: () => NOW });
    const body = await (await app.request('/v1/stats')).json();
    const { today, week, month } = body.periods;

    assert.equal(today.model.calls, 3);
    assert.equal(today.model.estimated_cost_usd, 0.12);
    assert.equal(today.model.reported_cost_usd, 0);
    assert.equal(today.model.calls_missing_cost, 1);
    assert.equal(today.model.calls_missing_usage, 1);
    assert.equal(today.model.by_agent.librarian.calls, 2);
    assert.equal(today.model.by_agent.retriever.estimated_cost_usd, 0.02);

    assert.equal(week.model.known_cost_usd, 8.42); // includes Wed 30 Sep, excludes Sunday 27 Sep 23:59:59 local
    assert.equal(month.model.known_cost_usd, 1.12); // excludes 30 Sep and the Tuesday/Wednesday before 1 Oct
    assert.equal(month.model.calls, 4);

    assert.equal(today.http.requests, 2);
    assert.deepEqual(today.http.by_status_class, { '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 1, other: 0 });
    assert.deepEqual(today.http.duration_ms, { total: 400, avg: 200, max: 300 });
    assert.equal(body.coverage.accounting_since, '2026-09-27T20:59:59.000Z');
    assert.match(body.coverage.cost_basis, /not an OpenRouter invoice/);
  });

  test('one bank: only its events; coverage starts at its first event', async () => {
    const app = createStatsRouter({ ledger: await seeded(), banks: banks({ alpha: 'active', beta: 'active' }), now: () => NOW });
    const body = await (await app.request('/v1/banks/beta/stats')).json();
    assert.deepEqual(body.bank, { name: 'beta', status: 'active' });
    assert.equal(body.periods.today.model.calls, 0);
    assert.equal(body.periods.week.model.known_cost_usd, 1.3);
    assert.equal(body.periods.month.model.known_cost_usd, 1);
    assert.equal(body.periods.week.http.requests, 0);
    assert.equal(body.coverage.accounting_since, '2026-09-29T10:00:00.000Z');
    assert.equal(body.coverage.ledger_since, '2026-09-27T20:59:59.000Z');
  });

  test('archived bank keeps its history; unknown bank without history is 404', async () => {
    const ledger = await seeded();
    const app = createStatsRouter({ ledger, banks: banks({ alpha: 'archived', beta: 'archiving' }), now: () => NOW });
    const alpha = await (await app.request('/v1/banks/alpha/stats')).json();
    assert.equal(alpha.bank.status, 'archived');
    assert.equal(alpha.periods.today.model.calls, 3);
    assert.equal((await (await app.request('/v1/banks/beta/stats')).json()).bank.status, 'archiving');
    const missing = await app.request('/v1/banks/gamma/stats');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'bank_not_found');
    // History outlives the registry entry: still served, flagged as missing.
    const gone = createStatsRouter({ ledger, banks: banks({}), now: () => NOW });
    const res = await gone.request('/v1/banks/alpha/stats');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).bank.status, 'missing');
    // Global totals include archived banks.
    assert.equal((await (await app.request('/v1/stats')).json()).periods.week.model.known_cost_usd, 8.42);
  });

  test('bad input: invalid bank name and unknown timezone are 400', async () => {
    const app = createStatsRouter({ ledger: freshLedger(), now: () => NOW });
    const badBank = await app.request('/v1/banks/Bad_Name/stats');
    assert.equal(badBank.status, 400);
    assert.equal((await badBank.json()).error.code, 'invalid_bank_id');
    const badTz = await app.request('/v1/stats?timezone=Mars/Olympus');
    assert.equal(badTz.status, 400);
    assert.deepEqual((await badTz.json()).error.details, { field: 'timezone' });
    assert.equal((await app.request('/v1/stats?timezone=%2B02:00')).status, 400);
  });

  test('explicit timezone moves the boundaries, not the data', async () => {
    const app = createStatsRouter({ ledger: await seeded(), now: () => NOW });
    const body = await (await app.request('/v1/stats?timezone=America/New_York')).json();
    assert.equal(body.timezone, 'America/New_York');
    assert.equal(body.periods.today.start, '2026-10-03T04:00:00.000Z');
    // 30 Sep 20:00Z is 16:00 in New York — September there too; month = Oct only.
    assert.equal(body.periods.month.model.known_cost_usd, 1.12);
    // Sunday 27 Sep 20:59Z is 16:59 on the 27th in New York: still the previous week.
    assert.equal(body.periods.week.model.known_cost_usd, 8.42);
  });
});

describe('HTTP stats middleware', () => {
  test('records method, route pattern, status, bank and duration; skips the stats endpoints', async () => {
    const ledger = freshLedger();
    let clock = 1000;
    const app = new Hono();
    app.use('*', httpStatsMiddleware(ledger, { now: () => (clock += 25) }));
    app.post('/v1/banks/:bank/ask', (c) => c.json({ ok: true }));
    app.onError((_err, c) => c.json({ error: 'internal' }, 500));
    app.get('/v1/boom', () => {
      throw new Error('boom');
    });
    app.route('/', createStatsRouter({ ledger }));

    assert.equal((await app.request('/v1/banks/alpha/ask', { method: 'POST' })).status, 200);
    assert.equal((await app.request('/v1/boom')).status, 500);
    assert.equal((await app.request('/v1/missing')).status, 404);
    assert.equal((await app.request('/v1/stats')).status, 200);
    assert.equal((await app.request('/v1/banks/alpha/stats')).status, 200);

    const { events } = await ledger.read();
    const http = events.filter((e) => e.kind === 'http_request');
    assert.equal(http.length, 3);
    assert.deepEqual(
      http.map((e) => [e.method, e.route, e.status, e.bank, e.duration_ms]),
      [
        ['POST', '/v1/banks/:bank/ask', 200, 'alpha', 25],
        ['GET', '/v1/boom', 500, null, 25],
        ['GET', 'unmatched', 404, null, 25],
      ],
    );
  });

  test('a broken recorder never breaks the response', async () => {
    const app = new Hono();
    const original = console.error;
    console.error = () => {};
    try {
      app.use('*', httpStatsMiddleware({
        recordModelCall: async () => ({ recorded: false }),
        recordHttpRequest: async () => {
          throw new Error('disk full');
        },
      }));
      app.get('/v1/ok', (c) => c.text('ok'));
      const res = await app.request('/v1/ok');
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    } finally {
      console.error = original;
    }
  });
});

describe('pipeline hook', () => {
  const meta = (executionId: string) => ({ executionId, bank: 'alpha', agent: 'librarian', runId: 'r1', model: 'openai/gpt-6-luna' });

  test('success records the returned usage and passes the result through', async () => {
    const ledger = freshLedger();
    const reply = { data: { summary: 'ok' }, usage: usage(0.05), toolCalls: ['bash'] };
    assert.equal(await recordAgentCall(ledger, meta('librarian-r1-aaaa'), async () => reply), reply);
    const [e] = (await ledger.read()).events;
    assert.equal(e.kind, 'model_call');
    assert.equal(e.kind === 'model_call' && e.cost_usd, 0.05);
    assert.equal(e.kind === 'model_call' && e.run_id, 'r1');
  });

  test('a failed call is recorded as missing cost and the error is rethrown unchanged', async () => {
    const ledger = freshLedger();
    const boom = new Error('model timeout');
    await assert.rejects(recordAgentCall(ledger, meta('librarian-r1-bbbb'), async () => {
      throw boom;
    }), (err) => err === boom);
    const app = createStatsRouter({ ledger, now: () => new Date() });
    const body = await (await app.request('/v1/stats')).json();
    assert.equal(body.periods.today.model.calls, 1);
    assert.equal(body.periods.today.model.calls_missing_cost, 1);
    assert.equal(body.periods.today.model.known_cost_usd, 0);
  });

  test('a client retry is a new execution and counts again', async () => {
    const ledger = freshLedger();
    await recordAgentCall(ledger, meta('librarian-r1-cccc'), async () => ({ usage: usage(0.1) }));
    await recordAgentCall(ledger, meta('librarian-r1-dddd'), async () => ({ usage: usage(0.1) }));
    const body = await (await createStatsRouter({ ledger }).request('/v1/stats')).json();
    assert.equal(body.periods.today.model.known_cost_usd, 0.2);
  });

  test('a broken ledger never fails the pipeline', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const broken = {
        recordModelCall: async () => {
          throw new Error('disk full');
        },
        recordHttpRequest: async () => ({ recorded: false }),
      };
      assert.deepEqual(await recordAgentCall(broken, meta('x'), async () => ({ usage: null })), { usage: null });
    } finally {
      console.error = original;
    }
  });

  test('sharedSpendLedger is one instance per ledger path', () => {
    const prev = process.env.MEMORY_BANK_ACCOUNTING_DIR;
    try {
      process.env.MEMORY_BANK_ACCOUNTING_DIR = path.join(dir, 'shared-a');
      const a = sharedSpendLedger();
      assert.equal(sharedSpendLedger(), a);
      process.env.MEMORY_BANK_ACCOUNTING_DIR = path.join(dir, 'shared-b');
      assert.notEqual(sharedSpendLedger(), a);
    } finally {
      if (prev === undefined) delete process.env.MEMORY_BANK_ACCOUNTING_DIR;
      else process.env.MEMORY_BANK_ACCOUNTING_DIR = prev;
    }
  });
});
