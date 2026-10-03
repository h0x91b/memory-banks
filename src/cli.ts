import { start } from '@flue/runtime/node';
import { Curator } from '../.flue/agents/curator.js';
import { Retriever } from '../.flue/agents/retriever.js';
import { runCurator } from './curator.js';
import { runRetriever } from './retriever.js';

/** Boot an in-process Flue runtime (in-memory state) and run one pipeline. */
export async function runCli(name: 'curator' | 'retriever', payload: unknown, runId: string) {
  const flue = await start({ agents: [Curator, Retriever] });
  try {
    return name === 'curator' ? await runCurator(payload as any, runId) : await runRetriever(payload as any, runId);
  } finally {
    await flue.stop();
  }
}
