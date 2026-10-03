import { test } from 'node:test';
import assert from 'node:assert/strict';
import { violation, type Violation } from '../src/bank-format/index.ts';
import { createSubmitGate, rejectionMessage } from '../src/librarian-gate.ts';

const missing = (i: number) => violation('manifest-missing', `n/${i}.md`, `n/${i}.md: no n/${i}.md.manifest.json`);
const report = (violations: Violation[]) => ({ violations, errors: violations.length, warnings: 0, scanned: { folders: 1, contentFiles: 0, manifests: 0 } });

test('rejection message lists at most REJECTION_LIST_MAX lines, then the remainder count', () => {
  const blocking = Array.from({ length: 23 }, (_, i) => missing(i));
  const lines = rejectionMessage(blocking, 1).split('\n');
  assert.equal(lines[0], 'Bank validation failed (rejection 1 of 3): 23 new violations.');
  assert.equal(lines.filter((l) => l.startsWith('- [manifest-missing]')).length, 20);
  assert.equal(lines.at(-2), '…and 3 more');
  assert.equal(lines.at(-1), 'Fix these and call submit_result again.');
});

test('singular count and last-chance wording on the third rejection', () => {
  const msg = rejectionMessage([missing(1)], 3);
  assert.match(msg, /^Bank validation failed \(rejection 3 of 3\): 1 new violation\.\n/);
  assert.match(msg, /The next submit_result will be accepted even with violations; fix what you can\.$/);
});

test('gate: pre-existing errors pass, new ones reject three times, the fourth is accepted', async () => {
  let current = [missing(1)];
  const gate = createSubmitGate('/unused', { violations: [missing(1)] }, async () => report(current));
  const first = await gate.check();
  assert.equal(first.accept, true);
  assert.equal(first.accept && first.outcome.status, 'passed');
  assert.deepEqual(first.accept && first.outcome.violations.map((v) => v.new), [false]);

  current = [missing(1), missing(2)];
  for (let i = 1; i <= 3; i++) {
    const d = await gate.check();
    assert.equal(d.accept, false);
    assert.match(!d.accept ? d.message : '', new RegExp(`rejection ${i} of 3`));
  }
  const fourth = await gate.check();
  assert.equal(fourth.accept && fourth.outcome.status, 'accepted-with-violations');
  assert.equal(fourth.accept && fourth.outcome.rejections, 3);
  assert.deepEqual(gate.outcome(), fourth.accept ? fourth.outcome : null);
});

test('gate: a throwing validator accepts with validator-error and empty violations', async () => {
  const gate = createSubmitGate('/unused', { violations: [] }, async () => {
    throw new Error('boom');
  });
  const d = await gate.check();
  assert.deepEqual(d.accept && { status: d.outcome.status, violations: d.outcome.violations, error: d.outcome.error }, {
    status: 'validator-error',
    violations: [],
    error: 'boom',
  });
});

test('gate: a failed baseline accepts with validator-error without validating', async () => {
  let called = false;
  const gate = createSubmitGate('/unused', { error: 'EACCES' }, async () => {
    called = true;
    return report([]);
  });
  const d = await gate.check();
  assert.equal(d.accept && d.outcome.status, 'validator-error');
  assert.equal(called, false);
});
