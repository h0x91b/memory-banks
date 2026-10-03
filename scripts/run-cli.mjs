#!/usr/bin/env node
/**
 * Run one agent pipeline (ingest/briefing → agent → report) from the command
 * line, without starting the HTTP server:
 *
 *   node scripts/run-cli.mjs curator '{"bank":"demo","items":[...]}'
 *   node scripts/run-cli.mjs retriever '{"bank":"demo","question":"..."}'
 *
 * The pipeline modules are loaded through Vite's module runner (TypeScript and
 * `.md` role imports work as in the server build) and run against an
 * in-process Flue runtime. The JSON report goes to stdout; activity logs go
 * to stderr.
 */
import { readFile } from 'node:fs/promises';
import { createServer, createServerModuleRunner } from 'vite';

/**
 * `.md` imports resolve to their text, matching what the Flue Vite plugin does
 * for non-skill markdown. The Flue plugin itself is deliberately not loaded
 * here: its dev bootstrap registers its own copies of the agent functions,
 * which would shadow the ones `start()` registers below.
 */
function markdownAsText() {
  return {
    name: 'memory-banks:markdown-as-text',
    async load(id) {
      if (!id.endsWith('.md')) return null;
      return `export default ${JSON.stringify(await readFile(id, 'utf8'))};`;
    },
  };
}

const [name, rawPayload = '{}', runId = 'cli'] = process.argv.slice(2);
if (name !== 'curator' && name !== 'retriever') {
  console.error('usage: run-cli.mjs <curator|retriever> <json-payload> [run-id]');
  process.exit(2);
}

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'warn',
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [markdownAsText()],
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
let exitCode = 0;
try {
  const { runCli } = await runner.import('/src/cli.ts');
  const report = await runCli(name, JSON.parse(rawPayload), runId);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await runner.close();
  await server.close();
}
process.exit(exitCode);
