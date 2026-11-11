import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseLaunchctlPrint } from './daemon-liveness.ts';

/**
 * CREW-3237: `crew daemon start` on launchd. `launchctl load` on a unit that is
 * already loaded answers "Load failed: 5: Input/output error", which says
 * nothing about the real state, so the start is planned from what the service
 * manager reports: an unloaded unit is loaded as before, a loaded unit with a
 * process is reported as running, and a loaded unit with no process is
 * kick-started and then checked. Planning is pure; `startLaunchdDaemon` is the
 * only part that runs commands.
 */
export interface LaunchdReading {
  loaded: boolean;
  pid: number | null;
  lastExitCode: number | null;
}

export type LaunchdStartState = 'unloaded' | 'running' | 'loaded';

export interface LaunchdStartPlan {
  state: LaunchdStartState;
  /** Run in order; empty when the daemon is already running. */
  commands: string[][];
}

export function launchdStartState(r: LaunchdReading): LaunchdStartState {
  if (!r.loaded) return 'unloaded';
  return r.pid !== null ? 'running' : 'loaded';
}

/** The commands `crew daemon start` runs for a unit in the given state. */
export function planLaunchdStart(r: LaunchdReading, unit: { unitPath: string; label: string; uid: number }): LaunchdStartPlan {
  const state = launchdStartState(r);
  if (state === 'running') return { state, commands: [] };
  // `kickstart` without `-k` starts a stopped job and never kills a running one.
  if (state === 'loaded') return { state, commands: [['launchctl', 'kickstart', `gui/${unit.uid}/${unit.label}`]] };
  return { state, commands: [['launchctl', 'load', unit.unitPath]] };
}

export interface CommandResult { status: number | null; stdout: string; stderr: string }

export interface StartLaunchdOptions {
  unitPath: string;
  label: string;
  uid: number;
  /** The scheduler log the unit writes stdout/stderr to. */
  schedulerLog: string;
  dryRun: boolean;
  /** Check that a process stayed up after loading an unloaded unit too (`restart`). A plain `start` of an unloaded unit is unchanged. */
  verifyAfterLoad?: boolean;
  /** Treat the unit as unloaded without asking (`restart` has just unloaded it). */
  assumeUnloaded?: boolean;
  /** Test seams. */
  run?: (cmd: string[]) => CommandResult | null;
  sleep?: (ms: number) => void;
  readLog?: (path: string) => string | null;
  settleMs?: number;
}

export interface StartLaunchdResult { exitCode: number; stdout: string; stderr: string }

const LOG_TAIL_LINES = 10;

function defaultRun(cmd: string[]): CommandResult | null {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' });
  return r.error ? null : { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultReadLog(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** The last non-empty lines of a log, in order. */
export function logTail(text: string | null, n = LOG_TAIL_LINES): string[] {
  if (text === null) return [];
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(-n);
}

export function startLaunchdDaemon(o: StartLaunchdOptions): StartLaunchdResult {
  const run = o.run ?? defaultRun;
  const sleep = o.sleep ?? defaultSleep;
  const readLog = o.readLog ?? defaultReadLog;
  let out = '';
  let err = '';
  const read = (): LaunchdReading => {
    const r = run(['launchctl', 'print', `gui/${o.uid}/${o.label}`]);
    if (!r || r.status !== 0) return { loaded: false, pid: null, lastExitCode: null };
    return { loaded: true, ...parseLaunchctlPrint(r.stdout) };
  };
  const reading: LaunchdReading = o.assumeUnloaded ? { loaded: false, pid: null, lastExitCode: null } : read();
  const plan = planLaunchdStart(reading, o);
  if (plan.state === 'running') {
    out += `crew daemon start: already running (pid ${reading.pid})\n`;
    return { exitCode: 0, stdout: out, stderr: err };
  }
  if (o.dryRun) {
    for (const c of plan.commands) out += `would run: ${c.join(' ')}\n`;
    return { exitCode: 0, stdout: out, stderr: err };
  }
  for (const cmd of plan.commands) {
    const res = run(cmd);
    if (res?.stdout) out += res.stdout;
    if (res?.stderr) err += res.stderr;
    if (!res || res.status !== 0) {
      err += `crew daemon start: ${cmd.join(' ')} exited ${res?.status ?? 'error'}\n`;
      return { exitCode: 1, stdout: out, stderr: err };
    }
  }
  // An unloaded unit started by a plain `start` is as it always was: the load's own exit status is the answer.
  if (plan.state === 'unloaded' && !o.verifyAfterLoad) return { exitCode: 0, stdout: out, stderr: err };

  sleep(o.settleMs ?? 3000);
  const after = read();
  if (after.loaded && after.pid !== null) {
    out += `crew daemon start: running (pid ${after.pid})\n`;
    return { exitCode: 0, stdout: out, stderr: err };
  }
  err += 'crew daemon start: the daemon did not stay up.\n';
  err += `  last exit status: ${after.lastExitCode ?? 'none recorded'}\n`;
  const tail = logTail(readLog(o.schedulerLog));
  if (tail.length) {
    err += `  last lines of ${o.schedulerLog}:\n`;
    for (const l of tail) err += `    ${l}\n`;
  } else {
    err += `  ${o.schedulerLog} has no output\n`;
  }
  return { exitCode: 1, stdout: out, stderr: err };
}
