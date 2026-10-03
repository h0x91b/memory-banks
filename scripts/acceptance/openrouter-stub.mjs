// Scripted model for the acceptance run (scripts/acceptance/run.mjs), preloaded
// into the built server with `node --import`. Every openrouter.ai call is
// answered locally, so the whole pipeline runs without a paid model; any other
// host goes to the real fetch.
//
// Librarian (its submit_result has no `references`):
//   turn 1  bash: file everything in _raw/ into notes/ with a manifest each and
//           rewrite the root map, so the bank passes the format validator;
//   turn 2  submit_result.
// Retriever:
//   turn 1  bash: print every note;
//   turn 2  bash: try to write into the bank (the query snapshot must refuse it);
//   turn 3  submit_result with the printed text as the answer, or the no-data
//           literal when the question contains NO-DATA-PROBE.
//
// ACCEPTANCE_STUB_LOG: append one JSON line per call {agent, turn, prompt, lastToolResult} for
// the harness to inspect. ACCEPTANCE_STUB_DELAY_MS: delay per call, so batches
// of different banks visibly overlap.
import { appendFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
const LOG = process.env.ACCEPTANCE_STUB_LOG;
const DELAY_MS = Number(process.env.ACCEPTANCE_STUB_DELAY_MS ?? 0);
const NO_DATA = 'No relevant data found in the memory bank.';

const LIBRARIAN_FILE = [
  'mkdir -p notes',
  'for f in _raw/*; do b=$(basename "$f"); mv "$f" "notes/$b"; ' +
    `printf '{"title":"Acceptance note %s","keywords":["acceptance"],"glossary":{}}' "$b" > "notes/$b.manifest.json"; done`,
  `printf '# acceptance\\n\\nSynthetic bank written by the acceptance stub.\\n\\n## Folders\\n\\n- \`notes/\` — Synthetic notes filed by the acceptance stub\\n' > _index.md`,
].join('\n');

const RETRIEVER_READ = 'cat notes/*.md notes/*.txt 2>/dev/null; true';
const RETRIEVER_TAMPER = 'echo tamper > notes/zz-tamper.md';

function sse(toolName, args) {
  const base = { id: 'stub', object: 'chat.completion.chunk', created: 0, model: 'stub' };
  const chunks = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `call_${toolName}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { ...base, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('\n');
  return '';
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!new URL(url).hostname.endsWith('openrouter.ai')) return realFetch(input, init);
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : '{}');
  const req = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  const messages = req.messages ?? [];
  const tools = JSON.stringify(req.tools ?? []);
  const agent = tools.includes('"references"') ? 'retriever' : 'librarian';
  const toolResults = messages.filter((m) => m.role === 'tool');
  const prompt = messages.filter((m) => m.role === 'user' || m.role === 'system').map((m) => text(m.content)).join('\n');
  if (LOG) appendFileSync(LOG, JSON.stringify({ agent, turn: toolResults.length + 1, prompt, lastToolResult: text(toolResults.at(-1)?.content).slice(0, 500) }) + '\n');
  if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));

  if (agent === 'librarian') {
    return toolResults.length === 0 ? sse('bash', { command: LIBRARIAN_FILE }) : sse('submit_result', { summary: 'filed by acceptance stub' });
  }
  if (toolResults.length === 0) return sse('bash', { command: RETRIEVER_READ });
  if (toolResults.length === 1) return sse('bash', { command: RETRIEVER_TAMPER });
  if (prompt.includes('NO-DATA-PROBE')) return sse('submit_result', { answer: NO_DATA, references: [] });
  const printed = text(toolResults[0].content);
  const firstNote = /ACCEPT-[A-Z0-9-]+/.test(printed) ? 'notes/' : '';
  return sse('submit_result', {
    answer: printed.slice(0, 4000),
    references: firstNote ? [{ path: 'notes/', why: 'acceptance stub read every note' }] : [],
  });
};
