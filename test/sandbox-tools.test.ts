import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_MAX_CHARS,
  READ_MAX_LINES,
  createHeadBashTool,
  createPagedReadTool,
  formatBashOutput,
  formatRead,
  paginate,
} from '../src/sandbox-tools.ts';

const join = (pages: { start: number; end: number }[], s: string) => pages.map((p) => s.slice(p.start, p.end)).join('');

describe('paginate', () => {
  test('pages cover the content exactly, without overlap, ending on line breaks', () => {
    const line = 'x'.repeat(99) + '\n';
    const content = line.repeat(5000); // 500 000 chars
    const pages = paginate(content);
    assert.equal(join(pages, content), content);
    for (const p of pages) {
      assert.ok(p.end - p.start <= READ_MAX_CHARS);
      assert.equal(content[p.end - 1], '\n');
    }
    assert.equal(pages[0].firstLine, 1);
    assert.equal(pages[1].firstLine, pages[0].lastLine + 1);
    assert.equal(pages.at(-1)!.lastLine, 5000);
  });

  test('a line longer than a page is split across pages', () => {
    const content = 'short\n' + 'y'.repeat(450_000) + '\nend';
    const pages = paginate(content);
    assert.equal(join(pages, content), content);
    assert.ok(pages.length >= 3);
    for (const p of pages) assert.ok(p.end - p.start <= READ_MAX_CHARS);
    assert.equal(pages.at(-1)!.lastLine, 3);
  });

  test('line cap closes a page before the char cap', () => {
    const content = 'a\n'.repeat(READ_MAX_LINES + 10);
    const pages = paginate(content);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].lastLine, READ_MAX_LINES);
    assert.equal(pages[1].firstLine, READ_MAX_LINES + 1);
  });
});

describe('formatRead', () => {
  test('a small file comes back whole, with no header', () => {
    assert.equal(formatRead('/a.md', '# A\n\ntext\n'), '# A\n\ntext\n');
  });

  test('a large file starts at page 1 with totals and a next-page hint', () => {
    const content = ('z'.repeat(79) + '\n').repeat(6000); // 480 000 chars
    const out = formatRead('/big.js', content);
    assert.match(out, /^\[\/big\.js — 480 000 chars, 6 000 lines; page 1 of 3: lines 1–2 500\]/);
    assert.match(out, /Next: page=2\. Request pages 2–3 in parallel calls/);
    const last = formatRead('/big.js', content, { page: 3 });
    assert.match(last, /\[End of file: last page 3 of 3\.\]$/);
  });

  test('every page together reproduces the file', () => {
    const content = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'w'.repeat(i % 300)}`).join('\n');
    const total = paginate(content).length;
    let rebuilt = '';
    for (let p = 1; p <= total; p++) {
      const out = formatRead('/f', content, { page: p });
      const body = out.slice(out.indexOf(']\n') + 2, out.lastIndexOf('\n['));
      rebuilt += p === total && !content.endsWith('\n') ? body : body + '\n';
    }
    assert.equal(rebuilt.replace(/\n$/, ''), content);
  });

  test('a page outside the file is an error naming the total', () => {
    assert.throws(() => formatRead('/f', 'a\n'.repeat(10), { page: 2 }), /has 1 page/);
  });

  test('line mode keeps offset/limit and points to the page when capped', () => {
    const content = ('q'.repeat(99) + '\n').repeat(4000);
    assert.equal(formatRead('/f', content, { offset: 2, limit: 2 }), `${'q'.repeat(99)}\n${'q'.repeat(99)}`);
    const capped = formatRead('/f', content, { offset: 1 });
    assert.match(capped, /Continue with offset=2001, or read by page: page=2 of 2\.\]$/);
  });

  test('line mode on an over-long line shows its start and the page to continue', () => {
    const content = 'head\n' + 'L'.repeat(300_000) + '\n';
    const out = formatRead('/f', content, { offset: 2, limit: 1 });
    assert.match(out, /Line 2 alone is longer than 200 000 chars; only its start is shown\. The rest continues on page=3 of 3\.\]$/);
  });

  test('an empty file says so', () => {
    assert.equal(formatRead('/e', ''), '(empty file)');
  });
});

describe('formatBashOutput', () => {
  test('small output passes through; exit code is appended on failure', () => {
    assert.equal(formatBashOutput('ok\n', '', 0), 'ok');
    assert.equal(formatBashOutput('', 'boom', 2), 'boom\n\nCommand exited with code 2');
    assert.equal(formatBashOutput('', '', 0), '(no output)');
  });

  test('oversized output keeps its START and says how much was cut', () => {
    const stdout = Array.from({ length: 300_000 }, (_, i) => `row ${i}`).join('\n');
    const out = formatBashOutput(stdout, '', 0);
    assert.ok(out.startsWith('row 0\nrow 1\n'));
    assert.match(out, /\[Output cut: showed the first [\d ]+ of [\d ]+ chars \(5 000 of 300 000 lines\)/);
  });

  test('stderr survives a cut stdout', () => {
    const out = formatBashOutput('x'.repeat(READ_MAX_CHARS + 10), 'warning: tail', 1);
    assert.match(out, /\[stderr\]\nwarning: tail\n\nCommand exited with code 1$/);
  });
});

describe('tools over a sandbox', () => {
  const big = ('r'.repeat(99) + '\n').repeat(3000);
  const env = {
    readFile: async (p: string) => (p === '/big' ? big : 'tiny\n'),
    exec: async (cmd: string) => ({ stdout: cmd === 'yes' ? 'y\n'.repeat(10_000) : 'done\n', stderr: '', exitCode: 0 }),
  } as any;

  test('read tool pages through the sandbox file', async () => {
    const tool = createPagedReadTool(env) as any;
    assert.equal(tool.name, 'read');
    const r1 = await tool.execute('t1', { path: '/big' });
    assert.match(r1.content[0].text, /page 1 of 2/);
    const r2 = await tool.execute('t2', { path: '/big', page: 2 });
    assert.match(r2.content[0].text, /last page 2 of 2/);
    const small = await tool.execute('t3', { path: '/small' });
    assert.equal(small.content[0].text, 'tiny\n');
  });

  test('bash tool keeps the head of a long output', async () => {
    const tool = createHeadBashTool(env) as any;
    assert.equal(tool.name, 'bash');
    const r = await tool.execute('t1', { command: 'yes' });
    assert.ok(r.content[0].text.startsWith('y\ny\n'));
    assert.match(r.content[0].text, /Output cut/);
    assert.equal(r.details.exitCode, 0);
  });
});

describe('tool notes for the run log', () => {
  test('read reports the page and range it returned; bash reports a cut', async () => {
    const big = ('n'.repeat(99) + '\n').repeat(3000);
    const env = {
      readFile: async () => big,
      exec: async () => ({ stdout: 'y\n'.repeat(10_000), stderr: '', exitCode: 0 }),
    } as any;
    const notes: string[] = [];
    const read = createPagedReadTool(env, (m) => notes.push(m)) as any;
    await read.execute('a', { path: '/big', page: 2 });
    await read.execute('b', { path: '/big', page: 3 }).catch(() => {});
    await (createHeadBashTool(env, (m) => notes.push(m)) as any).execute('c', { command: 'x' });
    assert.equal(notes[0], '/big page 2/2 lines 2001–3000 (100 000 of 300 000 chars)');
    assert.equal(notes[1], '/big page 3 of 2: does not exist');
    assert.match(notes[2], /^\[Output cut: showed the first/);
  });
});
