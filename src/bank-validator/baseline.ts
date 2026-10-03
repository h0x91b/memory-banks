// New vs pre-existing violations (contract §8.1–§8.2). Pure: works on
// violation lists, so a gate can keep the baseline in memory between calls.
import { nfc, type Violation } from '../bank-format/index.ts';

/** Identity key per §8.1: `code \0 NFC(path) \0 detail`. Message, value and severity are not part of it. */
export function violationKey(v: Violation): string {
  return `${v.code}\0${nfc(v.path)}\0${v.detail ?? ''}`;
}

export type ComparedViolation = Violation & { new: boolean };

export interface BaselineComparison {
  /** Every current violation, same order, each marked `new` per §8.2. */
  violations: ComparedViolation[];
  /** New errors only: what a gate rejects on. New warnings never block. */
  blocking: ComparedViolation[];
}

/**
 * Marks each current violation as new or pre-existing. New when its identity
 * key is absent from the baseline, or when it has a `value` greater than the
 * largest baseline value for the same key ("not worse than before"). Keys are
 * counted as a multiset: a key seen twice now and once before has one new
 * occurrence (the later one, in list order).
 */
export function compareWithBaseline(current: readonly Violation[], baseline: readonly Violation[]): BaselineComparison {
  const before = new Map<string, { count: number; maxValue: number | undefined }>();
  for (const v of baseline) {
    const key = violationKey(v);
    const entry = before.get(key) ?? { count: 0, maxValue: undefined };
    entry.count++;
    if (v.value !== undefined) entry.maxValue = Math.max(entry.maxValue ?? -Infinity, v.value);
    before.set(key, entry);
  }

  const seen = new Map<string, number>();
  const violations = current.map((v): ComparedViolation => {
    const key = violationKey(v);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const base = before.get(key);
    const worse = v.value !== undefined && base?.maxValue !== undefined && v.value > base.maxValue;
    return { ...v, new: base === undefined || occurrence > base.count || worse };
  });
  return { violations, blocking: violations.filter((v) => v.new && v.severity === 'error') };
}
