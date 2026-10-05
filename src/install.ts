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
 *   - Loading a periodic unit must not also start it: RunAtLoad / OnBootSec=0
 *     turns "installed" into "running right now", which is not what an
 *     operator asked for. This still holds for `release`/`passengers`, which
 *     stay periodic. `run` is the deliberate exception (ISSUE-763): it is a
 *     genuine persistent service now, not a timer, so "installed" IS meant
 *     to mean "running" — see `planLaunchd`/`planSystemd`'s own comments.
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
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Ship } from './config.ts';
import type { ShipPlatform } from './platform.ts';
import { isCompiledBinary } from './runtime-info.ts';

/**
 * The argv that launches crew: `node bin/crew` from a checkout, or just the
 * binary itself when this is a `bun build --compile` executable — there is
 * no separate script for a compiled binary's own `process.execPath` to run.
 */
function crewInvocation(crewHome: string): string[] {
  if (isCompiledBinary(import.meta.url)) return [process.execPath];
  return [process.execPath, join(crewHome, 'bin', 'crew')];
}

/** How often the timer fires. Matches the plist this replaces (2 minutes). */
export const INTERVAL_SECONDS = 120;

/**
 * `run` (poll, select, one agent session), `release` (test, build, deploy)
 * and `passengers` (Host Passengers container/tunnel lifecycle sync) are
 * three SEPARATE scheduler units, each on its own timer — see the
 * release-lane comment on `case 'run'` in cli.ts. A release is minutes, not
 * seconds, and used to run inline at the end of `run`, so every board sat
 * idle behind whichever one's release was slow; `passengers` used to run
 * inline at the top of `run` for the same reason — a long agent turn could
 * block the next container/tunnel health check for as long as that turn
 * took, even though passenger health has nothing to do with which ticket a
 * cycle happens to work (ISSUE-677). `install` writes all three units by
 * default; `run`'s own gets `--no-release` appended, since the `release`
 * unit now owns that.
 */
export type InstallJob = 'run' | 'release' | 'passengers';

/**
 * A launchd label / systemd unit stem / cron marker unique to this checkout
 * AND job. Hashing the checkout's own real path — rather than a fixed
 * constant — is what keeps two checkouts (a real production install and a
 * ticket worktree testing this very file, say) from writing, loading or
 * unloading each other's scheduler unit; the job suffix does the same
 * between `run` and `release` on the SAME checkout, which would otherwise
 * hash identically and silently overwrite one another's unit file.
 * `crewHome`, not `process.cwd()`: the label must stay the same across
 * `install` and a later `uninstall` run from anywhere within the checkout.
 * `realpathSync` collapses symlinks so a checkout reached two different ways
 * still hashes to one label.
 */
export function labelFor(crewHome: string, job: InstallJob): string {
  const real = (() => {
    try {
      return realpathSync(crewHome);
    } catch {
      return crewHome;
    }
  })();
  const hash = createHash('sha1').update(real).digest('hex').slice(0, 8);
  const stem =
    job === 'release' ? 'com.tablation.crew-release' :
    job === 'passengers' ? 'com.tablation.crew-passengers' :
    'com.tablation.crew';
  return `${stem}.${hash}`;
}

function cronMarkerFor(label: string): string {
  return `# crew:${label} — managed by \`crew install\`, do not edit by hand`;
}

/**
 * The subcommand a unit actually runs, per job and mechanism.
 *
 * `release` and `passengers` are unchanged by ISSUE-763: they stay on their
 * own fixed timers, one-shot per fire. `run` becomes a persistent service
 * (`crew daemon`, the long-running loop from ISSUE-762) on launchd and
 * systemd, since both can supervise a real process. Plain cron cannot — a
 * crontab line only ever fires a fresh invocation and has no concept of "keep
 * this process alive" — so a `run` job on cron keeps the old one-shot
 * `crew run --no-release` invocation, deliberately not cut over. See
 * `planCron`'s own comment for the consequence of that.
 */
function subcommandFor(job: InstallJob, mechanism: InstallMechanism): string[] {
  if (job === 'release') return ['release', '--fleet'];
  if (job === 'passengers') return ['passengers'];
  if (mechanism === 'cron') return ['run', '--no-release'];
  return ['daemon'];
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
  /**
   * argv to run, in order, BEFORE `loadCommands`, on a reinstall. Only
   * launchd needs this: `launchctl load` on an already-loaded job is a
   * documented no-op that keeps running the OLD in-memory definition even
   * after the plist on disk has changed, so a reinstall must unload first.
   * systemd's `daemon-reload` + `enable --now` and cron's plain crontab
   * overwrite both already pick up a changed unit on every install with no
   * separate unload step, so they leave this empty. Tolerated to fail (a
   * fresh install has nothing loaded yet) — see `applyInstall`.
   */
  preLoadCommands: string[][];
  /** argv to run, in order, once the unit files exist. */
  loadCommands: string[][];
  /** Where the crew's own emitter writes — from config, never invented here. */
  crewLog: string;
  /** Where the scheduler's own stdout/stderr goes — always a DIFFERENT file. */
  schedulerLog: string;
  /**
   * The crontab marker this plan's job/checkout owns, when `crontabLine` is
   * set. Carried on the plan (rather than recomputed by `apply*` from
   * `crewHome` alone) so `applyInstall`/`applyUninstall` never have to know
   * which job they were handed — `run` and `release` on the same checkout
   * need DIFFERENT markers, or one job's crontab entry would silently
   * replace the other's on every reinstall.
   */
  cronMarker: string | null;
}

export interface UninstallPlan {
  mechanism: InstallMechanism | 'none';
  unitPaths: string[];
  crontabLine: string | null;
  unloadCommands: string[][];
}

/**
 * The scheduler's own log, derived from the crew's so the two never collide.
 * The `release` job gets its own suffix too — same reasoning as `labelFor`'s
 * job suffix: two units on one checkout must not share a file the way `run`
 * alone always has, or one job's crash-before-crew's-own-emitter-starts
 * output is unreadable interleaved with the other's.
 */
function schedulerLogFor(crewLog: string, job: InstallJob): string {
  const ext = extname(crewLog);
  const stem = ext ? crewLog.slice(0, -ext.length) : crewLog;
  const suffix =
    job === 'release' ? 'release-scheduler' :
    job === 'passengers' ? 'passengers-scheduler' :
    'scheduler';
  return `${stem}.${suffix}${ext || '.log'}`;
}

/**
 * `PATH` a launched unit needs to find both node and whatever hooks use.
 * Exported so `crew doctor` checks the agent binary and git against the same
 * PATH the daemon actually gets, not the operator's interactive shell.
 */
export function pathFor(ship: Ship): string {
  const nodeBinDir = dirname(process.execPath);
  const parts = [nodeBinDir];
  if (ship.extraPath) parts.push(ship.extraPath);
  parts.push('/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return parts.join(':');
}

/**
 * Where `bin` resolves to on `searchPath`, or undefined. A name with a slash
 * is checked as a path, as the OS does; a bare name is looked up in each
 * PATH directory in order. Only an existing, executable regular file counts.
 */
export function findOnPath(bin: string, searchPath: string): string | undefined {
  const candidates = bin.includes('/')
    ? [bin]
    : searchPath.split(':').filter(Boolean).map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here, or not executable — keep looking down the PATH.
    }
  }
  return undefined;
}

/**
 * Why Host Passengers cannot see `docker` under the scheduler (CREW-1375), or
 * undefined when it can. A Docker Desktop CLI in `/usr/local/bin` answers
 * `docker info` in the operator's shell but is absent from `pathFor(ship)`,
 * so the timer logs a bare "Docker is not available" while `crew install`'s
 * pull (run in the shell) succeeds. When the shell does find it, the message
 * names the directory `ship.extraPath` needs.
 */
/** Where Docker's CLI usually lives, for a unit that has no interactive PATH to consult. */
export const COMMON_DOCKER_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.docker', 'bin')].join(':');

export function dockerPathProblem(ship: Ship, shellPath: string = process.env.PATH ?? ''): string | undefined {
  const schedulerPath = pathFor(ship);
  if (findOnPath('docker', schedulerPath)) return undefined;
  const inShell = findOnPath('docker', shellPath);
  return inShell
    ? `\`docker\` is not on the scheduler PATH (${schedulerPath}) but is at ${inShell} in your shell; ` +
        `add ${dirname(inShell)} to ship.extraPath in crew.yaml and run \`crew install\``
    : `\`docker\` is not on the scheduler PATH (${schedulerPath}) or your shell PATH; install Docker, ` +
        'then add its directory to ship.extraPath in crew.yaml and run `crew install`';
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function planLaunchd(ship: Ship, crewHome: string, job: InstallJob): InstallPlan {
  const label = labelFor(crewHome, job);
  const unitPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const crewLog = ship.logFile;
  const schedulerLog = schedulerLogFor(crewLog, job);
  // `run` (ISSUE-763) is now a persistent service: KeepAlive restarts it
  // whenever it exits (crash or otherwise) instead of the timer re-firing a
  // fresh one-shot invocation, and RunAtLoad starts it the moment `crew
  // install` loads the plist — the whole point of "installed" for a
  // persistent service is "running". `release`/`passengers` keep the old
  // fixed-interval, load-but-don't-run-yet shape untouched.
  const persistent = job === 'run';
  const scheduleKeys = persistent
    ? `  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>`
    : `  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <false/>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`crew install\` — re-run it rather than hand-editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    ${crewInvocation(crewHome).map((a) => `<string>${xmlEscape(a)}</string>`).join('\n    ')}
    ${subcommandFor(job, 'launchd').map((a) => `<string>${xmlEscape(a)}</string>`).join('\n    ')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathFor(ship))}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(crewHome)}</string>
${scheduleKeys}
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
    cronMarker: null,
    preLoadCommands: [['launchctl', 'unload', unitPath]],
    loadCommands: [['launchctl', 'load', unitPath]],
    crewLog,
    schedulerLog,
  };
}

function planSystemd(ship: Ship, crewHome: string, job: InstallJob): InstallPlan {
  const label = labelFor(crewHome, job);
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const servicePath = join(unitDir, `${label}.service`);
  const crewLog = ship.logFile;
  const schedulerLog = schedulerLogFor(crewLog, job);
  const description =
    job === 'release' ? 'Tablation crew — release' :
    job === 'passengers' ? 'Tablation crew — Host Passengers sync' :
    'Tablation crew — persistent supervisor loop';

  // `run` (ISSUE-763) is a persistent service now: a plain `.service`, no
  // companion `.timer` — `Type=simple` (the default; the process is meant to
  // keep running, not exit) plus `Restart=on-failure` is systemd's own
  // equivalent of launchd's KeepAlive. `enable --now` both starts it
  // immediately and re-starts it at every future login, matching "installed"
  // meaning "running" for a persistent service. `release`/`passengers` keep
  // the original oneshot service + timer pair, untouched.
  if (job === 'run') {
    const service = `# Written by \`crew install\` — re-run it rather than hand-editing this file.
[Unit]
Description=${description}

[Service]
Type=simple
ExecStart=${[...crewInvocation(crewHome), ...subcommandFor(job, 'systemd')].join(' ')}
WorkingDirectory=${crewHome}
Environment=PATH=${pathFor(ship)}
StandardOutput=append:${schedulerLog}
StandardError=append:${schedulerLog}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    return {
      mechanism: 'systemd',
      unitPaths: [servicePath],
      unitContent: { [servicePath]: service },
      crontabLine: null,
      cronMarker: null,
      preLoadCommands: [],
      loadCommands: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', `${label}.service`],
      ],
      crewLog,
      schedulerLog,
    };
  }

  const timerPath = join(unitDir, `${label}.timer`);
  const service = `# Written by \`crew install\` — re-run it rather than hand-editing this file.
[Unit]
Description=${description}

[Service]
Type=oneshot
ExecStart=${[...crewInvocation(crewHome), ...subcommandFor(job, 'systemd')].join(' ')}
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
Description=${description} — timer

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
    cronMarker: null,
    preLoadCommands: [],
    loadCommands: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', `${label}.timer`],
    ],
    crewLog,
    schedulerLog,
  };
}

function planCron(ship: Ship, crewHome: string, job: InstallJob): InstallPlan {
  const label = labelFor(crewHome, job);
  const crewLog = ship.logFile;
  const schedulerLog = schedulerLogFor(crewLog, job);
  const minutes = Math.max(1, Math.round(INTERVAL_SECONDS / 60));
  const line =
    `*/${minutes} * * * * ` +
    `cd ${crewHome} && PATH=${pathFor(ship)} ${[...crewInvocation(crewHome), ...subcommandFor(job, 'cron')].join(' ')} >> ${schedulerLog} 2>&1`;
  return {
    mechanism: 'cron',
    unitPaths: [],
    unitContent: {},
    crontabLine: line,
    cronMarker: cronMarkerFor(label),
    preLoadCommands: [],
    loadCommands: [],
    crewLog,
    schedulerLog,
  };
}

/**
 * Which mechanism this host gets. `hasSystemd` is supplied by the caller
 * (a real check against this machine) rather than probed in here, so the
 * choice stays a pure function of its inputs. `job` defaults to `'run'` so
 * every existing caller (and every test written before the release lane
 * existed) keeps behaving exactly as it did.
 */
export function planInstall(
  ship: Ship, crewHome: string, hostShip: ShipPlatform, hasSystemd: boolean, job: InstallJob = 'run',
): InstallPlan {
  if (hostShip === 'macos') return planLaunchd(ship, crewHome, job);
  if (hostShip === 'linux' && hasSystemd) return planSystemd(ship, crewHome, job);
  if (hostShip === 'linux') return planCron(ship, crewHome, job);
  throw new Error(`crew install: no scheduler support yet for ${hostShip} (Windows is planned, not built)`);
}

export function planUninstall(
  ship: Ship, crewHome: string, hostShip: ShipPlatform, hasSystemd: boolean, job: InstallJob = 'run',
): UninstallPlan {
  const label = labelFor(crewHome, job);
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
    // `run` (ISSUE-763) is a lone persistent `.service`, disabled/stopped
    // directly — no `.timer` unit exists for it any more. `release` and
    // `passengers` keep the original service+timer pair.
    if (job === 'run') {
      return {
        mechanism: 'systemd',
        unitPaths: [join(unitDir, `${label}.service`)],
        crontabLine: null,
        unloadCommands: [['systemctl', '--user', 'disable', '--now', `${label}.service`]],
      };
    }
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

export interface DaemonControlPlan {
  mechanism: InstallMechanism | 'none';
  /** null when this mechanism has no persistent process to control (cron, none). */
  startCommand: string[] | null;
  stopCommand: string[] | null;
  statusCommand: string[] | null;
}

/**
 * `crew daemon start/stop/status` (ISSUE-763) — thin wrappers around
 * whichever OS service manager `crew install` already handed the `run` job
 * to, always targeting the SAME label/unit `planInstall(..., 'run')` writes.
 *
 * launchd has no clean "stop, but stay startable" verb for a `KeepAlive:
 * true` job — `launchctl stop` on one just gets relaunched. `unload`/`load`
 * (the same pair `applyInstall`'s `preLoadCommands`/`loadCommands` already
 * use) is what actually stops it and, combined with `RunAtLoad: true`,
 * starts it again — so `stop` unloads and `start` loads, not `launchctl
 * start`/`stop`.
 *
 * systemd's `start`/`stop` verbs don't have that gotcha: `Restart=on-failure`
 * only fires on a crash, never on a deliberate `systemctl stop`.
 *
 * Cron cannot supervise a persistent process at all (see `subcommandFor`'s
 * doc comment) — there is no service for these commands to control there,
 * so all three come back null and the caller should say so rather than
 * running nothing silently.
 */
export function planDaemonControl(crewHome: string, hostShip: ShipPlatform, hasSystemd: boolean): DaemonControlPlan {
  const label = labelFor(crewHome, 'run');
  if (hostShip === 'macos') {
    const unitPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    return {
      mechanism: 'launchd',
      startCommand: ['launchctl', 'load', unitPath],
      stopCommand: ['launchctl', 'unload', unitPath],
      statusCommand: ['launchctl', 'list', label],
    };
  }
  if (hostShip === 'linux' && hasSystemd) {
    const unit = `${label}.service`;
    return {
      mechanism: 'systemd',
      startCommand: ['systemctl', '--user', 'start', unit],
      stopCommand: ['systemctl', '--user', 'stop', unit],
      statusCommand: ['systemctl', '--user', 'status', unit],
    };
  }
  if (hostShip === 'linux') {
    return { mechanism: 'cron', startCommand: null, stopCommand: null, statusCommand: null };
  }
  return { mechanism: 'none', startCommand: null, stopCommand: null, statusCommand: null };
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
      addCrontabLine(plan.cronMarker!, plan.crontabLine);
      log.emit('added crontab entry');
    }
  }

  if (plan.preLoadCommands.length) {
    if (dryRun) {
      for (const c of plan.preLoadCommands) log.emit(`would run: ${c.join(' ')}`);
    } else {
      // A unit that isn't loaded yet (first install) fails to unload — that
      // is expected, not a failure of this install, so it's only logged,
      // never thrown. See preLoadCommands' own doc comment for why this
      // step exists at all.
      const ok = runAll(plan.preLoadCommands, crewHome, log);
      if (!ok) log.emit('unload before reload failed — likely not loaded yet, continuing');
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
      // For uninstall, `crontabLine` on a cron plan IS the marker itself
      // (see `planUninstall`'s cron branch) — there is no separate line to
      // remove, only the marked block `addCrontabLine` wrote.
      removeCrontabLine(plan.crontabLine);
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
