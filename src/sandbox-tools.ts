import { Type } from '@earendil-works/pi-ai';
import { createEditTool, createGlobTool, createGrepTool, createWriteTool } from '@flue/runtime';
import type { Sandbox, SandboxFactory, SandboxToolFactory } from '@flue/runtime';

/**
 * Bank replacements for Flue's built-in `read` and `bash` tools.
 *
 * Flue caps every tool result at 2000 lines / 51 200 characters, and its
 * `bash` tool keeps the END of an oversized output with no marker at all.
 * A Librarian paging a 875 000-character source with `sed -n 'A,Bp'` asked for
 * line ranges of unknown size, silently lost their beginnings and read the
 * same ranges two or three times. These tools raise the cap, page large files
 * by size instead of line count, and always say what was cut.
 *
 * Limits count JavaScript string length (UTF-16 units), like Flue's own.
 */

export const READ_MAX_LINES = 5000;
export const READ_MAX_CHARS = 200_000;

type AgentToolLike = ReturnType<SandboxToolFactory>[number];

export interface Page {
  /** Character range [start, end) in the file content. */
  start: number;
  end: number;
  /** 1-indexed lines the page touches (first and last may be partial). */
  firstLine: number;
  lastLine: number;
}

/**
 * Split content into consecutive pages of at most `maxChars` characters and
 * `maxLines` lines. Pages end on a line break whenever the line fits; a single
 * line longer than `maxChars` is cut into several pages.
 */
export function paginate(content: string, maxChars = READ_MAX_CHARS, maxLines = READ_MAX_LINES): Page[] {
  const pages: Page[] = [];
  let pos = 0;
  let line = 1;
  while (pos < content.length) {
    let end = Math.min(pos + maxChars, content.length);
    let newlines = 0;
    for (let i = pos; i < end; i++) {
      if (content.charCodeAt(i) !== 10) continue;
      newlines++;
      if (newlines === maxLines) {
        end = i + 1;
        break;
      }
    }
    if (end < content.length && content.charCodeAt(end - 1) !== 10) {
      const lastBreak = content.lastIndexOf('\n', end - 1);
      if (lastBreak >= pos) end = lastBreak + 1;
    }
    const slice = content.slice(pos, end);
    const breaks = countNewlines(slice);
    const lastLine = slice.endsWith('\n') ? line + breaks - 1 : line + breaks;
    pages.push({ start: pos, end, firstLine: line, lastLine });
    line += breaks;
    pos = end;
  }
  return pages;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

const fmt = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return countNewlines(content) + (content.endsWith('\n') ? 0 : 1);
}

function pageLabel(p: Page, index: number, total: number): string {
  const lines = p.firstLine === p.lastLine ? `line ${fmt(p.firstLine)}` : `lines ${fmt(p.firstLine)}–${fmt(p.lastLine)}`;
  return `page ${index + 1} of ${total}: ${lines}`;
}

export interface ReadArgs {
  offset?: number;
  limit?: number;
  page?: number;
}

/** Render one `read` call. Throws on an out-of-range page or offset. */
export function formatRead(path: string, content: string, args: ReadArgs = {}): string {
  if (content.length === 0) return '(empty file)';
  const pages = paginate(content);
  const total = pages.length;
  const head = `[${path} — ${fmt(content.length)} chars, ${fmt(lineCount(content))} lines`;

  if (args.page !== undefined || (args.offset === undefined && args.limit === undefined)) {
    const index = (args.page ?? 1) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new Error(`page ${args.page} does not exist: ${path} has ${total} page(s)`);
    }
    if (total === 1) return content;
    const p = pages[index];
    let text = `${head}; ${pageLabel(p, index, total)}]\n${content.slice(p.start, p.end)}`;
    if (!text.endsWith('\n')) text += '\n';
    if (index + 1 < total) {
      const rest = index + 2 === total ? `page=${total}` : `pages ${index + 2}–${total}`;
      text += `[End of page ${index + 1} of ${total}. Next: page=${index + 2}. Request ${rest} in parallel calls if you need them all.]`;
    } else {
      text += `[End of file: last page ${total} of ${total}.]`;
    }
    return text;
  }

  // Line mode: offset/limit, as in Flue's read, with the larger caps.
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  const startLine = args.offset ? Math.max(0, Math.floor(args.offset) - 1) : 0;
  if (startLine >= lines.length) {
    throw new Error(`offset ${args.offset} is beyond end of file (${lines.length} lines total)`);
  }
  const endLine = args.limit ? Math.min(lines.length, startLine + Math.floor(args.limit)) : lines.length;
  let out = '';
  let shown = 0;
  for (let i = startLine; i < endLine && shown < READ_MAX_LINES; i++) {
    const next = shown === 0 ? lines[i] : `\n${lines[i]}`;
    if (out.length + next.length > READ_MAX_CHARS) break;
    out += next;
    shown++;
  }
  const pageOf = (line: number) => pages.findIndex((p) => line >= p.firstLine && line <= p.lastLine) + 1;
  if (shown === 0) {
    let lineStart = 0;
    for (let i = 0; i < startLine; i++) lineStart += lines[i].length + 1;
    const restAt = lineStart + READ_MAX_CHARS;
    const restPage = pages.findIndex((p) => restAt >= p.start && restAt < p.end) + 1;
    return `${lines[startLine].slice(0, READ_MAX_CHARS)}\n[Line ${startLine + 1} alone is longer than ${fmt(READ_MAX_CHARS)} chars; only its start is shown. The rest continues on page=${restPage} of ${total}.]`;
  }
  const shownEnd = startLine + shown;
  if (shownEnd < endLine) {
    out += `\n[Showing lines ${startLine + 1}–${shownEnd} of ${lines.length}: the ${fmt(READ_MAX_CHARS)}-char / ${fmt(READ_MAX_LINES)}-line cap was hit. Continue with offset=${shownEnd + 1}, or read by page: page=${pageOf(shownEnd + 1)} of ${total}.]`;
  }
  return out;
}

const ReadParams = Type.Object({
  path: Type.String({ description: 'Path to the file to read' }),
  page: Type.Optional(
    Type.Number({
      description: `Page number (1-indexed). Pages are consecutive, non-overlapping chunks of up to ${fmt(READ_MAX_CHARS)} chars; the first page names the total. Prefer this for large files.`,
    }),
  ),
  offset: Type.Optional(Type.Number({ description: 'Line number to start from (1-indexed)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});

/** One line per tool result that was paged or cut, for the run log. */
export type ToolNote = (message: string) => void;

/** Describe what a `read` call returned: which page or line range, out of what. */
export function describeRead(path: string, content: string, args: ReadArgs): string {
  const pages = paginate(content);
  const total = pages.length;
  if (args.page !== undefined || (args.offset === undefined && args.limit === undefined)) {
    const index = (args.page ?? 1) - 1;
    const p = pages[index];
    if (!p) return `${path} page ${args.page} of ${total}: does not exist`;
    return `${path} page ${index + 1}/${total} lines ${p.firstLine}–${p.lastLine} (${fmt(p.end - p.start)} of ${fmt(content.length)} chars)`;
  }
  return `${path} lines from ${args.offset ?? 1}${args.limit ? ` limit ${args.limit}` : ''} (${fmt(content.length)} chars, ${total} page(s))`;
}

export function createPagedReadTool(env: Sandbox, note?: ToolNote): AgentToolLike {
  return {
    name: 'read',
    label: 'Read File',
    description:
      `Read a file. Small files come back whole. A file over ${fmt(READ_MAX_CHARS)} chars or ${fmt(READ_MAX_LINES)} lines ` +
      'comes back one page at a time, with a header naming the total pages: pass page=N for the next ones ' +
      '(they can be requested in parallel). offset/limit select a line range instead.',
    parameters: ReadParams,
    async execute(_toolCallId: string, params: { path: string; page?: number; offset?: number; limit?: number }, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const content = await env.readFile(params.path);
      note?.(describeRead(params.path, content, params));
      const text = formatRead(params.path, content, params);
      return { content: [{ type: 'text', text }], details: { path: params.path, chars: content.length } };
    },
  } as AgentToolLike;
}

/** Keep the START of an oversized command output and say how much was cut. */
export function formatBashOutput(stdout: string, stderr: string, exitCode: number): string {
  const full = (stdout + (stderr ? `\n${stderr}` : '')).trim();
  let text = full;
  const totalLines = full.length === 0 ? 0 : countNewlines(full) + 1;
  if (full.length > READ_MAX_CHARS || totalLines > READ_MAX_LINES) {
    let cut = full.slice(0, READ_MAX_CHARS);
    let nl = -1;
    for (let i = 0, n = 0; i < cut.length; i++) {
      if (cut.charCodeAt(i) === 10 && ++n === READ_MAX_LINES) {
        nl = i;
        break;
      }
    }
    if (nl >= 0) cut = cut.slice(0, nl);
    text =
      `${cut}\n[Output cut: showed the first ${fmt(cut.length)} of ${fmt(full.length)} chars ` +
      `(${fmt(countNewlines(cut) + 1)} of ${fmt(totalLines)} lines). To read a file, use the read tool with page=N instead of cat/sed.]`;
    if (stderr.trim() && !cut.includes(stderr.trim())) text += `\n[stderr]\n${stderr.trim().slice(-2000)}`;
  }
  if (!text) text = '(no output)';
  return exitCode === 0 ? text : `${text}\n\nCommand exited with code ${exitCode}`;
}

const BashParams = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })),
});

export function createHeadBashTool(env: Sandbox, note?: ToolNote): AgentToolLike {
  return {
    name: 'bash',
    label: 'Run Command',
    description:
      `Execute a bash command. Returns stdout and stderr. Output over ${fmt(READ_MAX_LINES)} lines or ` +
      `${fmt(READ_MAX_CHARS)} chars keeps its start and says how much was cut. Read files with the read tool, not cat/sed.`,
    parameters: BashParams,
    async execute(_toolCallId: string, params: { command: string; timeout?: number }, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const timeoutMs = typeof params.timeout === 'number' ? params.timeout * 1000 : undefined;
      const timeoutSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
      const signals = [signal, timeoutSignal].filter((s): s is AbortSignal => s !== undefined);
      const execSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const details = { command: params.command };
      const timedOut = () => ({
        content: [{ type: 'text', text: formatBashOutput('', `Command timed out after ${params.timeout} seconds.`, 124) }],
        details: { ...details, exitCode: 124 },
      });
      try {
        const r = await env.exec(params.command, { timeoutMs, signal: execSignal });
        if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
        const text = formatBashOutput(r.stdout, r.stderr, r.exitCode);
        const cut = text.match(/\[Output cut: [^\]]*\]/);
        if (cut) note?.(cut[0]);
        return {
          content: [{ type: 'text', text }],
          details: { ...details, exitCode: r.exitCode },
        };
      } catch (err) {
        if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
        throw err;
      }
    },
  } as AgentToolLike;
}

/**
 * The same sandbox with Flue's standard tool set, except `read` and `bash`
 * are the paged / head-keeping versions above. Removing this wrapper restores
 * Flue's defaults.
 */
export function withPagedTools(factory: SandboxFactory, notes: { read?: ToolNote; bash?: ToolNote } = {}): SandboxFactory {
  return {
    ...factory,
    tools: (env) => [
      createPagedReadTool(env, notes.read),
      createWriteTool(env),
      createEditTool(env),
      createHeadBashTool(env, notes.bash),
      createGrepTool(env),
      createGlobTool(env),
    ],
  };
}
