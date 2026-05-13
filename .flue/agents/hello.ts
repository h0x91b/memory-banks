import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

// Model: openrouter/deepseek/deepseek-v4-flash routed through NovitaAI.
// OpenRouter provider routing is normally set via the request-body `provider`
// field (e.g. `{ order: ['novita'], allow_fallbacks: false }`). Flue's
// configureProvider() only exposes baseUrl/headers/apiKey today, so the
// simplest reliable way to pin Novita is to set provider preferences for this
// model in your OpenRouter account. See https://openrouter.ai/docs#provider-routing
export default async function ({ init, payload }: FlueContext) {
  const harness = await init({ model: 'openrouter/deepseek/deepseek-v4-flash' });
  const session = await harness.session();

  const response = await session.prompt(
    `Say hello to ${payload.name ?? 'stranger'} in one short sentence.`,
    {
      schema: v.object({
        greeting: v.string(),
        mood: v.picklist(['friendly', 'formal', 'silly']),
      }),
    },
  );

  return {
    ...response.data,
    meta: {
      model: response.model.id,
      tokens: {
        input: response.usage.input,
        output: response.usage.output,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        total: response.usage.totalTokens,
      },
      cost: {
        input: response.usage.cost.input,
        output: response.usage.cost.output,
        cacheRead: response.usage.cost.cacheRead,
        cacheWrite: response.usage.cost.cacheWrite,
        total: response.usage.cost.total,
        totalUsd: formatUsd(response.usage.cost.total),
      },
    },
  };
}

function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount < 0.0001) return `$${amount.toExponential(2)}`;
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  return `$${amount.toFixed(4)}`;
}
