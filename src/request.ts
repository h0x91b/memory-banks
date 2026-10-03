import { randomUUID } from 'node:crypto';
import type { PromptUsage } from '@flue/runtime';
import { MODEL } from './model.js';

/** A caller error (bad payload): the HTTP route maps it to 400. */
export class RequestError extends Error {
  readonly status = 400;
}

/**
 * Every request runs in a fresh agent instance. Flue persists conversations by
 * instance id, so reusing the caller's run id (e.g. "test-1") would otherwise
 * continue the previous conversation and carry its history into this run.
 */
export function freshInstanceId(agent: string, runId: string): string {
  return `${agent}-${runId}-${randomUUID().slice(0, 8)}`;
}

/** Model id as reported in `meta.model` (provider prefix stripped, as before). */
export const MODEL_ID = MODEL.slice(MODEL.indexOf('/') + 1);

export function tokensMeta(usage: PromptUsage | null) {
  if (!usage) return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens,
  };
}

export function costMeta(usage: PromptUsage | null) {
  if (!usage) return null;
  return { ...usage.cost };
}
