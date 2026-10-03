// Agent briefing for a bank (contract §5.3, §6): the root `_index.md`
// verbatim and in full, then the generated glossary, then — for the Librarian
// only — `/_open-questions.md`. Read-only: never writes into the bank, never
// throws; problems become diagnostics for the run log.
import { constants as fsc } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import {
  codePointLength,
  MAP_MAX,
  OPEN_QUESTIONS_FILE,
  parseRootMap,
  ROOT_MAP_FILE,
} from '../bank-format/index.ts';
import { scanBank, validateScan, type BankScan } from '../bank-validator/index.ts';
import type { BriefingDiagnostic } from './diagnostics.ts';
import { buildGlossary, GLOSSARY_HEADING } from './glossary.ts';

export type BriefingRole = 'librarian' | 'retriever';

export const ROOT_MAP_MISSING = `(root ${ROOT_MAP_FILE} is missing)`;
export const OPEN_QUESTIONS_HEADING = `## Open questions (/${OPEN_QUESTIONS_FILE})`;

export interface BriefingStats {
  /** Usable folder lines the root map parser read. */
  mapEntries: number;
  mapCodePoints: number;
  manifests: number;
  manifestsUsed: number;
  manifestsSkipped: number;
  glossaryLines: number;
  glossaryCodePoints: number;
  /** Terms that valid manifests describe differently (each still gets all its lines). */
  glossaryConflicts: number;
}

export interface BankBriefing {
  role: BriefingRole;
  /** Ready to inject: root map, glossary, and for the Librarian the open questions. Never truncated. */
  text: string;
  /** Root `_index.md` decoded as UTF-8, verbatim; `null` when missing. */
  rootMap: string | null;
  /** Glossary block: heading, blank line, lines or `(none)`. */
  glossary: string;
  /** `/_open-questions.md` verbatim; always `null` for the retriever. */
  openQuestions: string | null;
  diagnostics: BriefingDiagnostic[];
  stats: BriefingStats;
}

/**
 * Joins the parts in contract order. Each part keeps its own text; only
 * trailing line breaks are dropped so parts are separated by one blank line.
 * The retriever never gets the open questions, whatever is passed.
 */
export function composeBriefing(parts: {
  role: BriefingRole;
  rootMap: string | null;
  glossary: string;
  openQuestions: string | null;
}): string {
  const trimEnd = (s: string) => s.replace(/[\r\n]+$/, '');
  const out = [parts.rootMap === null ? ROOT_MAP_MISSING : trimEnd(parts.rootMap), trimEnd(parts.glossary)];
  if (parts.role === 'librarian' && parts.openQuestions !== null) {
    out.push(`${OPEN_QUESTIONS_HEADING}\n\n${trimEnd(parts.openQuestions)}`);
  }
  return out.join('\n\n') + '\n';
}

/** Builds the briefing of the bank whose `fs/` directory is `fsPath`. */
export async function buildBankBriefing(fsPath: string, opts: { role: BriefingRole }): Promise<BankBriefing> {
  const { role } = opts;
  const diagnostics: BriefingDiagnostic[] = [];

  let scan: BankScan | null = null;
  try {
    scan = await scanBank(fsPath);
  } catch (e) {
    diagnostics.push({ code: 'scan-failed', path: '', message: `bank scan failed: ${(e as Error).message}` });
  }

  const rootMapBytes = scan ? scan.rootMap : await readRegularFile(join(fsPath, ROOT_MAP_FILE)).catch(() => null);
  const rootMap = rootMapBytes === null ? null : new TextDecoder('utf-8').decode(rootMapBytes);
  let mapEntries = 0;
  if (rootMap === null) {
    diagnostics.push({ code: 'map-missing', path: ROOT_MAP_FILE, message: `root ${ROOT_MAP_FILE} is missing` });
  } else {
    mapEntries = parseRootMap(rootMap).entries.length;
    const size = codePointLength(rootMap);
    if (size > MAP_MAX) {
      diagnostics.push({
        code: 'map-over-budget',
        path: ROOT_MAP_FILE,
        message: `${ROOT_MAP_FILE} is ${size} code points (budget ${MAP_MAX}); injected in full`,
      });
    }
  }

  let glossary = `${GLOSSARY_HEADING}\n\n(unavailable: the bank could not be scanned)`;
  let glossaryLines = 0;
  let manifestsUsed = 0;
  let conflicts = 0;
  if (scan) {
    const g = buildGlossary(scan.manifests);
    glossary = g.block;
    glossaryLines = g.lines.length;
    manifestsUsed = g.manifestsUsed;
    diagnostics.push(...g.skipped);

    // Conflicts and map errors come from the validator so both report the same thing.
    const report = validateScan(scan);
    const mapErrors = report.violations.filter(
      (v) => v.severity === 'error' && v.code.startsWith('map-') && v.code !== 'map-file-missing',
    );
    if (mapErrors.length > 0) {
      diagnostics.push({
        code: 'map-invalid',
        path: ROOT_MAP_FILE,
        detail: [...new Set(mapErrors.map((v) => v.code))].sort().join(','),
        message: `${ROOT_MAP_FILE} has ${mapErrors.length} format error(s); injected verbatim anyway`,
      });
    }
    for (const v of report.violations) {
      if (v.code !== 'glossary-conflict') continue;
      conflicts++;
      diagnostics.push({ code: 'glossary-conflict', path: '', detail: v.detail, message: v.message });
    }
  }

  let openQuestions: string | null = null;
  if (role === 'librarian') {
    try {
      const bytes = await readRegularFile(join(fsPath, OPEN_QUESTIONS_FILE));
      openQuestions = bytes === null ? null : new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      diagnostics.push({
        code: 'open-questions-unreadable',
        path: OPEN_QUESTIONS_FILE,
        message: `${OPEN_QUESTIONS_FILE} could not be read: ${(e as Error).message}`,
      });
    }
  }

  const text = composeBriefing({ role, rootMap, glossary, openQuestions });
  const manifests = scan?.manifests.length ?? 0;
  return {
    role,
    text,
    rootMap,
    glossary,
    openQuestions,
    diagnostics,
    stats: {
      mapEntries,
      mapCodePoints: rootMap === null ? 0 : codePointLength(rootMap),
      manifests,
      manifestsUsed,
      manifestsSkipped: manifests - manifestsUsed,
      glossaryLines,
      glossaryCodePoints: codePointLength(glossary),
      glossaryConflicts: conflicts,
    },
  };
}

/** One run-log line, e.g. `map 12 folders/1834 cp; glossary 40 lines from 30/32 manifests (2 skipped), 1 conflict`. */
export function summarizeBriefing(b: BankBriefing): string {
  const s = b.stats;
  const map = b.rootMap === null ? 'map missing' : `map ${s.mapEntries} folders/${s.mapCodePoints} cp`;
  const skipped = s.manifestsSkipped > 0 ? ` (${s.manifestsSkipped} skipped)` : '';
  const conflicts = s.glossaryConflicts > 0 ? `, ${s.glossaryConflicts} conflict(s)` : '';
  const oq = b.role === 'librarian' ? `; open questions ${b.openQuestions === null ? 'none' : 'included'}` : '';
  return `${map}; glossary ${s.glossaryLines} lines from ${s.manifestsUsed}/${s.manifests} manifests${skipped}${conflicts}${oq}`;
}

/**
 * Contents of a regular file, `null` when it does not exist. Refuses a
 * symlink or anything that is not a regular file, and opens with O_NOFOLLOW
 * so nothing outside the bank can leak in.
 */
async function readRegularFile(path: string): Promise<Uint8Array | null> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  const handle = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
