#!/usr/bin/env node
/**
 * Verify the "wrap global fetch and inject `provider` for openrouter.ai" trick.
 * If this works in isolation, we can apply it in agent entry points before
 * Flue's pi-ai HTTP call goes out.
 */
import fs from 'node:fs';
import path from 'node:path';
const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"\n]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const KEY = process.env.OPENROUTER_API_KEY;

const originalFetch = globalThis.fetch;
globalThis.fetch = async function pinnedFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (url.includes('openrouter.ai') && init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      body.provider = { only: ['Novita'], allow_fallbacks: false };
      init = { ...init, body: JSON.stringify(body) };
      console.log(`  [fetch-wrap] injected provider.only=['Novita'] into ${url}`);
    } catch {
      // not JSON, pass through
    }
  }
  return originalFetch(input, init);
};

const lorem = 'The quick brown fox jumps over the lazy dog. '.repeat(800);
async function call(label) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'Probe.\n\n' + lorem },
        { role: 'user', content: `Say ${label}` },
      ],
      max_tokens: 20, temperature: 0,
      usage: { include: true },
    }),
  });
  const j = await res.json();
  if (!res.ok) { console.log(`${label} HTTP ${res.status}: ${JSON.stringify(j).slice(0,200)}`); return; }
  const u = j.usage || {};
  const ptd = u.prompt_tokens_details || {};
  console.log(`${label} provider=${j.provider} cached=${ptd.cached_tokens ?? 0} cost=$${u.cost ?? 0}`);
}
await call('#1'); await new Promise(r=>setTimeout(r,2500));
await call('#2'); await new Promise(r=>setTimeout(r,2500));
await call('#3'); await new Promise(r=>setTimeout(r,2500));
await call('#4');
