/**
 * Lightweight stderr logger used to surface agent activity (bash, read, write,
 * edit, grep, glob calls, plus high-level milestones) live in the dev server
 * console. Flue's `log.info()` events go through its internal event stream and
 * don't hit stdout/stderr; this is what makes runs visible during development.
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

// Default to ANSI colors. Subprocess stderr usually isn't a TTY, but tmux /
// modern terminals render ANSI fine over pipes. Honour standard opt-outs.
const USE_COLOR = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

type Color = keyof typeof COLORS;

/**
 * Emit a single stderr log line. When `bank` is provided, it's rendered as a
 * dim `[bank-name]` prefix between the timestamp and the tag so the operator
 * can tell at a glance which memory bank an event belongs to. For startup /
 * one-off events that aren't tied to a specific bank (e.g. provider pin log
 * at module load), omit `bank`.
 */
export function logLine(tag: string, message: string, color: Color = 'cyan', bank?: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  const open = USE_COLOR ? COLORS[color] : '';
  const close = USE_COLOR ? COLORS.reset : '';
  const dim = USE_COLOR ? COLORS.gray : '';
  const bankPart = bank ? `${dim}[${bank}]${close} ` : '';
  process.stderr.write(`${dim}${ts}${close} ${bankPart}${open}${tag.padEnd(14)}${close} ${message}\n`);
}

/**
 * Convenience: returns a `logLine`-compatible function that always carries the
 * given bank name. Use this inside agent entry points so every call site stays
 * short — `log('librarian', '...', 'blue')` instead of repeating the bank
 * argument.
 */
export function bankLogger(bank: string): (tag: string, message: string, color?: Color) => void {
  return (tag, message, color) => logLine(tag, message, color ?? 'cyan', bank);
}

export function preview(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + '…';
}
