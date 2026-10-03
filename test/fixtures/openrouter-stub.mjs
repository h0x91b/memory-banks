// Preloaded into a built server (`node --import`) by
// ingestion-worker-built-server.test.ts: answers every openrouter.ai call
// with a scripted Librarian turn, so the real pipeline runs end to end without
// a paid model. Turn 1 files everything from _raw/ into notes/ with a manifest
// each (the bank-format gate requires one) via bash;
// turn 2 (after a tool result) submits the structured result. Any other host
// goes to the real fetch.
const FILE_ALL = "mkdir -p /notes && for f in /_raw/*; do n=$(basename \"$f\"); mv \"$f\" \"/notes/$n\"; echo \"{\\\"title\\\":\\\"Note $n\\\",\\\"keywords\\\":[\\\"note\\\"],\\\"glossary\\\":{}}\" > \"/notes/$n.manifest.json\"; done && printf -- '- `notes/` — Filed notes\\n' >> /_index.md";
const realFetch = globalThis.fetch;

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
    { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!new URL(url).hostname.endsWith('openrouter.ai')) return realFetch(input, init);
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : '{}');
  const req = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  const toolResults = (req.messages ?? []).filter((m) => m.role === 'tool').length;
  globalThis.__openrouterStubCalls = (globalThis.__openrouterStubCalls ?? 0) + 1;
  return toolResults === 0
    ? sse('bash', { command: FILE_ALL })
    : sse('submit_result', { summary: 'filed by stub' });
};
