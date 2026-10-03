import type { ThinkingLevel } from '@flue/runtime';

/**
 * Model used by both agents. GPT-5.6 Luna is in the OpenRouter catalog shipped
 * with @earendil-works/pi-ai 0.83 (the version @flue/runtime 2.1.0 pins), so it
 * resolves with real metadata: reasoning enabled, `xhigh` mapped to OpenRouter's
 * `xhigh` effort, and per-token pricing for cost reporting.
 */
export const MODEL = 'openrouter/openai/gpt-5.6-luna';
export const THINKING_LEVEL: ThinkingLevel = 'xhigh';
