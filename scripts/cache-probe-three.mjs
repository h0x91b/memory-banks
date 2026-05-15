#!/usr/bin/env node
/**
 * Pin all three caching providers via provider.only.
 * Goal: across N calls, see how often we get a cache hit vs cold start,
 * and which provider is picked.
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
const lorem = 'The quick brown fox jumps over the lazy dog. '.repeat(800);
const SHARED_SYSTEM = 'You are a synthetic prompt-cache probe. Be terse.\n\n' + lorem;

async function call(label) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [
        { role: 'system', content: SHARED_SYSTEM },
        { role: 'user', content: `Say ${label}` },
      ],
      max_tokens: 20, temperature: 0,
      usage: { include: true },
      provider: {
        only: ['Novita', 'AtlasCloud', 'SiliconFlow'],
        allow_fallbacks: false,
      },
    }),
  });
  const j = await res.json();
  if (!res.ok) { console.log(`${label} HTTP ${res.status}: ${JSON.stringify(j).slice(0,200)}`); return null; }
  const u = j.usage || {};
  const ptd = u.prompt_tokens_details || {};
  const provider = j.provider || '?';
  const cached = ptd.cached_tokens ?? 0;
  const cost = u.cost ?? 0;
  console.log(`${label.padEnd(6)} provider=${String(provider).padEnd(13)} prompt=${u.prompt_tokens} cached=${String(cached).padEnd(5)} cost=$${cost.toFixed(6)} ${cached>0 ? '✓ HIT' : '∅ miss'}`);
  return { provider, cached, cost };
}

const N = 8;
const results = [];
for (let i = 1; i <= N; i++) {
  const r = await call(`#${i}`);
  if (r) results.push(r);
  await new Promise(rs => setTimeout(rs, 3000));
}

console.log('\n=== summary ===');
const totalCost = results.reduce((s, r) => s + r.cost, 0);
const hits = results.filter(r => r.cached > 0).length;
const providers = {};
for (const r of results) providers[r.provider] = (providers[r.provider] || 0) + 1;
console.log(`calls: ${results.length}`);
console.log(`cache hits: ${hits} / ${results.length} (${Math.round(hits*100/results.length)}%)`);
console.log(`total cost: $${totalCost.toFixed(5)}`);
console.log(`avg cost/call: $${(totalCost/results.length).toFixed(5)}`);
console.log(`providers picked:`, providers);
