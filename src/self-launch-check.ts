import { spawn } from 'node:child_process';
import { selfLaunch, type SelfLaunch } from './runtime-info.ts';

/** What the child process did, as `selfLaunchVerdict` needs to judge it. */
export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SpawnChild = (launch: SelfLaunch, args: string[], timeoutMs: number) => Promise<ChildResult>;

export interface SelfLaunchVerdict {
  ok: boolean;
  /** One line saying what was checked or what went wrong. */
  message: string;
}

export const SELF_LAUNCH_TIMEOUT_MS = 15_000;

/**
 * CREW-3279: the verdict on a child started through `selfLaunch()` with
 * `--version --json`. It passes only when the child exited 0 and printed a JSON
 * object whose `version` and `compiled` equal this process's own: that proves a
 * compiled binary can start another copy of itself (CREW-3277) without a
 * config, a workspace, a key or the network.
 */
export function selfLaunchVerdict(child: ChildResult, own: { version: string; compiled: boolean }): SelfLaunchVerdict {
  const printed = `${child.stdout}${child.stderr}`.trim();
  const fail = (why: string): SelfLaunchVerdict => ({ ok: false, message: `self-launch failed: ${why}${printed ? `\nchild printed:\n${printed}` : ''}` });
  if (child.timedOut) return fail('the child did not finish in time');
  if (child.code !== 0) return fail(`the child exited ${child.code === null ? 'on a signal' : child.code}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(child.stdout);
  } catch {
    return fail('the child did not print a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail('the child did not print a JSON object');
  const obj = parsed as { version?: unknown; compiled?: unknown };
  if (obj.version !== own.version) return fail(`the child reports version ${JSON.stringify(obj.version)}, this process is ${own.version}`);
  if (obj.compiled !== own.compiled) return fail(`the child reports compiled ${JSON.stringify(obj.compiled)}, this process is ${own.compiled}`);
  return { ok: true, message: `self-launch ok: ${own.version}${own.compiled ? ' (compiled)' : ''}` };
}

export const spawnChild: SpawnChild = (launch, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.args, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });

/** Start a child through `selfLaunch()` and judge it. */
export async function runSelfLaunchCheck(
  own: { version: string; compiled: boolean },
  spawnFn: SpawnChild = spawnChild,
  launch: SelfLaunch = selfLaunch(),
  timeoutMs: number = SELF_LAUNCH_TIMEOUT_MS,
): Promise<SelfLaunchVerdict> {
  return selfLaunchVerdict(await spawnFn(launch, ['--version', '--json'], timeoutMs), own);
}
