#!/usr/bin/env node
// End-to-end acceptance of the bank API against the BUILT server (dist/server.mjs).
//
//   node scripts/acceptance/run.mjs [--mode stub|live] [--out <dir>] [--no-build]
//                                   [--window-ms <ms>] [--env-file <path>] [--keep]
//
// stub (default): the full chain on a fresh temporary MEMORY_BANK_ROOT with a
//   scripted model (scripts/acceptance/openrouter-stub.mjs): create bank ->
//   durable 202 intake (JSON + multipart + URL) -> idempotent replay -> crash
//   and restart -> batching worker (default 60s window unless --window-ms) ->
//   format validation -> snapshot query -> spend stats -> archive/restore.
// live: one small real Librarian ingest and two real queries on synthetic data.
//   Needs OPENROUTER_API_KEY in the environment or --env-file <file>; the key is
//   handed to the server process only and never printed.
//
// Writes <out>/results.json (one entry per check, with evidence) and the
// server log. Exit 0 when nothing FAILED. A check whose endpoint is not
// deployed yet is SKIP, never PASS. The server is stopped by its own PID only.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const REPO = path.resolve(import.meta.dirname, '../..');
const NO_DATA = 'No relevant data found in the memory bank.';
const DEFAULT_WINDOW_MS = 60_000;

const { values: opt } = parseArgs({
  options: {
    mode: { type: 'string', default: 'stub' },
    out: { type: 'string' },
    'no-build': { type: 'boolean', default: false },
    'window-ms': { type: 'string' },
    'env-file': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
if (!['stub', 'live'].includes(opt.mode)) throw new Error(`--mode must be stub or live, got ${opt.mode}`);

const work = mkdtempSync(path.join(tmpdir(), `bank-acceptance-${opt.mode}-`));
const root = path.join(work, 'banks');
const out = path.resolve(opt.out ?? mkdtempSync(path.join(tmpdir(), 'bank-acceptance-evidence-')));
mkdirSync(out, { recursive: true });
const serverLog = path.join(out, `server-${opt.mode}.log`);
const stubLog = path.join(work, 'stub-calls.jsonl');
const windowMs = opt['window-ms'] ? Number(opt['window-ms']) : null;
const effectiveWindowMs = windowMs ?? DEFAULT_WINDOW_MS;

// ---------------------------------------------------------------- results

const results = [];
const started = Date.now();
function log(msg) {
  const line = `[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${msg}`;
  console.log(line);
}
function record(id, area, title, status, evidence) {
  results.push({ id, area, title, status, evidence });
  log(`${status.padEnd(4)} ${id} ${title}${status === 'PASS' ? '' : ` — ${JSON.stringify(evidence).slice(0, 400)}`}`);
}
/** Run fn; it returns evidence. Throwing = FAIL with the message; returning {skip} = SKIP. */
async function check(id, area, title, fn) {
  try {
    const ev = await fn();
    if (ev && ev.skip) return record(id, area, title, 'SKIP', ev.skip), null;
    record(id, area, title, 'PASS', ev ?? {});
    return ev;
  } catch (err) {
    record(id, area, title, 'FAIL', { error: err instanceof Error ? err.message : String(err), ...(err?.evidence ?? {}) });
    return null;
  }
}
function must(cond, message, evidence) {
  if (!cond) {
    const e = new Error(message);
    e.evidence = evidence === undefined ? {} : { detail: evidence };
    throw e;
  }
}

// ---------------------------------------------------------------- server

let server = null; // { child, pid, base }
let port = 0;

async function freePort() {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function serverEnv() {
  const env = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL']) if (process.env[k]) env[k] = process.env[k];
  env.PORT = String(port);
  env.MEMORY_BANK_ROOT = root;
  env.NO_COLOR = '1';
  if (windowMs !== null) env.MEMORY_BANK_INGESTION_WINDOW_MS = String(windowMs);
  if (opt.mode === 'stub') {
    env.OPENROUTER_API_KEY = 'stub-key-not-real';
    env.ACCEPTANCE_STUB_LOG = stubLog;
    env.ACCEPTANCE_STUB_DELAY_MS = '2500';
  } else if (process.env.OPENROUTER_API_KEY) {
    env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  }
  return env;
}

async function startServer(label) {
  const args = [];
  if (opt.mode === 'stub') args.push('--import', path.join(REPO, 'scripts/acceptance/openrouter-stub.mjs'));
  if (opt.mode === 'live' && opt['env-file']) args.push(`--env-file=${path.resolve(opt['env-file'])}`);
  args.push(path.join(REPO, 'dist/server.mjs'));
  appendFileSync(serverLog, `\n===== start (${label}) ${new Date().toISOString()}\n`);
  const child = spawn(process.execPath, args, { cwd: REPO, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => appendFileSync(serverLog, d));
  child.stderr.on('data', (d) => appendFileSync(serverLog, d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}; see ${serverLog}`);
    try {
      await fetch(`${base}/v1/banks?limit=1`);
      break;
    } catch {
      if (i > 600) throw new Error(`server did not start; see ${serverLog}`);
      await sleep(50);
    }
  }
  server = { child, pid: child.pid, base };
  log(`server up (${label}) pid=${child.pid} port=${port}`);
  return server;
}

/** Stop exactly the PID we started. SIGKILL simulates a crash. */
async function stopServer(signal = 'SIGTERM') {
  if (!server) return;
  const { child, pid } = server;
  server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  process.kill(pid, signal);
  const timer = setTimeout(() => child.exitCode === null && process.kill(pid, 'SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
  log(`server pid=${pid} stopped (${signal})`);
}

// ---------------------------------------------------------------- http helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, { json, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['content-type'] = 'application/json';
  } else if (form) {
    init.body = form;
  }
  const res = await fetch(`${server.base}${url}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

async function waitFor(desc, fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms waiting for ${desc}`);
    await sleep(1000);
  }
}

const TERMINAL = new Set(['succeeded', 'partial', 'failed']);
async function waitIngestion(bank, id, timeoutMs) {
  return waitFor(`${bank}/${id} terminal`, async () => {
    const r = await api('GET', `/v1/banks/${bank}/ingestions/${id}`);
    return TERMINAL.has(r.body?.status) ? r.body : null;
  }, timeoutMs);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (bank, ...args) => execFileSync('git', ['-C', path.join(root, bank), ...args], { encoding: 'buffer' });
const gitText = (bank, ...args) => git(bank, ...args).toString('utf8').trim();

function treeHashes(dir) {
  const outMap = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else outMap[path.relative(dir, p)] = sha256(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return outMap;
}

function validate(bank) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(REPO, 'src/bank-validator/cli.ts'), path.join(root, bank, 'fs'), '--json'], { encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

function stubCalls() {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function queryDeployed() {
  const r = await api('POST', '/v1/banks/__probe__/query', { json: {} });
  return r.status !== 404 || r.body?.error?.code !== 'not_found';
}

// ---------------------------------------------------------------- synthetic source server (URL items)

const PAGE = '<html><body><h1>Field trip</h1><p>ACCEPT-URL-7731 The bus leaves the depot at 07:40.</p></body></html>\n';
const sourceServer = createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/field-trip.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  } else {
    res.writeHead(404).end();
  }
});
const sourcePort = await new Promise((r) => sourceServer.listen(0, '127.0.0.1', () => r(sourceServer.address().port)));
const SOURCE_URL = `http://127.0.0.1:${sourcePort}/field-trip.html?token=acceptance-secret`;

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---------------------------------------------------------------- scenarios

async function stubScenario() {
  const hasQuery = await queryDeployed();
  const A = 'alpha';
  const B = 'beta';
  const G = 'gamma';
  const ev = {};

  // ---- banks
  await check('bank.create', 'banks', 'POST /v1/banks creates active banks (201) and scaffolds a git repo', async () => {
    const rs = [];
    for (const id of [A, B, G]) rs.push(await api('POST', '/v1/banks', { json: { id, name: `Acceptance ${id}`, description: 'synthetic' } }));
    must(rs.every((r) => r.status === 201 && r.body.status === 'active'), 'not all 201 active', rs.map((r) => [r.status, r.body]));
    must(existsSync(path.join(root, A, '.git')) && existsSync(path.join(root, A, 'fs', '_index.md')), 'no .git or fs/_index.md');
    return { statuses: rs.map((r) => r.status) };
  });
  await check('bank.errors', 'banks', 'duplicate id -> 409 bank_exists, bad id -> 400 invalid_bank_id', async () => {
    const dup = await api('POST', '/v1/banks', { json: { id: A } });
    const bad = await api('POST', '/v1/banks', { json: { id: 'Bad_ID' } });
    must(dup.status === 409 && dup.body.error.code === 'bank_exists', 'dup', dup);
    must(bad.status === 400 && bad.body.error.code === 'invalid_bank_id', 'bad', bad);
    return { dup: dup.body.error.code, bad: bad.body.error.code };
  });
  await check('bank.scaffold-valid', 'format', 'a freshly created bank passes the format validator', async () => {
    const rep = validate(A);
    must(rep.errors === 0, 'validator errors on fresh bank', rep);
    return { errors: rep.errors, warnings: rep.warnings };
  });
  if (hasQuery) {
    await check('query.no-revision', 'query', 'query on a bank with no completed revision: searchable=false, no model call', async () => {
      const before = stubCalls().length;
      const r = await api('POST', `/v1/banks/${G}/query`, { json: { question: 'Anything?' } });
      must(r.status === 200, 'status', r);
      must(r.body.processing?.searchable === false && r.body.processing?.reason === 'no_completed_revision', 'processing', r.body);
      must(r.body.revision === null && r.body.answer === NO_DATA && r.body.references.length === 0, 'body', r.body);
      must(stubCalls().length === before, 'model was called');
      return { processing: r.body.processing };
    });
  }

  // ---- intake
  const textA1 = '# Standup 2026-10-01\n\nACCEPT-A1-4471 Kestrel launch moved to 14 October.\n';
  const bodyA1 = { metadata: { source: 'acceptance' }, items: [{ type: 'text', text: textA1, filename: 'standup.md', mediaType: 'text/markdown' }] };
  const r1 = await check('intake.json-202', 'intake', 'JSON text intake answers 202 + Location, status queued', async () => {
    const r = await api('POST', `/v1/banks/${A}/ingestions`, { json: bodyA1, headers: { 'idempotency-key': 'acc-k1' } });
    must(r.status === 202 && r.body.status === 'queued' && r.headers.location === r.body.status_url, 'bad 202', r);
    ev.firstArrival = Date.now();
    return { id: r.body.id, location: r.headers.location };
  });
  const idA1 = r1?.id;
  await check('intake.idempotent-replay', 'intake', 'same Idempotency-Key + same payload -> same id, Idempotent-Replayed: true', async () => {
    const r = await api('POST', `/v1/banks/${A}/ingestions`, { json: bodyA1, headers: { 'idempotency-key': 'acc-k1' } });
    must(r.status === 202 && r.body.id === idA1 && r.headers['idempotent-replayed'] === 'true', 'no replay', r);
    return { id: r.body.id };
  });
  await check('intake.idempotent-conflict', 'intake', 'same key + different payload -> 409 idempotency_conflict', async () => {
    const r = await api('POST', `/v1/banks/${A}/ingestions`, {
      json: { items: [{ type: 'text', text: 'different' }] },
      headers: { 'idempotency-key': 'acc-k1' },
    });
    must(r.status === 409 && r.body.error.code === 'idempotency_conflict' && r.body.error.details.ingestionId === idA1, 'no conflict', r);
    return { code: r.body.error.code };
  });
  const fileA2 = Buffer.from('# Packing\n\nACCEPT-A2-9902 Bring the blue raincoat.\n');
  const textA2 = 'ACCEPT-A2T-5150 The dentist is on Thursday.';
  const r2 = await check('intake.multipart-202', 'intake', 'multipart file (md + png) + text + url intake answers 202', async () => {
    const form = new FormData();
    form.append('file', new Blob([fileA2], { type: 'text/markdown' }), 'packing.md');
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'dot.png');
    form.append('text', textA2);
    form.append('url', SOURCE_URL);
    form.append('metadata', JSON.stringify({ source: 'acceptance-multipart' }));
    const r = await api('POST', `/v1/banks/${A}/ingestions`, { form, headers: { 'idempotency-key': 'acc-k2' } });
    must(r.status === 202, 'not 202', r);
    const st = await api('GET', `/v1/banks/${A}/ingestions/${r.body.id}`);
    const kinds = st.body.items.map((i) => i.kind);
    must(JSON.stringify(kinds) === JSON.stringify(['file', 'file', 'text', 'url']), 'item kinds', kinds);
    must(st.body.items[0].sha256 === sha256(fileA2) && st.body.items[1].sha256 === sha256(PNG), 'stored hashes differ', st.body.items);
    return { id: r.body.id, kinds };
  });
  const idA2 = r2?.id;
  await check('intake.bad-requests', 'intake', 'unknown bank 404, bad content type 415, empty items 400', async () => {
    const nf = await api('POST', '/v1/banks/nope/ingestions', { json: bodyA1 });
    const ct = await api('POST', `/v1/banks/${A}/ingestions`, { headers: { 'content-type': 'text/plain' } });
    const empty = await api('POST', `/v1/banks/${A}/ingestions`, { json: { items: [] } });
    must(nf.status === 404 && nf.body.error.code === 'bank_not_found', 'nf', nf);
    must(ct.status === 415, 'ct', ct);
    must(empty.status === 400 && empty.body.error.code === 'validation_error', 'empty', empty);
    return { codes: [nf.body.error.code, ct.body.error?.code, empty.body.error.code] };
  });

  // ---- crash + restart before the window closes
  await check('intake.durable-restart', 'intake', 'after SIGKILL + restart, accepted requests survive and replay still returns the same id', async () => {
    const age = Date.now() - ev.firstArrival;
    must(age < effectiveWindowMs, `window already closed before the crash (${age}ms)`);
    await stopServer('SIGKILL');
    await startServer('after crash');
    const s1 = await api('GET', `/v1/banks/${A}/ingestions/${idA1}`);
    const s2 = await api('GET', `/v1/banks/${A}/ingestions/${idA2}`);
    must(s1.status === 200 && s2.status === 200, 'lost after restart', [s1, s2]);
    const replay = await api('POST', `/v1/banks/${A}/ingestions`, { json: bodyA1, headers: { 'idempotency-key': 'acc-k1' } });
    must(replay.body.id === idA1 && replay.headers['idempotent-replayed'] === 'true', 'replay after restart', replay);
    const holds = readdirSync(path.join(root, '.lifecycle/holds', A));
    return { crashedAfterMs: age, statuses: [s1.body.status, s2.body.status], holds };
  });

  // ---- second bank, parallel
  const textB1 = 'ACCEPT-B1-3307 Beta bank note about the boiler service.';
  const rb = await api('POST', `/v1/banks/${B}/ingestions`, { json: { items: [{ type: 'text', text: textB1, filename: 'boiler.md', mediaType: 'text/markdown' }] } });
  const idB1 = rb.body?.id;

  // ---- worker
  const workerUp = await (async () => {
    // Without a worker nothing ever leaves `queued`; give it two windows before deciding.
    const deadline = Date.now() + effectiveWindowMs * 2 + 30_000;
    while (Date.now() < deadline) {
      const s = await api('GET', `/v1/banks/${A}/ingestions/${idA1}`);
      if (s.body.status !== 'queued') return true;
      await sleep(1000);
    }
    return false;
  })();
  if (!workerUp) {
    record('worker.*', 'worker', 'ingestion worker processes queued requests', 'SKIP', { reason: `requests still queued after ${effectiveWindowMs * 2 + 30_000}ms; worker not deployed on this build` });
    return finishWithoutWorker({ A, G, hasQuery });
  }

  // while alpha's batch runs, queue one more request: it must wait for the next batch
  const textA3 = 'ACCEPT-A3-PENDING-6618 This note arrived while a batch was running.';
  const r3 = await api('POST', `/v1/banks/${A}/ingestions`, { json: { items: [{ type: 'text', text: textA3, filename: 'late.md', mediaType: 'text/markdown' }] } });
  const idA3 = r3.body.id;
  const a3PostedWhile = (await api('GET', `/v1/banks/${A}/ingestions/${idA1}`)).body.status;

  const doneA1 = await waitIngestion(A, idA1, 10 * 60_000);
  const doneA2 = await waitIngestion(A, idA2, 60_000);
  const doneB1 = await waitIngestion(B, idB1, 10 * 60_000);

  await check('worker.window', 'worker', `batch starts no earlier than the window (${effectiveWindowMs}ms${windowMs === null ? ', server default' : ''}) after the oldest arrival`, async () => {
    const waited = Date.parse(doneA1.startedAt) - Date.parse(doneA1.createdAt);
    must(waited >= effectiveWindowMs - 1000, `started after ${waited}ms`, doneA1);
    must(waited < effectiveWindowMs + 60_000, `started too late: ${waited}ms`, doneA1);
    return { waitedMs: waited, windowMs: effectiveWindowMs, defaultWindow: windowMs === null };
  });
  await check('worker.batch', 'worker', 'both alpha requests queued in one window ran as one batch with one revision', async () => {
    must(doneA1.status === 'succeeded' && doneA2.status === 'succeeded', 'not succeeded', [doneA1, doneA2]);
    must(/^[0-9a-f]{40}$/.test(doneA1.revision ?? '') && doneA1.revision === doneA2.revision, 'revisions', [doneA1.revision, doneA2.revision]);
    must(doneA2.items.every((i) => i.status === 'succeeded'), 'items', doneA2.items);
    return { revision: doneA1.revision, commits: doneA1.commits, attempts: doneA1.attempts };
  });
  await check('worker.parallel-banks', 'worker', 'alpha and beta batches run in parallel (time ranges overlap)', async () => {
    must(doneB1.status === 'succeeded', 'beta not succeeded', doneB1);
    const a = [Date.parse(doneA1.startedAt), Date.parse(doneA1.finishedAt)];
    const b = [Date.parse(doneB1.startedAt), Date.parse(doneB1.finishedAt)];
    must(a[0] < b[1] && b[0] < a[1], 'no overlap', { alpha: a, beta: b });
    return { alpha: [doneA1.startedAt, doneA1.finishedAt], beta: [doneB1.startedAt, doneB1.finishedAt] };
  });

  await check('intake.url-redacted', 'provenance', 'public status and history never echo URL credentials (token=... query value)', async () => {
    const one = await api('GET', `/v1/banks/${A}/ingestions/${idA2}`);
    const list = await api('GET', `/v1/banks/${A}/ingestions`);
    const leaked = [one, list].filter((r) => JSON.stringify(r.body).includes('acceptance-secret'));
    must(leaked.length === 0, 'URL secret visible in the public API', leaked.map((r) => JSON.stringify(r.body).slice(0, 600)));
    return { url: one.body.items.find((i) => i.kind === 'url')?.url };
  });

  // ---- what the batch wrote
  const revA = doneA1.revision;
  await check('ingest.revision-record', 'worker', 'completed revision = request revision = bank HEAD after the batch', async () => {
    const rec = JSON.parse(readFileSync(path.join(root, '.revisions', `${A}.json`), 'utf8'));
    must(rec.revision === revA && rec.by === 'worker', 'record', rec);
    return { record: rec };
  });
  await check('format.valid-after-ingest', 'format', 'bank after the batch: 0 validator errors, every content file has a manifest, root map lists notes/', async () => {
    const rep = validate(A);
    must(rep.errors === 0, 'validator errors', rep.violations);
    const idx = gitText(A, 'show', `${revA}:fs/_index.md`);
    must(idx.includes('- `notes/` — '), 'root map line', idx);
    const files = gitText(A, 'ls-tree', '-r', '--name-only', revA, 'fs/notes').split('\n');
    const content = files.filter((f) => !f.endsWith('.manifest.json'));
    must(content.length >= 5 && content.every((f) => files.includes(`${f}.manifest.json`)), 'manifests', files);
    return { errors: rep.errors, warnings: rep.warnings, scanned: rep.scanned, files };
  });
  const ingestCommit = await check('ingest.source-in-git', 'provenance', 'original bytes of every item are in the ingest commit, byte-exact', async () => {
    const log = gitText(A, 'log', '--format=%H%x00%B%x1e', revA).split('\x1e').map((s) => s.trim()).filter(Boolean);
    const ing = log.map((e) => e.split('\x00')).find(([, body]) => body.includes(`Ingestion-Item: ${idA1}/0`));
    must(ing, 'no ingest commit with Ingestion-Item trailer', log.slice(0, 3));
    const [sha, body] = ing;
    const raw = gitText(A, 'ls-tree', '-r', '--name-only', sha, 'fs/_raw').split('\n');
    const hashes = Object.fromEntries(raw.map((f) => [f, sha256(git(A, 'show', `${sha}:${f}`))]));
    const want = [sha256(Buffer.from(textA1)), sha256(fileA2), sha256(PNG), sha256(Buffer.from(textA2)), sha256(Buffer.from(PAGE))];
    const missing = want.filter((h) => !Object.values(hashes).includes(h));
    must(missing.length === 0, 'originals missing from ingest commit', { hashes, missing });
    return { commit: sha, raw, body };
  });
  await check('provenance.commit', 'provenance', 'ingest commit lists each source (inline/upload/url) with redacted URL secrets', async () => {
    must(ingestCommit, 'no ingest commit');
    const body = ingestCommit.body;
    if (!body.includes('Sources:')) return { skip: { reason: 'ingest commit has no Sources: block; provenance (Seq29) not deployed', body } };
    must(/"type":"url"/.test(body) && body.includes(`127.0.0.1:${sourcePort}/field-trip.html`), 'url source', body);
    must(!body.includes('acceptance-secret'), 'URL secret leaked into commit', body);
    must(/"type":"upload"/.test(body) && /"type":"inline"/.test(body), 'upload/inline', body);
    return { sources: body.split('\n').filter((l) => l.startsWith('- fs/_raw/')) };
  });
  await check('provenance.context', 'provenance', 'Librarian briefing carried the host-recorded source provenance', async () => {
    const calls = stubCalls().filter((c) => c.agent === 'librarian' && c.turn === 1);
    const withProv = calls.find((c) => c.prompt.includes('Source provenance'));
    if (!withProv) return { skip: { reason: 'no Librarian prompt contained a provenance section; provenance (Seq29) not deployed', librarianCalls: calls.length } };
    must(withProv.prompt.includes('field-trip.html') && !withProv.prompt.includes('acceptance-secret'), 'url in briefing', withProv.prompt.slice(0, 2000));
    return { librarianCalls: calls.length };
  });

  // ---- query over completed revision while A3 is pending
  const a3Now = (await api('GET', `/v1/banks/${A}/ingestions/${idA3}`)).body;
  if (hasQuery) {
    const headBefore = gitText(A, 'rev-parse', 'HEAD');
    const fsBefore = treeHashes(path.join(root, A, 'fs'));
    await check('query.completed-revision', 'query', 'query answers from the completed revision while newer work is pending', async () => {
      must(a3Now.status === 'queued', `late request not queued at query time (${a3Now.status}); the test needs it pending`, a3Now);
      const r = await api('POST', `/v1/banks/${A}/query`, { json: { question: 'When does the Kestrel launch happen?' } });
      must(r.status === 200, 'status', r);
      ev.query = r.body;
      must(r.body.revision === revA, 'revision', { got: r.body.revision, want: revA });
      must(r.body.processing.searchable === true && r.body.processing.revisionSource === 'worker', 'processing', r.body.processing);
      must(r.body.processing.pendingIngestions?.queued >= 1, 'pending count', r.body.processing);
      must(r.body.answer.includes('ACCEPT-A1-4471') && !r.body.answer.includes('ACCEPT-A3-PENDING'), 'answer must show completed data only', r.body.answer);
      return { revision: r.body.revision, processing: r.body.processing, references: r.body.references, meta: { unexpected_writes: r.body.meta?.unexpected_writes } };
    });
    await check('query.citations', 'query', 'references are real bank fs/ paths, never the snapshot path', async () => {
      must(ev.query, 'no query result');
      const refs = ev.query.references;
      must(refs.length > 0, 'no references');
      const fsRoot = path.join(root, A, 'fs');
      must(refs.every((x) => x.path.startsWith(fsRoot) && !x.path.includes('.query-snapshots')), 'paths', refs);
      return { references: refs };
    });
    await check('query.no-data', 'query', 'question with no data -> the no-data literal and no references', async () => {
      const r = await api('POST', `/v1/banks/${A}/query`, { json: { question: 'NO-DATA-PROBE What is the wifi password at the dacha?' } });
      must(r.status === 200 && r.body.answer === NO_DATA && r.body.references.length === 0, 'body', r.body);
      return { answer: r.body.answer };
    });
    await check('query.read-only', 'query', 'query writes nothing: bank HEAD and fs/ unchanged, snapshot attempt refused, snapshots cleaned', async () => {
      must(gitText(A, 'rev-parse', 'HEAD') === headBefore, 'HEAD moved');
      const fsAfter = treeHashes(path.join(root, A, 'fs'));
      must(JSON.stringify(fsAfter) === JSON.stringify(fsBefore), 'fs changed', { before: Object.keys(fsBefore), after: Object.keys(fsAfter) });
      must(!Object.keys(fsAfter).some((f) => f.includes('zz-tamper')), 'tamper file landed');
      must(ev.query?.meta?.unexpected_writes === 0, 'unexpected_writes', ev.query?.meta);
      const tamper = stubCalls().filter((c) => c.agent === 'retriever' && c.turn === 3).map((c) => c.lastToolResult);
      must(tamper.length > 0 && tamper.every((t) => /EACCES|read-only|permission/i.test(t)), 'snapshot write was not refused', tamper);
      const snaps = path.join(root, '.query-snapshots', A);
      const left = existsSync(snaps) ? readdirSync(snaps) : [];
      must(left.length === 0, 'snapshot dirs left', left);
      return { head: headBefore, snapshotsLeft: left.length, tamperRefusal: tamper[0] };
    });
    await check('query.validation', 'query', 'bad query body -> 400 validation_error; unknown bank -> 404', async () => {
      const bad = await api('POST', `/v1/banks/${A}/query`, { json: { question: '' } });
      const extra = await api('POST', `/v1/banks/${A}/query`, { json: { question: 'x', revision: 'HEAD' } });
      const nf = await api('POST', '/v1/banks/nope/query', { json: { question: 'x' } });
      must(bad.status === 400 && extra.status === 400 && nf.status === 404, 'codes', [bad, extra, nf]);
      return { codes: [bad.body.error.code, extra.body.error.code, nf.body.error.code] };
    });
  } else {
    record('query.*', 'query', 'POST /v1/banks/:bank/query', 'SKIP', { reason: 'route answers 404 not_found; query API (Seq28) not deployed' });
  }

  // ---- same-bank queue: A3 waited for the running batch and ran as its own batch
  const doneA3 = await waitIngestion(A, idA3, 10 * 60_000);
  await check('worker.same-bank-queue', 'worker', 'request accepted during a running batch waits and runs in the next batch', async () => {
    must(doneA3.status === 'succeeded', 'A3', doneA3);
    must(doneA3.revision !== revA, 'same revision as batch 1');
    must(Date.parse(doneA3.startedAt) >= Date.parse(doneA1.finishedAt), 'overlapping batches on one bank', { a1: doneA1.finishedAt, a3: doneA3.startedAt });
    return { postedWhileBatch1Was: a3PostedWhile, batch1: [doneA1.startedAt, doneA1.finishedAt], batch2: [doneA3.startedAt, doneA3.finishedAt], revision: doneA3.revision };
  });
  if (hasQuery) {
    await check('query.next-revision', 'query', 'after the next batch, the query sees the new revision and the late note', async () => {
      const r = await api('POST', `/v1/banks/${A}/query`, { json: { question: 'What arrived late?' } });
      must(r.body.revision === doneA3.revision && r.body.answer.includes('ACCEPT-A3-PENDING'), 'body', r.body);
      return { revision: r.body.revision };
    });
  }

  await statsChecks({ A, B });
  await archiveChecks({ G, hasQuery });
}

async function finishWithoutWorker({ A, G, hasQuery }) {
  await statsChecks({ A, B: 'beta' });
  await check('archive.holds-without-worker', 'archive', 'archive with accepted-but-unprocessed work -> 202 archiving, new intake 409', async () => {
    const r = await api('POST', `/v1/banks/${A}/archive`);
    must(r.status === 202 && r.body.status === 'archiving', 'archive', r);
    const intake = await api('POST', `/v1/banks/${A}/ingestions`, { json: { items: [{ type: 'text', text: 'late' }] } });
    must(intake.status === 409 && intake.body.error.code === 'bank_archiving', 'intake', intake);
    const restore = await api('POST', `/v1/banks/${A}/restore`);
    must(restore.status === 409 && restore.body.error.code === 'bank_archiving', 'restore while archiving', restore);
    await stopServer('SIGTERM');
    await startServer('archiving restart');
    const after = await api('GET', `/v1/banks/${A}`);
    must(after.body.status === 'archiving', 'archiving did not survive restart', after.body);
    return { archive: r.status, intake: intake.body.error.code, restore: restore.body.error.code, afterRestart: after.body.status };
  });
  await archiveEmpty(G);
}

async function archiveEmpty(G) {
  await check('archive.empty-roundtrip', 'archive', 'idle bank: archive 200 archived, restore 200 active, files and history unchanged', async () => {
    const head = gitText(G, 'rev-parse', 'HEAD');
    const files = treeHashes(path.join(root, G, 'fs'));
    const a = await api('POST', `/v1/banks/${G}/archive`);
    const listed = await api('GET', '/v1/banks?status=archived');
    const r = await api('POST', `/v1/banks/${G}/restore`);
    must(a.status === 200 && a.body.status === 'archived', 'archive', a);
    must(listed.body.banks.some((b) => b.id === G), 'not listed as archived', listed.body);
    must(r.status === 200 && r.body.status === 'active', 'restore', r);
    must(gitText(G, 'rev-parse', 'HEAD') === head && JSON.stringify(treeHashes(path.join(root, G, 'fs'))) === JSON.stringify(files), 'changed');
    return { head };
  });
}

async function statsChecks({ A, B }) {
  const getStats = async (url) => (await api('GET', url)).body;
  const sAll = await check('stats.global', 'stats', 'GET /v1/stats: today/week/month calendar periods, estimated cost labelled, model calls recorded', async () => {
    const s = await getStats('/v1/stats?timezone=UTC');
    must(s.scope === 'all_banks' && s.currency === 'USD' && s.week_starts_on === 'monday', 'header', s);
    const { today, week, month } = s.periods;
    must(today.start.endsWith('T00:00:00.000Z') && new Date(week.start).getUTCDay() === 1 && new Date(month.start).getUTCDate() === 1, 'period bounds (UTC)', { today: today.start, week: week.start, month: month.start });
    must(/estimat/i.test(s.coverage.cost_basis), 'cost basis label', s.coverage);
    return { periods: Object.fromEntries(Object.entries(s.periods).map(([k, p]) => [k, { start: p.start, end: p.end, calls: p.model.calls, estimated_cost_usd: p.model.estimated_cost_usd, reported_cost_usd: p.model.reported_cost_usd, calls_missing_cost: p.model.calls_missing_cost, by_agent: Object.fromEntries(Object.entries(p.model.by_agent).map(([a, x]) => [a, x.calls])), http: p.http.requests }])), coverage: s.coverage };
  });
  await check('stats.timezone', 'stats', 'timezone moves period boundaries (Asia/Jerusalem default), bad zone 400', async () => {
    const jer = await getStats('/v1/stats');
    const bad = await api('GET', '/v1/stats?timezone=%2B02:00');
    must(jer.timezone === 'Asia/Jerusalem' && !jer.periods.today.start.endsWith('T00:00:00.000Z'), 'default tz', jer.periods.today);
    must(bad.status === 400 && bad.body.error.code === 'validation_error', 'bad tz', bad);
    return { today: jer.periods.today };
  });
  await check('stats.per-bank', 'stats', 'GET /v1/banks/:bank/stats counts that bank only; banks add up', async () => {
    const a = await getStats(`/v1/banks/${A}/stats?timezone=UTC`);
    const b = await getStats(`/v1/banks/${B}/stats?timezone=UTC`);
    const all = await getStats('/v1/stats?timezone=UTC');
    must(a.scope === 'bank' && a.bank.name === A, 'scope', a);
    must(a.periods.month.model.calls + b.periods.month.model.calls <= all.periods.month.model.calls, 'sum', [a.periods.month.model, b.periods.month.model, all.periods.month.model]);
    return { alpha: a.periods.month.model, beta: { calls: b.periods.month.model.calls }, all: { calls: all.periods.month.model.calls } };
  });
  await check('stats.persist', 'stats', 'model spend survives a server restart (ledger on disk)', async () => {
    const before = (await getStats('/v1/stats?timezone=UTC')).periods.month.model;
    await stopServer('SIGTERM');
    await startServer('stats restart');
    const after = (await getStats('/v1/stats?timezone=UTC')).periods.month.model;
    must(before.calls === after.calls && before.estimated_cost_usd === after.estimated_cost_usd, 'changed across restart', { before, after });
    must(existsSync(path.join(root, '.accounting/ledger.jsonl')), 'no ledger file');
    return { calls: after.calls, estimated_cost_usd: after.estimated_cost_usd, calls_missing_cost: after.calls_missing_cost };
  });
  return sAll;
}

async function archiveChecks({ G, hasQuery }) {
  // seed gamma with one completed batch, then archive while a second request is still queued
  const seed = await api('POST', `/v1/banks/${G}/ingestions`, { json: { items: [{ type: 'text', text: 'ACCEPT-G1-2024 Gamma seed note.', filename: 'seed.md', mediaType: 'text/markdown' }] } });
  const seedDone = await waitIngestion(G, seed.body.id, 10 * 60_000);
  const pending = await api('POST', `/v1/banks/${G}/ingestions`, { json: { items: [{ type: 'text', text: 'ACCEPT-G2-2025 Accepted before archive.', filename: 'drain.md', mediaType: 'text/markdown' }] } });
  let headBefore;
  await check('archive.drain', 'archive', 'archive with queued work: 202 archiving, new intake/query 409, accepted work drains, then archived', async () => {
    const a = await api('POST', `/v1/banks/${G}/archive`);
    must(a.status === 202 && a.body.status === 'archiving', 'archive', a);
    const intake = await api('POST', `/v1/banks/${G}/ingestions`, { json: { items: [{ type: 'text', text: 'refused' }] } });
    must(intake.status === 409 && intake.body.error.code === 'bank_archiving', 'intake', intake);
    const restore = await api('POST', `/v1/banks/${G}/restore`);
    must(restore.status === 409, 'restore while archiving', restore);
    let q = null;
    if (hasQuery) {
      q = await api('POST', `/v1/banks/${G}/query`, { json: { question: 'x' } });
      must(q.status === 409 && q.body.error.code === 'bank_archiving', 'query', q);
    }
    const drained = await waitIngestion(G, pending.body.id, 10 * 60_000);
    must(drained.status === 'succeeded', 'accepted work not drained', drained);
    const bank = await waitFor('archived', async () => {
      const r = await api('GET', `/v1/banks/${G}`);
      return r.body.status === 'archived' ? r.body : null;
    }, 60_000);
    headBefore = gitText(G, 'rev-parse', 'HEAD');
    must(headBefore === drained.revision, 'drained revision is not HEAD', { headBefore, revision: drained.revision });
    return { seedRevision: seedDone.revision, drainedRevision: drained.revision, intake: intake.body.error.code, query: q?.body?.error?.code ?? 'n/a', archivedAt: bank.archivedAt };
  });
  await check('archive.restore', 'archive', 'restore -> active; files, git history and ingestion history unchanged; intake and query work again', async () => {
    const files = treeHashes(path.join(root, G, 'fs'));
    const histBefore = gitText(G, 'log', '--format=%H');
    const ingBefore = (await api('GET', `/v1/banks/${G}/ingestions`)).body.ingestions.map((i) => [i.id, i.status]);
    const archQuery = hasQuery ? await api('POST', `/v1/banks/${G}/query`, { json: { question: 'x' } }) : null;
    if (archQuery) must(archQuery.status === 409 && archQuery.body.error.code === 'bank_archived', 'query on archived', archQuery);
    const r = await api('POST', `/v1/banks/${G}/restore`);
    must(r.status === 200 && r.body.status === 'active', 'restore', r);
    must(gitText(G, 'log', '--format=%H') === histBefore, 'history changed');
    must(JSON.stringify(treeHashes(path.join(root, G, 'fs'))) === JSON.stringify(files), 'files changed');
    const ingAfter = (await api('GET', `/v1/banks/${G}/ingestions`)).body.ingestions.map((i) => [i.id, i.status]);
    must(JSON.stringify(ingAfter) === JSON.stringify(ingBefore), 'ingestion history changed');
    const intake = await api('POST', `/v1/banks/${G}/ingestions`, { json: { items: [{ type: 'text', text: 'after restore' }] } });
    must(intake.status === 202, 'intake after restore', intake);
    let q = null;
    if (hasQuery) {
      q = await api('POST', `/v1/banks/${G}/query`, { json: { question: 'What did gamma accept before archive?' } });
      must(q.status === 200 && q.body.revision === headBefore && q.body.answer.includes('ACCEPT-G2-2025'), 'query after restore', q.body);
    }
    const st = await api('GET', `/v1/banks/${G}/stats`);
    must(st.status === 200, 'stats of restored bank', st);
    return { head: headBefore, commits: histBefore.split('\n').length, ingestions: ingAfter.length, queryRevision: q?.body?.revision ?? 'n/a' };
  });
}

async function liveScenario() {
  must(process.env.OPENROUTER_API_KEY || opt['env-file'], 'live mode needs OPENROUTER_API_KEY or --env-file');
  const L = 'live-notes';
  const fact = '# Household notes\n\nThe plumber Arkady Volkov will replace the kitchen mixer tap on 17 November 2026 at 10:00. Price agreed: 180 EUR.\n';
  await check('live.create', 'live', 'create bank', async () => {
    const r = await api('POST', '/v1/banks', { json: { id: L, name: 'Live acceptance' } });
    must(r.status === 201, 'create', r);
  });
  const acc = await api('POST', `/v1/banks/${L}/ingestions`, { json: { items: [{ type: 'text', text: fact, filename: 'plumber.md', mediaType: 'text/markdown' }] } });
  const done = await check('live.ingest', 'live', 'real Librarian files one note through the worker; bank passes the validator', async () => {
    must(acc.status === 202, 'intake', acc);
    const d = await waitIngestion(L, acc.body.id, 20 * 60_000);
    must(d.status === 'succeeded', 'ingestion', d);
    const rep = validate(L);
    must(rep.errors === 0, 'validator errors', rep.violations);
    const tree = gitText(L, 'ls-tree', '-r', '--name-only', d.revision, 'fs').split('\n');
    return { revision: d.revision, waitedMs: Date.parse(d.startedAt) - Date.parse(d.createdAt), runMs: Date.parse(d.finishedAt) - Date.parse(d.startedAt), tree, warnings: rep.warnings };
  });
  if (!(await queryDeployed())) {
    record('live.query', 'live', 'real queries', 'SKIP', { reason: 'query API not deployed' });
  } else {
    await check('live.query-answer', 'live', 'real query answers from the bank with a citation', async () => {
      const r = await api('POST', `/v1/banks/${L}/query`, { json: { question: 'When is the plumber coming and how much will it cost?' } });
      must(r.status === 200 && r.body.revision === done?.revision, 'status/revision', r.body);
      must(/17/.test(r.body.answer) && /180/.test(r.body.answer), 'answer lacks the fact', r.body.answer);
      must(r.body.references.length > 0 && r.body.references.every((x) => x.path.startsWith(path.join(root, L, 'fs'))), 'refs', r.body.references);
      return { answer: r.body.answer, references: r.body.references, cost: r.body.meta?.cost };
    });
    await check('live.query-missing', 'live', 'real query about absent data does not invent an answer', async () => {
      const r = await api('POST', `/v1/banks/${L}/query`, { json: { question: "What is the plumber's phone number?" } });
      must(r.status === 200, 'status', r);
      must(!/\+?\d[\d\s()-]{6,}\d/.test(r.body.answer), 'answer contains an invented phone number', r.body.answer);
      return { answer: r.body.answer, references: r.body.references, literal: r.body.answer === NO_DATA };
    });
  }
  await check('live.stats', 'live', 'real spend recorded per bank with an estimated cost', async () => {
    const s = (await api('GET', `/v1/banks/${L}/stats`)).body;
    const m = s.periods.today.model;
    must(m.calls >= 1 && m.estimated_cost_usd > 0, 'no spend', m);
    return { calls: m.calls, by_agent: Object.fromEntries(Object.entries(m.by_agent).map(([k, v]) => [k, { calls: v.calls, estimated_cost_usd: v.estimated_cost_usd }])), estimated_cost_usd: m.estimated_cost_usd, reported_cost_usd: m.reported_cost_usd, calls_missing_cost: m.calls_missing_cost, tokens: m.tokens };
  });
}

// ---------------------------------------------------------------- main

let exitCode = 1;
try {
  if (!opt['no-build']) {
    log('building dist/ (vite build)');
    execFileSync(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'], { cwd: REPO, stdio: 'inherit' });
  }
  port = await freePort();
  log(`mode=${opt.mode} root=${root} window=${windowMs ?? 'server default'}`);
  await startServer('initial');
  if (opt.mode === 'stub') await stubScenario();
  else await liveScenario();
  exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
} catch (err) {
  record('harness', 'harness', 'harness crashed', 'FAIL', { error: err instanceof Error ? err.stack : String(err) });
} finally {
  await stopServer('SIGTERM').catch(() => {});
  sourceServer.close();
  const summary = {
    mode: opt.mode,
    commit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    window: windowMs ?? `default (${DEFAULT_WINDOW_MS}ms)`,
    counts: Object.fromEntries(['PASS', 'FAIL', 'SKIP'].map((s) => [s, results.filter((r) => r.status === s).length])),
    results,
  };
  writeFileSync(path.join(out, `results-${opt.mode}.json`), JSON.stringify(summary, null, 2));
  log(`${JSON.stringify(summary.counts)} -> ${path.join(out, `results-${opt.mode}.json`)}`);
  if (!opt.keep) rmSync(work, { recursive: true, force: true });
  else log(`kept ${work}`);
  process.exit(exitCode);
}
