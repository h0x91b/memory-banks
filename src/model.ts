import type { ThinkingLevel } from '@flue/runtime';
import './openrouter-provider.js';

/**
 * Model used by both agents. GPT-6 Luna is not in the catalog bundled with
 * Flue 2.1.0, so `./openrouter-provider.js` declares it on the `openrouter`
 * provider with explicit metadata (reasoning, `xhigh` mapping, pricing).
 * Importing this module performs that registration.
 */
export const MODEL = 'openrouter/openai/gpt-6-luna';

/** Reasoning effort per agent: the librarian rewrites the bank, the retriever only reads it. */
export const LIBRARIAN_THINKING_LEVEL: ThinkingLevel = 'xhigh';
export const RETRIEVER_THINKING_LEVEL: ThinkingLevel = 'medium';
