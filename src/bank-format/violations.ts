// Violation record and codes (contract §8.1, §8.3).

export type Severity = 'error' | 'warning';

/** Default severity of every code in §8.3. */
export const VIOLATION_SEVERITY = {
  'hidden-entry': 'error',
  symlink: 'error',
  'special-file': 'error',
  'nested-index': 'error',
  'depth-over-limit': 'error',
  'width-over-limit': 'error',
  'width-over-limit-at-max-depth': 'warning',
  'width-over-target': 'warning',
  'empty-folder': 'warning',
  'manifest-missing': 'error',
  'manifest-orphan': 'error',
  'manifest-json': 'error',
  'manifest-schema': 'error',
  'manifest-size': 'error',
  'map-file-missing': 'error',
  'map-structure': 'error',
  'map-line-syntax': 'error',
  'map-missing': 'error',
  'map-stale': 'error',
  'map-duplicate': 'error',
  'map-reserved': 'error',
  'map-desc-too-long': 'error',
  'map-order': 'warning',
  'map-size': 'warning',
  'glossary-conflict': 'warning',
} as const satisfies Record<string, Severity>;

export type ViolationCode = keyof typeof VIOLATION_SEVERITY;

export interface Violation {
  code: ViolationCode;
  severity: Severity;
  /** Folder/file the finding is about; `''` for the root. */
  path: string;
  /** E.g. a glossary term or manifest field: `glossary.LIPO`. Part of the identity key. */
  detail?: string;
  value?: number;
  limit?: number;
  /** Actionable, one line. */
  message: string;
}

export function violation(
  code: ViolationCode,
  path: string,
  message: string,
  extra: Pick<Violation, 'detail' | 'value' | 'limit'> = {},
): Violation {
  return { code, severity: VIOLATION_SEVERITY[code], path, ...extra, message };
}
