/**
 * Loaded through Vite's module runner by ingestion-worker-e2e.test.ts so the
 * Flue runtime, the faux provider, the worker wiring and the legacy route
 * share one module graph (same reason as faux-spend-harness.ts).
 */
import { start } from '@flue/runtime/node';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Librarian } from '../../.flue/agents/librarian.js';
import { Retriever } from '../../.flue/agents/retriever.js';
import { MODEL } from '../../src/model.js';
import { Hono } from 'hono';
import { bankRegistry, ingestionStore, runLibrarianGuarded } from '../../src/guarded-runs.js';
import { createIngestionsRouter } from '../../src/ingestions/index.ts';
import { completedRevisions } from '../../src/bank-mutation.ts';
import { createIngestionWorker } from '../../src/ingestion-worker/runtime.ts';

const slash = MODEL.indexOf('/');
export const faux = fauxProvider({
  provider: MODEL.slice(0, slash),
  models: [{ id: MODEL.slice(slash + 1), reasoning: true }],
});

export {
  bankRegistry,
  completedRevisions,
  createIngestionWorker,
  fauxAssistantMessage,
  fauxToolCall,
  ingestionStore,
  runLibrarianGuarded,
};

/** The real /v1 intake router over the shared store, for tests that go through HTTP. */
export function ingestionApp(): Hono {
  return new Hono().route('/v1', createIngestionsRouter(ingestionStore, bankRegistry));
}

export async function startFlue() {
  return start({ agents: [Librarian, Retriever], providers: [faux.provider] });
}
