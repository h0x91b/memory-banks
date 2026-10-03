/**
 * Calendar period boundaries (today / this week / this month) in an IANA
 * timezone, returned as UTC instants. Events are stored in UTC; only the
 * boundaries are computed in the requested zone, so DST shifts move the
 * boundaries (a day can be 23 or 25 hours long) without touching the data.
 *
 * Weeks start on Monday (ISO calendar week). This is the working default for
 * the stats API, not a user-confirmed product decision.
 */

export const DEFAULT_TIMEZONE = 'Asia/Jerusalem';
export const WEEK_START = 'monday';

export interface Period {
  /** Inclusive start, UTC. */
  start: Date;
  /** Exclusive end, UTC. */
  end: Date;
}

export interface Periods {
  today: Period;
  week: Period;
  month: Period;
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Canonical IANA name for `timeZone`, or null when the runtime does not know
 * it. Fixed offsets like "+02:00" are rejected: they have no DST rules, which
 * is exactly what a calendar-period API should not silently ignore.
 */
export function normalizeTimezone(timeZone: string): string | null {
  if (!timeZone || /^[+-]\d/.test(timeZone)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function localDateOf(instant: number, timeZone: string): LocalDate {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function dayNumber(d: LocalDate): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
}

function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/**
 * First UTC instant whose local calendar date in `timeZone` is `date` or later,
 * i.e. the start of that local day. Usually local midnight; in zones whose DST
 * jump skips midnight it is the first wall-clock time that exists that day.
 * Binary search over a ±2 day window around the naive UTC midnight; every real
 * UTC offset is well inside ±26h.
 */
function startOfLocalDay(date: LocalDate, timeZone: string): number {
  const target = dayNumber(date);
  let lo = Date.UTC(date.year, date.month - 1, date.day) - 2 * 86_400_000;
  let hi = lo + 4 * 86_400_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayNumber(localDateOf(mid, timeZone)) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function period(from: LocalDate, to: LocalDate, timeZone: string): Period {
  return { start: new Date(startOfLocalDay(from, timeZone)), end: new Date(startOfLocalDay(to, timeZone)) };
}

/** Today, the current Monday-based week and the current calendar month around `now` in `timeZone`. */
export function computePeriods(now: Date, timeZone: string): Periods {
  const today = localDateOf(now.getTime(), timeZone);
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay(); // 0 = Sunday
  const monday = addDays(today, -((weekday + 6) % 7));
  const firstOfMonth: LocalDate = { year: today.year, month: today.month, day: 1 };
  const firstOfNextMonth: LocalDate =
    today.month === 12 ? { year: today.year + 1, month: 1, day: 1 } : { year: today.year, month: today.month + 1, day: 1 };
  return {
    today: period(today, addDays(today, 1), timeZone),
    week: period(monday, addDays(monday, 7), timeZone),
    month: period(firstOfMonth, firstOfNextMonth, timeZone),
  };
}
