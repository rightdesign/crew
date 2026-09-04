#!/usr/bin/env node
/**
 * `crew` — the CLI.
 *
 * Every command that could change something takes `--dry-run`, and the
 * interlock (`enabled: false` per route) refuses anything that writes
 * until an operator arms it deliberately.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, findRoute, routeForDir, resolveApiKey, reposOf, repoIdForName, shipWorktreePrefixFor, ticketsByRepo,
  DEFAULT_BASE_URL, resolvedPathFor, dirForRepo, repoTargetFor, mergeRouteRelease,
  type Unplaceable, type UnplaceableReason,
  ConfigError, ROLE_NAMES, ROLE_LABEL, type RoleName, type RepoTarget, type Route,
} from './config.ts';
import { State } from './state.ts';
import { Emitter, eventFileFor } from './events.ts';
import { decideCycle, rosterFor, writeDigest } from './poll.ts';
import { rankedCandidates } from './select.ts';
import { resolveTopCandidate } from './claim.ts';
import { applySweep } from './blocked.ts';
import { planConflictBounce, applyConflictBounce } from './conflict.ts';
import { planStrandedVerified, applyStrandedVerified } from './stranded-verified.ts';
import { planAgentRun, describePlan, spawnAgent } from './agent.ts';
import { hostPlatform, satisfies, explain } from './platform.ts';
import { planInstall, planUninstall, applyInstall, applyUninstall, detectSystemd } from './install.ts';
import { loadRepoConfig, resolveRepoConfig, validateEffective, renderBranchName } from './repo-config.ts';
import { runRelease, summarizeOutcome, type RepoReleaseSummary } from './release-run.ts';
import { describeUnplaceable } from './release.ts';
import { planStamp, applyStamp, applyExternalClosures } from './stamp.ts';
import { renderEnvironment } from './environment.ts';
import { notify, describeRelease } from './notify.ts';
import { applyFailureAlert } from './failure-alert.ts';
import { Tracker, type Ticket } from './tracker.ts';
import { StaleWriteError } from '@tablation/client';
import type { BoardLockResult } from './board-lock.ts';
import { validateContract, DEFAULT_CONTRACT } from './contract.ts';
import { startWatch } from './watch.ts';
import { findOrphansIn, listeners, ticketForPort, killGently, pidsInWorktree, worktreeExistsIn } from './ports.ts';
import { gatherInbox, renderInbox } from './inbox.ts';
import { decideFleet, renderFleet, snapshot, changed, nextRoles, since } from './fleet.ts';
import { discover, listWorkspaces, renderConnection, ConnectHttpError } from './connect.ts';
import { syncPersonas, describeSyncOutcome, describeCrewLink, AgentsSyncError, fetchDivergedPrompt, currentPersonaPrompt, PERSONA_NAME } from './agents.ts';
import { syncSkills, describeSkillSyncOutcome, SkillSyncError } from './skills.ts';
import { listLogEntries, showLogEntry, LogbookError } from './logbook.ts';
import {
  worktrees, git, gitOk, syncState, fastForward, fetchRemote, branchForIssue, ensureRepoCheckout, GitError,
} from './git.ts';
import { planWorktreeSweep, applyWorktreeSweep } from './worktree-sweep.ts';
import { planStreamSweep, applyStreamSweep } from './stream-sweep.ts';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname as dirOf, resolve as resolvePath } from 'node:path';
import { isCompiledBinary } from './runtime-info.ts';

const CREW_HOME = isCompiledBinary(import.meta.url)
  ? dirname(process.execPath)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How long an unreleased board lock claim (ISSUE-394) stays valid before
 * another ship may take it over as stale. Generous relative to a normal
 * release (build, test, merge, deploy — minutes, not longer) so a slow but
 * live release is never preempted by another ship; only a claim left behind
 * by a crashed or network-lost run should ever go stale.
 */
const RELEASE_LOCK_TTL_MS = 20 * 60 * 1000;

/**
 * The launchd fire interval (`launchd/com.tablation.crew.plist`'s
 * `StartInterval`), in seconds — the natural unit for ship-heartbeat
 * staleness (ISSUE-380). Judged in multiples of this, not absolute seconds,
 * so a slower cycle does not read as a dead ship.
 */
const CYCLE_SECONDS = 120;

/** A `last_seen` older than this many cycles reads as "not seen recently". */
const STALE_CYCLES = 3;

/**
 * One `crew status` line for a `Ships` row (ISSUE-380) — distinguishes
 * online-and-idle, online-and-engaged (naming what and since when), and
 * not-seen-recently, per the ticket's own three-way `crew status` split.
 */
function renderShipLine(
  s: import('./tracker.ts').ShipRow,
  issueLabelById: Map<string, string | null | undefined>,
): string {
  const name = s.name ?? '(unnamed)';
  if (!s.last_seen) return `${name.padEnd(20)} never seen`;
  const staleAfterMs = STALE_CYCLES * CYCLE_SECONDS * 1000;
  const ageMs = Date.now() - Date.parse(s.last_seen);
  if (ageMs > staleAfterMs) {
    return `${name.padEnd(20)} not seen recently — last seen ${since(s.last_seen)} ago`;
  }
  if (s.engaged) {
    const ticketLabel = s.engaged_ticket_id ? issueLabelById.get(s.engaged_ticket_id) : undefined;
    const what = [s.engaged_connection, ticketLabel].filter(Boolean).join(' / ');
    const sinceText = s.engaged_since ? ` since ${since(s.engaged_since)} ago` : '';
    return `${name.padEnd(20)} online, engaged${what ? ` — ${what}` : ''}${sinceText}`;
  }
  return `${name.padEnd(20)} online, idle (seen ${since(s.last_seen)} ago)`;
}

/**
 * Asks, on a real terminal, which Crew row is the human running `crew
 * connect` — the fallback for when `discover()` couldn't match this key's
 * own identity email to exactly one hold. Returns `undefined` on a blank
 * answer or an out-of-range number, leaving the caller to fall back to the
 * "edit the state file by hand" instructions.
 */
async function pickOperator(holds: Array<{ id: string; name: string }>): Promise<string | undefined> {
  process.stderr.write('\nWhich of these Crew rows is you?\n');
  holds.forEach((h, i) => process.stderr.write(`  ${i + 1}. ${h.name || h.id}\n`));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('Enter a number (blank to skip): ')).trim();
    const n = Number(answer);
    if (!answer || !Number.isInteger(n) || n < 1 || n > holds.length) return undefined;
    return holds[n - 1]!.id;
  } finally {
    rl.close();
  }
}

/**
 * Asks, on a real terminal, which of this workspace's own status values
 * (that DEFAULT_CONTRACT doesn't already name) mean the ticket is resolved —
 * ISSUE-467. Only "resolved" is asked about, deliberately: a blocker only
 * ever needs to know which statuses stop it counting (docs/CONTRACT.md), and
 * anything answered "no" is left unclassified exactly as it already was
 * before this value existed — never added to `open`, since guessing that a
 * custom status means "live, pollable work" (a pre-triage `draft`, say) is a
 * worse mistake than asking again next connect. A blank/no answer is simply
 * not recorded as "resolved"; the caller still remembers it was asked, via
 * `reviewedStatuses`, so it isn't re-asked forever.
 */
async function pickResolvedStatuses(unrecognized: Array<{ value: string; label?: string }>): Promise<string[]> {
  process.stderr.write(
    '\nThis workspace has status values the default contract doesn\'t know the meaning of.\n' +
      'For each: does it mean the ticket is DONE — resolved/terminal (shipped, closed, won\'t-fix) — ' +
      'so a ticket blocked by it should stop being blocked?\n',
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const resolved: string[] = [];
  try {
    for (const s of unrecognized) {
      const label = s.label && s.label !== s.value ? ` ("${s.label}")` : '';
      const answer = (await rl.question(`  "${s.value}"${label} — resolved/terminal? [y/N] `)).trim();
      if (/^y/i.test(answer)) resolved.push(s.value);
    }
  } finally {
    rl.close();
  }
  return resolved;
}

function usage(): never {
  process.stderr.write(`crew — a standing team of headless agents

  crew poll [route]              decide a cycle and report it; writes nothing
  crew run [route] [--role R]    run the winning role's session
  crew release [route]           merge what QA verified, version it, ship it
  crew merge [route]             merge verified branches and stop
  crew deploy [route]            release now, even with nothing new to merge
  crew watch [route]             live view of what the crew is doing
  crew status [route] [--json]   paused/running state; --json for a machine reader
  crew doctor [route]            read-only preflight
  crew ports [route]             which checkout owns which ports, and what is up
  crew reap [route]              kill orphaned servers, drop worktrees for closed tickets
  crew drop [route] NNN          remove a merged ticket's worktree and branch
  crew unassign [route] NNN      hand back a session's ticket — clears assignee, next cycle picks it up
  crew sync [route]              fast-forward the checkout and its worktrees from the remote
  crew pause|resume [route] [R]  pause everything, or one role
  crew log [route]               tail the log
  crew inbox [--member NAME]    your tickets across every workspace (or a colleague's)
  crew connect                  resolve a workspace's ids into a crew.yaml block
  crew agents sync [route]      push crew's personas AND skill files into the workspace Agents/Agent Skills tables
  crew agents prompt R [route] print one persona's current prompt (e.g. R=pair, for a SessionStart hook)
  crew skills sync [route]      push only crew's skill files (e.g. grill-me) into the workspace Agent Skills table
  crew logbook list [route]     recent Agent Log entries, filterable by --role/--ticket
  crew logbook show [route] ID [--prompt]   one entry; --prompt reconstructs and verifies its prompt
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
  --by-route (inbox) group by workspace instead of status
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
// A route that failed to parse is dropped, not fatal (config.ts) — surface
// it loudly so a broken route doesn't sit silently unnoticed, but every
// OTHER route still runs.
for (const w of cfg.warnings) process.stderr.write(`crew: warning: ${w}\n`);
// `inbox` spans every route, so it must not demand one be named.
// `inbox` spans every route; `poll`/`run` do too when none is named.
// `connect` is neither — its positional argument is a workspace[/project]
// slug on the TRACKER, not the name of a route already in crew.yaml, so
// it must not be forced through the same by-name lookup every other command
// uses.
const FLEET_CAPABLE = new Set(['poll', 'run']);
// `--fleet` is release/merge/deploy's own opt-in to the same fleet-wide path
// `poll`/`run` take automatically — release stays "a deliberate act on one
// repo" by default (README), so an operator naming no route on a multi-route
// ship still gets "name one" unless they say `--fleet` explicitly.
const releaseFleetWide = ['merge', 'deploy', 'release'].includes(command) && flag('fleet');
const named = positional[1];
const fleetWide = command === 'inbox' || command === 'connect' || command === 'agents' || command === 'skills' || command === 'logbook' || releaseFleetWide ||
  (FLEET_CAPABLE.has(command) && !named && cfg.routes.length > 1);
let route: ReturnType<typeof findRoute>;
try {
  route = fleetWide ? (cfg.routes[0] as ReturnType<typeof findRoute>) : findRoute(cfg, named);
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
  route: route.route,
  eventFile: dryRun ? undefined : eventFileFor(cfg.ship.stateDir),
  logFile: dryRun ? undefined : cfg.ship.logFile,
  console: (l) => process.stderr.write(`${l}\n`),
});

/**
 * The interlock. A dry run is exempt because it writes nothing — being able
 * to inspect a disarmed installation is the point of having one.
 */
function requireArmed(what: string): void {
  if (dryRun || route.enabled) return;
  process.stderr.write(
    `crew: route "${route.route}" is not enabled in ${cfg.configFile} — refusing to ${what}.\n` +
      `      Add --dry-run to see what it would do.\n`,
  );
  process.exit(0);
}


/**
 * Release every route, whoever won the agent slot.
 *
 * The release phase is per route and has nothing to do with which board
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
/**
 * One line per repo, printed once every repo a fan-out touched has run.
 *
 * Only when there is more than one: a single-repo release already has its
 * own outcome in the log immediately above with nothing to disambiguate it
 * from. The ambiguity this exists to remove — a mixed pass/fail run reading
 * as "tests didn't block the deploy" — only arises once a route or `--fleet`
 * run spans more than one repo (ISSUE-583).
 */
function printReleaseSummary(summaries: RepoReleaseSummary[]): void {
  if (summaries.length <= 1) return;
  emit.enter('release');
  emit.emit(`release summary — ${summaries.length} repo(s):`);
  for (const s of summaries) {
    const testLabel = s.tests === 'pass' ? 'tests passed' : s.tests === 'fail' ? 'tests FAILED' : 'tests skipped';
    emit.emit(`  ${s.scope}: ${testLabel}, ${s.outcome} — ${s.detail}`, {
      level: s.outcome === 'error' || s.tests === 'fail' ? 'warn' : 'info',
    });
  }
}

async function releaseFleet(opts: { mergeOnly?: boolean; force?: boolean } = {}): Promise<void> {
  const summaries: RepoReleaseSummary[] = [];
  for (const c of cfg.routes) {
    if (!dryRun && !c.enabled) continue;
    // No route-wide platform gate: releasePhase checks each repo's own
    // requirement, and a route can span repos with different needs.
    for (const r of reposOf(c)) summaries.push(await releasePhase(c, r, opts));
  }
  printReleaseSummary(summaries);
}

/**
 * Release every repository of the route in play.
 *
 * `crew run` on a single route still has to cover all of its
 * repositories: a verified branch in the second one is no less ready than a
 * verified branch in the first.
 */
async function releaseTargets(opts: { mergeOnly?: boolean; force?: boolean } = {}): Promise<void> {
  const only = value('repo');
  const targets = reposOf(route);
  const chosen = only ? targets.filter((t) => t.name === only) : targets;
  if (only && chosen.length === 0) {
    process.stderr.write(
      `crew: no repo named "${only}" on route "${route.route}" ` +
        `(have: ${targets.map((t) => t.name).join(', ')})\n`,
    );
    process.exit(2);
  }
  const summaries: RepoReleaseSummary[] = [];
  for (const t of chosen) summaries.push(await releasePhase(route, t, opts));
  printReleaseSummary(summaries);

  // Ship-wide, not per-repo — one sweep per release cycle, alongside the
  // worktree sweep each repo just ran above (ISSUE-401).
  try {
    const paths = planStreamSweep(cfg.ship.stateDir, cfg.ship.streamRetentionDays);
    if (paths.length) {
      emit.enter('worktree');
      const removed = applyStreamSweep(paths, dryRun, emit);
      emit.emit(`swept ${removed} stream artifact(s)`, { step: 'worktree' });
    }
  } catch (e) {
    emit.warn(`stream sweep failed: ${(e as Error).message}`, { step: 'worktree' });
  }
}

/**
 * The Environment section of a session's prompt, for one route.
 *
 * Assembled here rather than inside planAgentRun because it needs the repo's
 * own `.crew.yaml` and the route's contract, and reading those is the
 * cycle's job, not the prompt builder's.
 */
// Repo row and Project (area) row lookups, cached by id for the life of this
// process: several repos can share one area, and resolvedRepos() is called
// more than once per cycle for the same route — without this every one
// of those would refetch the same two rows over the network.
const repoRowCache = new Map<string, Promise<{ project_id?: string | null } | undefined>>();
const projectRowCache = new Map<string, Promise<{ issue_prefix?: string | null } | undefined>>();

/**
 * The area's own issue-key prefix for this repo, lowercased and dashed —
 * `"CREW"` becomes `"crew-"` — or `undefined` when there is nothing to
 * derive one from (no repo id, no Repos/Projects table, no `project_id` on
 * the repo's row, or the Projects row's `issue_prefix` is unset or blank).
 * `undefined` is not a value to report as an error: it means "fall back to
 * the directory-derived default", which every repo already had before this
 * existed, so a workspace that has not adopted this field sees no change at
 * all.
 */
async function areaWorktreePrefix(c: typeof route, repoId: string | undefined): Promise<string | undefined> {
  if (!repoId) return undefined;
  let repoPromise = repoRowCache.get(repoId);
  if (!repoPromise) {
    repoPromise = new Tracker(c, cfg.ship).repoRow(repoId);
    repoRowCache.set(repoId, repoPromise);
  }
  const projectId = (await repoPromise)?.project_id;
  if (!projectId) return undefined;
  let projectPromise = projectRowCache.get(projectId);
  if (!projectPromise) {
    projectPromise = new Tracker(c, cfg.ship).projectRow(projectId);
    projectRowCache.set(projectId, projectPromise);
  }
  const raw = (await projectPromise)?.issue_prefix;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed ? `${trimmed.toLowerCase()}-` : undefined;
}

/**
 * Every repository a route serves, with its own contract resolved.
 *
 * One place, because three commands need it and each got it wrong its own way
 * before ISSUE-350: they read the route's `dir` and `worktreePrefix` and
 * so saw only the first repo of an area that has several.
 */
async function resolvedRepos(c: typeof route) {
  return Promise.all(reposOf(c).map(async (t) => {
    const id = repoIdForName(c, t.name);
    // This repo's own entry under `repos:` (if it named hooks/labels/release
    // of its own) sits between the route-wide fallback and the repo's own
    // `.crew.yaml` — only the fields it actually set shadow the route-wide
    // ones, so an override naming just `hooks.test` still inherits the
    // route's `build`/`deploy`/`notify`.
    const o = c.repoOverrides[t.name];
    return {
      name: t.name,
      dir: t.dir,
      id,
      config: resolveRepoConfig(loadRepoConfig(t.dir), {
        hooks: { ...c.hooks, ...o?.hooks }, labels: { ...c.labels, ...o?.labels },
        release: mergeRouteRelease(c.release, o?.release),
        branch: { ...c.branch, ...o?.branch },
        // The route's own prefix is a SHIP-level default for a repo
        // that declares none (ISSUE-398, single-repo only). Next, the
        // repo's own area may name an issue-key prefix of its own (its
        // tracker `Projects` row's `issue_prefix`) — shared across every
        // repo in that area, since they use the same ticket-key format
        // regardless of which one a ticket happens to build in. A repo
        // that declares its own `worktrees.prefix` shadows either, and
        // `doctor` reports that the way it reports every other shadowed
        // setting.
        worktrees: { prefix: shipWorktreePrefixFor(c) ?? await areaWorktreePrefix(c, id) },
      }, t.dir),
    };
  }));
}

/** Where this route's worktrees live, per repository. */
const worktreeLocations = async (c: typeof route) =>
  (await resolvedRepos(c)).map((r) => ({
    parent: resolvePath(r.dir, '..'),
    prefix: r.config.worktrees.prefix,
  }));

/**
 * Whether this ship can build ANYTHING on this route at all.
 *
 * What a host must be belongs to each repo (its own `.crew.yaml`), not the
 * route — so a route spanning repos with different needs is
 * refused only when NONE of them fit. This runs before a ticket is picked
 * and so cannot know which repo it targets, the same coarseness the old
 * route-wide `platform` setting had; the release phase is the one
 * place that already checks the actual repo (`releasePhase`), because it
 * only ever runs one repo at a time.
 */
async function anyRepoServable(c: typeof route): Promise<boolean> {
  return (await resolvedRepos(c)).some((r) => satisfies(cfg.ship.platform, r.config.platform));
}

/** Why `anyRepoServable` refused a route, naming each repo's own requirement. */
async function explainUnservable(c: typeof route): Promise<string> {
  return (await resolvedRepos(c))
    .map((r) => `${r.name} requires ${r.config.platform}`)
    .join(', ');
}

async function environmentFor(c: typeof route, ticket?: string | null): Promise<string> {
  const contract = new Tracker(c, cfg.ship).contract;
  // Every repository the route serves, not just the first. Which one
  // THIS ticket's work happens in is unknowable here — the brief describes
  // them all (ISSUE-350). `ticket`, when the caller already resolved one
  // before building the environment, is only used for filing guidance
  // (ISSUE-411) — it names the ticket a spotted-bug report should reference,
  // never which repo section applies.
  return renderEnvironment({
    route: c, userAgent: cfg.ship.userAgent, repos: await resolvedRepos(c), contract, sourceTicket: ticket,
  });
}

/**
 * Routes whose unplaceable tickets have already been reported this run.
 *
 * `releasePhase` runs once per REPOSITORY, and every one of them computes the
 * same route-wide unplaceable set — so without this the same message is
 * emitted once per repo, three times over for an area with three checkouts.
 * A process is one cycle, so a Set that lives as long as it is exactly the
 * right lifetime.
 */
const unplaceableReported = new Set<string>();

/** Emit what `describeUnplaceable` decided, once per route per run. */
function reportUnplaceable(
  c: typeof route,
  unplaceable: Array<Unplaceable<Ticket>>,
  verified: string,
  emit: Emitter,
): void {
  if (unplaceableReported.has(c.route)) return;
  unplaceableReported.add(c.route);
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
  c: typeof route, target: RepoTarget, opts: { mergeOnly?: boolean; force?: boolean } = {},
): Promise<RepoReleaseSummary> {
  const scope = `${c.route}/${target.name}`;
  // Per REPOSITORY, not per route. A board's area spans several repos and
  // each releases on its own: they have separate versions, separate tags and
  // separate deploy targets, and a long release of one must not hold up
  // another. Scoping this to the route meant only `route.dir` was ever
  // released — every other repo on the board was silently never shipped.
  const relLock = dryRun ? undefined : state.acquire(`release-${scope}`);
  if (relLock && !relLock.ok) {
    emit.emit(`a previous release (pid ${relLock.heldBy}) is still running — skipping`, { step: 'release' });
    return { scope, tests: 'skipped', outcome: 'skipped', detail: 'a previous release is still running' };
  }
  // Board-visible, cross-ship claim (ISSUE-394) — `relLock` above only ever
  // excluded two processes on THIS machine. Taken after the local lock so a
  // dry run and a machine with no other releasing process never pay for a
  // network round trip; released in the `finally` below alongside it.
  let boardLock: BoardLockResult | undefined;
  try {

    const repoFile = loadRepoConfig(target.dir);
    const o = c.repoOverrides[target.name];
    const repo = resolveRepoConfig(repoFile, {
      hooks: { ...c.hooks, ...o?.hooks }, labels: { ...c.labels, ...o?.labels },
      release: mergeRouteRelease(c.release, o?.release),
      branch: { ...c.branch, ...o?.branch },
      worktrees: { prefix: shipWorktreePrefixFor(c) },
    }, target.dir);
    const problems = validateEffective(repo);
    for (const p of problems) emit.warn(`${scope}: ${p}`);

    // What a host must be to build THIS repo is that repo's own fact
    // (`.crew.yaml`), not the route's — a route can span repos with
    // different needs. Skip only this one; the rest of the route's
    // repos may still be releasable here.
    if (!satisfies(cfg.ship.platform, repo.platform)) {
      const detail = explain(cfg.ship.platform, repo.platform);
      emit.emit(`${scope}: skipping — ${detail}`, { step: 'release' });
      return { scope, tests: 'skipped', outcome: 'skipped', detail };
    }

    if (!dryRun && !c.enabled) return { scope, tests: 'skipped', outcome: 'skipped', detail: 'route not enabled' };
    const tracker = new Tracker(c, cfg.ship);

    if (!dryRun) {
      const holderLabel = `${cfg.ship.name}:${process.pid}`;
      const got = await tracker.acquireBoardLock(scope, holderLabel, RELEASE_LOCK_TTL_MS);
      if (!got.ok) {
        const why = got.reason === 'held' ? `held by ${got.heldBy ?? 'another ship'}` : 'claimed by another ship mid-check';
        emit.emit(`release for ${scope} is ${why} on the board — skipping`, { step: 'release' });
        return { scope, tests: 'skipped', outcome: 'skipped', detail: `release ${why} on the board` };
      }
      boardLock = got;
    }

    const all = await tracker.openTickets();

    // Only this repository's tickets. Handing the whole board's tickets to a
    // release would look for their branches in the wrong checkout — and on a
    // near-miss (a branch of the same name in two repos) merge the wrong work.
    const { byRepo, unplaceable } = ticketsByRepo(c, all);
    const tickets = byRepo.get(target.name) ?? [];
    reportUnplaceable(c, unplaceable, tracker.contract.statuses.verified, emit);

    const outcome = await runRelease({
      cwd: target.dir, repo, contract: tracker.contract, tickets, emit, scope,
      state: state.release(scope),
      dryRun, skipTests: flag('skip-tests'), shell: cfg.ship.shell,
      mergeOnly: command === 'merge',
      // `deploy` is the "go now" button: it exists for a commit a previous
      // deploy failed on, where nothing new will merge but the work is
      // genuinely unreleased.
      force: command === 'deploy' || flag('force'),
    });
    const summary = summarizeOutcome(outcome, scope, !!repo.hooks.test && !flag('skip-tests'));

    // Stamping is deliberately last and deliberately non-fatal: the work is
    // already live, and a tracker blip must not turn a good release into a
    // failed one. Untouched tickets are still `verified` and still named in
    // the released range, so the next cycle picks them up.
    if (outcome.deployed || outcome.confirmed || outcome.alreadyLive || outcome.integrated) {
      emit.enter('reconcile');
      const plan = planStamp(
        target.dir, tickets, tracker.contract,
        outcome.decision.lastReleased, outcome.decision.head,
        new Map(outcome.merged.map((m) => [m.ticket.issue_id, m.sha])),
      );
      if (plan.length) await applyStamp(tracker, plan, outcome.version, tracker.contract, emit, dryRun);
    } else if (outcome.stopped) {
      emit.emit(`nothing stamped — ${outcome.stopped}`);
    }

    // `release.mode: external`: the crew ships nothing itself, but a ticket
    // whose branch has landed on the other side of the hand-off still gets
    // its `commit_sha`/`merged_at` written, same as the block above does for
    // tickets this release actually stamped `deployed` itself.
    if (outcome.externalClosures?.length) {
      await applyExternalClosures(tracker, outcome.externalClosures, emit, dryRun);
    }

    // Last, and non-fatal: whatever happened has happened, and telling someone
    // about it must not be able to change the outcome.
    const news = describeRelease(outcome, scope);
    if (news) {
      const notified = await notify(c, cfg.ship, news, emit, dryRun);
      // No `hooks.notify` configured on this route — the common case, since
      // the key has existed since the Node port and nobody has wired it
      // (notify.ts's own header). A failure must not go silent just because
      // nobody has hooked up a notifier: fall back to filing/updating a
      // tracker ticket directly, the same way synthesis's bash dev-loop.sh
      // has always done for a deploy failure.
      if (!notified && news.level === 'fail') {
        const memberId = c.resolved?.seats.dev ?? c.resolved?.seats.qa ?? '';
        await applyFailureAlert(tracker, news, scope, all, memberId, emit, dryRun).catch((e) => {
          emit.warn(`could not file/update a failure ticket: ${(e as Error).message}`, { step: 'release' });
        });
      }
    }

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

    return summary;
  } catch (e) {
    // Last resort: every step above already treats a tracker blip as
    // non-fatal on its own (stamping, notify, the conflict/unbuildable
    // loops, the worktree sweep), but this phase talks to the tracker in a
    // few other places too (openTickets, acquireBoardLock, comments) that
    // don't have their own try/catch. Whatever escapes here would otherwise
    // reach the top of the process as an uncaught exception — crashing a
    // release that may already be live — so it gets the same "warn, don't
    // fail" treatment as everything else in this function.
    emit.warn(`release phase failed: ${(e as Error).message}`, { step: 'release' });
    return { scope, tests: 'skipped', outcome: 'error', detail: (e as Error).message };
  } finally {
    if (boardLock && boardLock.ok) await boardLock.release();
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
    // A release runs a test suite, a build and a deploy on top of whatever
    // this cycle just did — minutes, not seconds, and NOTHING else in this
    // process can proceed until it returns (this is one straight-line pass,
    // not a scheduler of its own). `crew install` now installs release as
    // its OWN unit on its own timer for exactly that reason: a slow release
    // used to make every board wait behind it for the next poll. `run`
    // itself skips its inline release under `--no-release`, which is what
    // that companion unit's `crew run` passes — see `install.ts`.
    const skipInlineRelease = flag('no-release');
    // Many routes and none named: poll them all and pick the most
    // urgent across the fleet (ISSUE-338).
    if (fleetWide) {
      const fleet = await decideFleet({
        routes: cfg.routes, ship: cfg.ship, state, emit,
        enabledOnly: !dryRun,
      });

      // The single-route path below applies its sweep before doing
      // anything else; the fleet-wide path must too, and for EVERY
      // reachable route, not just the winner — otherwise a route that
      // never wins (lower weight, or consistently out-ranked) never
      // parks or restores a blocked ticket at all, silently, forever.
      for (const e of fleet.entries) {
        if (e.error || !e.decision || !e.decision.sweep.length) continue;
        if (dryRun) {
          for (const s of e.decision.sweep) {
            emit.emit(`would ${s.action} -> ${s.to} (blockers: ${s.blockers})`, {
              ticket: s.ticket.issue_id, step: 'sweep',
            });
          }
          continue;
        }
        const seat = e.route.resolved?.seats.qa ?? e.route.resolved?.seats.dev;
        try {
          const r = await applySweep(new Tracker(e.route, cfg.ship), e.decision.sweep, seat ?? '', emit);
          emit.emit(
            `swept ${r.parked} parked, ${r.restored} restored` +
              `${r.failed ? `, ${r.failed} failed` : ''}${r.contended ? `, ${r.contended} contended` : ''} (${e.route.route})`,
            { step: 'sweep', data: r },
          );
        } catch (err) {
          emit.warn(`could not sweep ${e.route.route}: ${(err as Error).message}`, { step: 'sweep' });
        }
      }

      process.stdout.write(renderFleet(fleet, state));
      if (command === 'poll') break;

      // Ship-level heartbeat (ISSUE-380), once per `run` cycle regardless of
      // outcome — including this exact "nothing to run" case, which is the
      // one a task-progress-only heartbeat could never distinguish from a
      // dead ship. "A ship has a Ships row per workspace... beats on each":
      // every eligible route gets its own write, not only the winner's,
      // since this ship polled all of them successfully this cycle. Best
      // effort — a workspace with no Ships table, or unreachable this cycle,
      // must not stop the run itself. Skipped entirely for --dry-run, which
      // "performs nothing" — see the matching guard on the single-route
      // path below.
      if (!dryRun) {
        await Promise.all(cfg.routes.filter((c) => c.enabled).map(async (c) => {
          try {
            await new Tracker(c, cfg.ship).beatShip(cfg.ship.name);
          } catch (e) {
            emit.warn(`could not beat ship for ${c.route}: ${(e as Error).message}`, { step: 'poll' });
          }
        }));
      }

      if (!fleet.winner) {
        emit.emit('nothing to run across the fleet');
        if (!skipInlineRelease) await releaseFleet();
        break;
      }

      const w = fleet.winner;
      if (!(await anyRepoServable(w.route))) {
        emit.error(
          `refusing ${w.route.route} — this ship is ${cfg.ship.platform}, but ` +
            `${await explainUnservable(w.route)}`,
        );
        break;
      }
      if (!dryRun && !w.route.enabled) {
        emit.emit(`route "${w.route.route}" is not enabled — not running`);
        break;
      }
      if (dryRun) {
        const fleetPlan = planAgentRun({
          role: w.role, route: w.route, ship: cfg.ship,
          stateDir: cfg.ship.stateDir, roster: rosterFor(w.decision, w.route, w.role),
          environment: await environmentFor(w.route, w.decision.actionable.top?.issue_id),
          apiKey: resolveApiKey(w.route),
          cycle: emit.cycle, ticket: w.decision.actionable.top?.issue_id,
          divergedPrompt: await fetchDivergedPrompt(w.route, w.role, { userAgent: cfg.ship.userAgent }),
        });
        process.stdout.write(`${describePlan(fleetPlan)}\n`);
        break;
      }

      // Role-distinct, capacity-limited (ISSUE-381) — see State.acquireRun.
      // Taken here, once the winning role is known, not up front: the fleet
      // poll above is read-only and must run every cycle regardless.
      const fleetLock = state.acquireRun(w.role, cfg.ship.maxConcurrentAgents);
      if (!fleetLock.ok) {
        emit.emit(`${w.role} skipped this cycle — ${fleetLock.reason}`);
        if (!skipInlineRelease) await releaseFleet();
        break;
      }
      lock = fleetLock;
      const fleetTracker = new Tracker(w.route, cfg.ship);

      // ISSUE-395: claim the fleet winner's top ticket before spawning it —
      // see the matching comment on the single-route path below for why.
      // A fleet-wide runner-up is out of scope here: a contended claim just
      // ends this cycle for the whole fleet, same as "nothing to run" did
      // before this ticket, and the next poll re-ranks everything fresh.
      let fleetTicketHint = w.decision.actionable.top?.issue_id;
      let fleetWorkingId = w.decision.actionable.top?.id ?? null;
      if (w.role === 'dev' || w.role === 'design') {
        const seat = w.route.resolved?.seats[w.role];
        if (seat) {
          const candidates = rankedCandidates(w.role, w.decision.selectionInput);
          const contract = w.decision.selectionInput.contract ?? DEFAULT_CONTRACT;
          const result = await resolveTopCandidate(
            fleetTracker, candidates, seat,
            contract.statuses.approved,
            contract.statuses.building,
            (t) => dirForRepo(w.route, t.repo_id) !== null,
          );
          if (result.contended.length) {
            emit.emit(`claim contended for ${result.contended.join(', ')} — moved to the next candidate`, {
              step: 'select', role: w.role,
            });
          }
          if (result.unservable.length) {
            emit.emit(
              `skipped ${result.unservable.join(', ')} — no local checkout for their repo`,
              { step: 'select', role: w.role },
            );
          }
          if (!result.ticket) {
            emit.emit(`${w.role} skipped this cycle — every candidate was already claimed elsewhere`);
            if (!skipInlineRelease) await releaseFleet();
            break;
          }
          if (result.claimed) {
            const idx = w.decision.tickets.findIndex((t) => t.id === result.ticket!.id);
            if (idx >= 0) w.decision.tickets[idx] = result.ticket;
            writeDigest({ route: w.route, ship: cfg.ship, state, emit }, w.decision, w.role, cfg.ship.stateDir);
          }
          fleetTicketHint = result.ticket.issue_id;
          fleetWorkingId = result.ticket.id;

          // Lazy: only the repo THIS ticket actually names, only now that
          // it's the one about to be worked — not every repo `reposOf`
          // could derive a path for. See `ensureRepoCheckout`'s own doc.
          const target = repoTargetFor(w.route, result.ticket.repo_id);
          try {
            if (target && ensureRepoCheckout(target.dir, target.remote)) {
              emit.emit(`cloned ${target.name} into ${target.dir}`, { step: 'select', role: w.role });
            }
          } catch (e) {
            emit.error(`could not check out ${target?.name ?? '(unknown repo)'} for ${result.ticket.issue_id}: ${(e as GitError).message}`);
            if (!skipInlineRelease) await releaseFleet();
            break;
          }
        }
      }

      const fleetPlan = planAgentRun({
        role: w.role, route: w.route, ship: cfg.ship,
        stateDir: cfg.ship.stateDir, roster: rosterFor(w.decision, w.route, w.role),
        environment: await environmentFor(w.route, fleetTicketHint),
        apiKey: resolveApiKey(w.route),
        cycle: emit.cycle, ticket: fleetTicketHint,
        divergedPrompt: await fetchDivergedPrompt(w.route, w.role, { userAgent: cfg.ship.userAgent }),
      });
      emit.enter('agent', w.role);
      emit.emit(`starting agent run for ${w.route.route}`);
      const fleetMemberId = w.route.resolved?.seats[w.role];
      if (fleetMemberId) {
        try {
          await fleetTracker.setCrewStatus(fleetMemberId, 'working', fleetWorkingId);
        } catch (e) {
          emit.warn(`could not set crew status: ${(e as Error).message}`, { step: 'agent' });
        }
      }
      try {
        await fleetTracker.beatEngaged(cfg.ship.name, w.route.route, fleetWorkingId);
      } catch (e) {
        emit.warn(`could not beat ship engaged: ${(e as Error).message}`, { step: 'agent' });
      }
      try {
        await spawnAgent(fleetPlan, emit);
      } finally {
        dropLock();
        if (fleetMemberId) {
          try {
            await fleetTracker.setCrewStatus(fleetMemberId, 'idle');
          } catch (e) {
            emit.warn(`could not clear crew status: ${(e as Error).message}`, { step: 'agent' });
          }
        }
        try {
          await fleetTracker.beatIdle(cfg.ship.name);
        } catch (e) {
          emit.warn(`could not beat ship idle: ${(e as Error).message}`, { step: 'agent' });
        }
      }
      if (!skipInlineRelease) await releaseFleet();
      break;
    }

    // A ship that cannot satisfy any of this route's repos must not take
    // its work: it would fail at the first hook, having already claimed a
    // ticket.
    if (!(await anyRepoServable(route))) {
      emit.error(
        `refusing this route — this ship is ${cfg.ship.platform}, but ${await explainUnservable(route)}`,
      );
      process.exit(1);
    }
    if (state.isPaused()) {
      emit.emit('the crew is paused');
      break;
    }
    const decision = await decideCycle({ route, ship: cfg.ship, state, emit });

    if (decision.sweep.length) {
      if (dryRun) {
        for (const s of decision.sweep) {
          emit.emit(`would ${s.action} -> ${s.to} (blockers: ${s.blockers})`, {
            ticket: s.ticket.issue_id, step: 'sweep',
          });
        }
      } else {
        const seat = route.resolved?.seats.qa ?? route.resolved?.seats.dev;
        const r = await applySweep(new Tracker(route, cfg.ship), decision.sweep, seat ?? '', emit);
        emit.emit(
          `swept ${r.parked} parked, ${r.restored} restored` +
            `${r.failed ? `, ${r.failed} failed` : ''}${r.contended ? `, ${r.contended} contended` : ''}`,
          { step: 'sweep', data: r },
        );
      }
    }

    const role = (value('role') as RoleName | undefined) ?? decision.selection.selected;
    if (command === 'poll') break;

    // Ship-level heartbeat (ISSUE-380) — see the matching fleet-wide comment
    // above. Fires here, once, regardless of whether a role was found below.
    // Skipped for --dry-run, which "performs nothing".
    if (!dryRun) {
      try {
        await new Tracker(route, cfg.ship).beatShip(cfg.ship.name);
      } catch (e) {
        emit.warn(`could not beat ship: ${(e as Error).message}`, { step: 'poll' });
      }
    }

    if (!role) {
      emit.emit('no role to run this cycle');
      // The release still has to happen (unless a companion release unit
      // owns it — see `skipInlineRelease` above). A cycle with no agent
      // work is exactly when verified branches are most likely to be
      // waiting — and returning here is what left ISSUE-280 and ISSUE-292
      // unmerged.
      if (!skipInlineRelease) await releaseTargets();
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
    const tracker2 = new Tracker(route, cfg.ship);

    while (current) {
      // Role-distinct, capacity-limited (ISSUE-381) — see State.acquireRun.
      // A role already running elsewhere (another route, another
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

      // ISSUE-395: the poll only DECIDED this role's top ticket; claim it now,
      // atomically, rather than leaving that to the session minutes from now.
      // A ticket still at the approved status is contended with a conditional
      // write — a second ship's identical claim loses and this walks down to
      // the next candidate. A resumption ticket needs no claim and is handed
      // back as-is.
      let ticketHint = decision.actionable.top?.issue_id;
      let workingId = decision.actionable.top?.id ?? null;
      if (!dryRun && (current === 'dev' || current === 'design')) {
        const seat = route.resolved?.seats[current];
        if (seat) {
          const candidates = rankedCandidates(current, decision.selectionInput);
          const contract = decision.selectionInput.contract ?? DEFAULT_CONTRACT;
          const result = await resolveTopCandidate(
            tracker2, candidates, seat,
            contract.statuses.approved,
            contract.statuses.building,
            (t) => dirForRepo(route, t.repo_id) !== null,
          );
          if (result.contended.length) {
            emit.emit(`claim contended for ${result.contended.join(', ')} — moved to the next candidate`, {
              step: 'select', role: current,
            });
          }
          if (result.unservable.length) {
            emit.emit(
              `skipped ${result.unservable.join(', ')} — no local checkout for their repo`,
              { step: 'select', role: current },
            );
          }
          if (!result.ticket) {
            emit.emit(`${current} skipped this cycle — every candidate was already claimed elsewhere`);
            dropLock();
            if (explicitRole) { current = undefined; break; }
            const remaining = nextRoles(decision, [...ran, current]);
            current = remaining[0];
            continue;
          }
          if (result.claimed) {
            const idx = decision.tickets.findIndex((t) => t.id === result.ticket!.id);
            if (idx >= 0) decision.tickets[idx] = result.ticket;
            writeDigest({ route, ship: cfg.ship, state, emit }, decision, current, cfg.ship.stateDir);
          }
          ticketHint = result.ticket.issue_id;
          workingId = result.ticket.id;

          // Lazy: only the repo THIS ticket names, only now that it's the
          // one about to be worked. See the matching fleet-path comment
          // above and `ensureRepoCheckout`'s own doc in git.ts.
          const target = repoTargetFor(route, result.ticket.repo_id);
          try {
            if (target && ensureRepoCheckout(target.dir, target.remote)) {
              emit.emit(`cloned ${target.name} into ${target.dir}`, { step: 'select', role: current });
            }
          } catch (e) {
            emit.error(`could not check out ${target?.name ?? '(unknown repo)'} for ${result.ticket.issue_id}: ${(e as GitError).message}`);
            dropLock();
            if (explicitRole) { current = undefined; break; }
            const remaining = nextRoles(decision, [...ran, current]);
            current = remaining[0];
            continue;
          }
        }
      }

      const plan = planAgentRun({
        role: current, route, ship: cfg.ship,
        stateDir: cfg.ship.stateDir, roster: rosterFor(decision, route, current),
        environment: await environmentFor(route, ticketHint),
        apiKey: resolveApiKey(route),
        cycle: emit.cycle, ticket: ticketHint,
        divergedPrompt: await fetchDivergedPrompt(route, current, { userAgent: cfg.ship.userAgent }),
      });
      if (dryRun) {
        process.stdout.write(`${describePlan(plan)}\n`);
        break;
      }
      const before = snapshot(await tracker2.openTickets());
      emit.enter('agent', current);
      emit.emit('starting agent run');
      const memberId = route.resolved?.seats[current];
      if (memberId) {
        try {
          await tracker2.setCrewStatus(memberId, 'working', workingId);
        } catch (e) {
          emit.warn(`could not set crew status: ${(e as Error).message}`, { step: 'agent' });
        }
      }
      try {
        await tracker2.beatEngaged(cfg.ship.name, route.route, workingId);
      } catch (e) {
        emit.warn(`could not beat ship engaged: ${(e as Error).message}`, { step: 'agent' });
      }
      try {
        await spawnAgent(plan, emit);
      } finally {
        dropLock();
        if (memberId) {
          try {
            await tracker2.setCrewStatus(memberId, 'idle');
          } catch (e) {
            emit.warn(`could not clear crew status: ${(e as Error).message}`, { step: 'agent' });
          }
        }
        try {
          await tracker2.beatIdle(cfg.ship.name);
        } catch (e) {
          emit.warn(`could not beat ship idle: ${(e as Error).message}`, { step: 'agent' });
        }
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
    // Skipped for `--role` ("run exactly this seat") or a companion release
    // unit (`skipInlineRelease` above).
    if (!value('role') && !skipInlineRelease) await releaseTargets();
    break;
  }

  case 'merge':
  case 'deploy':
  case 'release': {
    const opts = { mergeOnly: command === 'merge', force: command === 'deploy' || flag('force') };
    // Named or single route by default — `crew release` is a deliberate act
    // on one repo. `--fleet` opts into the same fleet-wide sweep `crew run`
    // used to do inline (see the release-lane comment on `case 'run'`); the
    // companion release unit `crew install` sets up runs exactly this.
    if (releaseFleetWide) await releaseFleet(opts);
    else await releaseTargets(opts);
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
        route: positional[1] ? route.route : undefined,
      },
    });
    process.on('SIGINT', () => { stop(); process.exit(0); });
    break;
  }

  case 'agents': {
    // `crew agents sync [route]` and `crew agents prompt <role> [route]`.
    // Unlike every other route-scoped command, the route argument is
    // positional[2] or [3] (`agents` occupies positional[1] as the
    // subcommand name), so this resolves its own target route instead of
    // using the `route` the global `fleetWide` default picked (see the
    // `command === 'agents'` entry there, which exists only to stop
    // `findRoute(cfg, 'sync')` throwing).
    const sub = positional[1];
    if (sub === 'prompt') {
      const role = positional[2] as RoleName | undefined;
      if (!role || !ROLE_NAMES.includes(role)) {
        process.stderr.write(`crew agents prompt <role> [route]   print a persona's current prompt (roles: ${ROLE_NAMES.join(', ')})\n`);
        process.exit(2);
      }
      let promptTarget: Route;
      try {
        // No route named: prefer the route this cwd belongs to (a `SessionStart`
        // hook runs from inside a checkout, not with a route named on argv) —
        // falling back to findRoute's own single-route default for a ship with
        // exactly one route.
        promptTarget = positional[3]
          ? findRoute(cfg, positional[3])
          : (routeForDir(cfg, process.cwd()) ?? findRoute(cfg, undefined));
      } catch (e) {
        if (e instanceof ConfigError) { process.stderr.write(`crew: ${e.message}\n`); process.exit(2); }
        throw e;
      }
      if (!promptTarget.resolved) {
        process.stderr.write(`crew agents prompt: route "${promptTarget.route}" has no resolved ids — run \`crew connect\` first\n`);
        process.exit(2);
      }
      try {
        const prompt = await currentPersonaPrompt(promptTarget, role, { userAgent: cfg.ship.userAgent });
        process.stdout.write(prompt);
      } catch (e) {
        if (e instanceof AgentsSyncError) { process.stderr.write(`crew agents prompt: ${e.message}\n`); process.exit(2); }
        throw e;
      }
      break;
    }
    if (sub !== 'sync') {
      process.stderr.write('crew agents sync [route]              push crew\'s personas (Developer/Design/QA/Triage/Pair) AND skill files (e.g. grill-me) into the workspace Agents/Agent Skills tables\n');
      process.stderr.write(`crew agents prompt <role> [route]     print a persona's current prompt (roles: ${ROLE_NAMES.join(', ')})\n`);
      process.exit(2);
    }
    let target: Route;
    try {
      target = findRoute(cfg, positional[2]);
    } catch (e) {
      if (e instanceof ConfigError) { process.stderr.write(`crew: ${e.message}\n`); process.exit(2); }
      throw e;
    }
    if (!target.resolved) {
      process.stderr.write(`crew agents sync: route "${target.route}" has no resolved ids — run \`crew connect\` first\n`);
      process.exit(2);
    }
    let personaResult: Awaited<ReturnType<typeof syncPersonas>>;
    try {
      personaResult = await syncPersonas(target, { userAgent: cfg.ship.userAgent, dryRun });
    } catch (e) {
      if (e instanceof AgentsSyncError) { process.stderr.write(`crew agents sync: ${e.message}\n`); process.exit(2); }
      throw e;
    }
    for (const o of personaResult.outcomes) process.stdout.write(`${describeSyncOutcome(o)}\n`);
    for (const o of personaResult.crewLinks) process.stdout.write(`${describeCrewLink(o)}\n`);
    // "Agents" here means every agent-shaped resource crew owns — personas
    // AND skills — not just the Agents table; `crew skills sync` remains
    // available on its own when an operator wants to push skill changes
    // without touching personas, but this is the one command a person
    // reaches for after editing anything under prompts/<promptSet>/.
    let skillResult: Awaited<ReturnType<typeof syncSkills>>;
    try {
      skillResult = await syncSkills(target, { userAgent: cfg.ship.userAgent, dryRun });
    } catch (e) {
      if (e instanceof SkillSyncError) { process.stderr.write(`crew agents sync: ${e.message}\n`); process.exit(2); }
      throw e;
    }
    for (const o of skillResult.outcomes) process.stdout.write(`${describeSkillSyncOutcome(o)}\n`);
    if (!dryRun) {
      // Persist `agentPersonas` and `agentSkills` into this route's resolved
      // state file — same merge-not-clobber shape `connect`'s own
      // `contract`/`reviewedStatuses` writes use, since a hand-authored
      // `contract` block or another field this command knows nothing about
      // must survive untouched.
      const resolvedPath = resolvedPathFor(cfg.ship.stateDir, target.route);
      const raw = existsSync(resolvedPath) ? JSON.parse(readFileSync(resolvedPath, 'utf8')) : {};
      raw.agentPersonas = personaResult.agentPersonas;
      raw.agentSkills = skillResult.agentSkills;
      mkdirSync(dirOf(resolvedPath), { recursive: true });
      writeFileSync(resolvedPath, `${JSON.stringify(raw, null, 2)}\n`);
    }
    // A diverged persona or skill is not this run's failure, but it IS
    // something an operator needs to act on (review the row, or re-sync
    // once they have) — a nonzero exit is what makes that visible to
    // whatever invoked this (a scheduler job's log, a person's own shell)
    // without erroring the whole command.
    if (personaResult.outcomes.some((o) => o.action === 'diverged') || skillResult.outcomes.some((o) => o.action === 'diverged')) {
      process.exitCode = 1;
    }
    break;
  }

  case 'skills': {
    // `crew skills sync [route]` — the skills-only subset of what `crew
    // agents sync` already does as part of its own run; use this when you
    // want to push a skill-file change without touching personas. Same
    // shape as `case 'agents'` above: `skills` occupies positional[1] as
    // the subcommand name, so this resolves its own target route from
    // positional[2] rather than the fleet-wide default `route` above
    // picked.
    const sub = positional[1];
    if (sub !== 'sync') {
      process.stderr.write('crew skills sync [route]              push crew\'s skill files (e.g. grill-me) into the workspace Agent Skills table\n');
      process.exit(2);
    }
    let target: Route;
    try {
      target = findRoute(cfg, positional[2]);
    } catch (e) {
      if (e instanceof ConfigError) { process.stderr.write(`crew: ${e.message}\n`); process.exit(2); }
      throw e;
    }
    if (!target.resolved) {
      process.stderr.write(`crew skills sync: route "${target.route}" has no resolved ids — run \`crew connect\` first\n`);
      process.exit(2);
    }
    let result: Awaited<ReturnType<typeof syncSkills>>;
    try {
      result = await syncSkills(target, { userAgent: cfg.ship.userAgent, dryRun });
    } catch (e) {
      if (e instanceof SkillSyncError) { process.stderr.write(`crew skills sync: ${e.message}\n`); process.exit(2); }
      throw e;
    }
    for (const o of result.outcomes) process.stdout.write(`${describeSkillSyncOutcome(o)}\n`);
    if (!dryRun) {
      // Same merge-not-clobber shape `case 'agents'` uses for its own
      // `agentPersonas` write — a hand-authored `contract` block or another
      // field this command knows nothing about must survive untouched.
      const resolvedPath = resolvedPathFor(cfg.ship.stateDir, target.route);
      const raw = existsSync(resolvedPath) ? JSON.parse(readFileSync(resolvedPath, 'utf8')) : {};
      raw.agentSkills = result.agentSkills;
      mkdirSync(dirOf(resolvedPath), { recursive: true });
      writeFileSync(resolvedPath, `${JSON.stringify(raw, null, 2)}\n`);
    }
    // A diverged skill is not this run's failure, but it IS something an
    // operator needs to act on — same reasoning as `case 'agents'`.
    if (result.outcomes.some((o) => o.action === 'diverged')) process.exitCode = 1;
    break;
  }

  case 'logbook': {
    // Same shape as `case 'agents'` above: `logbook` occupies positional[1]
    // as the subcommand name, so this resolves its own target route rather
    // than the fleet-wide default `route` above picked. `show`'s entry id
    // is always the LAST positional — a route is only read from
    // positional[2] when a further positional (the entry id) follows it,
    // so `crew logbook show ABC123` (no route named) still works on a
    // single-route ship without requiring `crew logbook show default ABC123`.
    const sub = positional[1];
    if (sub !== 'list' && sub !== 'show') {
      process.stderr.write(
        'crew logbook list [route] [--role R] [--ticket T] [--limit N]\n' +
        'crew logbook show [route] <entryId> [--prompt]\n',
      );
      process.exit(2);
    }
    const routeArg = sub === 'show' && positional[3] ? positional[2] : (sub === 'list' ? positional[2] : undefined);
    const entryId = sub === 'show' ? (positional[3] ?? positional[2]) : undefined;
    if (sub === 'show' && !entryId) {
      process.stderr.write('crew logbook show [route] <entryId> [--prompt]\n');
      process.exit(2);
    }
    let target: Route;
    try {
      target = findRoute(cfg, routeArg);
    } catch (e) {
      if (e instanceof ConfigError) { process.stderr.write(`crew: ${e.message}\n`); process.exit(2); }
      throw e;
    }
    try {
      if (sub === 'list') {
        const entries = await listLogEntries(target, {
          userAgent: cfg.ship.userAgent,
          role: value('role'),
          ticket: value('ticket'),
          limit: value('limit') ? Number(value('limit')) : undefined,
        });
        if (entries.length === 0) { process.stdout.write('(no Agent Log entries match)\n'); break; }
        for (const e of entries) {
          process.stdout.write(
            `${e.id}  ${e.started_at ?? '?'}  ${e.outcome ?? '?'}` +
              `${e.ticket_reference ? `  ${e.ticket_reference}` : ''}${e.model ? `  ${e.model}` : ''}\n`,
          );
        }
      } else {
        const { entry, reconstruction } = await showLogEntry(target, entryId!, {
          userAgent: cfg.ship.userAgent,
          withPrompt: flag('prompt'),
        });
        process.stdout.write(
          `id:         ${entry.id}\n` +
          `started:    ${entry.started_at ?? '?'}\n` +
          `finished:   ${entry.finished_at ?? '?'}\n` +
          `outcome:    ${entry.outcome ?? '?'}\n` +
          `ticket:     ${entry.ticket_reference ?? '(none)'}\n` +
          `model:      ${entry.model ?? '?'}\n`,
        );
        if (flag('prompt')) {
          process.stdout.write(`\nprompt reconstruction: ${reconstruction.status}` +
            `${reconstruction.reason ? ` — ${reconstruction.reason}` : ''}\n`);
          if (reconstruction.prompt) process.stdout.write(`\n${reconstruction.prompt}\n`);
          if (reconstruction.status !== 'exact') process.exitCode = 1;
        }
      }
    } catch (e) {
      if (e instanceof LogbookError) { process.stderr.write(`crew logbook: ${e.message}\n`); process.exit(2); }
      throw e;
    }
    break;
  }

  case 'connect': {
    // `crew connect foo/bar` (workspace slug / project slug) is the normal
    // form; `crew connect foo` offers every project in that workspace with
    // the tables a route needs, when there's more than one candidate; bare
    // `crew connect` (no argument at all) offers every workspace this key's
    // identity can see. `--workspace-id` (a uuid OR a slug — `discover()`
    // accepts either) and `--project` remain for scripting and for a project
    // named rather than slugged.
    const arg = positional[1];
    const [argWorkspace, argProject] = arg?.includes('/') ? arg.split(/\/(.*)/s) : [arg, undefined];
    const workspace = argWorkspace ?? value('workspace-id') ?? value('workspace');
    const project = argProject ?? value('project');
    // No bare `cfg.ship.apiKey` to read here — it's only a fallback SOURCE the
    // route parser merges in, not a field of its own on `Ship`. Any
    // already-configured route's (already-merged) key is the next best
    // guess, and exactly what a ship-level key resolves to in practice.
    const apiKey = value('key') ?? process.env.CREW_CONNECT_KEY ?? cfg.routes.find((c) => c.apiKey)?.apiKey;
    if (!apiKey) {
      process.stderr.write(
        'crew connect [<workspace>[/<project>]] --key K (or CREW_CONNECT_KEY, or ship.apiKey in crew.yaml)\n' +
        '  workspace/project may be slugs, ids, or (project) a name. Omit workspace to list them.\n',
      );
      process.exit(2);
    }
    const authOpts = {
      baseUrl: value('base-url') ?? cfg.routes[0]?.baseUrl ?? DEFAULT_BASE_URL,
      apiKey, userAgent: cfg.ship.userAgent,
    };

    const runConnect = async (ws: string, proj: string | undefined): Promise<void> => {
      const found = await discover({ ...authOpts, workspace: ws, project: proj, area: value('area') });
      if (!found.projectId) {
        process.stderr.write(`crew connect ${ws}: unresolved —\n`);
        for (const p of found.problems) process.stderr.write(`  - ${p}\n`);
        process.exit(2);
      }
      // The route's own identity, built from the SLUGS `discover()` resolved
      // — never from a display name, which may hold spaces/mixed case a
      // route string and a state-file path segment cannot.
      const route = `${found.workspaceSlug}/${found.projectSlug ?? found.projectId}`;
      const resolvedPath = resolvedPathFor(cfg.ship.stateDir, route);
      // `discover()` already tried to match this key's own identity email
      // against a Crew row; ask interactively only when that came up empty
      // (or ambiguous) AND there is a person on the other end of a terminal
      // to ask — a script piping stdin gets the old file-editing fallback.
      let operator = found.operator;
      if (!operator && found.holds.length > 0 && process.stdin.isTTY && process.stdout.isTTY) {
        operator = await pickOperator(found.holds);
      }
      // Read whatever this route already had — a re-run must not clobber a
      // hand-authored `contract` block (column renames, priority order, an
      // earlier hand-added `resolved` entry), and must not re-ask about a
      // status value this route was already asked about last time, whichever
      // way it was answered (`reviewedStatuses`, ISSUE-467).
      let previous:
        | { contract?: { statuses?: { resolved?: string[] } } | null; reviewedStatuses?: string[]; operator?: string }
        | undefined;
      if (existsSync(resolvedPath)) {
        try { previous = JSON.parse(readFileSync(resolvedPath, 'utf8')); } catch { /* treated as no previous file below */ }
      }
      // Same "never clobber what a previous run/hand-edit wrote" rule
      // `contract`/`reviewedStatuses` already follow (ISSUE-467) — a skipped
      // picker (blank answer, or no TTY to ask at all) must not wipe an
      // operator a prior run or a hand-edit already resolved.
      if (!operator) operator = previous?.operator;
      const alreadyReviewed = new Set(previous?.reviewedStatuses ?? []);
      const stillUnrecognized = (found.unrecognizedStatuses ?? []).filter((s) => !alreadyReviewed.has(s.value));
      const canPrompt = stillUnrecognized.length > 0 && process.stdin.isTTY && process.stdout.isTTY;
      const newlyResolved = canPrompt ? await pickResolvedStatuses(stillUnrecognized) : [];
      // Every value actually ASKED about — asked-and-declined counts as
      // reviewed too, so a `draft`-like status answered "no" isn't asked
      // about again and again on every future connect. A script run
      // (piped/non-interactive) never asked, so it must not mark them
      // reviewed — that would silently bury them until someone edits the
      // state file by hand, the same trap `operator` already avoids above.
      const reviewedStatuses = canPrompt
        ? [...new Set([...(previous?.reviewedStatuses ?? []), ...stillUnrecognized.map((s) => s.value)])].sort()
        : (previous?.reviewedStatuses ?? []);
      // Only the CUSTOM values, not the whole previously-written array — that
      // array already carries DEFAULT_CONTRACT's own entries too (it's
      // written in full below, same as the hand-authored precedent in
      // docs/CONTRACT.md), and re-prepending the defaults onto themselves
      // every run would grow duplicate entries in `resolved` forever.
      const previouslyResolvedCustom = (previous?.contract?.statuses?.resolved ?? [])
        .filter((v) => !DEFAULT_CONTRACT.statuses.resolved.includes(v));
      const resolvedStatusValues = [...new Set([...previouslyResolvedCustom, ...newlyResolved])];
      // Only `statuses.resolved` is ever written here — `resolveContract`
      // deep-merges per top-level key, so this alone would silently drop
      // any OTHER hand-authored contract field (columns, priorityOrder,
      // statuses.approved, ...) unless everything else from `previous` is
      // carried forward untouched.
      const contract = previous?.contract || resolvedStatusValues.length > 0
        ? {
            ...(previous?.contract ?? {}),
            statuses: {
              ...(previous?.contract?.statuses ?? {}),
              ...(resolvedStatusValues.length > 0
                ? { resolved: [...DEFAULT_CONTRACT.statuses.resolved, ...resolvedStatusValues] }
                : {}),
            },
          }
        : undefined;
      const resolved = {
        workspaceId: found.workspaceId, projectId: found.projectId,
        areaModelId: found.areaModelId, areaId: found.areaId,
        shipsModelId: found.shipsModelId, epicsModelId: found.epicsModelId, locksModelId: found.locksModelId,
        reposModelId: found.reposModelId, repoNames: found.repoNames, repoRemotes: found.repoRemotes,
        models: found.models, seats: found.seats, holds: found.holds.map((h) => ({ id: h.id, role: h.name })),
        ...(operator ? { operator } : {}),
        ...(contract ? { contract } : {}),
        ...(reviewedStatuses.length > 0 ? { reviewedStatuses } : {}),
      };
      if (dryRun) {
        process.stderr.write(`(dry run) would write resolved ids to ${resolvedPath}\n`);
      } else {
        mkdirSync(dirname(resolvedPath), { recursive: true });
        writeFileSync(resolvedPath, `${JSON.stringify(resolved, null, 2)}\n`);
        process.stderr.write(`Resolved ids written to ${resolvedPath}\n`);
      }
      process.stdout.write(renderConnection(
        found, route,
        value('dir') ?? 'REPLACE — the local checkout this route works',
        { area: value('area') },
      ));
      if (found.problems.length) {
        process.stderr.write('\n  Unresolved — fix these before arming it:\n');
        for (const p of found.problems) process.stderr.write(`    - ${p}\n`);
      }
      if (!canPrompt && stillUnrecognized.length > 0) {
        // Nowhere to ask (piped/non-interactive) — same reasoning as the
        // operator fallback below. Left unclassified rather than guessed;
        // a blocker sitting at one of these won't be recognised as resolved
        // until a person runs `crew connect` from a real terminal, or adds
        // it to contract.statuses.resolved in resolvedPath by hand.
        process.stderr.write(
          `\n  ${stillUnrecognized.length} status value(s) this workspace has that the default contract\n` +
          `  doesn't know the meaning of (${stillUnrecognized.map((s) => s.value).join(', ')}) — ` +
          `re-run from a terminal to classify them, or edit ${resolvedPath} by hand.\n`,
        );
      }
      if (operator) {
        process.stderr.write(
          `\n  Paste the block above under routes: in crew.yaml (if "${route}" isn't there already), then: ` +
            `crew doctor ${route}\n`,
        );
      } else {
        // Nothing to infer this from (no email match) and nowhere to ask
        // (piped/non-interactive) — which Crew row is the human running
        // this is left for a person to decide once, by hand, in the state
        // file `resolvedPath` names above.
        process.stderr.write(
          `\n  Paste the block above under routes: in crew.yaml (if "${route}" isn't there\n` +
          `  already), set operator in ${resolvedPath}, then: crew doctor ${route}\n`,
        );
      }
    };

    try {
      if (!workspace) {
        const workspaces = await listWorkspaces(authOpts);
        if (workspaces.length === 0) {
          process.stderr.write('crew connect: this key\'s identity has no workspace memberships.\n');
          process.exit(2);
        } else if (workspaces.length === 1) {
          // Only one candidate — same reasoning as an unnamed route with only
          // one enabled: nothing to disambiguate, so proceed with it directly
          // rather than making the operator retype what there was no choice in.
          await runConnect(workspaces[0]!.slug, project);
        } else {
          process.stderr.write(
            `${workspaces.length} workspaces reachable by this key — name one:\n` +
            workspaces.map((w) => `  ${w.slug.padEnd(24)} ${w.name} (${w.role})\n`).join(''),
          );
          process.exit(2);
        }
      } else {
        await runConnect(workspace, project);
      }
    } catch (e) {
      // A bad key/workspace pairing is an operator mistake, not a crash —
      // same reasoning as the crew.yaml ConfigError handling above main().
      if (e instanceof ConnectHttpError) {
        if (e.status === 401 || e.status === 403) {
          process.stderr.write(
            `crew connect: ${e.path} — ${e.status} ${e.status === 401 ? '(bad or expired key)' : '(this key is not a member of that workspace)'}\n` +
              '  A key only sees the workspace it was minted in, whatever role it holds there\n' +
              '  (platform admin included) — pass one minted inside the target workspace: --key K\n' +
              '  (or CREW_CONNECT_KEY).\n',
          );
        } else {
          process.stderr.write(`crew connect: ${e.message}\n`);
        }
        process.exit(2);
      }
      throw e;
    }
    break;
  }

  case 'inbox': {
    // Deliberately NOT scoped to one route: the whole point is that no
    // single board can answer this.
    const who = value('member');
    const { items, errors, resolved, ambiguous } = await gatherInbox(cfg.routes, cfg.ship, {
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
            ? `${r.route}: ${r.names.join(', ')}${r.emails.length ? ` <${r.emails.join(', ')}>` : ''}` +
              `${r.by === 'name' ? ' (matched by name)' : ''}\n`
            : `${r.route}: no crew member matching "${who}"\n`,
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
    process.stdout.write(renderInbox(items, flag('by-route'), subject));
    for (const e of errors) process.stderr.write(`  (${e.route} unreachable: ${e.error})\n`);
    break;
  }

  case 'ports': {
    const where = await worktreeLocations(route);
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

    // Every repository, not just the route's first: a worktree alive in
    // the second one used to read as an orphan, and reap kills orphans.
    const orphans = findOrphansIn(await worktreeLocations(route));
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
    const tracker = new Tracker(route, cfg.ship);
    const terminal = await tracker.terminalTickets();
    const { byRepo } = ticketsByRepo(route, terminal);
    for (const r of await resolvedRepos(route)) {
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

    // Same retention rule the release phase applies on its own (ISSUE-401),
    // available by hand here for the same reason the worktree sweep is.
    const streamPaths = planStreamSweep(cfg.ship.stateDir, cfg.ship.streamRetentionDays);
    if (streamPaths.length) {
      anything = true;
      const removed = applyStreamSweep(streamPaths, dryRun, emit);
      emit.emit(`swept ${removed} stream artifact(s)`, { step: 'worktree' });
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
    const repos = await resolvedRepos(route);
    const candidates = repos
      .map((r) => ({
        repo: r,
        path: `${resolvePath(r.dir, '..')}/${r.config.worktrees.prefix}${n}`,
      }))
      .filter((c) => existsSync(`${c.path}/.git`));
    if (candidates.length === 0) {
      process.stderr.write(
        `drop: no worktree for ISSUE-${n} in any of this route's repositories ` +
          `(looked in: ${repos.map((r) => `${r.config.worktrees.prefix}${n}`).join(', ')})\n`,
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

  case 'unassign': {
    // ISSUE-380's "crew release": renamed here because `crew release` was
    // already taken (merge/version/deploy, above) — a second meaning on the
    // same word would be confusing on the command line, not just in this
    // file. Needs no new state: select.ts already treats an in_progress
    // ticket with no assignee as "back up for grabs" (the same hand-off
    // protocol a seat's own worktree wrap-up uses), so this is purely
    // clearing `assignee_id`.
    emit.enter('select');   // closest existing step — this changes selection, not a worktree
    const n = positional[2] ?? positional[1];
    if (!n || !/^\d+$/.test(n)) { process.stderr.write('unassign: need a ticket number\n'); process.exit(2); }
    const tracker3 = new Tracker(route, cfg.ship);
    const c = tracker3.contract;
    const key = `ISSUE-${n}`;
    const open = await tracker3.openTickets();
    const ticket = open.find((t) => t[c.columns.key] === key);
    if (!ticket) {
      process.stderr.write(`unassign: no open ticket ${key} on ${route.route} (already resolved, or not this route's)\n`);
      process.exit(2);
    }
    if (!ticket[c.columns.assignee]) {
      process.stdout.write(`${key} already has no assignee\n`);
      break;
    }
    if (dryRun) {
      emit.emit(`would clear assignee on ${key} (status stays ${ticket[c.columns.status]})`);
      break;
    }
    try {
      await tracker3.updateTicket(ticket.id, { [c.columns.assignee]: null }, ticket.updated_at);
      emit.emit(`cleared assignee on ${key} — back up for grabs next cycle`);
    } catch (e) {
      if (e instanceof StaleWriteError) {
        process.stderr.write(`unassign: ${key} changed on the board since it was read — re-run to retry\n`);
        process.exit(2);
      }
      throw e;
    }
    break;
  }

  case 'sync': {
    // A reviewer's commits land on the remote; until a worktree takes them the
    // dev seat builds on stale code and QA verifies something nobody reviewed.
    emit.enter('worktree');
    let tracked = 0;
    let acted = 0;
    // Every repository of the route: a reviewer's commits on the second
    // repo's branch are no less stale for being next door (ISSUE-350).
    for (const r of reposOf(route)) {
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
    // Two units, not one: `run` (poll/select/one agent session) and
    // `release` (test/build/deploy) now run on independent timers, so a
    // slow release no longer holds every board's next poll hostage — see
    // the release-lane comment on `case 'run'`. `run`'s own unit passes
    // itself `--no-release` (baked into `planInstall`'s `run` job), since
    // the `release` unit owns that now.
    for (const job of ['run', 'release'] as const) {
      const plan = planInstall(cfg.ship, CREW_HOME, host, detectSystemd(), job);
      process.stdout.write(`installing ${job} via ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}\n`);
      await applyInstall(plan, CREW_HOME, dryRun, {
        emit: (m) => process.stdout.write(`${m}\n`),
        warn: (m) => process.stderr.write(`crew install: ${m}\n`),
      });
    }
    break;
  }

  case 'uninstall': {
    const host = hostPlatform();
    if (host === 'windows') {
      process.stdout.write('nothing installed on Windows\n');
      break;
    }
    for (const job of ['run', 'release'] as const) {
      const plan = planUninstall(cfg.ship, CREW_HOME, host, detectSystemd(), job);
      process.stdout.write(`uninstalling ${job} ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}\n`);
      await applyUninstall(plan, CREW_HOME, dryRun, {
        emit: (m) => process.stdout.write(`${m}\n`),
        warn: (m) => process.stderr.write(`crew uninstall: ${m}\n`),
      });
    }
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
    // `--json` is an ADDITION, not a mode the text output below was folded
    // into — the human form is unchanged, since people have it in scripts
    // and in their fingers. It exists because a monitor (crew-macos's menu
    // bar app, ISSUE-417) previously had no supported way to ask "what is
    // this ship doing" except parsing crew's own private files directly —
    // crew.yaml, the state directory's pause markers, its lock files. Every
    // one of those is an implementation detail this program is free to
    // change; this is the answer that's safe to depend on instead.
    //
    // Single-route, matching the text output below: `status` isn't
    // FLEET_CAPABLE today (see `FLEET_CAPABLE` near the top of this file),
    // so `route` here is always the one route this invocation resolved,
    // never a fleet-wide list.
    //
    // Starvation instrumentation (ISSUE-382): the poll writes this every
    // cycle, so a quiet board's most urgent ticket going unpicked shows up
    // here without anyone reading the log by hand.
    const fairness = state.fairness(route.route);
    const waiting = fairness.waiting();

    // Ship liveness (ISSUE-380): every ship this route's Ships table
    // knows about, not only this one — "status ... what this ship (or the
    // fleet) is doing" names both. Absent entirely on a workspace with no
    // Ships table, same as `doctor`'s "this workspace has no Ships table
    // (fine)".
    const statusTracker = new Tracker(route, cfg.ship);
    const shipRows = await statusTracker.shipRows();
    const engagedTicketIds = shipRows.map((s) => s.engaged_ticket_id).filter((id): id is string => !!id);
    const engagedTickets = engagedTicketIds.length ? await statusTracker.ticketsByIds(engagedTicketIds) : [];
    const issueLabelById = new Map(engagedTickets.map((t) => [t.id, t.issue_id]));

    if (flag('json')) {
      const repos = await resolvedRepos(route);
      // Per-seat identity (ISSUE-525): crew-macos's menu bar wants the seat's
      // own Crew-row `Name` (an operator can rename a seat to their liking)
      // as the PRIMARY label, with the linked Agent persona's display name
      // only as a secondary detail — see Brad's 2026-08-30 decision on
      // ISSUE-417. Both live on the tracker, not in local config, so this
      // reads the Crew rows fresh rather than trusting anything cached.
      const seatIds = route.resolved?.seats ?? {};
      const crewRows = Object.keys(seatIds).length ? await statusTracker.crewRows() : [];
      const crewRowById = new Map(crewRows.map((c) => [c.id, c]));
      const agentPersonas = route.resolved?.agentPersonas ?? {};
      // 'pair' never has a Crew-table seat (it's an interactive persona, not
      // a polled one — see config.ts's RoleName doc) — including it here
      // would show crew-macos a seat entry that can never be staffed.
      const seats = ROLE_NAMES.filter((r) => r !== 'pair').map((r) => {
        const seatId = seatIds[r];
        const crewRow = seatId ? crewRowById.get(seatId) : undefined;
        const linkedAgentId = agentPersonas[r]?.agentId;
        // Only claim the persona name once the row's own `agent_id`
        // matches what `crew agents sync` last linked — an unsynced or
        // re-pointed seat has no verified persona name to report.
        const personaName = crewRow?.agent_id && crewRow.agent_id === linkedAgentId ? PERSONA_NAME[r] : null;
        return {
          role: r,
          label: ROLE_LABEL[r],
          crewId: seatId ?? null,
          name: crewRow?.name ?? null,
          personaName,
        };
      });
      process.stdout.write(`${JSON.stringify({
        // Bumped only when a field CHANGES MEANING or is removed — new
        // fields never bump it, so a reader can add support without a flag
        // day.
        version: 1,
        configFile: cfg.configFile,
        ship: {
          name: cfg.ship.name,
          platform: cfg.ship.platform,
          agent: { bin: cfg.ship.agent.bin, model: cfg.ship.agent.model },
          stateDir: cfg.ship.stateDir,
          logFile: cfg.ship.logFile,
          eventFile: eventFileFor(cfg.ship.stateDir),
        },
        crew: {
          paused: state.isPaused(),
          roles: ROLE_NAMES.map((r) => ({ name: r, label: ROLE_LABEL[r], paused: state.isRolePaused(r) })),
          seats,
        },
        watermark: state.watermark(),
        route: {
          name: route.route,
          dir: route.dir,
          enabled: route.enabled,
          area: route.area ?? null,
          baseUrl: route.baseUrl,
          repos: repos.map((r) => ({
            name: r.name,
            dir: r.dir,
            worktreePrefix: r.config.worktrees.prefix,
            worktreeParent: resolvePath(r.dir, '..'),
          })),
          waiting: waiting ? { ticket: waiting.ticket, since: waiting.since, streak: fairness.streak() } : null,
        },
        ships: shipRows.map((s) => ({
          name: s.name ?? null,
          lastSeen: s.last_seen ?? null,
          engaged: !!s.engaged,
          engagedSince: s.engaged_since ?? null,
          engagedRoute: s.engaged_connection ?? null,
          engagedTicket: s.engaged_ticket_id ? issueLabelById.get(s.engaged_ticket_id) ?? null : null,
        })),
      }, null, 2)}\n`);
      break;
    }

    process.stdout.write(
      `ship:       ${cfg.ship.name} (${cfg.ship.platform})\n` +
        `route:      ${route.route} -> ${route.dir}\n` +
        `enabled:    ${route.enabled}\n` +
        `crew:       ${state.isPaused() ? 'paused' : 'active'}\n` +
        `watermark:  ${state.watermark()}\n`,
    );
    for (const r of ['dev', 'design', 'qa'] as RoleName[]) {
      if (state.isRolePaused(r)) process.stdout.write(`role ${r}: paused\n`);
    }
    if (waiting) {
      process.stdout.write(
        `waiting:    ${waiting.ticket} for ${since(waiting.since)}` +
          ` (passed over ${fairness.streak()} cycle${fairness.streak() === 1 ? '' : 's'} running)\n`,
      );
    }

    if (shipRows.length) {
      // "An engaged ship names what it is working" — resolve the raw
      // `engaged_ticket_id` references to their `issue_id` label, one call
      // for every engaged ship rather than one call per ship.
      process.stdout.write('ships:\n');
      for (const s of shipRows) {
        process.stdout.write(`  ${renderShipLine(s, issueLabelById)}\n`);
      }
    }
    break;
  }

  case 'doctor': {
    const host = hostPlatform();
    process.stdout.write(
      `ship:              ${cfg.ship.name} (${host})\n` +
        `routes:            ${cfg.routes.map((c) => c.route).join(', ')}\n`,
    );

    // Does this machine have a row on the board, and which seats are its own?
    // Matched by name, per Brad's call: it is what an operator recognises.
    const tracker = new Tracker(route, cfg.ship);

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

    // Per repository, because a route serves several and each carries its
    // own contract. `shadowed` was computed and never read by anything until
    // ISSUE-350 — a setting the ship declares and the repo overrides is
    // otherwise invisible, and reads as though it were in use.
    for (const r of await resolvedRepos(route)) {
      const { config } = r;
      process.stdout.write(
        `${`repo ${r.name}:`.padEnd(19)}${r.dir}\n` +
          `                   worktrees at ../${config.worktrees.prefix}<number> ` +
          `(${config.provenance['worktrees.prefix'] ?? 'default'}), ` +
          `branch ${config.branch.name}\n` +
          `                   requires ${config.platform} — ${satisfies(host, config.platform) ? 'OK' : 'MISMATCH'}\n`,
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
            `crew manifest:     ${seats.length ? seats.map((c) => c.name).join(', ') : 'none'}\n`,
        );
      }
    }
    break;
  }

  default:
    usage();
}

lock?.release();
