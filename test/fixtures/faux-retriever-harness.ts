/**
 * Loaded through Vite's module runner by retriever-telemetry-e2e.test.ts so
 * that the Flue runtime, the faux provider and the pipeline share one module
 * graph (a bare-specifier import from the test file itself would resolve a
 * second, unconfigured copy of @flue/runtime).
 */
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Curator } from '../../.flue/agents/curator.js';
import { Retriever, RetrieverResultSchema } from '../../.flue/agents/retriever.js';
import { MODEL } from '../../src/model.js';
import { runRetriever } from '../../src/retriever.js';
import { readStructuredReply } from '../../src/structured-result.js';

const slash = MODEL.indexOf('/');
export const faux = fauxProvider({
  provider: MODEL.slice(0, slash),
  models: [{ id: MODEL.slice(slash + 1), reasoning: true }],
});

export { fauxAssistantMessage, fauxToolCall, runRetriever };

export async function startFlue() {
  return start({ agents: [Curator, Retriever], providers: [faux.provider] });
}

/** Run the bare agent with a given briefing — no telemetry subscriber. */
export async function runBaseline(briefing: string, bank: string, fsPath: string) {
  const agent = init(Retriever, { id: `retriever-baseline-${Date.now()}` });
  const receipt = await agent.dispatch({ message: { kind: 'user', body: briefing }, initialData: { bank, fsPath } });
  return readStructuredReply(await agent.read(receipt), RetrieverResultSchema);
}
