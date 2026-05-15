import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { BANK_NAME_RE, bankFsPath, bankPath } from '../../src/bank.js';
import { createBankBashFactory } from '../../src/bash-factory.js';
import { readGitChanges } from '../../src/changes.js';
import { bankLogger } from '../../src/console-log.js';
import { pinOpenRouterProviders } from '../../src/openrouter-pin.js';
import { collectIndexes } from '../../src/index-scan.js';

pinOpenRouterProviders({ order: ['DeepSeek', 'Novita', 'AtlasCloud'], allowFallbacks: true });

export const triggers = { webhook: true };

interface RetrieverPayload {
  bank?: string;
  question?: string;
  hint?: string;
}

const ResultSchema = v.object({
  answer: v.string(),
  references: v.array(
    v.object({
      path: v.string(),
      why: v.string(),
    }),
  ),
});

const MODEL = 'openrouter/deepseek/deepseek-v4-flash';
const EMPTY_ANSWER = 'No relevant data found in the memory bank.';

export default async function ({ init, payload, log }: FlueContext<RetrieverPayload>) {
  const bank = payload?.bank?.trim();
  if (!bank) throw new Error('payload.bank is required');
  if (!BANK_NAME_RE.test(bank)) {
    throw new Error(`Invalid bank name "${bank}": must match [a-z0-9][a-z0-9-]*`);
  }
  const question = payload?.question?.trim();
  if (!question) throw new Error('payload.question is required');

  const t0 = Date.now();
  const ms = (since: number) => `${Date.now() - since}ms`;

  const banklog = bankLogger(bank);
  log.info('retriever.start', { bank, question_bytes: question.length, hint: payload?.hint ?? null });
  banklog(
    'retriever',
    `=== START q="${question.slice(0, 80)}${question.length > 80 ? '…' : ''}"`,
    'magenta',
  );

  const repoPath = bankPath(bank);
  const fsPath = bankFsPath(bank);

  if (!existsSync(repoPath) || !existsSync(fsPath)) {
    log.info('retriever.done', { reason: 'bank does not exist', took: ms(t0) });
    banklog('retriever', `=== DONE bank does not exist (took ${ms(t0)})`, 'magenta');
    return {
      bank,
      answer: EMPTY_ANSWER,
      references: [] as { path: string; why: string }[],
      meta: { model: null, tokens: null, cost: null, bash_calls: 0, reason: 'bank-missing' },
    };
  }

  log.info('llm.init', { model: MODEL, fs_root: fsPath });
  banklog('retriever', `LLM init: ${MODEL}`, 'blue');
  const bashCalls: { command: string; exitCode: number; tookMs: number }[] = [];
  const sandbox = createBankBashFactory({
    bank,
    bankFsPath: fsPath,
    log,
    onExec: (command, r) => bashCalls.push({ command, exitCode: r.exitCode, tookMs: r.tookMs }),
  });

  const harness = await init({
    model: MODEL,
    role: 'retriever',
    sandbox,
  });
  const session = await harness.session();

  const indexToc = await collectIndexes(fsPath, { linesPerFile: 30 });
  if (indexToc) {
    banklog('retriever', `pre-injected ${indexToc.split('\n### ').length} _index.md file(s) into briefing`, 'blue');
  }
  const briefing = buildBriefing(bank, question, fsPath, payload?.hint, indexToc);
  log.info('llm.calling', { model: MODEL, prompt_bytes: briefing.length });
  banklog('retriever', `LLM call (prompt=${briefing.length}B)`, 'blue');
  const tLlm = Date.now();
  const response = await session.prompt(briefing, { schema: ResultSchema });
  log.info('llm.responded', {
    took: ms(tLlm),
    tokens_in: response.usage.input,
    tokens_out: response.usage.output,
    cost_usd: response.usage.cost.total,
    bash_calls: bashCalls.length,
    answer_bytes: response.data.answer.length,
    refs: response.data.references.length,
  });
  banklog(
    'retriever',
    `LLM done in ${ms(tLlm)} — tokens=${response.usage.totalTokens} cost=$${response.usage.cost.total.toFixed(5)} bashCalls=${bashCalls.length} refs=${response.data.references.length}`,
    'blue',
  );
  banklog('retriever', `answer: ${response.data.answer.slice(0, 200)}${response.data.answer.length > 200 ? '…' : ''}`, 'blue');

  const references = response.data.references.map((r) => normalizeReference(r, fsPath));

  const changes = await readGitChanges(repoPath).catch(() => []);
  if (changes.length > 0) {
    log.warn('retriever.unexpected_writes', { count: changes.length, paths: changes.map((c) => c.path) });
    banklog('retriever', `WARN: retriever made ${changes.length} unexpected change(s) — read-only violated`, 'red');
  }

  log.info('retriever.done', {
    refs: references.length,
    bash_calls: bashCalls.length,
    took: ms(t0),
  });
  banklog(
    'retriever',
    `=== DONE refs=${references.length} bashCalls=${bashCalls.length} (took ${ms(t0)})`,
    'magenta',
  );

  return {
    bank,
    answer: response.data.answer,
    references,
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
      },
      bash_calls: bashCalls.length,
      unexpected_writes: changes.length,
    },
  };
}

/**
 * Convert whatever the LLM put in `path` into an absolute host filesystem
 * path under the bank's fs/ root. Accepts:
 *   - already-absolute paths that start with fsPath (kept verbatim)
 *   - sandbox-absolute paths like "/notes/foo.md" (joined to fsPath)
 *   - bare relative paths like "notes/foo.md" (joined to fsPath)
 *   - already-absolute paths NOT under fsPath: kept as-is but flagged
 */
function normalizeReference(
  ref: { path: string; why: string },
  fsPath: string,
): { path: string; why: string } {
  const p = ref.path.trim();
  if (!p) return { path: p, why: ref.why };
  if (p.startsWith(fsPath)) return { path: p, why: ref.why };
  if (p.startsWith('/')) {
    return { path: path.join(fsPath, p.replace(/^\/+/, '')), why: ref.why };
  }
  return { path: path.join(fsPath, p), why: ref.why };
}

function buildBriefing(
  bank: string,
  question: string,
  fsPath: string,
  hint: string | undefined,
  indexToc: string,
): string {
  const parts: string[] = [];
  parts.push(`# Retrieve from memory bank \`${bank}\``);
  parts.push('');
  parts.push('## Question');
  parts.push(question);
  parts.push('');
  if (hint && hint.trim()) {
    parts.push('## Hint from the caller');
    parts.push(hint.trim());
    parts.push('');
  }
  parts.push('## Sandbox details');
  parts.push(
    `Your tools see the bank mounted at \`/\`. The absolute host path of that root is:\n\n\`${fsPath}\`\n\nUse this prefix when building absolute paths for \`references\`. **Do not run \`pwd\`** — the path above is authoritative.`,
  );
  parts.push('');
  if (indexToc) {
    parts.push('## Index map (pre-loaded)');
    parts.push(
      "Top lines of every `_index.md` in the bank are included below so you don't need to `tree` or `cat _index.md` to orient. Each section header is the relative path of the index file. Use this as a navigation aid — open individual notes only when you need their content to answer the question.",
    );
    parts.push('');
    parts.push(indexToc);
    parts.push('');
  }
  parts.push('## Your job');
  parts.push(
    'Use your tools (`bash`, `read`, `grep`, `glob`) to find the answer to the question — strictly from the bank\'s contents. Cite every file you used in `references` with absolute paths. If nothing relevant exists in the bank, return the exact "no data" answer described in your role instructions.',
  );
  parts.push('');
  parts.push(
    "**Write the `answer` field in English** — even if the question is in another language. A downstream agent will localize the final user-facing answer. Direct quotes from source files preserve their original language verbatim.",
  );
  parts.push('');
  parts.push(
    'You already have the index map above — go straight to the relevant folders/files. Do NOT modify the bank — reads, searches and listings only.',
  );
  return parts.join('\n');
}
