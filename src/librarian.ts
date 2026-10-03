import path from 'node:path';
import fs from 'node:fs/promises';
import { init } from '@flue/runtime';
import { BANK_NAME_RE, ensureBank } from './bank.js';
import { ingestOne, type IngestItem } from './ingest.js';
import { gitCommitAll, gitEnsureRepo } from './git.js';
import { readGitChanges, type Change } from './changes.js';
import { sweepRawToUnsorted } from './sweep.js';
import { bankLogger } from './console-log.js';
import { collectIndexes } from './index-scan.js';
import { MODEL } from './model.js';
import { MODEL_ID, RequestError, costMeta, freshInstanceId, tokensMeta } from './request.js';
import { readStructuredReply } from './structured-result.js';
import { recordAgentCall, sharedSpendLedger } from './spend-ledger.js';
import { Librarian, LibrarianResultSchema } from '../.flue/agents/librarian.js';

export interface LibrarianPayload {
  bank?: string;
  items?: IngestItem[];
  hint?: string;
}

export async function runLibrarian(payload: LibrarianPayload | undefined, runId: string) {
  const bank = payload?.bank?.trim();
  if (!bank) throw new RequestError('payload.bank is required');
  if (!BANK_NAME_RE.test(bank)) {
    throw new RequestError(`Invalid bank name "${bank}": must match [a-z0-9][a-z0-9-]*`);
  }

  const items = Array.isArray(payload?.items) ? payload!.items! : [];
  const t0 = Date.now();
  const ms = (since: number) => `${Date.now() - since}ms`;

  const banklog = bankLogger(bank);
  banklog('librarian', `=== START items=${items.length}${payload?.hint ? ` hint="${payload.hint.slice(0, 80)}"` : ''}`, 'magenta');

  const { created, repoPath, fsPath } = await ensureBank(bank);
  await gitEnsureRepo(repoPath);
  banklog('librarian', `bank ${created ? 'CREATED' : 'ready'} at ${fsPath}`, 'blue');

  const ingested: string[] = [];
  if (items.length > 0) {
    banklog('librarian', `ingest ${items.length} item(s) → fs/_raw/`, 'blue');
    for (let i = 0; i < items.length; i++) {
      const res = await ingestOne(bank, items[i]);
      ingested.push(res.sourceLabel);
      banklog('ingest', `${i + 1}/${items.length} ${res.sourceLabel}`, 'green');
    }
  }
  const ingestCommit = ingested.length
    ? await gitCommitAll(repoPath, `ingest: ${ingested.length} item(s) into fs/_raw/`)
    : null;
  if (ingestCommit) {
    banklog('git', `commit ${ingestCommit} (ingest)`, 'yellow');
  }

  const rawDirAbs = path.join(fsPath, '_raw');
  await cleanMacJunk(rawDirAbs);
  const rawEntries = await listTopLevelEntries(rawDirAbs);
  const rawFileCount = await countFilesRecursively(rawDirAbs);
  banklog('librarian', `_raw/ has ${rawEntries.length} top-level entr${rawEntries.length === 1 ? 'y' : 'ies'} (${rawFileCount} files total)`, 'blue');

  if (rawEntries.length === 0) {
    banklog('librarian', `=== DONE _raw/ empty, nothing to curate (took ${ms(t0)})`, 'magenta');
    return {
      bank,
      processed: [],
      skipped: [],
      commits: ingestCommit ? [ingestCommit] : [],
      summary: '_raw/ is empty — nothing to curate.',
    };
  }

  banklog('librarian', `LLM init: ${MODEL}`, 'blue');
  const indexToc = await collectIndexes(fsPath, { linesPerFile: 30 });
  if (indexToc) {
    banklog('librarian', `pre-injected ${indexToc.split('\n### ').length} _index.md file(s) into briefing`, 'blue');
  }
  const briefing = buildBriefing(bank, rawEntries, rawFileCount, payload?.hint, indexToc);
  banklog('librarian', `LLM call (prompt=${briefing.length}B, raw_entries=${rawEntries.length}, raw_files=${rawFileCount})`, 'blue');
  const tLlm = Date.now();
  const instanceId = freshInstanceId('librarian', runId);
  const { data, usage, toolCalls } = await recordAgentCall(
    sharedSpendLedger(),
    { executionId: instanceId, bank, agent: 'librarian', runId, model: MODEL_ID },
    async () => {
      const agent = init(Librarian, { id: instanceId });
      const receipt = await agent.dispatch({
        message: { kind: 'user', body: briefing },
        initialData: { bank, fsPath },
      });
      return readStructuredReply(await agent.read(receipt), LibrarianResultSchema);
    },
  );
  const bashCalls = toolCalls.filter((tool) => tool === 'bash').length;
  banklog(
    'librarian',
    `LLM done in ${ms(tLlm)} — tokens=${usage?.totalTokens ?? '?'} cost=$${usage ? usage.cost.total.toFixed(5) : '?'} bashCalls=${bashCalls}`,
    'blue',
  );
  banklog('librarian', `summary: ${data.summary}`, 'blue');

  const swept = await sweepRawToUnsorted(fsPath);
  if (swept.length) {
    banklog('sweep', `${swept.length} leftover → _unsorted/`, 'yellow');
  }

  const changes = await readGitChanges(repoPath);
  const { processed, skipped } = splitChanges(changes);

  const curateCommit =
    processed.length || skipped.length
      ? await gitCommitAll(repoPath, `curate: ${data.summary}`)
      : null;
  if (curateCommit) {
    banklog('git', `commit ${curateCommit} (curate)`, 'yellow');
  }

  banklog(
    'librarian',
    `=== DONE processed=${processed.length} skipped=${skipped.length} swept=${swept.length} bashCalls=${bashCalls} (took ${ms(t0)})`,
    'magenta',
  );

  return {
    bank,
    summary: data.summary,
    processed,
    skipped,
    commits: [ingestCommit, curateCommit].filter(Boolean) as string[],
    bash_calls: bashCalls,
    meta: {
      model: MODEL_ID,
      tokens: tokensMeta(usage),
      cost: costMeta(usage),
    },
  };
}

interface RawEntry {
  name: string;
  kind: 'file' | 'dir';
  bytes?: number;
  fileCount?: number;
}

async function listTopLevelEntries(dir: string): Promise<RawEntry[]> {
  try {
    const names = await fs.readdir(dir);
    const entries: RawEntry[] = [];
    for (const name of names.sort()) {
      try {
        const st = await fs.stat(path.join(dir, name));
        if (st.isFile()) {
          entries.push({ name, kind: 'file', bytes: st.size });
        } else if (st.isDirectory()) {
          const fc = await countFilesRecursively(path.join(dir, name));
          entries.push({ name, kind: 'dir', fileCount: fc });
        }
      } catch {
        // ignore
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function countFilesRecursively(dir: string): Promise<number> {
  let count = 0;
  try {
    const names = await fs.readdir(dir);
    for (const name of names) {
      try {
        const st = await fs.stat(path.join(dir, name));
        if (st.isFile()) count += 1;
        else if (st.isDirectory()) count += await countFilesRecursively(path.join(dir, name));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return count;
}

async function cleanMacJunk(dir: string): Promise<void> {
  // Strip .DS_Store recursively — pure noise that confuses the LLM and
  // bloats _unsorted/.
  try {
    const names = await fs.readdir(dir);
    for (const name of names) {
      const abs = path.join(dir, name);
      try {
        const st = await fs.stat(abs);
        if (st.isFile() && name === '.DS_Store') {
          await fs.rm(abs, { force: true });
        } else if (st.isDirectory()) {
          await cleanMacJunk(abs);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function splitChanges(changes: Change[]): {
  processed: Array<{ status: Change['status']; path: string; from?: string }>;
  skipped: Array<{ status: Change['status']; path: string }>;
} {
  const processed: Array<{ status: Change['status']; path: string; from?: string }> = [];
  const skipped: Array<{ status: Change['status']; path: string }> = [];
  for (const c of changes) {
    if (c.path.startsWith('_unsorted/')) {
      skipped.push({ status: c.status, path: c.path });
    } else {
      processed.push({ status: c.status, path: c.path, from: c.from });
    }
  }
  return { processed, skipped };
}

function buildBriefing(
  bank: string,
  rawEntries: RawEntry[],
  totalFiles: number,
  hint: string | undefined,
  indexToc: string,
): string {
  const parts: string[] = [];
  parts.push(`# Curate memory bank \`${bank}\``);
  parts.push('');
  parts.push(
    `\`_raw/\` contains **${rawEntries.length} top-level entr${rawEntries.length === 1 ? 'y' : 'ies'}** (${totalFiles} file(s) total):`,
  );
  for (const e of rawEntries) {
    if (e.kind === 'dir') {
      parts.push(`  - **${e.name}/** (directory, ${e.fileCount} file(s) inside)`);
    } else {
      parts.push(`  - ${e.name} (${e.bytes ?? 0} bytes)`);
    }
  }
  parts.push('');
  if (hint && hint.trim()) {
    parts.push('## Hint from the user');
    parts.push(hint.trim());
    parts.push('');
  }
  if (indexToc) {
    parts.push('## Existing index map (pre-loaded)');
    parts.push(
      "Top lines of every `_index.md` already in the bank are included below so you don't need to `tree` or `cat _index.md` to orient. Use this to decide where new items fit — and which indexes you'll need to update after placing them.",
    );
    parts.push('');
    parts.push(indexToc);
    parts.push('');
  }
  parts.push('## Your job');
  parts.push(
    'Use your tools (`bash`, `read`, `write`, `edit`, `grep`, `glob`) to inspect, decide, and execute the curation. Follow the rules in your role instructions. When fully done, submit `{ summary }` as your structured result.',
  );
  parts.push('');
  parts.push(
    'You already have the index map above — use it to plan placements directly. Sample items in `_raw/` to understand what you\'re filing, then move them into the right folders and update the relevant `_index.md` files. For directories with many files, decide whether to keep them as a single themed folder or distribute the files across existing/new categories.',
  );
  return parts.join('\n');
}
