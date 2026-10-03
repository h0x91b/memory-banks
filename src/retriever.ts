import path from 'node:path';
import { existsSync } from 'node:fs';
import { init } from '@flue/runtime';
import { BANK_NAME_RE, bankFsPath, bankPath } from './bank.js';
import { readGitChanges } from './changes.js';
import { bankLogger } from './console-log.js';
import { buildBankBriefing, summarizeBriefing } from './bank-briefing/index.js';
import { buildRetrieverBriefing } from './retriever-briefing.js';
import { MODEL } from './model.js';
import { MODEL_ID, RequestError, costMeta, freshInstanceId, tokensMeta } from './request.js';
import { RESULT_TOOL, readStructuredReply } from './structured-result.js';
import { recordAgentCall, sharedSpendLedger } from './spend-ledger.js';
import {
  recordToolStarts,
  summarizeToolStarts,
  telemetryLogLine,
  type ToolStart,
} from './retriever-telemetry.js';
import { Retriever, RetrieverResultSchema } from '../.flue/agents/retriever.js';

export interface RetrieverPayload {
  bank?: string;
  question?: string;
  hint?: string;
}

const EMPTY_ANSWER = 'No relevant data found in the memory bank.';

export async function runRetriever(payload: RetrieverPayload | undefined, runId: string) {
  const bank = payload?.bank?.trim();
  if (!bank) throw new RequestError('payload.bank is required');
  if (!BANK_NAME_RE.test(bank)) {
    throw new RequestError(`Invalid bank name "${bank}": must match [a-z0-9][a-z0-9-]*`);
  }
  const question = payload?.question?.trim();
  if (!question) throw new RequestError('payload.question is required');

  const t0 = Date.now();
  const ms = (since: number) => `${Date.now() - since}ms`;

  const banklog = bankLogger(bank);
  banklog(
    'retriever',
    `=== START q="${question.slice(0, 80)}${question.length > 80 ? '…' : ''}"`,
    'magenta',
  );

  const repoPath = bankPath(bank);
  const fsPath = bankFsPath(bank);

  if (!existsSync(repoPath) || !existsSync(fsPath)) {
    banklog('retriever', `=== DONE bank does not exist (took ${ms(t0)})`, 'magenta');
    return {
      bank,
      answer: EMPTY_ANSWER,
      references: [] as { path: string; why: string }[],
      meta: { model: null, tokens: null, cost: null, bash_calls: 0, reason: 'bank-missing', telemetry: null },
    };
  }

  banklog('retriever', `LLM init: ${MODEL}`, 'blue');
  const bankBriefing = await buildBankBriefing(fsPath, { role: 'retriever' });
  banklog('retriever', `briefing: ${summarizeBriefing(bankBriefing)}`, 'blue');
  for (const d of bankBriefing.diagnostics) {
    banklog('retriever', `briefing ${d.code}: ${d.message}`, 'yellow');
  }
  const briefing = buildRetrieverBriefing({
    bank,
    question,
    fsPath,
    hint: payload?.hint,
    bankBriefing: bankBriefing.text,
  });
  banklog('retriever', `LLM call (prompt=${briefing.length}B)`, 'blue');
  const tLlm = Date.now();
  const instanceId = freshInstanceId('retriever', runId);
  const recorder = recordToolStarts(instanceId);
  let toolStarts: ToolStart[] = [];
  const { data, usage, toolCalls } = await recordAgentCall(
    sharedSpendLedger(),
    { executionId: instanceId, bank, agent: 'retriever', runId, model: MODEL_ID },
    async () => {
      let reply;
      try {
        const agent = init(Retriever, { id: instanceId });
        const receipt = await agent.dispatch({
          message: { kind: 'user', body: briefing },
          initialData: { bank, fsPath },
        });
        reply = await agent.read(receipt);
      } finally {
        toolStarts = recorder.stop();
      }
      return readStructuredReply(reply, RetrieverResultSchema);
    },
  );
  const bashCalls = toolCalls.filter((tool) => tool === 'bash').length;
  const telemetry = summarizeToolStarts(toolStarts, {
    fsPath,
    briefing,
    recordedToolCalls: toolCalls.length,
    resultTool: RESULT_TOOL,
  });
  banklog(
    'retriever',
    `LLM done in ${ms(tLlm)} — tokens=${usage?.totalTokens ?? '?'} cost=$${usage ? usage.cost.total.toFixed(5) : '?'} bashCalls=${bashCalls} refs=${data.references.length}`,
    'blue',
  );
  banklog('retriever', telemetryLogLine(telemetry), 'blue');
  if (telemetry.read_paths.length > 0) {
    banklog('retriever', `read order: ${telemetry.read_paths.join(' -> ')}`, 'blue');
  }
  banklog('retriever', `answer: ${data.answer.slice(0, 200)}${data.answer.length > 200 ? '…' : ''}`, 'blue');

  const references = data.references.map((r) => normalizeReference(r, fsPath));

  const changes = await readGitChanges(repoPath).catch(() => []);
  if (changes.length > 0) {
    banklog('retriever', `WARN: retriever made ${changes.length} unexpected change(s) — read-only violated`, 'red');
  }

  banklog('retriever', `=== DONE refs=${references.length} bashCalls=${bashCalls} (took ${ms(t0)})`, 'magenta');

  return {
    bank,
    answer: data.answer,
    references,
    meta: {
      model: MODEL_ID,
      tokens: tokensMeta(usage),
      cost: costMeta(usage),
      bash_calls: bashCalls,
      unexpected_writes: changes.length,
      telemetry,
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
