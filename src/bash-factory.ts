import { Bash, ReadWriteFs } from 'just-bash';
import type { BashFactory, BashLike } from '@flue/sdk';
import type { FlueLogger } from './log-types.js';
import { logLine, preview } from './console-log.js';

/**
 * Heuristic: rewrite `grep ... 'a|b'` into `grep -E ... 'a|b'`.
 *
 * The retriever LLM (deepseek-v4-flash) reliably reaches for `grep` even
 * when the role doc says "use rg only", and just as reliably writes
 * alternation as `|` instead of `\|`. With grep's default basic regex,
 * `|` is a literal character, so the search silently returns nothing
 * and the call is wasted. Adding `-E` upgrades to extended regex where
 * `|` is alternation — which is the agent's clear intent.
 *
 * We only rewrite when:
 *   - the command actually invokes grep (not egrep, fgrep, ripgrep)
 *   - no regex-mode flag is already set (-E/-P/-F/-G or long forms)
 *   - the agent passed a quoted pattern that contains `|`
 *
 * Returns either the original command (no change) or the rewritten one.
 */
export function maybeUpgradeGrep(cmd: string): string {
  if (!/\bgrep\b/.test(cmd)) return cmd;
  if (/(^|\s)-[EPFG]\b/.test(cmd)) return cmd;
  if (/--extended-regexp|--perl-regexp|--fixed-strings|--basic-regexp/.test(cmd)) return cmd;
  // Look for a quoted pattern containing `|` somewhere after `grep`.
  // Stop at common shell separators so we don't get fooled by later commands.
  const m = cmd.match(/\bgrep\b[^|;&]*?(['"])([^'"]*\|[^'"]*)\1/);
  if (!m) return cmd;
  return cmd.replace(/\bgrep\b/, 'grep -E');
}

export interface BashFactoryDeps {
  /** Bank name — used to prefix stderr log lines so multi-bank runs are distinguishable. */
  bank: string;
  bankFsPath: string;
  log: FlueLogger;
  onExec?: (command: string, result: { stdout: string; stderr: string; exitCode: number; tookMs: number }) => void;
}

/**
 * Plug just-bash into Flue's `init({ sandbox })` so the agent's built-in
 * `bash`, `read`, `write`, `edit`, `grep`, `glob` tools all route through a
 * sandbox rooted at <bank-name>/fs/. The .git directory sits at
 * <bank-name>/.git, one level outside this sandbox, so the agent has no
 * way to touch it.
 *
 * Every tool call is mirrored to stderr via `logLine` so the dev server pane
 * shows live agent activity. Flue's `log.info()` goes to its event stream
 * (not stdout), so without the stderr mirror you'd see nothing.
 */
export function createBankBashFactory({ bank, bankFsPath, log, onExec }: BashFactoryDeps): BashFactory {
  return () => {
    const fs = new ReadWriteFs({ root: bankFsPath });
    const bash = new Bash({
      fs,
      cwd: '/',
      executionLimits: {
        maxCallDepth: 50,
        maxCommandCount: 5000,
        maxLoopIterations: 5000,
      },
    });

    let execIndex = 0;
    const bashLike: BashLike = {
      exec: async (command, options) => {
        execIndex += 1;
        const idx = execIndex;
        const upgraded = maybeUpgradeGrep(command);
        const effective = upgraded !== command ? upgraded : command;
        const script = preview(effective);
        log.info('bash.call', { index: idx, script, upgraded: upgraded !== command });
        if (upgraded !== command) {
          logLine('bash.fix', `#${idx} grep -> grep -E (alternation detected)`, 'yellow', bank);
        }
        logLine('bash', `#${idx} $ ${script}`, 'cyan', bank);
        const t0 = Date.now();
        const result = await bash.exec(effective, {
          cwd: options?.cwd,
          env: options?.env,
          signal: options?.signal,
        });
        const tookMs = Date.now() - t0;
        const exit = result.exitCode ?? 0;
        const stdout = result.stdout ?? '';
        const stderr = result.stderr ?? '';
        log.info('bash.result', {
          index: idx,
          exit,
          stdout_bytes: stdout.length,
          stderr_bytes: stderr.length,
          took: `${tookMs}ms`,
        });
        logLine(
          'bash',
          `#${idx} exit=${exit} stdout=${stdout.length}B stderr=${stderr.length}B in ${tookMs}ms`,
          exit === 0 ? 'gray' : 'red',
          bank,
        );
        if (exit !== 0 && stderr) {
          logLine('bash.err', preview(stderr, 300), 'red', bank);
        }
        onExec?.(command, { stdout, stderr, exitCode: exit, tookMs });
        return result;
      },
      getCwd: () => '/',
      fs: {
        readFile: async (p, options) => {
          logLine('read', String(p), 'green', bank);
          return fs.readFile(p, options ?? 'utf8');
        },
        readFileBuffer: async (p) => {
          logLine('read', `${p} (binary)`, 'green', bank);
          return fs.readFileBuffer(p);
        },
        writeFile: async (p, content, options) => {
          const size = typeof content === 'string' ? content.length : content.byteLength;
          logLine('write', `${p} (${size}B)`, 'yellow', bank);
          return fs.writeFile(p, content, options);
        },
        stat: (p) => {
          logLine('stat', String(p), 'gray', bank);
          return fs.stat(p);
        },
        readdir: async (p) => {
          logLine('readdir', String(p), 'green', bank);
          return fs.readdir(p);
        },
        exists: (p) => fs.exists(p),
        mkdir: async (p, opts) => {
          logLine('mkdir', `${p}${opts?.recursive ? ' -p' : ''}`, 'yellow', bank);
          return fs.mkdir(p, opts);
        },
        rm: async (p, opts) => {
          const flags = [opts?.recursive ? '-r' : '', opts?.force ? '-f' : ''].filter(Boolean).join('');
          logLine('rm', `${p}${flags ? ' ' + flags : ''}`, 'magenta', bank);
          return fs.rm(p, opts);
        },
        resolvePath: (base, p) => fs.resolvePath(base, p),
      },
    };

    return bashLike;
  };
}
