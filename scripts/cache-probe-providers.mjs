#!/usr/bin/env node
/**
 * Like cache-probe.mjs but tries multiple OpenRouter `provider` orderings,
 * to see whether any specific upstream returns cached_tokens > 0 for
 * deepseek-v4-flash with a repeated large prefix.
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

const MODEL = 'deepseek/deepseek-v4-flash';
const lorem = 'The quick brown fox jumps over the lazy dog. '.repeat(800);
const SHARED_SYSTEM = 'You are a synthetic prompt-cache probe. Be terse.\n\n' + lorem;

async function call(label, userText, providerPref) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SHARED_SYSTEM },
      { role: 'user', content: userText },
    ],
    max_tokens: 20,
    temperature: 0,
    usage: { include: true },
    ...(providerPref ? { provider: providerPref } : {}),
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) { console.error(label, 'HTTP', res.status, JSON.stringify(j).slice(0, 300)); return null; }
  const u = j.usage || {};
  const ptd = u.prompt_tokens_details || {};
  const provider = j.provider || u.provider || '?';
  console.log(`${label.padEnd(40)} provider=${String(provider).padEnd(14)} prompt=${u.prompt_tokens} cached=${ptd.cached_tokens ?? 0} cache_write=${ptd.cache_write_tokens ?? 0} cost=$${u.cost ?? 0}`);
  return u;
}

const scenarios = [
  ['no provider preference', undefined],
  ['provider: DeepSeek only', { order: ['DeepSeek'], allow_fallbacks: false }],
  ['provider: Novita only', { order: ['Novita'], allow_fallbacks: false }],
  ['provider: Fireworks only', { order: ['Fireworks'], allow_fallbacks: false }],
  ['provider: Targon only', { order: ['Targon'], allow_fallbacks: false }],
];

for (const [label, providerPref] of scenarios) {
  console.log(`\n--- ${label} ---`);
  await call(`${label} #1`, 'Say A', providerPref);
  await new Promise((r) => setTimeout(r, 2500));
  await call(`${label} #2`, 'Say B', providerPref);
  await new Promise((r) => setTimeout(r, 2500));
  await call(`${label} #3`, 'Say C', providerPref);
}
