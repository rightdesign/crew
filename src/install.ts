/**
 * `crew install` / `crew uninstall` — writing and loading the platform's own
 * scheduler unit, instead of the hand-edited plist this used to require.
 *
 * Every mistake below was hit for real, running this project's own board:
 *
 *   - A relative interpreter (`node`, or `#!/usr/bin/env node`) fails on
 *     every fire, silently, because a scheduler hands a job a minimal PATH.
 *     `process.execPath` is already absolute; nothing to detect.
 *   - Pointing the scheduler's own stdout/stderr at the SAME file the crew's
 *     own emitter writes doubles every line. They must be different files.
 *   - No working directory means a relative config or state path resolves
 *     against `/`.
 *   - A hook still needs its own PATH (a package manager, a language
 *     runtime) — `ship.extraPath` exists for exactly this and was unused
 *     until this file.
 *   - Loading a unit must not also start it: RunAtLoad / OnBootSec=0 turns
 *     "installed" into "running right now", which is not what an operator
 *     asked for.
 *
 * One mechanism per host, chosen from `hostPlatform()` — Windows is not
 * handled yet (see the ticket; Task Scheduler is "eventually"). Linux always
 * prefers systemd **user** units (no root) and falls back to crontab only
 * when `systemctl` itself is unusable on this host — a caller-supplied
 * `hasSystemd` boolean, not a guess made in here, so the pure planning stays
 * testable without touching the real machine.
 *
 * `plan*` is pure — it only computes paths, unit text and the argv this host
 * would run. `apply*` is the only place that touches disk or spawns a
 * process, and is skipped entirely under `--dry-run`.
 */

import { dirname, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Ship } from './config.ts';
import type { ShipPlatform } from './platform.ts';

/** How often the timer fires. Matches the plist this replaces (2 minutes). */
export const INTERVAL_SECONDS = 120;

/**
 * A launchd label / systemd unit stem / cron marker unique to this
 * checkout. Hashing the checkout's own real path — rather than a fixed
 * constant — is what keeps two checkouts (a real production install and a
 * ticket worktree testing this very file, say) from writing, loading or
 * unloading each other's scheduler unit. `crewHome`, not `process.cwd()`:
 * the label must stay the same across `install` and a later `uninstall` run
 * from anywhere within the checkout. `realpathSync` collapses symlinks so a
 * checkout reached two different ways still hashes to one label.
 */
function labelFor(crewHome: string): string {
  const real = (() => {
    try {
      return realpathSync(crewHome);
    } catch {
      return crewHome;
    }
  })();
  const hash = createHash('sha1').update(real).digest('hex').slice(0, 8);
  return `com.tablation.crew.${hash}`;
}

function cronMarkerFor(label: string): string {
  return `# crew:${label} — managed by \`crew install\`, do not edit by hand`;
}

export type InstallMechanism = 'launchd' | 'systemd' | 'cron';

export interface InstallPlan {
  mechanism: InstallMechanism;
  /** Absolute path to the unit file(s) this plan writes. Empty for cron. */
  unitPaths: string[];
  /** path -> content, for whatever `unitPaths` names. */
  unitContent: Record<string, string>;
  /** The one line appended to the user's crontab. Only set for `cron`. */
  crontabLine: string | null;
  /** argv to run, in order, once the unit files exist. */
  loadCommands: string[][];
  /** Where the crew's own emitter writes — from config, never invented here. */
  crewLog: string;
  /** Where the scheduler's own stdout/stderr goes — always a DIFFERENT file. */
  schedulerLog: string;
}

export interface UninstallPlan {
  mechanism: InstallMechanism | 'none';
  unitPaths: string[];
  crontabLine: string | null;
  unloadCommands: string[][];
}

/** The scheduler's own log, derived from the crew's so the two never collide. */
function schedulerLogFor(crewLog: string): string {
  const ext = extname(crewLog);
  const stem = ext ? crewLog.slice(0, -ext.length) : crewLog;
  return `${stem}.scheduler${ext || '.log'}`;
}

/** `PATH` a launched unit needs to find both node and whatever hooks use. */
function pathFor(ship: Ship): string {
  const nodeBinDir = dirname(process.execPath);
  const parts = [nodeBinDir];
  if (ship.extraPath) parts.push(ship.extraPath);
  parts.push('/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return parts.join(':');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function planLaunchd(ship: Ship, crewHome: string): InstallPlan {
  const label = labelFor(crewHome);
  const unitPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const crewLog = ship.logFile;
  const schedulerLog = schedulerLogFor(crewLog);
  const crewBin = join(crewHome, 'bin', 'crew');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`crew install\` — re-run it rather than hand-editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(crewBin)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathFor(ship))}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(crewHome)}</string>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(schedulerLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(schedulerLog)}</string>
</dict>
</plist>
`;
  return {
    mechanism: 'launchd',
    unitPaths: [unitPath],
    unitContent: { [unitPath]: content },
    crontabLine: null,
    loadCommands: [['launchctl', 'load', unitPath]],
    crewLog,
    schedulerLog,
  };
}

function planSystemd(ship: Ship, crewHome: string): InstallPlan {
  const label = labelFor(crewHome);
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const servicePath = join(unitDir, `${label}.service`);
  const timerPath = join(unitDir, `${label}.timer`);
  const crewLog = ship.logFile;
  const schedulerLog = schedulerLogFor(crewLog);
  const crewBin = join(crewHome, 'bin', 'crew');

  const service = `# Written by \`crew install\` — re-run it rather than hand-editing this file.
[Unit]
Description=Tablation crew — one poll cycle

[Service]
Type=oneshot
ExecStart=${process.execPath} ${crewBin} run
WorkingDirectory=${crewHome}
Environment=PATH=${pathFor(ship)}
StandardOutput=append:${schedulerLog}
StandardError=append:${schedulerLog}
`;

  // OnActiveSec (not OnBootSec) + no Persistent=true: the first fire is a
  // full interval after the timer is enabled, never at load. OnUnitActiveSec
  // repeats it every interval after that fire finishes.
  const timer = `# Written by \`crew install\` — re-run it rather than hand-editing this file.
[Unit]
Description=Tablation crew — poll timer

[Timer]
OnActiveSec=${INTERVAL_SECONDS}
OnUnitActiveSec=${INTERVAL_SECONDS}
AccuracySec=5

[Install]
WantedBy=timers.target
`;

  return {
    mechanism: 'systemd',
    unitPaths: [servicePath, timerPath],
    unitContent: { [servicePath]: service, [timerPath]: timer },
    crontabLine: null,
    loadCommands: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', `${label}.timer`],
    ],
    crewLog,
    schedulerLog,
  };
}

function planCron(ship: Ship, crewHome: string): InstallPlan {
  const crewLog = ship.logFile;
  const schedulerLog = schedulerLogFor(crewLog);
  const crewBin = join(crewHome, 'bin', 'crew');
  const minutes = Math.max(1, Math.round(INTERVAL_SECONDS / 60));
  const line =
    `*/${minutes} * * * * ` +
    `cd ${crewHome} && PATH=${pathFor(ship)} ${process.execPath} ${crewBin} run >> ${schedulerLog} 2>&1`;
  return {
    mechanism: 'cron',
    unitPaths: [],
    unitContent: {},
    crontabLine: line,
    loadCommands: [],
    crewLog,
    schedulerLog,
  };
}

/**
 * Which mechanism this host gets. `hasSystemd` is supplied by the caller
 * (a real check against this machine) rather than probed in here, so the
 * choice stays a pure function of its inputs.
 */
export function planInstall(
  ship: Ship, crewHome: string, hostShip: ShipPlatform, hasSystemd: boolean,
): InstallPlan {
  if (hostShip === 'macos') return planLaunchd(ship, crewHome);
  if (hostShip === 'linux' && hasSystemd) return planSystemd(ship, crewHome);
  if (hostShip === 'linux') return planCron(ship, crewHome);
  throw new Error(`crew install: no scheduler support yet for ${hostShip} (Windows is planned, not built)`);
}

export function planUninstall(
  ship: Ship, crewHome: string, hostShip: ShipPlatform, hasSystemd: boolean,
): UninstallPlan {
  const label = labelFor(crewHome);
  if (hostShip === 'macos') {
    const unitPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    return {
      mechanism: 'launchd',
      unitPaths: [unitPath],
      crontabLine: null,
      unloadCommands: [['launchctl', 'unload', unitPath]],
    };
  }
  if (hostShip === 'linux' && hasSystemd) {
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    return {
      mechanism: 'systemd',
      unitPaths: [join(unitDir, `${label}.service`), join(unitDir, `${label}.timer`)],
      crontabLine: null,
      unloadCommands: [['systemctl', '--user', 'disable', '--now', `${label}.timer`]],
    };
  }
  if (hostShip === 'linux') {
    return {
      mechanism: 'cron',
      unitPaths: [],
      crontabLine: cronMarkerFor(label),
      unloadCommands: [],
    };
  }
  return { mechanism: 'none', unitPaths: [], crontabLine: null, unloadCommands: [] };
}

export interface InstallLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

/** Runs a plan's argv list in order, stopping at the first failure. */
function runAll(commands: string[][], cwd: string, log: InstallLog): boolean {
  for (const [bin, ...args] of commands) {
    const res = spawnSync(bin!, args, { cwd, encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      log.warn(`${bin} ${args.join(' ')} exited ${res.status ?? 'error'}`, {
        output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? String(res.error) : ''}`,
      });
      return false;
    }
  }
  return true;
}

export async function applyInstall(plan: InstallPlan, crewHome: string, dryRun: boolean, log: InstallLog): Promise<void> {
  for (const path of plan.unitPaths) {
    if (dryRun) { log.emit(`would write ${path}`); continue; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plan.unitContent[path]!);
    log.emit(`wrote ${path}`);
  }

  if (plan.crontabLine) {
    if (dryRun) {
      log.emit(`would add to crontab: ${plan.crontabLine}`);
    } else {
      addCrontabLine(cronMarkerFor(labelFor(crewHome)), plan.crontabLine);
      log.emit('added crontab entry');
    }
  }

  if (plan.loadCommands.length) {
    if (dryRun) {
      for (const c of plan.loadCommands) log.emit(`would run: ${c.join(' ')}`);
    } else {
      const ok = runAll(plan.loadCommands, crewHome, log);
      if (!ok) throw new Error('crew install: loading the unit failed — see the warning above');
      log.emit(`loaded (${plan.mechanism}), firing every ${INTERVAL_SECONDS}s starting ${INTERVAL_SECONDS}s from now`);
    }
  }

  log.emit(`crew's own log: ${plan.crewLog}`);
  log.emit(`scheduler log (only what escapes the crew, e.g. a crash before it starts): ${plan.schedulerLog}`);
}

export async function applyUninstall(plan: UninstallPlan, crewHome: string, dryRun: boolean, log: InstallLog): Promise<void> {
  if (plan.mechanism === 'none') { log.emit('nothing to uninstall on this platform'); return; }

  if (plan.unloadCommands.length) {
    if (dryRun) {
      for (const c of plan.unloadCommands) log.emit(`would run: ${c.join(' ')}`);
    } else {
      // A unit that was never loaded fails to unload; that is not this
      // command's problem to escalate, only to note.
      const ok = runAll(plan.unloadCommands, crewHome, log);
      if (!ok) log.warn('unload command failed — it may not have been loaded; continuing to remove files');
    }
  }

  for (const path of plan.unitPaths) {
    if (!existsSync(path)) continue;
    if (dryRun) { log.emit(`would remove ${path}`); continue; }
    unlinkSync(path);
    log.emit(`removed ${path}`);
  }

  if (plan.crontabLine) {
    if (dryRun) {
      log.emit('would remove crontab entry');
    } else {
      removeCrontabLine(cronMarkerFor(labelFor(crewHome)));
      log.emit('removed crontab entry');
    }
  }
}

function readCrontab(): string {
  const res = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  // `crontab -l` exits non-zero with "no crontab for user" on a fresh
  // account — that is an empty crontab, not a failure to report.
  return res.status === 0 ? (res.stdout ?? '') : '';
}

function writeCrontab(text: string): void {
  spawnSync('crontab', ['-'], { input: text, encoding: 'utf8' });
}

// `marker` is this checkout's own — see `labelFor`/`cronMarkerFor` — so a
// reinstall replaces only this checkout's line and never a different
// checkout's, whatever else the crontab holds.
function addCrontabLine(marker: string, line: string): void {
  const existing = readCrontab();
  const lines = existing.split('\n').filter((l) => l.trim() && !l.includes(marker));
  lines.push(marker, line);
  writeCrontab(`${lines.join('\n')}\n`);
}

function removeCrontabLine(marker: string): void {
  const existing = readCrontab();
  const lines = existing.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(marker)) { i++; continue; } // also drops the line right after the marker
    kept.push(lines[i]!);
  }
  writeCrontab(`${kept.filter((l) => l.trim()).join('\n')}${kept.some((l) => l.trim()) ? '\n' : ''}`);
}

/** Is `systemctl --user` usable on this host? Probed once, at the call site. */
export function detectSystemd(): boolean {
  if (process.platform !== 'linux') return false;
  const res = spawnSync('systemctl', ['--user', 'status'], { encoding: 'utf8' });
  // Absent binary -> ENOENT (res.error). Present but no session bus is
  // still "has systemd", just not running right now — code alone would
  // wrongly read that as absent, so only a missing binary falls back.
  return !res.error;
}
