#!/usr/bin/env node
/**
 * `crew` — the CLI.
 *
 * Every command that could change something takes `--dry-run`, and the
 * interlock (`enabled: false` per connection) refuses anything that writes
 * until an operator arms it deliberately.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, connection, type RoleName } from './config.ts';
import { State } from './state.ts';
import { Emitter, eventFileFor } from './events.ts';
import { decideCycle, rosterFor } from './poll.ts';
import { planAgentRun, describePlan, spawnAgent } from './agent.ts';
import { hostPlatform, satisfies, explain } from './platform.ts';
import { loadRepoConfig, resolveRepoConfig, validateEffective } from './repo-config.ts';
import { runRelease } from './release-run.ts';
import { planStamp, applyStamp } from './stamp.ts';
import { Tracker } from './tracker.ts';
import { startWatch } from './watch.ts';
import { findOrphans, listeners, ticketForPort, killGently, pidsInWorktree, worktreeExists } from './ports.ts';
import { gatherInbox, renderInbox } from './inbox.ts';
import { decideFleet, renderFleet, snapshot, changed, nextRoles } from './fleet.ts';
import { worktrees, git, gitOk, syncState, fastForward, fetchRemote } from './git.ts';
import { readFileSync } from 'node:fs';
import { dirname as dirOf, resolve as resolvePath } from 'node:path';

const CREW_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): never {
  process.stderr.write(`crew — a standing team of headless agents

  crew poll [conn]              decide a cycle and report it; writes nothing
  crew run [conn] [--role R]    run the winning role's session
  crew release [conn]           merge what QA verified, version it, ship it
  crew merge [conn]             merge verified branches and stop
  crew deploy [conn]            release now, even with nothing new to merge
  crew watch [conn]             live view of what the crew is doing
  crew status [conn]            paused/running state
  crew doctor [conn]            read-only preflight
  crew ports [conn]             which checkout owns which ports, and what is up
  crew reap [conn]              kill servers left behind by removed worktrees
  crew drop [conn] NNN          remove a merged ticket's worktree and branch
  crew sync [conn]              fast-forward worktrees that are behind their remote
  crew pause|resume [conn] [R]  pause everything, or one role
  crew log [conn]               tail the log
  crew inbox [--member NAME]    your tickets across every workspace (or a colleague's)

Options:
  --dry-run      decide everything, perform nothing
  --role NAME    force a role instead of the poll's choice (disables fall-through)
  --max-roles N  roles to try in one cycle when one does nothing (default 2)
  --skip-tests   release without the test gate (a hotfix over a red suite)
  --force        release even when nothing new merged
  --role NAME    (watch) show only this role
  --ticket KEY   (watch) show only this ticket
  --level warn   (watch) show only warnings and errors
  --tail N       (watch) lines of history on start (default 20)
  --member WHO   (inbox) a colleague's queue — an email matches exactly,
                 a name is a per-workspace label and may differ between boards
  --by-connection (inbox) group by workspace instead of status
  --all          (inbox) include closed tickets

In watch: space pauses the stream, q quits.
`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const command = positional[0];
if (!command) usage();

const cfg = loadConfig(CREW_HOME);
// `inbox` spans every connection, so it must not demand one be named.
// `inbox` spans every connection; `poll`/`run` do too when none is named.
const FLEET_CAPABLE = new Set(['poll', 'run']);
const named = positional[1];
const fleetWide = command === 'inbox' || (FLEET_CAPABLE.has(command) && !named && cfg.connections.length > 1);
const conn = fleetWide
  ? (cfg.connections[0] as ReturnType<typeof connection>)
  : connection(cfg, named);
const state = new State(cfg.ship.stateDir);
const dryRun = flag('dry-run');

const emit = new Emitter({
  connection: conn.name,
  eventFile: eventFileFor(cfg.ship.stateDir),
  logFile: cfg.ship.logFile,
  console: (l) => process.stderr.write(`${l}\n`),
});

/**
 * The interlock. A dry run is exempt because it writes nothing — being able
 * to inspect a disarmed installation is the point of having one.
 */
function requireArmed(what: string): void {
  if (dryRun || conn.enabled) return;
  process.stderr.write(
    `crew: connection "${conn.name}" is not enabled in ${cfg.configFile} — refusing to ${what}.\n` +
      `      Add --dry-run to see what it would do.\n`,
  );
  process.exit(0);
}

switch (command) {
  case 'poll':
  case 'run': {
    // Many connections and none named: poll them all and pick the most
    // urgent across the fleet (ISSUE-338).
    if (fleetWide) {
      const fleet = await decideFleet({
        connections: cfg.connections, ship: cfg.ship, state, emit,
        enabledOnly: !dryRun,
      });
      process.stdout.write(renderFleet(fleet));
      if (!fleet.winner) { emit.emit('nothing to run across the fleet'); break; }
      if (command === 'poll') break;

      const w = fleet.winner;
      if (!satisfies(cfg.ship.platform, w.connection.platform)) {
        emit.error(`refusing ${w.connection.name} — ${explain(cfg.ship.platform, w.connection.platform)}`);
        break;
      }
      if (!dryRun && !w.connection.enabled) {
        emit.emit(`connection "${w.connection.name}" is not enabled — not running`);
        break;
      }
      const fleetPlan = planAgentRun({
        role: w.role, conn: w.connection, ship: cfg.ship, crewHome: CREW_HOME,
        stateDir: cfg.ship.stateDir, roster: rosterFor(w.decision, w.connection, w.role),
      });
      if (dryRun) { process.stdout.write(`${describePlan(fleetPlan)}\n`); break; }
      emit.enter('agent', w.role);
      emit.emit(`starting agent run for ${w.connection.name}`);
      await spawnAgent(fleetPlan, emit);
      break;
    }

    // A ship that cannot satisfy the project's platform must not take its
    // work: it would fail at the first hook, having already claimed a ticket.
    if (!satisfies(cfg.ship.platform, conn.platform)) {
      emit.error(`refusing this connection — ${explain(cfg.ship.platform, conn.platform)}`);
      process.exit(1);
    }
    if (state.isPaused()) {
      emit.emit('the crew is paused');
      break;
    }
    const decision = await decideCycle({ conn, ship: cfg.ship, state, emit });

    if (decision.sweep.length) {
      const verb = dryRun ? 'would' : 'will';
      for (const s of decision.sweep) {
        emit.emit(`${verb} ${s.action} ${s.ticket.issue_id} -> ${s.to} (blockers: ${s.blockers})`, {
          ticket: s.ticket.issue_id, step: 'sweep',
        });
      }
    }

    const role = (value('role') as RoleName | undefined) ?? decision.selection.selected;
    if (command === 'poll' || !role) {
      if (!role) emit.emit('nothing to run this cycle');
      break;
    }

    requireArmed(`run the ${role} role`);

    // A role can be selected honestly and still do nothing: the poll sees
    // status and assignee, and cannot know a seat will judge a ticket
    // unbuildable. When that happens the runner-up is worth trying rather
    // than spending the whole cycle on a no-op.
    const maxRoles = Number(value('max-roles') ?? 2);
    const ran: RoleName[] = [];
    let current: RoleName | undefined = role;
    const tracker2 = new Tracker(conn, cfg.ship);

    while (current) {
      const plan = planAgentRun({
        role: current, conn, ship: cfg.ship, crewHome: CREW_HOME,
        stateDir: cfg.ship.stateDir, roster: rosterFor(decision, conn, current),
      });
      if (dryRun) {
        process.stdout.write(`${describePlan(plan)}\n`);
        break;
      }
      const before = snapshot(await tracker2.openTickets());
      emit.enter('agent', current);
      emit.emit('starting agent run');
      await spawnAgent(plan, emit);
      ran.push(current);

      if (ran.length >= maxRoles || value('role')) break;   // an explicit --role means that role only
      const after = snapshot(await tracker2.openTickets());
      if (changed(before, after)) { emit.emit(`${current} changed something — done this cycle`); break; }

      const remaining = nextRoles(decision, ran);
      current = remaining[0];
      if (current) emit.emit(`${ran.at(-1)} changed nothing — falling through to ${current}`);
      else emit.emit(`${ran.at(-1)} changed nothing, and no other role is pending`);
    }
    break;
  }

  case 'merge':
  case 'deploy':
  case 'release': {
    const repoFile = loadRepoConfig(conn.dir);
    const repo = resolveRepoConfig(repoFile, {
      hooks: conn.hooks, labels: conn.labels,
      release: { versionFiles: conn.release.versionFiles, changelog: conn.release.changelog },
      platform: conn.platform,
    }, conn.dir);
    const problems = validateEffective(repo);
    for (const p of problems) emit.warn(p);

    requireArmed('release');
    const tracker = new Tracker(conn, cfg.ship);
    const tickets = await tracker.openTickets();
    const outcome = await runRelease({
      cwd: conn.dir, repo, contract: tracker.contract, tickets, emit,
      dryRun, skipTests: flag('skip-tests'), shell: cfg.ship.shell,
      mergeOnly: command === 'merge',
      // `deploy` is the "go now" button: it exists for a commit a previous
      // deploy failed on, where nothing new will merge but the work is
      // genuinely unreleased.
      force: command === 'deploy' || flag('force'),
    });

    // Stamping is deliberately last and deliberately non-fatal: the work is
    // already live, and a tracker blip must not turn a good release into a
    // failed one. Untouched tickets are still `verified` and still named in
    // the released range, so the next cycle picks them up.
    if (outcome.deployed || outcome.confirmed) {
      emit.enter('reconcile');
      const plan = planStamp(
        conn.dir, tickets, tracker.contract,
        outcome.decision.lastReleased, outcome.decision.head,
      );
      if (plan.length) await applyStamp(tracker, plan, outcome.version, tracker.contract, emit, dryRun);
    } else if (outcome.stopped) {
      emit.emit(`nothing stamped — ${outcome.stopped}`);
    }
    break;
  }

  case 'watch': {
    const stop = startWatch({
      file: eventFileFor(cfg.ship.stateDir),
      tail: value('tail') ? Number(value('tail')) : undefined,
      filter: {
        role: value('role'),
        ticket: value('ticket'),
        level: value('level') as 'warn' | 'error' | undefined,
        connection: positional[1] ? conn.name : undefined,
      },
    });
    process.on('SIGINT', () => { stop(); process.exit(0); });
    break;
  }

  case 'inbox': {
    // Deliberately NOT scoped to one connection: the whole point is that no
    // single board can answer this.
    const who = value('member');
    const { items, errors, resolved, ambiguous } = await gatherInbox(cfg.connections, cfg.ship, {
      includeClosed: flag('all'),
      memberQuery: who,
    });
    // Say who the name resolved to. "no tickets" and "no such person" look
    // identical otherwise, and covering for a colleague is exactly when you
    // cannot afford to misread one as the other.
    if (who) {
      for (const r of resolved) {
        process.stdout.write(
          r.names.length
            ? `${r.connection}: ${r.names.join(', ')}${r.emails.length ? ` <${r.emails.join(', ')}>` : ''}` +
              `${r.by === 'name' ? ' (matched by name)' : ''}\n`
            : `${r.connection}: no crew member matching "${who}"\n`,
        );
      }
      if (ambiguous) {
        process.stderr.write(
          `\n  WARNING: "${who}" resolved to different people on different workspaces.\n` +
          `  A name is a per-workspace label, not an identity — this queue is a mixture.\n` +
          `  Use an email address to match exactly.\n`,
        );
      }
      process.stdout.write('\n');
    }
    const subject = who
      ? [...new Set(resolved.flatMap((r) => r.names))].join(', ') || `"${who}"`
      : undefined;
    process.stdout.write(renderInbox(items, flag('by-connection'), subject));
    for (const e of errors) process.stderr.write(`  (${e.connection} unreachable: ${e.error})\n`);
    break;
  }

  case 'ports': {
    const parent = resolvePath(conn.dir, '..');
    const rows = listeners()
      .map((l) => ({ ...l, t: ticketForPort(l.port) }))
      .filter((r) => r.t)
      .sort((a, b) => a.port - b.port);
    if (!rows.length) { process.stdout.write('nothing of ours is listening\n'); break; }
    for (const r of rows) {
      const live = worktreeExists(parent, conn.worktreePrefix, r.t!.n);
      process.stdout.write(
        `${String(r.port).padEnd(6)} ${r.t!.role.padEnd(9)} ISSUE-${String(r.t!.n).padEnd(5)} ` +
          `pid ${String(r.pid).padEnd(7)} ${live ? 'worktree present' : 'ORPHAN — worktree gone'}\n`,
      );
    }
    break;
  }

  case 'reap': {
    emit.enter('worktree');
    const parent = resolvePath(conn.dir, '..');
    const orphans = findOrphans(parent, conn.worktreePrefix);
    if (!orphans.length) { emit.emit('nothing to clean up'); break; }
    for (const o of orphans) {
      emit.emit(
        `${dryRun ? 'would kill' : 'killing'} orphaned ${o.role} on :${o.port} (pid ${o.pid})` +
          ` — no worktree for ISSUE-${o.n}`,
      );
    }
    if (!dryRun) await killGently(orphans.map((o) => o.pid));
    break;
  }

  case 'drop': {
    emit.enter('worktree');
    const n = positional[2] ?? positional[1];
    if (!n || !/^\d+$/.test(n)) { process.stderr.write('drop: need a ticket number\n'); process.exit(2); }
    const num = Number(n);
    const parent = resolvePath(conn.dir, '..');
    const wt = `${parent}/${conn.worktreePrefix}${n}`;
    const pids = pidsInWorktree(wt, num);
    if (pids.length) {
      emit.emit(`${dryRun ? 'would kill' : 'killing'} processes still inside ${wt}: ${pids.join(' ')}`);
      if (!dryRun) await killGently(pids);
    }
    if (dryRun) {
      emit.emit(`would remove worktree ${wt} and branch issue-${n}`);
      break;
    }
    gitOk(conn.dir, ['worktree', 'remove', '--force', wt]);
    gitOk(conn.dir, ['branch', '-D', `issue-${n}`]);
    emit.emit(`dropped ISSUE-${n}`);
    break;
  }

  case 'sync': {
    // A reviewer's commits land on the remote; until a worktree takes them the
    // dev seat builds on stale code and QA verifies something nobody reviewed.
    emit.enter('worktree');
    fetchRemote(conn.dir);
    let tracked = 0;
    let acted = 0;
    for (const w of worktrees(conn.dir)) {
      if (!w.branch) continue;
      const s2 = syncState(w.path, w.branch);
      if (!s2.upstream) continue;
      tracked++;
      if (s2.canFastForward) {
        acted++;
        if (dryRun) emit.emit(`would fast-forward ${w.branch}: ${s2.detail}`);
        else emit.emit(fastForward(w.path, w.branch) ? `fast-forwarded ${w.branch}` : `could not fast-forward ${w.branch}`);
      } else if (s2.behind > 0 || s2.ahead > 0) {
        acted++;
        emit.warn(`${w.branch}: ${s2.detail}`);
      }
    }
    // Silence would read as "checked and fine"; say which it was.
    if (tracked === 0) emit.emit('no worktree tracks a remote branch — nothing to sync');
    else if (acted === 0) emit.emit(`${tracked} worktree(s) tracking a remote, all level with it`);
    break;
  }

  case 'pause':
  case 'resume': {
    const role = positional[2] ?? (['dev', 'design', 'qa'].includes(positional[1] ?? '') ? positional[1] : undefined);
    if (command === 'pause') state.pause(role as RoleName | undefined);
    else state.resume(role as RoleName | undefined);
    process.stdout.write(`${command}d${role ? ` role ${role}` : ''}\n`);
    break;
  }

  case 'log': {
    try {
      const text = readFileSync(cfg.ship.logFile, 'utf8').split('\n');
      process.stdout.write(`${text.slice(-(Number(value('tail')) || 40)).join('\n')}\n`);
    } catch {
      process.stdout.write(`no log yet at ${cfg.ship.logFile}\n`);
    }
    break;
  }

  case 'status': {
    process.stdout.write(
      `ship:       ${cfg.ship.name} (${cfg.ship.platform})\n` +
        `connection: ${conn.name} -> ${conn.dir}\n` +
        `enabled:    ${conn.enabled}\n` +
        `crew:       ${state.isPaused() ? 'paused' : 'active'}\n` +
        `watermark:  ${state.watermark()}\n`,
    );
    for (const r of ['dev', 'design', 'qa'] as RoleName[]) {
      if (state.isRolePaused(r)) process.stdout.write(`role ${r}: paused\n`);
    }
    break;
  }

  case 'doctor': {
    const host = hostPlatform();
    process.stdout.write(
      `ship:              ${cfg.ship.name} (${host})\n` +
        `project requires:  ${conn.platform} — ${satisfies(host, conn.platform) ? 'OK' : 'MISMATCH'}\n` +
        `connections:       ${cfg.connections.map((c) => c.name).join(', ')}\n`,
    );

    // Does this machine have a row on the board, and which seats are its own?
    // Matched by name, per Brad's call: it is what an operator recognises.
    const tracker = new Tracker(conn, cfg.ship);
    const [ships, crewRows] = await Promise.all([tracker.shipRows(), tracker.crewRows()]);
    if (ships.length === 0) {
      process.stdout.write('ship record:       this workspace has no Ships table (fine)\n');
    } else {
      const mine = ships.filter((s2) => (s2.name ?? '').trim() === cfg.ship.name.trim());
      if (mine.length === 0) {
        process.stdout.write(
          `ship record:       NO row named "${cfg.ship.name}" — ` +
            `have: ${ships.map((s2) => s2.name).join(', ')}\n`,
        );
      } else if (mine.length > 1) {
        // A name is only an identity while it is unique; say so rather than
        // silently picking one.
        process.stdout.write(`ship record:       ${mine.length} rows named "${cfg.ship.name}" — ambiguous\n`);
      } else {
        const row = mine[0]!;
        const seats = crewRows.filter((c) => (c as { ship_id?: string }).ship_id === row.id);
        const declared = row.platform;
        process.stdout.write(
          `ship record:       ${row.name} (${declared ?? 'no platform'})` +
            `${declared && declared !== host ? ` — MISMATCH, this host is ${host}` : ''}\n` +
            `seats on it:       ${seats.length ? seats.map((c) => c.name).join(', ') : 'none'}\n`,
        );
      }
    }
    break;
  }

  default:
    usage();
}
