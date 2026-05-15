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
const SHARED_SYSTEM = 'You are a synthetic prompt-cache probe. Be terse.\n\n' + lorem;
async function call(model, label) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SHARED_SYSTEM },
      { role: 'user', content: `Say ${label}` },
    ],
    max_tokens: 20, temperature: 0,
    usage: { include: true },
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) { console.log(`${model.padEnd(45)} ${label} HTTP ${res.status}: ${JSON.stringify(j).slice(0,150)}`); return; }
  const u = j.usage || {};
  const ptd = u.prompt_tokens_details || {};
  const provider = j.provider || '?';
  console.log(`${model.padEnd(45)} ${label} provider=${String(provider).padEnd(12)} cached=${ptd.cached_tokens ?? 0} cost=$${u.cost ?? 0}`);
}
for (const m of [
  'deepseek/deepseek-v4-flash:novita',
  'deepseek/deepseek-v4-flash',
]) {
  console.log(`\n--- ${m} ---`);
  await call(m, '#1'); await new Promise(r=>setTimeout(r,2500));
  await call(m, '#2'); await new Promise(r=>setTimeout(r,2500));
  await call(m, '#3');
}
