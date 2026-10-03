// Bank briefing/glossary generator, contract v1 (docs/design/bank-format.md
// §5.3, §6). Read-only. Not wired into any agent yet; agents call
// buildBankBriefing(fsPath, { role }) and inject `.text`.
export * from './diagnostics.ts';
export * from './glossary.ts';
export * from './briefing.ts';
