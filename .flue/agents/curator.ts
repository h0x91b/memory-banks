import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';
import path from 'node:path';
import fs from 'node:fs/promises';
import { BANK_NAME_RE, ensureBank } from '../../src/bank.js';
import { ingestOne, type IngestItem } from '../../src/ingest.js';
import { gitCommitAll, gitEnsureRepo } from '../../src/git.js';
import { createBankBashFactory } from '../../src/bash-factory.js';
import { readGitChanges, type Change } from '../../src/changes.js';
import { sweepRawToUnsorted } from '../../src/sweep.js';
import { bankLogger } from '../../src/console-log.js';
import { pinOpenRouterProviders } from '../../src/openrouter-pin.js';
import { collectIndexes } from '../../src/index-scan.js';

pinOpenRouterProviders({ order: ['DeepSeek', 'Novita', 'AtlasCloud'], allowFallbacks: true });

export const triggers = { webhook: true };

interface CuratorPayload {
  bank?: string;
  items?: IngestItem[];
  hint?: string;
}

const ResultSchema = v.object({
  summary: v.string(),
});

const MODEL = 'openrouter/deepseek/deepseek-v4-flash';

export default async function ({ init, payload, log }: FlueContext<CuratorPayload>) {
  const bank = payload?.bank?.trim();
  if (!bank) throw new Error('payload.bank is required');
  if (!BANK_NAME_RE.test(bank)) {
    throw new Error(`Invalid bank name "${bank}": must match [a-z0-9][a-z0-9-]*`);
  }

  const items = Array.isArray(payload?.items) ? payload!.items! : [];
  const t0 = Date.now();
  const ms = (since: number) => `${Date.now() - since}ms`;

  const banklog = bankLogger(bank);
  log.info('curator.start', { bank, items: items.length, hint: payload?.hint ?? null });
  banklog('curator', `=== START items=${items.length}${payload?.hint ? ` hint="${payload.hint.slice(0, 80)}"` : ''}`, 'magenta');

  log.info('bank.resolving', { bank });
  const tBank = Date.now();
  const { created, repoPath, fsPath } = await ensureBank(bank);
  await gitEnsureRepo(repoPath);
  log.info('bank.ready', { bank, repoPath, fsPath, created, took: ms(tBank) });
  banklog('curator', `bank ${created ? 'CREATED' : 'ready'} at ${fsPath}`, 'blue');

  const ingested: string[] = [];
  if (items.length > 0) {
    log.info('ingest.start', { count: items.length });
    banklog('curator', `ingest ${items.length} item(s) → fs/_raw/`, 'blue');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const meta =
        item.kind === 'inline'
          ? { kind: 'inline', filename: item.filename ?? null, bytes: item.content.length }
          : { kind: 'path', uri: item.uri };
      log.info('ingest.item', { index: i + 1, total: items.length, ...meta });
      const tItem = Date.now();
      const res = await ingestOne(bank, item);
      ingested.push(res.sourceLabel);
      log.info('ingest.item.done', { label: res.sourceLabel, took: ms(tItem) });
      banklog('ingest', `${i + 1}/${items.length} ${res.sourceLabel}`, 'green');
    }
  } else {
    log.info('ingest.skipped', { reason: 'no items in payload' });
  }
  const ingestCommit = ingested.length
    ? await gitCommitAll(repoPath, `ingest: ${ingested.length} item(s) into fs/_raw/`)
    : null;
  if (ingestCommit) {
    log.info('git.commit.ingest', { sha: ingestCommit, count: ingested.length });
    banklog('git', `commit ${ingestCommit} (ingest)`, 'yellow');
  }

  const rawDirAbs = path.join(fsPath, '_raw');
  await cleanMacJunk(rawDirAbs);
  const rawEntries = await listTopLevelEntries(rawDirAbs);
  const rawFileCount = await countFilesRecursively(rawDirAbs);
  log.info('raw.listed', { entries: rawEntries.length, files_total: rawFileCount });
  banklog('curator', `_raw/ has ${rawEntries.length} top-level entr${rawEntries.length === 1 ? 'y' : 'ies'} (${rawFileCount} files total)`, 'blue');

  if (rawEntries.length === 0) {
    log.info('curator.done', { reason: '_raw/ is empty', took: ms(t0) });
    banklog('curator', `=== DONE _raw/ empty, nothing to curate (took ${ms(t0)})`, 'magenta');
    return {
      bank,
      processed: [],
      skipped: [],
      commits: ingestCommit ? [ingestCommit] : [],
      summary: '_raw/ is empty — nothing to curate.',
    };
  }

  log.info('llm.init', { model: MODEL, fs_root: fsPath });
  banklog('curator', `LLM init: ${MODEL}`, 'blue');
  const bashCalls: { command: string; exitCode: number; tookMs: number }[] = [];
  const sandbox = createBankBashFactory({
    bank,
    bankFsPath: fsPath,
    log,
    onExec: (command, r) => bashCalls.push({ command, exitCode: r.exitCode, tookMs: r.tookMs }),
  });

  const harness = await init({
    model: MODEL,
    role: 'curator',
    sandbox,
  });
  const session = await harness.session();

  const indexToc = await collectIndexes(fsPath, { linesPerFile: 30 });
  if (indexToc) {
    banklog('curator', `pre-injected ${indexToc.split('\n### ').length} _index.md file(s) into briefing`, 'blue');
  }
  const briefing = buildBriefing(bank, rawEntries, rawFileCount, payload?.hint, indexToc);
  log.info('llm.calling', { model: MODEL, prompt_bytes: briefing.length, raw_entries: rawEntries.length });
  banklog('curator', `LLM call (prompt=${briefing.length}B, raw_entries=${rawEntries.length}, raw_files=${rawFileCount})`, 'blue');
  const tLlm = Date.now();
  const response = await session.prompt(briefing, { schema: ResultSchema });
  log.info('llm.responded', {
    took: ms(tLlm),
    tokens_in: response.usage.input,
    tokens_out: response.usage.output,
    cost_usd: response.usage.cost.total,
    bash_calls: bashCalls.length,
    summary: response.data.summary,
  });
  banklog(
    'curator',
    `LLM done in ${ms(tLlm)} — tokens=${response.usage.totalTokens} cost=$${response.usage.cost.total.toFixed(5)} bashCalls=${bashCalls.length}`,
    'blue',
  );
  banklog('curator', `summary: ${response.data.summary}`, 'blue');

  log.info('sweep.start');
  const swept = await sweepRawToUnsorted(fsPath);
  if (swept.length) {
    log.info('sweep.done', { swept: swept.length });
    banklog('sweep', `${swept.length} leftover → _unsorted/`, 'yellow');
  }

  const changes = await readGitChanges(repoPath);
  log.info('changes.read', { count: changes.length });

  const { processed, skipped } = splitChanges(changes);

  const curateCommit =
    processed.length || skipped.length
      ? await gitCommitAll(repoPath, `curate: ${response.data.summary}`)
      : null;
  if (curateCommit) {
    log.info('git.commit.curate', { sha: curateCommit });
    banklog('git', `commit ${curateCommit} (curate)`, 'yellow');
  }

  log.info('curator.done', {
    processed: processed.length,
    skipped: skipped.length,
    swept: swept.length,
    bash_calls: bashCalls.length,
    commits: [ingestCommit, curateCommit].filter(Boolean).length,
    took: ms(t0),
  });
  banklog(
    'curator',
    `=== DONE processed=${processed.length} skipped=${skipped.length} swept=${swept.length} bashCalls=${bashCalls.length} (took ${ms(t0)})`,
    'magenta',
  );

  return {
    bank,
    summary: response.data.summary,
    processed,
    skipped,
    commits: [ingestCommit, curateCommit].filter(Boolean) as string[],
    bash_calls: bashCalls.length,
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
    'Use your tools (`bash`, `read`, `write`, `edit`, `grep`, `glob`) to inspect, decide, and execute the curation. Follow the rules in your role instructions. When fully done, return `{ summary }` as a structured result.',
  );
  parts.push('');
  parts.push(
    'You already have the index map above — use it to plan placements directly. Sample items in `_raw/` to understand what you\'re filing, then move them into the right folders and update the relevant `_index.md` files. For directories with many files, decide whether to keep them as a single themed folder or distribute the files across existing/new categories.',
  );
  return parts.join('\n');
}
