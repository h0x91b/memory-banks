/**
 * Monkey-patch global fetch so every request to openrouter.ai carries a
 * `provider` routing preference. Flue's `configureProvider()` only exposes
 * baseUrl/headers/apiKey, so OR's `provider` field has no first-class path
 * through pi-ai. This is the local workaround.
 *
 * Why: OpenRouter load-balances across upstream providers per request. For
 * deepseek-v4-flash that means our calls bounce between Novita, AtlasCloud,
 * SiliconFlow, Parasail, Alibaba, etc. — and each provider has its own KV
 * cache, so prompt-cache hits are essentially random. Pinning an order with
 * fallbacks lets us land on cache-capable providers consistently while still
 * recovering on outages.
 *
 * Behaviour: idempotent. Call once at module load (or before first init).
 * Only requests to openrouter.ai are touched; everything else passes through.
 */

import { logLine } from './console-log.js';

let installed = false;

export interface PinOptions {
  /** Ordered preferred providers (OR routing). First-listed is tried first. */
  order: string[];
  /** Allow OR to fall back to other providers when the preferred ones fail. */
  allowFallbacks: boolean;
}

export function pinOpenRouterProviders(opts: PinOptions): void {
  if (installed) return;
  installed = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function pinnedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : '';
    if (url.includes('openrouter.ai') && init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (typeof body === 'object' && body !== null && !body.provider) {
          body.provider = { order: opts.order, allow_fallbacks: opts.allowFallbacks };
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // body wasn't JSON — leave it alone
      }
    }
    return originalFetch(input, init);
  };

  logLine(
    'openrouter',
    `pinned providers: order=[${opts.order.join(', ')}] allow_fallbacks=${opts.allowFallbacks}`,
    'magenta',
  );
}
