#!/usr/bin/env node
/**
 * Synthetic cache probe. Hits OpenRouter directly with a large shared prefix
 * twice and compares `usage` fields. If prompt caching works, the second call
 * should show non-trivial cached_tokens / cache_read in the response.
 *
 * Run:  node scripts/cache-probe.mjs
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

const KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_FLUE;
if (!KEY) { console.error('No OPENROUTER_API_KEY'); process.exit(1); }

const MODEL = process.argv[2] || 'deepseek/deepseek-v4-flash';

// Build a deterministic large shared prefix (~5-6K tokens) so we can see if it
// gets cached on the second call.
const lorem = (
  'The quick brown fox jumps over the lazy dog. ' +
  'Sphinx of black quartz, judge my vow. ' +
  'Pack my box with five dozen liquor jugs. '
).repeat(400);

const SHARED_SYSTEM =
  'You are a synthetic prompt-cache probe. Be terse.\n\n' +
  'Reference text (do NOT summarise unless asked):\n' + lorem;

async function call(idx, userText) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SHARED_SYSTEM },
      { role: 'user', content: userText },
    ],
    max_tokens: 40,
    temperature: 0,
    usage: { include: true }, // OpenRouter: ask for full usage breakdown
  };
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      'HTTP-Referer': 'https://localhost/cache-probe',
      'X-Title': 'cache-probe',
    },
    body: JSON.stringify(body),
  });
  const tookMs = Date.now() - t0;
  const json = await res.json();
  if (!res.ok) {
    console.error(`call ${idx} HTTP ${res.status}:`, JSON.stringify(json).slice(0, 400));
    process.exit(2);
  }
  console.log(`\n=== call #${idx} (${tookMs}ms) ===`);
  console.log('reply:', JSON.stringify(json.choices?.[0]?.message?.content ?? '').slice(0, 120));
  console.log('usage:', JSON.stringify(json.usage, null, 2));
  if (json.usage?.prompt_tokens_details) {
    console.log('prompt_tokens_details:', JSON.stringify(json.usage.prompt_tokens_details));
  }
  return json.usage;
}

console.log('model:', MODEL);
console.log('shared system prompt size:', SHARED_SYSTEM.length, 'chars (~', Math.round(SHARED_SYSTEM.length / 4), 'tokens)');

const u1 = await call(1, 'Say "OK first call".');
// short sleep — DeepSeek implicit cache is normally instant but harmless
await new Promise((r) => setTimeout(r, 1500));
const u2 = await call(2, 'Say "OK second call".');
await new Promise((r) => setTimeout(r, 1500));
const u3 = await call(3, 'Say "OK third call".');

const cacheTok = (u) => u?.prompt_tokens_details?.cached_tokens ?? 0;
console.log('\n=== summary ===');
console.log(`call 1 prompt=${u1.prompt_tokens} cached=${cacheTok(u1)}`);
console.log(`call 2 prompt=${u2.prompt_tokens} cached=${cacheTok(u2)}`);
console.log(`call 3 prompt=${u3.prompt_tokens} cached=${cacheTok(u3)}`);
const cacheWorks = cacheTok(u2) > 0 || cacheTok(u3) > 0;
console.log(cacheWorks
  ? '\n✓ provider returned non-zero cached_tokens on repeat calls — cache is reachable from API'
  : '\n✗ NO cached_tokens returned on repeat calls — either provider does not support, or routing is hitting different nodes');
