// The worker against the real durable store and bank registry: an archived
// bank's previously accepted work is drained, results are persisted, and the
// bank only becomes archived once the last hold is released. Fake ingest and
// curate steps, no model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'ingestion-worker-store-'));
process.env.MEMORY_BANK_ROOT = root;
delete process.env.MEMORY_BANK_INGESTION_DIR;

const { rawDir } = await import('../src/bank.ts');
const { gitCommitAll } = await import('../src/git.ts');
const { BankRegistry } = await import('../src/banks/registry.ts');
const { IngestionStore } = await import('../src/ingestions/store.ts');
const { IngestionWorker } = await import('../src/ingestion-worker/worker.ts');
const { ManualClock, settle } = await import('./fixtures/fake-ingestion-store.ts');

test('archiving bank: accepted work is drained, persisted, then the bank settles to archived', async () => {
  const registry = new BankRegistry();
  const store = new IngestionStore(registry);
  await registry.create({ id: 'drain' });
  const { record } = await store.accept({
    bank: 'drain',
    items: [{ kind: 'text', bytes: Buffer.from('keep me'), filename: 'keep.md' }],
  });

  assert.equal((await registry.archive('drain')).status, 'archiving', 'the durable hold keeps it archiving');
  await assert.rejects(
    store.accept({ bank: 'drain', items: [{ kind: 'text', bytes: Buffer.from('late') }] }),
    (err: any) => err.code === 'bank_archiving',
    'no new admissions while draining',
  );

  const clock = new ManualClock(Date.now());
  const worker = new IngestionWorker({
    store,
    clock,
    bankStatus: (b) => registry.lookup(b),
    log: () => {},
    ingest: async (bank, item: any) => {
      await fs.mkdir(rawDir(bank), { recursive: true });
      const dest = path.join(rawDir(bank), item.filename);
      await fs.writeFile(dest, item.content);
      return { rawPath: dest, sourceLabel: dest };
    },
    curate: async (bank) => {
      const notes = path.join(root, bank, 'fs', 'notes');
      mkdirSync(notes, { recursive: true });
      for (const f of readdirSync(rawDir(bank))) await fs.rename(path.join(rawDir(bank), f), path.join(notes, f));
      const sha = await gitCommitAll(path.join(root, bank), 'curate: filed');
      return { commits: sha ? [sha] : [] };
    },
  });
  await worker.start();
  await clock.advance(60_000);
  await settle();
  await worker.idle();

  const done = await store.get('drain', record.id);
  assert.equal(done!.status, 'succeeded');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, 'drain'), encoding: 'utf8' }).trim();
  assert.equal(done!.revision, head);
  assert.equal((done as any).commits.length, 2);
  assert.equal((await registry.get('drain'))!.status, 'archived');
  await worker.stop();
});

test('persisted item errors show a failed URL only redacted', async () => {
  const registry = new BankRegistry();
  const store = new IngestionStore(registry);
  await registry.create({ id: 'secrets' });
  const url = 'https://carol:s3cr3tpw@example.test/doc?X-Amz-Signature=SIGVAL&page=4';
  const { record } = await store.accept({ bank: 'secrets', items: [{ kind: 'url', url }] });

  const clock = new ManualClock(Date.now());
  const worker = new IngestionWorker({
    store,
    clock,
    log: () => {},
    fetch: async () => new Response('nope', { status: 403 }),
    ingest: async () => assert.fail('nothing to ingest'),
    curate: async () => assert.fail('nothing to curate'),
  });
  await worker.start();
  await clock.advance(60_000);
  await settle();
  await worker.idle();

  const done = await store.get('secrets', record.id);
  assert.equal(done!.status, 'failed');
  assert.deepEqual(done!.items[0].error, {
    code: 'download_failed',
    message: 'fetch https://redacted@example.test/doc?X-Amz-Signature=redacted&page=4 → HTTP 403',
  });
  await worker.stop();
});
