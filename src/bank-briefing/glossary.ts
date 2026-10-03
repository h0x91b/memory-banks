// Generated glossary (contract §6): built by code from valid manifest
// sidecars, never written by a model. Pure: works on an existing scan.
import { codePointLength, compareCodePoints, GLOSSARY_BLOCK_MAX, nfc, SEPARATOR } from '../bank-format/index.ts';
import type { ScannedManifest } from '../bank-validator/index.ts';
import type { BriefingDiagnostic } from './diagnostics.ts';

export const GLOSSARY_HEADING = '## Glossary (generated from manifests)';
export const GLOSSARY_EMPTY = '(none)';

export interface GlossaryLine {
  /** Term as written in the manifest, NFC. */
  term: string;
  /** Description, NFC. */
  description: string;
  /** Content file the manifest describes, as on disk. */
  path: string;
  /** Rendered line: `TERM — description (path)`. */
  text: string;
}

export interface Glossary {
  /** Heading, blank line, then one line per (manifest, term) or `(none)`. */
  block: string;
  lines: GlossaryLine[];
  manifestsUsed: number;
  /** One `manifest-skipped` / `manifest-orphan` per manifest left out. */
  skipped: BriefingDiagnostic[];
}

/** `ЁЖ` → `ЁЖ / ЕЖ`, so a search for either spelling is obvious (§6, D9). Other terms unchanged. */
export function glossaryTermField(term: string): string {
  const t = nfc(term);
  if (!/[ёЁ]/.test(t)) return t;
  return `${t} / ${t.replace(/ё/g, 'е').replace(/Ё/g, 'Е')}`;
}

/** §6 order: lower-cased NFC term, then term, then path, all by code points. */
function compareLines(a: GlossaryLine, b: GlossaryLine): number {
  return (
    compareCodePoints(a.term.toLowerCase(), b.term.toLowerCase()) ||
    compareCodePoints(a.term, b.term) ||
    compareCodePoints(nfc(a.path), nfc(b.path)) ||
    compareCodePoints(a.path, b.path) ||
    compareCodePoints(a.description, b.description)
  );
}

/**
 * Builds the glossary block from scanned manifests. Orphans and manifests that
 * failed to parse are skipped with a diagnostic; the result does not depend on
 * the order of `manifests`.
 */
export function buildGlossary(manifests: readonly ScannedManifest[]): Glossary {
  const lines: GlossaryLine[] = [];
  const skipped: BriefingDiagnostic[] = [];
  let manifestsUsed = 0;
  for (const m of manifests) {
    if (m.contentPath === null || m.result === null) {
      skipped.push({
        code: 'manifest-orphan',
        path: m.path,
        message: `${m.path} describes no content file; left out of the glossary`,
      });
      continue;
    }
    if (!m.result.ok) {
      const codes = [...new Set(m.result.violations.map((v) => v.code))].sort(compareCodePoints).join(',');
      skipped.push({
        code: 'manifest-skipped',
        path: m.path,
        detail: codes,
        message: `${m.path} is invalid (${m.result.violations[0]?.message ?? codes}); left out of the glossary`,
      });
      continue;
    }
    manifestsUsed++;
    for (const [rawTerm, rawDescription] of m.result.manifest.glossary) {
      const term = nfc(rawTerm);
      const description = nfc(rawDescription);
      lines.push({
        term,
        description,
        path: m.contentPath,
        text: `${glossaryTermField(term)}${SEPARATOR}${description} (${m.contentPath})`,
      });
    }
  }
  lines.sort(compareLines);
  skipped.sort((a, b) => compareCodePoints(nfc(a.path), nfc(b.path)) || compareCodePoints(a.path, b.path));

  const body = lines.length === 0 ? GLOSSARY_EMPTY : lines.map((l) => l.text).join('\n');
  const block = `${GLOSSARY_HEADING}\n\n${body}`;
  const size = codePointLength(block);
  if (size > GLOSSARY_BLOCK_MAX) {
    // D10: injected in full anyway; this is only a run-log warning.
    skipped.push({
      code: 'glossary-over-budget',
      path: '',
      message: `glossary is ${size} code points (budget ${GLOSSARY_BLOCK_MAX}); injected in full`,
    });
  }
  return { block, lines, manifestsUsed, skipped };
}
