import { createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { setProvider } from '@flue/runtime';

/**
 * Register the `openrouter` provider with its full built-in catalog plus a
 * hand-declared GPT-6 Luna record.
 *
 * Flue 2.1.0 bundles @earendil-works/pi-ai 0.83, whose OpenRouter catalog
 * predates GPT-6 Luna, so `openrouter/openai/gpt-6-luna` would fail with
 * "Unknown model ID". Declaring the model with explicit metadata makes it
 * resolve with reasoning enabled (so `thinkingLevel: 'xhigh'` reaches the wire
 * as `reasoning.effort: "xhigh"`) and real per-token pricing for cost reports.
 *
 * The metadata mirrors the `openai/gpt-6-luna` record in the OpenRouter
 * catalog of pi-ai 0.87.1 (first release that ships it). Drop this module once
 * the project runs a Flue release built on pi-ai >= 0.87.1.
 *
 * Registration order is safe either way: Flue skips its built-in `openrouter`
 * registration when the ID already exists, and `setProvider` replaces a
 * built-in registered earlier.
 */
const builtin = openrouterProvider();
const template = builtin.getModels().find((model) => model.id === 'openai/gpt-5.6-luna');
if (!template) {
  throw new Error('[openrouter-provider] catalog template openai/gpt-5.6-luna not found');
}

const gpt6Luna: Model<'openai-completions'> = {
  ...template,
  id: 'openai/gpt-6-luna',
  name: 'OpenAI: GPT-6 Luna',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  thinkingLevelMap: {
    off: 'none',
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  },
};

setProvider(
  createProvider({
    id: builtin.id,
    name: builtin.name,
    baseUrl: builtin.baseUrl,
    auth: builtin.auth,
    models: [...builtin.getModels().filter((model) => model.id !== gpt6Luna.id), gpt6Luna],
    api: openAICompletionsApi(),
  }),
);
