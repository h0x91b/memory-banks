// Librarian gate in `submit_result`, contract §9 (docs/design/bank-format.md).
// The baseline is taken by the host before the agent starts; the gate runs the
// validator on every submit and decides whether the result may be recorded.
import { MAX_REJECTIONS, REJECTION_LIST_MAX, type Violation } from './bank-format/index.ts';
import { compareWithBaseline, validateBank, type ComparedViolation } from './bank-validator/index.ts';

export type ValidationStatus = 'passed' | 'accepted-with-violations' | 'validator-error';

/** What the gate passes to the agent: the baseline, or why it could not be taken. */
export type GateBaseline = { violations: Violation[] } | { error: string };

/** Additive `meta.validation` of the Librarian response (§9 step 7). */
export interface ValidationMeta {
  status: ValidationStatus;
  violations: ComparedViolation[];
}

/** Gate outcome recorded with the accepted result; `error` and `rejections` are for the run log only. */
export interface GateOutcome extends ValidationMeta {
  rejections: number;
  error?: string;
}

export type GateDecision = { accept: true; outcome: GateOutcome } | { accept: false; message: string };

/** Baseline per §8.2: validate the bank as it is before the Librarian starts. Never throws. */
export async function takeBaseline(fsPath: string): Promise<GateBaseline> {
  try {
    return { violations: (await validateBank(fsPath)).violations };
  } catch (err) {
    return { error: errorText(err) };
  }
}

export type SubmitGate = ReturnType<typeof createSubmitGate>;

/**
 * Live gates by id. Flue re-runs the agent function on every turn, so state
 * kept in its closure resets between submits; the host owns the gate for the
 * whole run instead and the agent finds it by the id in its initialData.
 */
const gates = new Map<string, SubmitGate>();

export function registerGate(id: string, gate: SubmitGate): void {
  gates.set(id, gate);
}

export function findGate(id: string): SubmitGate | undefined {
  return gates.get(id);
}

export function releaseGate(id: string): void {
  gates.delete(id);
}

/**
 * One gate per agent run. `check()` is called on every `submit_result`: it
 * accepts when no new errors exist, rejects up to `MAX_REJECTIONS` times, then
 * accepts with violations. A validator crash (now or at baseline) accepts with
 * `validator-error` so a validator bug never traps the agent in a loop.
 */
export function createSubmitGate(fsPath: string, baseline: GateBaseline, validate = validateBank) {
  let rejections = 0;
  let accepted: GateOutcome | null = null;
  return {
    /** Outcome of the last accepted submit; `null` while nothing was accepted. */
    outcome: () => accepted,
    async check(): Promise<GateDecision> {
      const accept = (outcome: Omit<GateOutcome, 'rejections'>): GateDecision => {
        accepted = { ...outcome, rejections };
        return { accept: true, outcome: accepted };
      };
      if ('error' in baseline) {
        return accept({ status: 'validator-error', violations: [], error: `baseline: ${baseline.error}` });
      }
      let current: Violation[];
      try {
        current = (await validate(fsPath)).violations;
      } catch (err) {
        return accept({ status: 'validator-error', violations: [], error: errorText(err) });
      }
      const { violations, blocking } = compareWithBaseline(current, baseline.violations);
      if (blocking.length === 0) return accept({ status: 'passed', violations });
      if (rejections >= MAX_REJECTIONS) return accept({ status: 'accepted-with-violations', violations });
      rejections++;
      return { accept: false, message: rejectionMessage(blocking, rejections) };
    },
  };
}

/** Tool error text shown to the model (§9 step 4). */
export function rejectionMessage(blocking: readonly Violation[], rejection: number): string {
  const n = blocking.length;
  const lines = [
    `Bank validation failed (rejection ${rejection} of ${MAX_REJECTIONS}): ${n} new violation${n === 1 ? '' : 's'}.`,
  ];
  for (const v of blocking.slice(0, REJECTION_LIST_MAX)) lines.push(`- [${v.code}] ${v.message}`);
  if (n > REJECTION_LIST_MAX) lines.push(`…and ${n - REJECTION_LIST_MAX} more`);
  lines.push(
    rejection >= MAX_REJECTIONS
      ? 'The next submit_result will be accepted even with violations; fix what you can.'
      : 'Fix these and call submit_result again.',
  );
  return lines.join('\n');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
