/**
 * Running a hook.
 *
 * A hook is a script written in whatever shell the ship uses — the crew never
 * parses it, only hands it over and reads the exit status. The shell is a
 * setting rather than an assumption, so that a Windows ship can run
 * PowerShell hooks without this file, the config schema, or any hook contract
 * changing shape. Nothing else in the runner shells out.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:process';

export interface ShellSpec {
  /** The interpreter, e.g. "bash", "sh", "pwsh". */
  bin: string;
  /** Args placed before the script text, e.g. ["-c"] or ["-NoProfile","-Command"]. */
  args: string[];
}

/** What this platform uses when crew.yaml does not say. */
export function defaultShell(): ShellSpec {
  return platform === 'win32'
    ? { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command'] }
    : { bin: 'bash', args: ['-c'] };
}

/**
 * Accepts either a bare interpreter name ("pwsh") or a full spec. A bare name
 * gets that platform family's usual argument form.
 */
export function resolveShell(configured?: string | ShellSpec): ShellSpec {
  if (!configured) return defaultShell();
  if (typeof configured !== 'string') return configured;
  const bin = configured.trim();
  if (/pwsh|powershell/i.test(bin)) {
    return { bin, args: ['-NoProfile', '-NonInteractive', '-Command'] };
  }
  if (/cmd(\.exe)?$/i.test(bin)) return { bin, args: ['/d', '/s', '/c'] };
  return { bin, args: ['-c'] };
}

export interface RunResult {
  code: number;
  output: string;
}

export interface RunOptions {
  cwd: string;
  shell?: ShellSpec;
  env?: NodeJS.ProcessEnv;
  /** Called per line, for live logging while still capturing the whole. */
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * Runs a hook script and captures its combined output. Never throws on a
 * non-zero exit — the exit status IS the result, and every caller decides what
 * a failure means (a red suite blocks a release; a failed notifier does not).
 */
export function runScript(script: string, opts: RunOptions): Promise<RunResult> {
  const shell = opts.shell ?? defaultShell();
  return new Promise((resolvePromise) => {
    const child = spawn(shell.bin, [...shell.args, script], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let pending = '';
    const absorb = (buf: Buffer) => {
      const text = buf.toString();
      output += text;
      if (!opts.onLine) return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) opts.onLine(l);
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);

    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      : undefined;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      // A missing interpreter is a config problem, and must read as one
      // rather than as the hook having failed.
      resolvePromise({ code: 127, output: `${output}\ncrew: cannot run ${shell.bin}: ${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (pending && opts.onLine) opts.onLine(pending);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}
