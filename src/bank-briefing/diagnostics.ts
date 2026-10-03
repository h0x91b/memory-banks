// Run-log findings of the briefing generator. They never fail a run: the
// generator is tolerant, the validator is strict (contract §6).

export type BriefingDiagnosticCode =
  | 'manifest-skipped'
  | 'manifest-orphan'
  | 'glossary-conflict'
  | 'glossary-over-budget'
  | 'map-missing'
  | 'map-invalid'
  | 'map-over-budget'
  | 'open-questions-unreadable'
  | 'scan-failed';

export interface BriefingDiagnostic {
  code: BriefingDiagnosticCode;
  /** Bank-relative path the finding is about; `''` for the whole bank. */
  path: string;
  /** One line, ready for the run log. */
  message: string;
  /** E.g. the glossary term, or the manifest's violation codes. */
  detail?: string;
}
