import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SEQUENCE,
  classifyBash,
  commandWords,
  sandboxPath,
  summarizeToolStarts,
  type ToolStart,
} from '../src/retriever-telemetry.ts';

const FS = '/banks/demo/fs';
const summarize = (starts: ToolStart[], recordedToolCalls = starts.length) =>
  summarizeToolStarts(starts, { fsPath: FS, briefing: 'héllo', recordedToolCalls, resultTool: 'submit_result' });

test('commandWords finds the command of every pipeline segment', () => {
  assert.deepEqual(commandWords("cd /notes && rg -n 'a|b' . | head -5"), ['cd', 'rg', 'head']);
  assert.deepEqual(commandWords('LC_ALL=C find . -name "*.md" | xargs -0 grep -l x'), ['find', 'grep']);
  assert.deepEqual(commandWords('/usr/bin/cat a.md; ls'), ['cat', 'ls']);
  assert.deepEqual(commandWords('echo $(cat a.md)'), ['echo', 'cat']);
});

test('classifyBash labels by command words, not by every bash call', () => {
  assert.deepEqual(classifyBash("rg -n 'Ann' /people"), ['search']);
  assert.deepEqual(classifyBash('cat /a.md'), ['read']);
  assert.deepEqual(classifyBash('ls -la /notes'), ['list']);
  assert.deepEqual(classifyBash("grep -rl x . | xargs head -3"), ['search', 'read']);
  assert.deepEqual(classifyBash('echo hi'), []);
  // A file named like a command is an argument, not a command word.
  assert.deepEqual(classifyBash('echo grep cat'), []);
});

test('sandboxPath maps host-absolute, sandbox-absolute and relative paths onto /', () => {
  assert.equal(sandboxPath(`${FS}/people/ann.md`, FS), '/people/ann.md');
  assert.equal(sandboxPath('/people/ann.md', FS), '/people/ann.md');
  assert.equal(sandboxPath('people/ann.md', FS), '/people/ann.md');
  assert.equal(sandboxPath('./people/ann.md', FS), '/people/ann.md');
  assert.equal(sandboxPath(undefined, FS), '/');
  assert.equal(sandboxPath('.', FS), '/');
});

test('summary keeps read order with repeats and counts each tool exactly', () => {
  const t = summarize([
    { tool: 'read', args: { path: '/_index.md' } },
    { tool: 'grep', args: { pattern: 'secret question words', path: '/people' } },
    { tool: 'bash', args: { command: "rg -n Ann . | head -3" } },
    { tool: 'read', args: { path: 'people/ann.md' } },
    { tool: 'glob', args: { pattern: '*.md' } },
    { tool: 'read', args: { path: '/_index.md', offset: 10 } },
    { tool: 'bash', args: { command: 'echo done' } },
    { tool: 'submit_result', args: { answer: 'x', references: [] } },
  ]);
  assert.equal(t.complete, true);
  assert.equal(t.briefing_bytes, 6); // UTF-8 bytes, not string length
  assert.deepEqual(t.tool_calls, { read: 3, grep: 1, glob: 1, bash: 2, other: 0 });
  assert.deepEqual(t.read_paths, ['/_index.md', '/people/ann.md', '/_index.md']);
  assert.deepEqual(t.bash_heuristic, { search: 1, read: 1, list: 0, unclassified: 1 });
  assert.deepEqual(t.operations, [
    { tool: 'read', path: '/_index.md' },
    { tool: 'grep', path: '/people' },
    { tool: 'bash', kinds: ['search', 'read'] },
    { tool: 'read', path: '/people/ann.md' },
    { tool: 'glob', path: '/' },
    { tool: 'read', path: '/_index.md' },
    { tool: 'bash', kinds: [] },
  ]);
  // No pattern or command text leaks into the summary.
  assert.doesNotMatch(JSON.stringify(t), /secret question words|rg -n|echo done/);
});

test('summary flags a mismatch with the recorded tool-call count', () => {
  const t = summarize([{ tool: 'read', args: { path: '/a.md' } }], 2);
  assert.equal(t.complete, false);
});

test('unknown tools count as other; sequences are capped', () => {
  const starts: ToolStart[] = [{ tool: 'write', args: { path: '/x.md' } }];
  for (let i = 0; i < MAX_SEQUENCE + 5; i += 1) starts.push({ tool: 'read', args: { path: `/n${i}.md` } });
  const t = summarize(starts);
  assert.equal(t.tool_calls.other, 1);
  assert.equal(t.tool_calls.read, MAX_SEQUENCE + 5);
  assert.equal(t.read_paths.length, MAX_SEQUENCE);
  assert.equal(t.operations.length, MAX_SEQUENCE);
  assert.equal(t.truncated, true);
});
