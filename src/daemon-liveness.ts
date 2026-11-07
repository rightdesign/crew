import { existsSync, readFileSync } from 'node:fs';
import { daemonStampFor } from './daemon.ts';
import { spawnSync } from 'node:child_process';
import type { InstallPlan } from './install.ts';
import type { DoctorProblem } from './doctor-problems.ts';

/**
 * CREW-3065: what the OS service manager says about the daemon unit, so
 * `crew doctor` does not describe a daemon that exits at startup as one that
 * is busy waiting for its agents. Parsers are pure; `probeDaemonUnit` is the
 * only part that runs a command.
 */
export interface DaemonLiveness {
  /** `not_installed`: no unit on disk. `unknown`: installed, but the service manager could not be read. */
  state: 'running' | 'exited' | 'loaded' | 'not_installed' | 'unknown';
  mechanism: InstallPlan['mechanism'];
  pid: number | null;
  /** ms since epoch of the daemon's own start stamp, when it is the live process. */
  startedAt: number | null;
  lastExitCode: number | null;
  schedulerLog: string;
  /** Last non-empty line of the scheduler log, when the daemon is not running. */
  lastLogLine: string | null;
}

export interface UnitReading {
  pid: number | null;
  lastExitCode: number | null;
}

/** `launchctl print gui/<uid>/<label>`: `pid = 123`, `last exit code = 2`. */
export function parseLaunchctlPrint(text: string): UnitReading {
  const num = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return { pid: num(/^\s*pid = (\d+)\s*$/m), lastExitCode: num(/^\s*last exit code = (-?\d+)\s*$/m) };
}

/** `systemctl show -p MainPID,ExecMainStatus,ActiveState`: `MainPID=0` means no process. */
export function parseSystemctlShow(text: string): UnitReading & { active: string | null } {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const pid = Number(kv.get('MainPID') ?? '0');
  const exit = kv.get('ExecMainStatus');
  return {
    pid: pid > 0 ? pid : null,
    lastExitCode: exit !== undefined && exit !== '' && Number.isFinite(Number(exit)) ? Number(exit) : null,
    active: kv.get('ActiveState') ?? null,
  };
}

/** The last non-empty line of a log file, trimmed; null when absent or empty. */
export function lastLogLine(path: string, read: (p: string) => string | null = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } }): string | null {
  const text = read(path);
  if (text === null) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : null;
}

/** Folds a unit reading into a liveness verdict. Pure. */
export function classifyDaemon(o: {
  plan: Pick<InstallPlan, 'mechanism' | 'schedulerLog'>;
  installed: boolean;
  reading: UnitReading | null;
  stamp: { pid?: number; startedAt: number } | null;
  logLine: string | null;
}): DaemonLiveness {
  const base = { mechanism: o.plan.mechanism, schedulerLog: o.plan.schedulerLog, pid: null, startedAt: null, lastExitCode: null, lastLogLine: null };
  if (!o.installed) return { ...base, state: 'not_installed' };
  if (!o.reading) return { ...base, state: 'unknown' };
  const { pid, lastExitCode } = o.reading;
  if (pid !== null) {
    // The stamp is the daemon's own; trust it only when it belongs to this process.
    const startedAt = o.stamp && (o.stamp.pid === undefined || o.stamp.pid === pid) ? o.stamp.startedAt : null;
    return { ...base, state: 'running', pid, startedAt, lastExitCode };
  }
  if (lastExitCode !== null && lastExitCode !== 0) return { ...base, state: 'exited', lastExitCode, lastLogLine: o.logLine };
  return { ...base, state: 'loaded', lastExitCode };
}

/** Runs the service manager for the `run` unit. Never throws; an unreadable manager is `unknown`. */
export function probeDaemonUnit(o: {
  plan: InstallPlan;
  label: string;
  uid: number;
  system: boolean;
  stamp: { pid?: number; startedAt: number } | null;
  /** Test seam. */
  run?: (cmd: string[]) => { status: number | null; stdout: string } | null;
}): DaemonLiveness {
  const run = o.run ?? ((cmd: string[]) => {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' });
    return r.error ? null : { status: r.status, stdout: r.stdout ?? '' };
  });
  const installed = o.plan.unitPaths.some((p) => existsSync(p));
  let reading: UnitReading | null = null;
  if (installed && o.plan.mechanism === 'launchd') {
    const r = run(['launchctl', 'print', `gui/${o.uid}/${o.label}`]);
    // Not loaded: print fails. The plist exists, so report it loaded-but-not-running.
    reading = r && r.status === 0 ? parseLaunchctlPrint(r.stdout) : r ? { pid: null, lastExitCode: null } : null;
  } else if (installed && o.plan.mechanism === 'systemd') {
    const ctl = o.system ? ['systemctl'] : ['systemctl', '--user'];
    const r = run([...ctl, 'show', `${o.label}.service`, '-p', 'ActiveState,MainPID,ExecMainStatus']);
    reading = r && r.status === 0 ? parseSystemctlShow(r.stdout) : null;
  }
  const logLine = installed ? lastLogLine(o.plan.schedulerLog) : null;
  return classifyDaemon({ plan: o.plan, installed, reading, stamp: o.stamp, logLine });
}

/** The doctor `daemon:` line, without its label column. */
export function daemonLineText(d: DaemonLiveness): string {
  switch (d.state) {
    case 'running':
      return `ok pid ${d.pid}${d.startedAt !== null ? `, started ${new Date(d.startedAt).toISOString()}` : ''}`;
    case 'exited':
      return `FAIL daemon is not running: exited ${d.lastExitCode}${d.lastLogLine ? `, last line of ${d.schedulerLog}: ${d.lastLogLine}` : `, ${d.schedulerLog} has no output`}`;
    case 'loaded':
      return 'WARN the unit is installed but no daemon process is running; `crew daemon start` (or `crew reload`) starts it';
    case 'not_installed':
      return 'WARN no daemon unit is installed, so nothing polls the board; run `crew install`';
    default:
      return `WARN the unit is installed but ${d.mechanism === 'launchd' ? '`launchctl print`' : '`systemctl show`'} could not be read`;
  }
}

/** True when a daemon process is known not to exist (so a pending reload waits on nothing). */
export function daemonKnownDead(d: DaemonLiveness | null): boolean {
  return d !== null && (d.state === 'exited' || d.state === 'loaded' || d.state === 'not_installed');
}

/** The `reload request` line: waiting on agents only when a daemon is alive to wait. */
export function reloadRequestText(ageSeconds: number, d: DaemonLiveness | null, agentRuns: number): string {
  if (daemonKnownDead(d)) return `WARN pending for ${ageSeconds}s — no daemon is running; the reload will apply when it starts (see the daemon line)`;
  if (ageSeconds > STALE_RELOAD_SECONDS && agentRuns === 0) return `WARN pending for ${ageSeconds}s with no agent run in flight — the daemon is not honoring it (see the daemon line); \`crew reload --now\` forces it`;
  return `WARN pending for ${ageSeconds}s — the daemon is waiting for its running agents to end; \`crew reload --now\` forces it`;
}

/** A reload pending this long with nothing running is itself suspicious (10 minutes). */
export const STALE_RELOAD_SECONDS = 600;

/** The structured form of the daemon line for `crew doctor --json`. */
export function daemonProblem(d: DaemonLiveness, route: string): DoctorProblem | null {
  if (d.state === 'running') return null;
  const kind = d.state === 'exited' ? 'daemon_not_running' : d.state === 'not_installed' ? 'daemon_not_installed' : d.state === 'loaded' ? 'daemon_not_running' : 'daemon_unreadable';
  const text = daemonLineText(d).replace(/^(FAIL|WARN) /, '');
  return {
    severity: d.state === 'exited' ? 'blocker' : 'attention',
    kind,
    route,
    message: text,
    ...(d.state === 'not_installed' ? { remedy: 'run `crew install`' } : {}),
  };
}

/** The daemon's own start stamp (`daemon.started`): its pid and start time, or null. */
export function readDaemonStamp(stateDir: string): { pid?: number; startedAt: number } | null {
  try {
    const v = JSON.parse(readFileSync(daemonStampFor(stateDir), 'utf8')) as { pid?: unknown; startedAt?: unknown };
    if (typeof v.startedAt !== 'number') return null;
    return typeof v.pid === 'number' ? { pid: v.pid, startedAt: v.startedAt } : { startedAt: v.startedAt };
  } catch {
    return null;
  }
}
