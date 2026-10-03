import type { HttpRequestEvent, LedgerEvent, ModelCallEvent, TokenCounts } from './spend-ledger.ts';
import { WEEK_START, computePeriods, type Period } from './stats-periods.ts';

/**
 * Pure aggregation of ledger events into today / week / month totals. Money is
 * summed in integer nano-dollars so many tiny per-call costs do not drift.
 */

const NANO = 1e9;
const toNano = (usd: number) => Math.round(usd * NANO);
const fromNano = (nano: number) => nano / NANO;

export interface ModelTotals {
  calls: number;
  /** Sum of costs the provider reported as billed. */
  reported_cost_usd: number;
  /** Sum of costs computed from declared per-token rates — an estimate, not an invoice. */
  estimated_cost_usd: number;
  /** reported + estimated. Excludes calls whose cost is unknown. */
  known_cost_usd: number;
  calls_with_reported_cost: number;
  calls_with_estimated_cost: number;
  /** Calls with no usable cost. Their spend is unknown, not zero. */
  calls_missing_cost: number;
  /** Token sums over calls that returned usage. */
  tokens: TokenCounts;
  calls_missing_usage: number;
}

export interface HttpTotals {
  requests: number;
  by_status_class: { '2xx': number; '3xx': number; '4xx': number; '5xx': number; other: number };
  duration_ms: { total: number; avg: number | null; max: number | null };
}

export interface PeriodTotals {
  start: string;
  end: string;
  model: ModelTotals & { by_agent: Record<string, ModelTotals> };
  http: HttpTotals;
}

export interface StatsReport {
  currency: 'USD';
  timezone: string;
  week_starts_on: typeof WEEK_START;
  generated_at: string;
  coverage: {
    /** First recorded event in scope; nothing before it is known. Null when nothing was recorded. */
    accounting_since: string | null;
    /** First event in the whole ledger (all banks). Spend before it was never recorded. */
    ledger_since: string | null;
    cost_basis: string;
    skipped_ledger_lines: number;
  };
  periods: { today: PeriodTotals; week: PeriodTotals; month: PeriodTotals };
}

interface ModelAcc {
  calls: number;
  reportedNano: number;
  estimatedNano: number;
  reported: number;
  estimated: number;
  missing: number;
  missingUsage: number;
  tokens: TokenCounts;
}

const emptyTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const emptyModelAcc = (): ModelAcc => ({
  calls: 0,
  reportedNano: 0,
  estimatedNano: 0,
  reported: 0,
  estimated: 0,
  missing: 0,
  missingUsage: 0,
  tokens: emptyTokens(),
});

function addModel(acc: ModelAcc, e: ModelCallEvent): void {
  acc.calls += 1;
  if (e.cost_source === 'reported' && e.cost_usd != null) {
    acc.reported += 1;
    acc.reportedNano += toNano(e.cost_usd);
  } else if (e.cost_source === 'estimated' && e.cost_usd != null) {
    acc.estimated += 1;
    acc.estimatedNano += toNano(e.cost_usd);
  } else {
    acc.missing += 1;
  }
  if (e.tokens) {
    for (const k of Object.keys(acc.tokens) as Array<keyof TokenCounts>) acc.tokens[k] += e.tokens[k] ?? 0;
  } else {
    acc.missingUsage += 1;
  }
}

function finishModel(acc: ModelAcc): ModelTotals {
  return {
    calls: acc.calls,
    reported_cost_usd: fromNano(acc.reportedNano),
    estimated_cost_usd: fromNano(acc.estimatedNano),
    known_cost_usd: fromNano(acc.reportedNano + acc.estimatedNano),
    calls_with_reported_cost: acc.reported,
    calls_with_estimated_cost: acc.estimated,
    calls_missing_cost: acc.missing,
    tokens: acc.tokens,
    calls_missing_usage: acc.missingUsage,
  };
}

function totalsFor(events: LedgerEvent[], p: Period): PeriodTotals {
  const start = p.start.getTime();
  const end = p.end.getTime();
  const all = emptyModelAcc();
  const byAgent = new Map<string, ModelAcc>();
  const http: HttpTotals = {
    requests: 0,
    by_status_class: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
    duration_ms: { total: 0, avg: null, max: null },
  };
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (t < start || t >= end) continue;
    if (e.kind === 'model_call') {
      addModel(all, e);
      let acc = byAgent.get(e.agent);
      if (!acc) byAgent.set(e.agent, (acc = emptyModelAcc()));
      addModel(acc, e);
    } else {
      addHttp(http, e);
    }
  }
  if (http.requests > 0) http.duration_ms.avg = Math.round(http.duration_ms.total / http.requests);
  const by_agent: Record<string, ModelTotals> = {};
  for (const [agent, acc] of [...byAgent].sort(([a], [b]) => a.localeCompare(b))) by_agent[agent] = finishModel(acc);
  return { start: p.start.toISOString(), end: p.end.toISOString(), model: { ...finishModel(all), by_agent }, http };
}

function addHttp(http: HttpTotals, e: HttpRequestEvent): void {
  http.requests += 1;
  const cls = Math.floor(e.status / 100);
  const key = cls >= 2 && cls <= 5 ? (`${cls}xx` as '2xx' | '3xx' | '4xx' | '5xx') : 'other';
  http.by_status_class[key] += 1;
  http.duration_ms.total += e.duration_ms;
  http.duration_ms.max = Math.max(http.duration_ms.max ?? 0, e.duration_ms);
}

export const COST_BASIS =
  'estimated_cost_usd is computed from the model\'s declared per-token rates on the returned token usage; it is not an OpenRouter invoice. reported_cost_usd is only non-zero for calls whose provider returned a billed amount.';

export interface BuildStatsOptions {
  /** Limit to one bank; omitted = every bank, including archived ones. */
  bank?: string;
  timezone: string;
  now: Date;
  skippedLines?: number;
}

export function buildStats(allEvents: LedgerEvent[], opts: BuildStatsOptions): StatsReport {
  const ledgerSince = earliest(allEvents);
  const events = opts.bank === undefined ? allEvents : allEvents.filter((e) => e.bank === opts.bank);
  const periods = computePeriods(opts.now, opts.timezone);
  return {
    currency: 'USD',
    timezone: opts.timezone,
    week_starts_on: WEEK_START,
    generated_at: opts.now.toISOString(),
    coverage: {
      accounting_since: earliest(events),
      ledger_since: ledgerSince,
      cost_basis: COST_BASIS,
      skipped_ledger_lines: opts.skippedLines ?? 0,
    },
    periods: {
      today: totalsFor(events, periods.today),
      week: totalsFor(events, periods.week),
      month: totalsFor(events, periods.month),
    },
  };
}

function earliest(events: LedgerEvent[]): string | null {
  let min = Infinity;
  for (const e of events) min = Math.min(min, Date.parse(e.ts));
  return Number.isFinite(min) ? new Date(min).toISOString() : null;
}
