import { start } from '@flue/runtime/node';
import { Librarian } from '../.flue/agents/librarian.js';
import { Retriever } from '../.flue/agents/retriever.js';
import { runLibrarianGuarded, runRetrieverGuarded } from './guarded-runs.js';

/** Boot an in-process Flue runtime (in-memory state) and run one pipeline. */
export async function runCli(name: 'librarian' | 'retriever', payload: unknown, runId: string) {
  const flue = await start({ agents: [Librarian, Retriever] });
  try {
    return name === 'librarian'
      ? await runLibrarianGuarded(payload as any, runId)
      : await runRetrieverGuarded(payload as any, runId);
  } finally {
    await flue.stop();
  }
}
