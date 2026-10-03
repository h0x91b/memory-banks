/**
 * Loaded through Vite's module runner by spend-pipeline-e2e.test.ts so the
 * Flue runtime, the faux provider and both pipelines share one module graph
 * (same reason as faux-retriever-harness.ts).
 */
import { start } from '@flue/runtime/node';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Librarian } from '../../.flue/agents/librarian.js';
import { Retriever } from '../../.flue/agents/retriever.js';
import { MODEL } from '../../src/model.js';
import { runLibrarian } from '../../src/librarian.js';
import { runRetriever } from '../../src/retriever.js';
import { sharedSpendLedger } from '../../src/spend-ledger.js';
import { createStatsRouter } from '../../src/stats-router.js';

const slash = MODEL.indexOf('/');
export const faux = fauxProvider({
  provider: MODEL.slice(0, slash),
  models: [{ id: MODEL.slice(slash + 1), reasoning: true }],
});

export { fauxAssistantMessage, fauxToolCall, runLibrarian, runRetriever, sharedSpendLedger, createStatsRouter };

export async function startFlue() {
  return start({ agents: [Librarian, Retriever], providers: [faux.provider] });
}
