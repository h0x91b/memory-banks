// The one entry point for running an agent pipeline against a bank. Both the
// HTTP routes (.flue/app.ts) and the CLI (src/cli.ts) go through here, so
// neither can run on an archiving/archived bank and archive waits for runs
// already admitted. See src/banks/agent-guard.ts.
//
// Librarian runs additionally hold the bank mutation lock (src/bank-mutation.ts),
// the same one the ingestion worker takes, so a direct call and a queued batch
// never write the same bank at once; a successful run records the bank's
// completed revision.
import { BANK_NAME_RE, ensureBank } from './bank.js';
import { withBankMutation } from './bank-mutation.ts';
import { BankRegistry, runGuarded } from './banks/index.ts';
import { gitEnsureRepo } from './git.js';
import { IngestionStore } from './ingestions/index.ts';
import { runLibrarian, type LibrarianPayload } from './librarian.js';
import { runRetriever, type RetrieverPayload } from './retriever.js';

export const bankRegistry = new BankRegistry();

/** Durable intake queue; its accepted work holds archiving through bankRegistry. */
export const ingestionStore = new IngestionStore(bankRegistry);

/** The librarian creates a missing bank, exactly as runLibrarian would. */
async function scaffoldBank(bank: string): Promise<void> {
  const { repoPath } = await ensureBank(bank);
  await gitEnsureRepo(repoPath);
}

export function runLibrarianGuarded(payload: LibrarianPayload | undefined, runId: string) {
  return runGuarded(bankRegistry, payload?.bank, { kind: 'curate', createIfMissing: scaffoldBank }, () =>
    runLibrarianExclusive(payload, runId),
  );
}

/** One Librarian writer per bank; a successful run becomes the completed revision. */
async function runLibrarianExclusive(payload: LibrarianPayload | undefined, runId: string) {
  const bank = typeof payload?.bank === 'string' ? payload.bank.trim() : '';
  // Invalid ids never reach the bank: the pipeline's own validation answers 400.
  if (!BANK_NAME_RE.test(bank)) return runLibrarian(payload, runId);
  return withBankMutation(bank, async (mutation) => {
    const result = await runLibrarian(payload, runId);
    await mutation.markCompleted({ by: 'legacy', runId });
    return result;
  });
}

export function runRetrieverGuarded(payload: RetrieverPayload | undefined, runId: string) {
  return runGuarded(bankRegistry, payload?.bank, { kind: 'query' }, () => runRetriever(payload, runId));
}
