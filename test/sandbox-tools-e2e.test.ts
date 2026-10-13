/**
 * src/sandbox-tools.ts over the real bank sandbox (src/bash-factory.ts):
 * paging returns the whole file with nothing dropped, and neither the paged
 * `read` nor the head-keeping `bash` can reach a file outside the bank's fs/.
 * Loaded through Vite's module runner, as scripts/run-cli.mjs does.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const repo = mkdtempSync(path.join(tmpdir(), 'paged-read-'));
const fsPath = path.join(repo, 'fs');
const BIG = Array.from({ length: 6000 }, (_, i) => `строка ${i} ${'ж'.repeat(i % 120)}`).join('\n') + '\n';

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let env: any;
let tools: typeof import('../src/sandbox-tools.ts');

before(async () => {
  mkdirSync(path.join(fsPath, '_raw'), { recursive: true });
  writeFileSync(path.join(repo, 'outside-secret.txt'), 'top secret\n');
  writeFileSync(path.join(fsPath, '_raw', 'big.txt'), BIG);
  server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  const factory: typeof import('../src/bash-factory.ts') = await runner.import('/src/bash-factory.ts');
  const flue: typeof import('@flue/runtime') = await runner.import('@flue/runtime');
  tools = await runner.import('/src/sandbox-tools.ts');
  env = await flue.bash(factory.createBankBashFactory({ bank: 'paged', bankFsPath: fsPath, log: { info() {}, warn() {}, error() {}, debug() {} } } as any)).createSandbox({ id: 'paged' });
});

after(async () => {
  await runner?.close();
  await server?.close();
  rmSync(repo, { recursive: true, force: true });
});

const text = (r: any) => r.content[0].text as string;
const body = (t: string) => t.slice(t.indexOf(']\n') + 2, t.lastIndexOf('\n[') + 1);

test('paging a large bank file returns every character exactly once', async () => {
  const read = tools.createPagedReadTool(env) as any;
  const first = text(await read.execute('r1', { path: '/_raw/big.txt' }));
  const total = Number(first.match(/page 1 of (\d+)/)![1]);
  assert.ok(total >= 2);
  const pages = [first];
  for (let p = 2; p <= total; p++) pages.push(text(await read.execute(`r${p}`, { path: '/_raw/big.txt', page: p })));
  assert.equal(pages.map(body).join(''), BIG);
});

test('read cannot reach a file outside the bank fs root', async () => {
  const read = tools.createPagedReadTool(env) as any;
  for (const p of ['/../outside-secret.txt', '../outside-secret.txt', path.join(repo, 'outside-secret.txt')]) {
    const out = await read.execute('esc', { path: p }).then(text, (e: Error) => `error: ${e.message}`);
    assert.doesNotMatch(out, /top secret/, `read escaped via ${p}`);
  }
});

test('bash cannot reach it either, and keeps the start of a long output', async () => {
  const sh = tools.createHeadBashTool(env) as any;
  const esc = text(await sh.execute('b1', { command: 'cat ../outside-secret.txt; cat /../outside-secret.txt' }));
  assert.doesNotMatch(esc, /top secret/);
  const long = text(await sh.execute('b2', { command: 'cat /_raw/big.txt' }));
  assert.ok(long.startsWith('строка 0 \nстрока 1 ж\n'));
  assert.match(long, /\[Output cut: showed the first/);
});

test('withPagedTools swaps only read and bash in the standard tool set', async () => {
  const flue: typeof import('@flue/runtime') = await runner.import('@flue/runtime');
  const factory = tools.withPagedTools({ createSandbox: async () => env });
  const list = factory.tools!(env, { subagents: {} }) as any[];
  assert.deepEqual(list.map((t) => t.name), ['read', 'write', 'edit', 'bash', 'grep', 'glob']);
  assert.match(list[0].description, /page=N/);
  assert.match(list[3].description, /keeps its start/);
  assert.equal(list[1].name, flue.createWriteTool(env).name);
});
