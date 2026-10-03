// Lifecycle guard around the existing /agents/* runs: a run on an archiving or
// archived bank is refused before it touches the bank, and an admitted run
// holds an operation lease, so archive waits for it to finish.
//
// The agent pipelines themselves stay unaware of lifecycle; this wraps them.

import { isValidBankId, type BankLifecycleGuard, type OperationKind } from './registry.ts';

export interface GuardedRunOptions {
  kind: OperationKind;
  /**
   * Called when the bank does not exist yet. Agents that auto-create banks
   * (the librarian) scaffold here, so the new bank is admitted like any other.
   * Without it a missing bank is passed straight to `run`, which owns that case.
   */
  createIfMissing?: (bank: string) => Promise<void>;
}

export async function runGuarded<T>(
  guard: BankLifecycleGuard,
  rawBank: unknown,
  options: GuardedRunOptions,
  run: () => Promise<T>,
): Promise<T> {
  const bank = typeof rawBank === 'string' ? rawBank.trim() : rawBank;
  // Invalid or absent ids: the pipeline's own validation answers with 400.
  if (!isValidBankId(bank)) return run();

  if ((await guard.lookup(bank)) === 'missing') {
    if (!options.createIfMissing) return run();
    await options.createIfMissing(bank);
  }

  const lease = await guard.beginOperation(bank, options.kind);
  try {
    return await run();
  } finally {
    await lease.release();
  }
}
