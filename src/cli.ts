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
import {
  loadConfig, connection, resolveApiKey, reposOf, ticketsByRepo,
  type Unplaceable, type UnplaceableReason,
  ConfigError, type RoleName, type RepoTarget,
} from './config.ts';
import { State } from './state.ts';
import { Emitter, eventFileFor } from './events.ts';
import { decideCycle, rosterFor } from './poll.ts';
import { applySweep } from './blocked.ts';
import { planConflictBounce, applyConflictBounce } from './conflict.ts';
import { planStrandedVerified, applyStrandedVerified } from './stranded-verified.ts';
import { planAgentRun, describePlan, spawnAgent } from './agent.ts';
import { hostPlatform, satisfies, explain } from './platform.ts';
import { planInstall, planUninstall, applyInstall, applyUninstall, detectSystemd } from './install.ts';
import { loadRepoConfig, resolveRepoConfig, validateEffective, renderBranchName } from './repo-config.ts';
import { runRelease } from './release-run.ts';
import { describeUnplaceable } from './release.ts';
import { planStamp, applyStamp } from './stamp.ts';
import { renderEnvironment } from './environment.ts';
import { notify, describeRelease } from './notify.ts';
import { Tracker, type Ticket } from './tracker.ts';
import { validateContract } from './contract.ts';
import { startWatch } from './watch.ts';
import { findOrphansIn, listeners, ticketForPort, killGently, pidsInWorktree, worktreeExistsIn } from './ports.ts';
import { gatherInbox, renderInbox } from './inbox.ts';
import { decideFleet, renderFleet, snapshot, changed, nextRoles, since } from './fleet.ts';
import { discover, renderConnection } from './connect.ts';
import { worktrees, git, gitOk, syncState, fastForward, fetchRemote, branchForIssue } from './git.ts';
import { planWorktreeSweep, applyWorktreeSweep } from './worktree-sweep.ts';
import { readFileSync, existsSync } from 'node:fs';
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
  crew reap [conn]              kill orphaned servers, drop worktrees for closed tickets
  crew drop [conn] NNN          remove a merged ticket's worktree and branch
  crew sync [conn]              fast-forward the checkout and its worktrees from the remote
  crew pause|resume [conn] [R]  pause everything, or one role
  crew log [conn]               tail the log
  crew inbox [--member NAME]    your tickets across every workspace (or a colleague's)
  crew connect                  resolve a workspace's ids into a crew.yaml block
  crew install                  write and load this platform's scheduler unit
  crew uninstall                unload and remove it
     --workspace-id ID --key K [--project NAME] [--area NAME] [--dir PATH] [--name N]

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

/**
 * A bad config is an operator's mistake, not a crash. Print what is wrong and
 * exit — a stack trace naming this file's internals tells them nothing about
 * their YAML.
 */
let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig(CREW_HOME);
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`crew: ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}
// `inbox` spans every connection, so it must not demand one be named.
// `inbox` spans every connection; `poll`/`run` do too when none is named.
const FLEET_CAPABLE = new Set(['poll', 'run']);
const named = positional[1];
const fleetWide = command === 'inbox' || (FLEET_CAPABLE.has(command) && !named && cfg.connections.length > 1);
let conn: ReturnType<typeof connection>;
try {
  conn = fleetWide ? (cfg.connections[0] as ReturnType<typeof connection>) : connection(cfg, named);
} catch (e) {
  if (e instanceof ConfigError) { process.stderr.write(`crew: ${e.message}\n`); process.exit(2); }
  throw e;
}
const state = new State(cfg.ship.stateDir);
const dryRun = flag('dry-run');

/**
 * Commands that must not overlap themselves. `poll`, `watch`, `status` and
 * the read-only inspections may run any number of times at once.
 *
 * `run` used to be a single blanket lock here (`{ run: 'crew' }`) — one
 * pid file, so a second `run` firing while the first was still mid-session
 * always skipped its whole cycle, whatever role either one wanted. That is
 * what let a single long dev session hold QA's queue idle for 68 minutes
 * (ISSUE-353) with nothing else able to run. ISSUE-381 replaces it with
 * `State.acquireRun`, taken once the role is actually known (role-distinct,
 * capacity-limited — see its own comment), so `run` is no longer listed
 * here at all.
 *
 * `release`/`merge`/`deploy` take their own lock inside releasePhase(), so
 * a long release never blocks the next poll from starting.
 */
const EXCLUSIVE: Record<string, string> = {};

// A dry run writes to the terminal ONLY.
//
// It used to append to the shared event file and log, with nothing marking it
// hypothetical — so `crew watch` showed a dry run's "released 1.2.3" among the
// real ones, and the ship's own history recorded things that never happened.
// An inspection belongs to whoever ran it, not to the record.
const emit = new Emitter({
  connection: conn.name,
  eventFile: dryRun ? undefined : eventFileFor(cfg.ship.stateDir),
  logFile: dryRun ? undefined : cfg.ship.logFile,
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


/**
 * Release every connection, whoever won the agent slot.
 *
 * The release phase is per connection and has nothing to do with which board
 * got the agent this cycle: a repo with a QA-verified branch waiting needs
 * releasing even if its board had no agent work at all. Running only the
 * winner's would leave every other board's verified work sitting unmerged —
 * and the fleet branch previously ran none at all, which is the same bug that
 * left ISSUE-280 and ISSUE-292 unmerged for a day.
 *
 * Sequential rather than concurrent: each one runs a test suite, a build and a
 * deploy, and two of those at once on one machine is how a release starts
 * failing for reasons unrelated to the code.
 */
async function releaseFleet(): Promise<void> {
  for (const c of cfg.connections) {
    if (!dryRun && !c.enabled) continue;
    if (!satisfies(cfg.ship.platform, c.platform)) continue;
    for (const r of reposOf(c)) await releasePhase(c, r);
  }
}

/**
 * Release every repository of the connection in play.
 *
 * `crew run` on a single connection still has to cover all of its
 * repositories: a verified branch in the second one is no less ready than a
 * verified branch in the first.
 */
async function releaseTargets(opts: { mergeOnly?: boolean; force?: boolean } = {}): Promise<void> {
  const only = value('repo');
  const targets = reposOf(conn);
  const chosen = only ? targets.filter((t) => t.name === only) : targets;
  if (only && chosen.length === 0) {
    process.stderr.write(
      `crew: no repo named "${only}" on connection "${conn.name}" ` +
        `(have: ${targets.map((t) => t.name).join(', ')})\n`,
    );
    process.exit(2);
  }
  for (const t of chosen) await releasePhase(conn, t, opts);
}

/**
 * The Environment section of a session's prompt, for one connection.
 *
 * Assembled here rather than inside planAgentRun because it needs the repo's
 * own `.crew.yaml` and the connection's contract, and reading those is the
 * cycle's job, not the prompt builder's.
 */
/**
 * Every repository a connection serves, with its own contract resolved.
 *
 * One place, because three commands need it and each got it wrong its own way
 * before ISSUE-350: they read the connection's `dir` and `worktreePrefix` and
 * so saw only the first repo of an area that has several.
 */
function resolvedRepos(c: typeof conn) {
  return reposOf(c).map((t) => ({
    name: t.name,
    dir: t.dir,
    config: resolveRepoConfig(loadRepoConfig(t.dir), {
      hooks: c.hooks, labels: c.labels,
      release: { versionFiles: c.release.versionFiles, changelog: c.release.changelog },
      platform: c.platform,
      // The connection's prefix is a SHIP-level default for a repo that
      // declares none. A repo that declares its own shadows it, and `doctor`
      // reports that the way it reports every other shadowed setting.
      worktrees: { prefix: c.worktreePrefix },
    }, t.dir),
  }));
}

/** Where this connection's worktrees live, per repository. */
const worktreeLocations = (c: typeof conn) =>
  resolvedRepos(c).map((r) => ({
    parent: resolvePath(r.dir, '..'),
    prefix: r.config.worktrees.prefix,
  }));

function environmentFor(c: typeof conn): string {
  const contract = new Tracker(c, cfg.ship).contract;
  // Every repository the connection serves, not just the first. The session
  // has not picked its ticket yet, so which one it will work is unknowable
  // here — the brief describes them all (ISSUE-350).
  return renderEnvironment({
    conn: c, userAgent: cfg.ship.userAgent, repos: resolvedRepos(c), contract,
  });
}

/**
 * Connections whose unplaceable tickets have already been reported this run.
 *
 * `releasePhase` runs once per REPOSITORY, and every one of them computes the
 * same connection-wide unplaceable set — so without this the same message is
 * emitted once per repo, three times over for an area with three checkouts.
 * A process is one cycle, so a Set that lives as long as it is exactly the
 * right lifetime.
 */
const unplaceableReported = new Set<string>();

/** Emit what `describeUnplaceable` decided, once per connection per run. */
function reportUnplaceable(
  c: typeof conn,
  unplaceable: Array<Unplaceable<Ticket>>,
  verified: string,
  emit: Emitter,
): void {
  if (unplaceableReported.has(c.name)) return;
  unplaceableReported.add(c.name);
  for (const note of describeUnplaceable(unplaceable, verified)) {
    if (note.level === 'warn') emit.warn(note.message, { step: 'release' });
    else emit.emit(note.message, { step: 'release' });
  }
}

/**
 * The release phase, callable on its own (`crew release`) or as the tail of a
 * cycle (`crew run`).
 *
 * Running it after the agent phase is what the bash did, and it matters: a
 * ticket verified at 03:00 ships at 03:00 rather than waiting for a separate
 * schedule. The two phases take DIFFERENT locks, so a long release never
 * blocks the next poll from starting, and vice versa.
 */
async function releasePhase(
  c: typeof conn, target: RepoTarget, opts: { mergeOnly?: boolean; force?: boolean } = {},
): Promise<void> {
  const scope = `${c.name}/${target.name}`;
  // Per REPOSITORY, not per connection. A board's area spans several repos and
  // each releases on its own: they have separate versions, separate tags and
  // separate deploy targets, and a long release of one must not hold up
  // another. Scoping this to the connection meant only `conn.dir` was ever
  // released — every other repo on the board was silently never shipped.
  const relLock = dryRun ? undefined : state.acquire(`release-${scope}`);
  if (relLock && !relLock.ok) {
    emit.emit(`a previous release (pid ${relLock.heldBy}) is still running — skipping`, { step: 'release' });
    return;
  }
  try {

    const repoFile = loadRepoConfig(target.dir);
    const repo = resolveRepoConfig(repoFile, {
      hooks: c.hooks, labels: c.labels,
      release: { versionFiles: c.release.versionFiles, changelog: c.release.changelog },
      platform: c.platform,
      worktrees: { prefix: c.worktreePrefix },
    }, target.dir);
    const problems = validateEffective(repo);
    for (const p of problems) emit.warn(`${scope}: ${p}`);

    if (!dryRun && !c.enabled) return;
    const tracker = new Tracker(c, cfg.ship);
    const all = await tracker.openTickets();

    // Only this repository's tickets. Handing the whole board's tickets to a
    // release would look for their branches in the wrong checkout — and on a
    // near-miss (a branch of the same name in two repos) merge the wrong work.
    const { byRepo, unplaceable } = ticketsByRepo(c, all);
    const tickets = byRepo.get(target.name) ?? [];
    reportUnplaceable(c, unplaceable, tracker.contract.statuses.verified, emit);

    const outcome = await runRelease({
      cwd: target.dir, repo, contract: tracker.contract, tickets, emit,
      state: state.release(scope),
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
    if (outcome.deployed || outcome.confirmed || outcome.alreadyLive || outcome.integrated) {
      emit.enter('reconcile');
      const plan = planStamp(
        target.dir, tickets, tracker.contract,
        outcome.decision.lastReleased, outcome.decision.head,
        outcome.merged.map((m) => m.ticket.issue_id),
      );
      if (plan.length) await applyStamp(tracker, plan, outcome.version, tracker.contract, emit, dryRun);
    } else if (outcome.stopped) {
      emit.emit(`nothing stamped — ${outcome.stopped}`);
    }

    // Last, and non-fatal: whatever happened has happened, and telling someone
    // about it must not be able to change the outcome.
    const news = describeRelease(outcome, scope);
    if (news) await notify(c, cfg.ship, news, emit, dryRun);

    // A verified branch that would not merge, or a verified ticket with
    // nothing to merge at all. Non-fatal like everything else down here —
    // the release has already shipped whatever could ship — but unlike the
    // old behaviour neither evaporates: a conflict goes back to a lane that
    // can fix it (ISSUE-346 failed six times in an hour that way), and a
    // ticket the release cannot place at all is flagged and, if it repeats,
    // escalated to a person (ISSUE-379).
    if ((outcome.conflicts?.length || outcome.unbuildable?.length)) {
      // Comments are fetched only when one of these actually happens, which
      // is almost never — it costs a request on the rare cycle that needs
      // one, and none at all on the rest. Shared between both loops below.
      const comments = await tracker.comments();
      const seat = c.resolved?.seats.dev ?? c.resolved?.seats.qa ?? '';

      for (const f of outcome.conflicts ?? []) {
        try {
          const bounce = planConflictBounce(
            target.dir, f.candidate.ticket, f.candidate.branch!, repo.branch.base, f.paths, comments,
          );
          const r = await applyConflictBounce(tracker, bounce, tracker.contract, seat, emit, dryRun);
          if (r.kind === 'failed') {
            emit.warn(`could not hand back ${f.candidate.ticket.issue_id}: ${r.why}`, { step: 'merge' });
          }
        } catch (e) {
          emit.warn(
            `could not hand back ${f.candidate.ticket.issue_id}: ${(e as Error).message}`,
            { step: 'merge' },
          );
        }
      }

      for (const cand of outcome.unbuildable ?? []) {
        try {
          const stranded = planStrandedVerified(cand, repo.branch.base, repo.branch.remote, comments);
          const r = await applyStrandedVerified(
            tracker, stranded, tracker.contract, c.resolved?.operator, seat, emit, dryRun,
          );
          if (r.kind === 'failed') {
            emit.warn(`could not flag ${cand.ticket.issue_id}: ${r.why}`, { step: 'merge' });
          }
        } catch (e) {
          emit.warn(`could not flag ${cand.ticket.issue_id}: ${(e as Error).message}`, { step: 'merge' });
        }
      }
    }

    // Also non-fatal, and last of all: a ticket that reached a terminal
    // status (here or on an earlier cycle) is done with its worktree. A
    // tracker blip here must not turn a good release into a failed one, the
    // same reasoning as stamping above (ISSUE-346).
    try {
      const terminal = await tracker.terminalTickets();
      const scoped = ticketsByRepo(c, terminal).byRepo.get(target.name) ?? [];
      const actions = planWorktreeSweep(target, scoped, tracker.contract, repo.worktrees.prefix);
      if (actions.length) {
        emit.enter('worktree');
        const r = await applyWorktreeSweep(target.dir, actions, dryRun, emit);
        emit.emit(`swept ${r.removed} worktree(s), kept ${r.keptBranches} branch(es)`, { step: 'worktree' });
      }
    } catch (e) {
      emit.warn(`worktree sweep failed: ${(e as Error).message}`, { step: 'worktree' });
    }

  } finally {
    if (relLock && relLock.ok) relLock.release();
  }
}

// Taken before any work and released on the way out, however that happens.
// Registered unconditionally (when not a dry run) so that `run`'s
// role/capacity lock — acquired further down, once the role is known — is
// covered by the same cleanup as a plain EXCLUSIVE command's.
let lock: { release: () => void } | undefined;
const dropLock = () => { lock?.release(); lock = undefined; };
if (!dryRun) {
  process.on('exit', dropLock);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { dropLock(); process.exit(0); });
  }
}
if (EXCLUSIVE[command] && !dryRun) {
  const got = state.acquire(EXCLUSIVE[command]!);
  if (!got.ok) {
    process.stderr.write(
      `crew: a previous ${command} (pid ${got.heldBy}) is still running — skipping this cycle\n`,
    );
    process.exit(0);
  }
  lock = got;
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
      process.stdout.write(renderFleet(fleet, state));
      if (command === 'poll') break;
      if (!fleet.winner) {
        emit.emit('nothing to run across the fleet');
        await releaseFleet();
        break;
      }

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
        environment: environmentFor(w.connection),
        apiKey: resolveApiKey(w.connection),
      });
      if (dryRun) { process.stdout.write(`${describePlan(fleetPlan)}\n`); break; }

      // Role-distinct, capacity-limited (ISSUE-381) — see State.acquireRun.
      // Taken here, once the winning role is known, not up front: the fleet
      // poll above is read-only and must run every cycle regardless.
      const fleetLock = state.acquireRun(w.role, cfg.ship.maxConcurrentAgents);
      if (!fleetLock.ok) {
        emit.emit(`${w.role} skipped this cycle — ${fleetLock.reason}`);
        await releaseFleet();
        break;
      }
      lock = fleetLock;
      emit.enter('agent', w.role);
      emit.emit(`starting agent run for ${w.connection.name}`);
      try {
        await spawnAgent(fleetPlan, emit);
      } finally {
        dropLock();
      }
      await releaseFleet();
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
      if (dryRun) {
        for (const s of decision.sweep) {
          emit.emit(`would ${s.action} -> ${s.to} (blockers: ${s.blockers})`, {
            ticket: s.ticket.issue_id, step: 'sweep',
          });
        }
      } else {
        const seat = conn.resolved?.seats.qa ?? conn.resolved?.seats.dev;
        const r = await applySweep(new Tracker(conn, cfg.ship), decision.sweep, seat ?? '', emit);
        emit.emit(
          `swept ${r.parked} parked, ${r.restored} restored${r.failed ? `, ${r.failed} failed` : ''}`,
          { step: 'sweep', data: r },
        );
      }
    }

    const role = (value('role') as RoleName | undefined) ?? decision.selection.selected;
    if (command === 'poll') break;
    if (!role) {
      emit.emit('no role to run this cycle');
      // The release still has to happen. A cycle with no agent work is
      // exactly when verified branches are most likely to be waiting — and
      // returning here is what left ISSUE-280 and ISSUE-292 unmerged.
      await releaseTargets();
      break;
    }

    requireArmed(`run the ${role} role`);

    // A role can be selected honestly and still do nothing: the poll sees
    // status and assignee, and cannot know a seat will judge a ticket
    // unbuildable. When that happens the runner-up is worth trying rather
    // than spending the whole cycle on a no-op.
    const maxRoles = Number(value('max-roles') ?? 2);
    const explicitRole = value('role') !== undefined;   // means "run exactly this seat"
    const ran: RoleName[] = [];
    let current: RoleName | undefined = role;
    const tracker2 = new Tracker(conn, cfg.ship);

    while (current) {
      // Role-distinct, capacity-limited (ISSUE-381) — see State.acquireRun.
      // A role already running elsewhere (another connection, another
      // ship-wide invocation) is skipped for the runner-up exactly as a
      // role that changed nothing is below; an explicit --role never falls
      // through, so it just stops.
      if (!dryRun) {
        const got = state.acquireRun(current, cfg.ship.maxConcurrentAgents);
        if (!got.ok) {
          emit.emit(`${current} skipped this cycle — ${got.reason}`);
          if (explicitRole) { current = undefined; break; }
          const remaining = nextRoles(decision, [...ran, current]);
          current = remaining[0];
          continue;
        }
        lock = got;
      }

      const plan = planAgentRun({
        role: current, conn, ship: cfg.ship, crewHome: CREW_HOME,
        stateDir: cfg.ship.stateDir, roster: rosterFor(decision, conn, current),
        environment: environmentFor(conn),
        apiKey: resolveApiKey(conn),
      });
      if (dryRun) {
        process.stdout.write(`${describePlan(plan)}\n`);
        break;
      }
      const before = snapshot(await tracker2.openTickets());
      emit.enter('agent', current);
      emit.emit('starting agent run');
      try {
        await spawnAgent(plan, emit);
      } finally {
        dropLock();
      }
      ran.push(current);

      if (ran.length >= maxRoles || explicitRole) break;   // an explicit --role means that role only
      const after = snapshot(await tracker2.openTickets());
      if (changed(before, after)) { emit.emit(`${current} changed something — done this cycle`); break; }

      const remaining = nextRoles(decision, ran);
      current = remaining[0];
      if (current) emit.emit(`${ran.at(-1)} changed nothing — falling through to ${current}`);
      else emit.emit(`${ran.at(-1)} changed nothing, and no other role is pending`);
    }

    // The release phase closes the cycle, as it did in the bash. Without it
    // verified work sits unmerged indefinitely: nothing else ever merges a
    // branch, and a ticket verified this cycle should ship this cycle.
    //
    // Skipped only for `--role`, which means "run exactly this seat".
    if (!value('role')) await releaseTargets();
    break;
  }

  case 'merge':
  case 'deploy':
  case 'release': {
    // Named or single connection only: `crew release` is a deliberate act on
    // one repo, not a fleet-wide sweep.
    await releaseTargets({
      mergeOnly: command === 'merge', force: command === 'deploy' || flag('force'),
    });
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

  case 'connect': {
    const wsId = value('workspace-id');
    const apiKey = value('key') ?? process.env.CREW_CONNECT_KEY;
    if (!wsId || !apiKey) {
      process.stderr.write(
        'crew connect: need --workspace-id and --key (or CREW_CONNECT_KEY).\n' +
        '  API keys are workspace-scoped — there is no platform key — so create one\n' +
        '  in that workspace first (Admin > API keys).\n',
      );
      process.exit(2);
    }
    const found = await discover({
      baseUrl: value('base-url') ?? cfg.connections[0]?.baseUrl ?? 'https://app.tablation.com',
      apiKey, workspaceId: wsId,
      project: value('project'), area: value('area'),
      userAgent: cfg.ship.userAgent,
    });
    process.stdout.write(renderConnection(
      found,
      value('name') ?? (found.projectName ?? 'new-connection').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      value('dir') ?? 'REPLACE — the local checkout this connection works',
      { area: value('area') },
    ));
    if (found.problems.length) {
      process.stderr.write('\n  Unresolved — fix these before arming it:\n');
      for (const p of found.problems) process.stderr.write(`    - ${p}\n`);
    }
    process.stderr.write(
      '\n  Paste the block above under `connections:` in crew.yaml, fill the REPLACE\n' +
      '  fields, then: crew doctor <name>\n',
    );
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
    const where = worktreeLocations(conn);
    const rows = listeners()
      .map((l) => ({ ...l, t: ticketForPort(l.port) }))
      .filter((r) => r.t)
      .sort((a, b) => a.port - b.port);
    if (!rows.length) { process.stdout.write('nothing of ours is listening\n'); break; }
    for (const r of rows) {
      const live = worktreeExistsIn(where, r.t!.n);
      process.stdout.write(
        `${String(r.port).padEnd(6)} ${r.t!.role.padEnd(9)} ISSUE-${String(r.t!.n).padEnd(5)} ` +
          `pid ${String(r.pid).padEnd(7)} ${live ? 'worktree present' : 'ORPHAN — worktree gone'}\n`,
      );
    }
    break;
  }

  case 'reap': {
    emit.enter('worktree');
    let anything = false;

    // Every repository, not just the connection's first: a worktree alive in
    // the second one used to read as an orphan, and reap kills orphans.
    const orphans = findOrphansIn(worktreeLocations(conn));
    for (const o of orphans) {
      anything = true;
      emit.emit(
        `${dryRun ? 'would kill' : 'killing'} orphaned ${o.role} on :${o.port} (pid ${o.pid})` +
          ` — no worktree for ISSUE-${o.n}`,
      );
    }
    if (!dryRun && orphans.length) await killGently(orphans.map((o) => o.pid));

    // Worktrees whose ticket has since reached a terminal status — the
    // by-hand case for the same sweep the release phase runs on its own
    // (ISSUE-346). Each repository names its worktrees itself (ISSUE-350), so
    // the sweep is planned with that repo's prefix, not the ship default.
    const tracker = new Tracker(conn, cfg.ship);
    const terminal = await tracker.terminalTickets();
    const { byRepo } = ticketsByRepo(conn, terminal);
    for (const r of resolvedRepos(conn)) {
      const actions = planWorktreeSweep(
        r, byRepo.get(r.name) ?? [], tracker.contract, r.config.worktrees.prefix,
      );
      if (!actions.length) continue;
      anything = true;
      const res = await applyWorktreeSweep(r.dir, actions, dryRun, emit);
      emit.emit(
        `swept ${res.removed} worktree(s) for ${r.name}, kept ${res.keptBranches} branch(es)`,
        { step: 'worktree' },
      );
    }

    if (!anything) emit.emit('nothing to clean up');
    break;
  }

  case 'drop': {
    emit.enter('worktree');
    const n = positional[2] ?? positional[1];
    if (!n || !/^\d+$/.test(n)) { process.stderr.write('drop: need a ticket number\n'); process.exit(2); }
    const num = Number(n);
    // Which repository's worktree? Each names them after itself (ISSUE-350),
    // so the number alone does not say — look for it in all of them. Removing
    // one is destructive, so an ambiguous answer stops rather than picks.
    const candidates = resolvedRepos(conn)
      .map((r) => ({
        repo: r,
        path: `${resolvePath(r.dir, '..')}/${r.config.worktrees.prefix}${n}`,
      }))
      .filter((c) => existsSync(`${c.path}/.git`));
    if (candidates.length === 0) {
      process.stderr.write(
        `drop: no worktree for ISSUE-${n} in any of this connection's repositories ` +
          `(looked in: ${resolvedRepos(conn).map((r) => `${r.config.worktrees.prefix}${n}`).join(', ')})\n`,
      );
      process.exit(2);
    }
    if (candidates.length > 1) {
      process.stderr.write(
        `drop: ISSUE-${n} has a worktree in more than one repository ` +
          `(${candidates.map((c) => c.repo.name).join(', ')}) — remove them one at a time by path\n`,
      );
      process.exit(2);
    }
    const { repo: target, path: wt } = candidates[0]!;
    // The repo's own branch convention, not `issue-<n>`: deleting by a name
    // this repository never uses silently deletes nothing.
    const branch = branchForIssue(target.dir, `ISSUE-${n}`, {
      name: target.config.branch.name, push: target.config.branch.push,
    }, (t) => renderBranchName(t, { key: `ISSUE-${n}` }));
    const pids = pidsInWorktree(wt, num);
    if (pids.length) {
      emit.emit(`${dryRun ? 'would kill' : 'killing'} processes still inside ${wt}: ${pids.join(' ')}`);
      if (!dryRun) await killGently(pids);
    }
    if (dryRun) {
      emit.emit(`would remove worktree ${wt} and branch ${branch ?? '(none found)'}`);
      break;
    }
    gitOk(target.dir, ['worktree', 'remove', '--force', wt]);
    if (branch) gitOk(target.dir, ['branch', '-D', branch]);
    else emit.warn(`no branch found for ISSUE-${n} in ${target.name} — worktree removed, nothing to delete`);
    emit.emit(`dropped ISSUE-${n} from ${target.name}`);
    break;
  }

  case 'sync': {
    // A reviewer's commits land on the remote; until a worktree takes them the
    // dev seat builds on stale code and QA verifies something nobody reviewed.
    emit.enter('worktree');
    let tracked = 0;
    let acted = 0;
    // Every repository of the connection: a reviewer's commits on the second
    // repo's branch are no less stale for being next door (ISSUE-350).
    for (const r of reposOf(conn)) {
      fetchRemote(r.dir);
      for (const w of worktrees(r.dir)) {
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

  case 'install': {
    const host = hostPlatform();
    if (host === 'windows') {
      process.stderr.write('crew install: no scheduler support yet for Windows (Task Scheduler is planned, not built)\n');
      process.exit(2);
    }
    const plan = planInstall(cfg.ship, CREW_HOME, host, detectSystemd());
    process.stdout.write(`installing via ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}\n`);
    await applyInstall(plan, CREW_HOME, dryRun, {
      emit: (m) => process.stdout.write(`${m}\n`),
      warn: (m) => process.stderr.write(`crew install: ${m}\n`),
    });
    break;
  }

  case 'uninstall': {
    const host = hostPlatform();
    if (host === 'windows') {
      process.stdout.write('nothing installed on Windows\n');
      break;
    }
    const plan = planUninstall(cfg.ship, CREW_HOME, host, detectSystemd());
    process.stdout.write(`uninstalling ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}\n`);
    await applyUninstall(plan, CREW_HOME, dryRun, {
      emit: (m) => process.stdout.write(`${m}\n`),
      warn: (m) => process.stderr.write(`crew uninstall: ${m}\n`),
    });
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
    // Starvation instrumentation (ISSUE-382): the poll writes this every
    // cycle, so a quiet board's most urgent ticket going unpicked shows up
    // here without anyone reading the log by hand.
    const fairness = state.fairness(conn.name);
    const waiting = fairness.waiting();
    if (waiting) {
      process.stdout.write(
        `waiting:    ${waiting.ticket} for ${since(waiting.since)}` +
          ` (passed over ${fairness.streak()} cycle${fairness.streak() === 1 ? '' : 's'} running)\n`,
      );
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

    // A workspace's contract can be internally inconsistent — a status named
    // as `approved` that is not in `open`, a `handoff` listed as resolved.
    // Checked here rather than left to fail as odd behaviour later.
    const contractProblems = validateContract(tracker.contract);
    process.stdout.write(
      contractProblems.length
        ? `contract:          ${contractProblems.length} problem(s)\n` +
          contractProblems.map((p) => `                   - ${p}\n`).join('')
        : 'contract:          consistent\n',
    );

    // Per repository, because a connection serves several and each carries its
    // own contract. `shadowed` was computed and never read by anything until
    // ISSUE-350 — a setting the ship declares and the repo overrides is
    // otherwise invisible, and reads as though it were in use.
    for (const r of resolvedRepos(conn)) {
      const { config } = r;
      process.stdout.write(
        `${`repo ${r.name}:`.padEnd(19)}${r.dir}\n` +
          `                   worktrees at ../${config.worktrees.prefix}<number> ` +
          `(${config.provenance['worktrees.prefix'] ?? 'default'}), ` +
          `branch ${config.branch.name}\n`,
      );
      if (config.shadowed.length) {
        process.stdout.write(
          `                   this ship declares ${config.shadowed.join(', ')}, ` +
            `and ${r.name} overrides it — the repo wins\n`,
        );
      }
      for (const p2 of validateEffective(config)) {
        process.stdout.write(`                   - ${p2}\n`);
      }
    }

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

lock?.release();
