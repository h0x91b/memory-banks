import { start } from '@flue/runtime/node';
import { Librarian } from '../.flue/agents/librarian.js';
import { Retriever } from '../.flue/agents/retriever.js';
import { runLibrarian } from './librarian.js';
import { runRetriever } from './retriever.js';

/** Boot an in-process Flue runtime (in-memory state) and run one pipeline. */
export async function runCli(name: 'librarian' | 'retriever', payload: unknown, runId: string) {
  const flue = await start({ agents: [Librarian, Retriever] });
  try {
    return name === 'librarian' ? await runLibrarian(payload as any, runId) : await runRetriever(payload as any, runId);
  } finally {
    await flue.stop();
  }
}
