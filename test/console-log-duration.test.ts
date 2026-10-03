import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/console-log.ts';

test('formatDuration picks a readable unit for each range', () => {
  assert.equal(formatDuration(850), '850ms');
  assert.equal(formatDuration(4_210), '4.2s');
  assert.equal(formatDuration(17 * 60_000 + 32_400), '17m 32s');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(formatDuration(3_600_000 + 3 * 60_000 + 10_000), '1h 03m');
});
