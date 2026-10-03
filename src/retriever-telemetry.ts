import { observe } from '@flue/runtime';

/**
 * Retriever diagnostics: which tools the model called, in what order, and
 * which files it opened with `read`. Measurement only — nothing here changes
 * the tool set, the sandbox, or the prompt.
 *
 * Source of truth is Flue's runtime event stream (`observe()`): every
 * model-invoked tool emits a `tool_start` observation carrying the tool name
 * and its normalized arguments, stamped with the agent `instanceId`. That
 * makes the per-tool counts and the `read` path list exact.
 *
 * Coverage limits (by construction, not by accident):
 *   - `bash` is opaque. One command can read, search and list at once, and
 *     the shell runs inside just-bash without reporting which files it
 *     touched. Bash calls are therefore only *classified* by the command
 *     words they contain (`bash_heuristic`); their file paths are never
 *     added to `read_paths`.
 *   - Search patterns and bash command text are not recorded here (they can
 *     echo the question); the existing stderr activity log already previews
 *     each bash command.
 *   - Events from delegated subagent sessions (`taskId` set) and programmatic
 *     `shell()` calls (`origin: 'caller'`) are excluded; the retriever uses
 *     neither today.
 */

export interface ToolStart {
  tool: string;
  args: unknown;
}

export type BashKind = 'search' | 'read' | 'list';

export type Operation =
  | { tool: 'read'; path: string }
  | { tool: 'grep' | 'glob'; path: string }
  | { tool: 'bash'; kinds: BashKind[] }
  | { tool: string };

export interface RetrieverTelemetry {
  /** Source of the counts below, so readers know what "exact" means. */
  source: 'flue-observe';
  /**
   * True when the number of observed tool starts equals the number of tool
   * calls Flue recorded on the response (the source of `bash_calls`). False
   * means some call never started (e.g. rejected arguments) or the subscriber
   * missed events — treat the numbers as a lower bound.
   */
  complete: boolean;
  /** UTF-8 size of the briefing sent as the user message. */
  briefing_bytes: number;
  /** Exact counts of model tool calls by tool (the result tool excluded). */
  tool_calls: { read: number; grep: number; glob: number; bash: number; other: number };
  /** Paths passed to the `read` tool, in call order, repeats kept. Sandbox-absolute. */
  read_paths: string[];
  /** Bash calls classified by command words. A call can land in several buckets. */
  bash_heuristic: { search: number; read: number; list: number; unclassified: number };
  /** Every model tool call in order; paths only, no patterns or command text. */
  operations: Operation[];
  /** True when `operations` / `read_paths` were cut at MAX_SEQUENCE entries. */
  truncated: boolean;
}

export const MAX_SEQUENCE = 200;

const SEARCH_WORDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'git-grep']);
const READ_WORDS = new Set(['cat', 'head', 'tail', 'sed', 'awk', 'less', 'more', 'nl', 'bat', 'strings', 'xxd', 'od']);
const LIST_WORDS = new Set(['ls', 'find', 'tree', 'du', 'stat', 'file', 'fd']);
const WRAPPERS = new Set(['xargs', 'sudo', 'env', 'time', 'nice', 'command', 'exec']);

/** Command words of every pipeline segment, e.g. `cd /a && rg x | head` → [cd, rg, head]. */
export function commandWords(command: string): string[] {
  const words: string[] = [];
  for (const segment of splitSegments(command)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i]!.replace(/^['"]|['"]$/g, '');
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        i += 1; // leading VAR=value assignment
        continue;
      }
      const base = token.slice(token.lastIndexOf('/') + 1);
      if (WRAPPERS.has(base)) {
        // Skip the wrapper and its flags (`xargs -0 grep` → grep).
        i += 1;
        while (i < tokens.length && tokens[i]!.startsWith('-')) i += 1;
        continue;
      }
      if (base) words.push(base);
      break;
    }
  }
  return words;
}

/**
 * Split on shell separators (`|`, `||`, `&&`, `;`, `&`, newline, `$(`,
 * backtick, `(`) that sit outside quotes, so `rg 'a|b'` stays one segment.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if ('|;&\n`('.includes(ch) || (ch === '$' && command[i + 1] === '(')) {
      segments.push(current);
      current = '';
      if (ch === '$') i += 1;
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

export function classifyBash(command: string): BashKind[] {
  const words = commandWords(command);
  const kinds: BashKind[] = [];
  if (words.some((w) => SEARCH_WORDS.has(w))) kinds.push('search');
  if (words.some((w) => READ_WORDS.has(w))) kinds.push('read');
  if (words.some((w) => LIST_WORDS.has(w))) kinds.push('list');
  return kinds;
}

/** Map a model-supplied path onto the sandbox root (`/`), stripping the host prefix if present. */
export function sandboxPath(raw: unknown, fsPath: string): string {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p || p === '.') return '/';
  const root = fsPath.replace(/\/+$/, '');
  if (p === root) return '/';
  if (p.startsWith(root + '/')) return p.slice(root.length);
  if (p.startsWith('/')) return p;
  return '/' + p.replace(/^\.\//, '');
}

function argOf(args: unknown, key: string): unknown {
  return args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
}

export function summarizeToolStarts(
  starts: readonly ToolStart[],
  opts: { fsPath: string; briefing: string; recordedToolCalls: number; resultTool: string },
): RetrieverTelemetry {
  const toolCalls = { read: 0, grep: 0, glob: 0, bash: 0, other: 0 };
  const bash = { search: 0, read: 0, list: 0, unclassified: 0 };
  const readPaths: string[] = [];
  const operations: Operation[] = [];
  let truncated = false;
  const push = <T>(list: T[], item: T) => {
    if (list.length < MAX_SEQUENCE) list.push(item);
    else truncated = true;
  };

  for (const { tool, args } of starts) {
    if (tool === opts.resultTool) continue;
    if (tool === 'read') {
      toolCalls.read += 1;
      const path = sandboxPath(argOf(args, 'path'), opts.fsPath);
      push(readPaths, path);
      push(operations, { tool: 'read', path });
    } else if (tool === 'grep' || tool === 'glob') {
      toolCalls[tool] += 1;
      push(operations, { tool, path: sandboxPath(argOf(args, 'path'), opts.fsPath) });
    } else if (tool === 'bash') {
      toolCalls.bash += 1;
      const command = argOf(args, 'command');
      const kinds = typeof command === 'string' ? classifyBash(command) : [];
      for (const kind of kinds) bash[kind] += 1;
      if (kinds.length === 0) bash.unclassified += 1;
      push(operations, { tool: 'bash', kinds });
    } else {
      toolCalls.other += 1;
      push(operations, { tool });
    }
  }

  return {
    source: 'flue-observe',
    complete: starts.length === opts.recordedToolCalls,
    briefing_bytes: Buffer.byteLength(opts.briefing, 'utf8'),
    tool_calls: toolCalls,
    read_paths: readPaths,
    bash_heuristic: bash,
    operations,
    truncated,
  };
}

/**
 * Subscribe to Flue's runtime events and collect the root session's
 * model-invoked tool starts for one agent instance. Call `stop()` once the
 * reply is read; it unsubscribes and returns the starts in emission order.
 */
export function recordToolStarts(instanceId: string): { stop(): ToolStart[] } {
  const starts: ToolStart[] = [];
  const unsubscribe = observe((event) => {
    if (event.type !== 'tool_start') return;
    if (event.instanceId !== instanceId) return;
    if (event.taskId !== undefined || event.origin === 'caller') return;
    starts.push({ tool: event.toolName, args: event.args });
  });
  return {
    stop() {
      unsubscribe();
      return starts;
    },
  };
}

/** One-line summary for the existing stderr activity log. */
export function telemetryLogLine(t: RetrieverTelemetry): string {
  const c = t.tool_calls;
  const h = t.bash_heuristic;
  return (
    `telemetry: briefing=${t.briefing_bytes}B read=${c.read} grep=${c.grep} glob=${c.glob} bash=${c.bash}` +
    ` (bash~ search=${h.search} read=${h.read} list=${h.list} other=${h.unclassified}) other=${c.other}` +
    `${t.complete ? '' : ' INCOMPLETE'}${t.truncated ? ' TRUNCATED' : ''}`
  );
}
