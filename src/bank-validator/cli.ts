// Standalone check of one bank, read-only:
//   node src/bank-validator/cli.ts <bank fs/ path> [--json] [--baseline <report.json>]
// Exit 0: no errors (with --baseline: no new errors). 1: errors. 2: usage or crash.
// --baseline takes a file written earlier with --json.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { compareWithBaseline, shown, validateBank, type BankValidationReport } from './index.ts';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean' }, baseline: { type: 'string' } },
  });
  if (positionals.length !== 1) {
    console.error('usage: node src/bank-validator/cli.ts <bank fs/ path> [--json] [--baseline <report.json>]');
    return 2;
  }
  const report = await validateBank(positionals[0]);
  const baseline = values.baseline
    ? (JSON.parse(await readFile(values.baseline, 'utf8')) as BankValidationReport).violations
    : null;
  const compared = baseline ? compareWithBaseline(report.violations, baseline) : null;

  if (values.json) {
    console.log(JSON.stringify(compared ? { ...report, violations: compared.violations } : report, null, 2));
  } else {
    for (const v of compared?.violations ?? report.violations) {
      const mark = 'new' in v ? (v.new ? ' NEW' : '') : '';
      const where = v.message.startsWith(shown(v.path)) ? '' : `${shown(v.path)}: `;
      console.log(`${v.severity}${mark} [${v.code}] ${where}${v.message}`);
    }
    const { folders, contentFiles, manifests } = report.scanned;
    console.log(
      `${report.errors} errors, ${report.warnings} warnings` +
        (compared ? `, ${compared.blocking.length} new errors` : '') +
        ` (${folders} folders, ${contentFiles} content files, ${manifests} manifests)`,
    );
  }
  return (compared ? compared.blocking.length : report.errors) > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
