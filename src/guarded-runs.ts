// The one entry point for running an agent pipeline against a bank. Both the
// HTTP routes (.flue/app.ts) and the CLI (src/cli.ts) go through here, so
// neither can run on an archiving/archived bank and archive waits for runs
// already admitted. See src/banks/agent-guard.ts.
import { ensureBank } from './bank.js';
import { BankRegistry, runGuarded } from './banks/index.ts';
import { gitEnsureRepo } from './git.js';
import { runLibrarian, type LibrarianPayload } from './librarian.js';
import { runRetriever, type RetrieverPayload } from './retriever.js';

export const bankRegistry = new BankRegistry();

/** The librarian creates a missing bank, exactly as runLibrarian would. */
async function scaffoldBank(bank: string): Promise<void> {
  const { repoPath } = await ensureBank(bank);
  await gitEnsureRepo(repoPath);
}

export function runLibrarianGuarded(payload: LibrarianPayload | undefined, runId: string) {
  return runGuarded(bankRegistry, payload?.bank, { kind: 'curate', createIfMissing: scaffoldBank }, () =>
    runLibrarian(payload, runId),
  );
}

export function runRetrieverGuarded(payload: RetrieverPayload | undefined, runId: string) {
  return runGuarded(bankRegistry, payload?.bank, { kind: 'query' }, () => runRetriever(payload, runId));
}
