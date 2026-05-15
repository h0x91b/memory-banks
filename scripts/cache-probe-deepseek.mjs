#!/usr/bin/env node
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

async function call(label, body) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) { console.log(`${label} HTTP ${res.status}: ${JSON.stringify(j).slice(0,160)}`); return; }
  const u = j.usage || {};
  const ptd = u.prompt_tokens_details || {};
  console.log(`${label.padEnd(35)} provider=${String(j.provider).padEnd(12)} prompt=${u.prompt_tokens} cached=${ptd.cached_tokens ?? 0} cost=$${(u.cost ?? 0).toFixed(6)}`);
}

const sys = 'You are a synthetic prompt-cache probe. Be terse.\n\n' + lorem;
function makeBody(provider, ix) {
  return {
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `Say ${ix}` },
    ],
    max_tokens: 20, temperature: 0,
    usage: { include: true },
    ...(provider ? { provider } : {}),
  };
}

console.log('--- DeepSeek native (with fallback) ---');
for (let i = 1; i <= 4; i++) {
  await call(`DeepSeek+fb #${i}`, makeBody({ order: ['DeepSeek'], allow_fallbacks: true }, i));
  await new Promise(r=>setTimeout(r,2500));
}

console.log('\n--- DeepSeek native (NO fallback) ---');
for (let i = 1; i <= 4; i++) {
  await call(`DeepSeek only #${i}`, makeBody({ only: ['DeepSeek'] }, i));
  await new Promise(r=>setTimeout(r,2500));
}
