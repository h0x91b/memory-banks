// Bank structure validator, contract v1 (docs/design/bank-format.md §2–§8).
// Read-only: it reports violations and never repairs the bank.
import {
  compareCodePoints,
  MAX_DEPTH,
  nfc,
  parseRootMap,
  ROOT_MAP_FILE,
  violation,
  WIDTH_LIMIT,
  WIDTH_TARGET,
  type Violation,
} from '../bank-format/index.ts';
import { scanBank, shown, type BankScan } from './scan.ts';

export interface BankValidationReport {
  /** Every finding, sorted by NFC path (code points), then code, then detail. */
  violations: Violation[];
  errors: number;
  warnings: number;
  /** What was looked at, for logs: folders include the root. */
  scanned: { folders: number; contentFiles: number; manifests: number };
}

/** Walks `fsPath` (a bank's `fs/` directory) and checks it against the contract. */
export async function validateBank(fsPath: string): Promise<BankValidationReport> {
  return validateScan(await scanBank(fsPath));
}

/** Validates an existing scan, so a caller that already walked the bank does not walk it twice. */
export function validateScan(scan: BankScan): BankValidationReport {
  const out: Violation[] = [...scan.violations];

  for (const f of scan.folders) {
    const p = shown(f.path);
    if (f.depth === MAX_DEPTH + 1) {
      out.push(
        violation('depth-over-limit', f.path, `${p} is at depth ${f.depth} (limit ${MAX_DEPTH}); move it up`, {
          value: f.depth,
          limit: MAX_DEPTH,
        }),
      );
    }
    const width = { value: f.contentFiles };
    if (f.contentFiles > WIDTH_LIMIT) {
      // Depth wins over width (§3.2): at or below the depth limit a folder cannot be split.
      const atMax = f.depth >= MAX_DEPTH;
      out.push(
        violation(
          atMax ? 'width-over-limit-at-max-depth' : 'width-over-limit',
          f.path,
          `${p} has ${f.contentFiles} content files (limit ${WIDTH_LIMIT}${atMax ? ', cannot split at max depth' : ''})`,
          { ...width, limit: WIDTH_LIMIT },
        ),
      );
    } else if (f.contentFiles > WIDTH_TARGET) {
      out.push(
        violation('width-over-target', f.path, `${p} has ${f.contentFiles} content files (target ${WIDTH_TARGET})`, {
          ...width,
          limit: WIDTH_TARGET,
        }),
      );
    }
    if (f.path !== '' && f.contentFiles === 0 && f.subfolders === 0) {
      out.push(violation('empty-folder', f.path, `${p} has no content files and no subfolders; remove it`));
    }
  }

  const described = new Set<string>();
  for (const m of scan.manifests) {
    if (m.contentPath === null) {
      out.push(violation('manifest-orphan', m.path, `${m.path} describes no content file; rename or remove it`));
      continue;
    }
    described.add(nfc(m.contentPath));
    if (m.result && !m.result.ok) out.push(...m.result.violations);
  }
  for (const c of scan.contentFiles) {
    if (!described.has(nfc(c))) {
      out.push(violation('manifest-missing', c, `${c}: no ${c}.manifest.json`));
    }
  }

  out.push(...glossaryConflicts(scan));
  out.push(...rootMapViolations(scan));

  out.sort(compareViolations);
  const errors = out.filter((v) => v.severity === 'error').length;
  return {
    violations: out,
    errors,
    warnings: out.length - errors,
    scanned: { folders: scan.folders.length, contentFiles: scan.contentFiles.length, manifests: scan.manifests.length },
  };
}

/**
 * One `glossary-conflict` warning per term (NFC, case-sensitive) that valid
 * manifests describe differently. Bank-wide finding: path `''`, detail = the
 * term, value = number of distinct descriptions.
 */
function glossaryConflicts(scan: BankScan): Violation[] {
  const byTerm = new Map<string, { descriptions: Set<string>; files: string[] }>();
  for (const m of scan.manifests) {
    if (!m.result?.ok || m.contentPath === null) continue;
    for (const [term, description] of m.result.manifest.glossary) {
      const key = nfc(term);
      const entry = byTerm.get(key) ?? { descriptions: new Set(), files: [] };
      entry.descriptions.add(nfc(description));
      entry.files.push(m.contentPath);
      byTerm.set(key, entry);
    }
  }
  const out: Violation[] = [];
  for (const [term, { descriptions, files }] of byTerm) {
    if (descriptions.size < 2) continue;
    const list = files.sort(compareCodePoints).join(', ');
    out.push(
      violation('glossary-conflict', '', `term "${term}" has ${descriptions.size} different descriptions in ${list}`, {
        detail: term,
        value: descriptions.size,
      }),
    );
  }
  return out;
}

/** Grammar (via the shared parser) plus coverage against the real folders (§5.2). */
function rootMapViolations(scan: BankScan): Violation[] {
  if (scan.rootMap === null) {
    return [violation('map-file-missing', ROOT_MAP_FILE, `root ${ROOT_MAP_FILE} is missing; create the root map`)];
  }
  const out: Violation[] = [];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(scan.rootMap);
  } catch {
    out.push(
      violation('map-structure', ROOT_MAP_FILE, `${ROOT_MAP_FILE} is not valid UTF-8`, { detail: 'encoding' }),
    );
    text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(scan.rootMap);
  }
  const map = parseRootMap(text);
  out.push(...map.violations);

  const folders = new Set(scan.folders.filter((f) => f.path !== '').map((f) => nfc(f.path)));
  const listed = new Set<string>();
  for (const e of map.entries) {
    const key = nfc(e.path);
    listed.add(key);
    if (!folders.has(key)) {
      out.push(violation('map-stale', e.path, `line ${e.line}: ${e.path} is not an existing folder; remove the line`));
    }
  }
  for (const f of scan.folders) {
    if (f.path !== '' && !listed.has(nfc(f.path))) {
      out.push(violation('map-missing', f.path, `${f.path} has no line in ${ROOT_MAP_FILE}; add one`));
    }
  }
  return out;
}

function compareViolations(a: Violation, b: Violation): number {
  return (
    compareCodePoints(nfc(a.path), nfc(b.path)) ||
    compareCodePoints(a.code, b.code) ||
    compareCodePoints(a.detail ?? '', b.detail ?? '')
  );
}
