#!/usr/bin/env node
/**
 * `crew` — the CLI.
 *
 * Every command that could change something takes `--dry-run`, and the
 * interlock (`enabled: false` per route) refuses anything that writes
 * until an operator arms it deliberately.
 */

import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  loadConfig, findRoute, routeForDir, resolveApiKey, hydrateApiKeys, reposOf, repoIdForName, shipWorktreePrefixFor,
  ticketsByRepo, configuredMembers,
  DEFAULT_BASE_URL, DEFAULT_REPOS_BASE_PATH, resolvedPathFor, apiKeyPathFor, dirForRepo, repoTargetFor, mergeRouteRelease, passengerRepoTargets,
  type Unplaceable, type UnplaceableReason,
  ConfigError, ROLE_NAMES, ROLE_LABEL, type RoleName, type RepoTarget, type Route, releaseSeat,
} from './config.ts';
import { buildRoster, crewLabel, holdIds, memberByIdentity } from './roster.ts';
import { State } from './state.ts';
import { Emitter, eventFileFor } from './events.ts';
import { decideCycle, rosterFor, writeDigest } from './poll.ts';
import { claimStatuses, rankedCandidates, withHoldCheck } from './select.ts';
import { applyHoldReleases, noteReaccepted, holdWarnings, noteTakeover, originBranchSha } from './ship-affinity.ts';
import { resolveTopCandidate } from './claim.ts';
import { applySweep } from './blocked.ts';
import { applyEpicSync, describeEpicStep } from './epics.ts';
import { planConflictBounce, applyConflictBounce } from './conflict.ts';
import { planStrandedVerified, applyStrandedVerified } from './stranded-verified.ts';
import { gateRedTickets, gateRedComment, alreadyReported } from './gate-red.ts';
import { planAgentRun, describePlan, spawnAgent, CREW_LANE_ROLE_VAR } from './agent.ts';
import { guardRunHandoff } from './handoff-guard.ts';
import { planRunWorktree, applyRunWorktree, describeRunWorktreePlan, planIsUsable } from './run-worktree.ts';
import { hostPlatform, satisfies, explain } from './platform.ts';
import {
  runWizard, shouldRunWizard, firstRunConfigPath, renderShipBlock, renderFullConfig, writeNewConfig, nextSteps,
  type Prompter, type WizardAnswers,
} from './connect-wizard.ts';
import { planInstall, planUninstall, applyInstall, applyUninstall, detectSystemd, planDaemonControl, labelFor, pathFor, findOnPath, dockerPathProblem, COMMON_DOCKER_DIRS, clearForeignLaunchdUnits, removeAllLaunchdUnits, loadedCrewLabels, describeForeignLaunchdUnits } from './install.ts';
import { loadRepoConfig, resolveRepoConfig, validateEffective, renderBranchName, effectiveBranchTemplate } from './repo-config.ts';
import { runRelease, summarizeOutcome, emitReleaseSummary, type RepoReleaseSummary, type RoutedReleaseSummary } from './release-run.ts';
import { describeUnplaceable } from './release.ts';
import { planStamp, applyStamp, applyExternalClosures } from './stamp.ts';
import { applyReview } from './review.ts';
import { renderEnvironment } from './environment.ts';
import { notify, describeRelease } from './notify.ts';
import { applyFailureAlert } from './failure-alert.ts';
import { Tracker, type Ticket, displayKey } from './tracker.ts';
import { operatorTodo } from './attention.ts';
import { StaleWriteError } from '@tablation/client';
import { releaseLockScope, type BoardLockResult } from './board-lock.ts';
import { releaserFor, nonReleaserNote, missingReleaserWarning } from './release-ship.ts';
import { validateContract, DEFAULT_CONTRACT } from './contract.ts';
import { startWatch } from './watch.ts';
import { findOrphansIn, listeners, ticketForPort, killGently, pidsInWorktree, worktreeExistsIn } from './ports.ts';
import { gatherInbox, renderInbox } from './inbox.ts';
import { decideFleet, renderFleet, snapshot, changed, nextRoles, since } from './fleet.ts';
import {
  discover, listWorkspaces, renderConnection, ConnectHttpError, provisionReleaseLocks,
  listLibraryTemplates, previewTemplateInstall, installTemplate, ISSUES_TEMPLATE_IDENTIFIER,
} from './connect.ts';
import {
  getSessionStore, hostFromUrl, loginWithDeviceCode, getOrCreateShipId, DeviceLoginError,
  type SessionStore,
} from '@tablation/client';
import { syncPersonas, describeSyncOutcome, describeCrewLink, AgentsSyncError, fetchDivergedPrompt, fetchSeatAgentModel, resolveAgentId, currentPersonaPrompt, PERSONA_NAME } from './agents.ts';
import { syncSkills, describeSkillSyncOutcome, SkillSyncError } from './skills.ts';
import { listLogEntries, showLogEntry, LogbookError } from './logbook.ts';
import { parseAddArgs, routeNamesOf, planRepoAdd, planRepoRow, resolveRepoProject, configuredRepos, matchRepoName, normalizeRemote, ReposError, type RepoRemotes } from './repos-cmd.ts';
import { ensureClaudeMcp, inspectClaudeMcp, mcpUrlFor } from './claude-mcp.ts';
import { gatherHealth, planFix, planEnable, routesInScope, schedulerInstalled } from './doctor-fix.ts';
import {
  resolve as gitResolve, worktrees, git, gitOk, syncState, fastForward, fetchRemote, branchForIssue, worktreeForNumber,
  remoteConfigured, remoteBranchExists, deleteRemoteBranch, findKeyInRange, firstReleaseTagContaining,
  ensureRepoCheckout, GitError, refreshBaseBranch, baseBranchUnsafe, describeUnsafeBase, type SyncState,
} from './git.ts';
import { planWorktreeSweep, applyWorktreeSweep, planRemoteBranchCleanup, applyRemoteBranchCleanup } from './worktree-sweep.ts';
import { planStreamSweep, applyStreamSweep } from './stream-sweep.ts';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, copyFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname as dirOf, resolve as resolvePath } from 'node:path';
import { isCompiledBinary } from './runtime-info.ts';
import { ensureShipSshKeypair, sshKeygenAvailable } from './ssh-keys.ts';
import {
  dockerAvailable, ensureImage, imagePresent, passengerImageRef, planContainers, syncAllPassengerCheckouts, syncPassengerContainers,
} from './passenger-containers.ts';
import {
  syncPassengerTunnels, readPersistedTunnel, isPidAlive, publicUrlFor, rotatePersistedSlug,
} from './tunnel.ts';
import {
  reconcileEndpoint, unregisterEndpoint, probeEndpointAccess, REGISTER_MCP_ENDPOINTS_HINT,
  type EndpointApi, type ReconcileDeps,
} from './mcp-endpoint-registry.ts';
import { runSyncDaemonFromEnv, syncPassengerSyncDaemons } from './passenger-sync-daemon.ts';
import { openShipAttention, raiseShipAttention, clearShipAttention, hookCommand, baseAttention } from './ship-attention.ts';
import { runDaemonLoop, runOnePass, makeStaleChecker, SpawnBreaker } from './daemon.ts';

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

/** The wizard's prompts on a real terminal; questions go to stderr like every other prompt here. */
function terminalPrompter(): Prompter & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    close: () => { rl.close(); },
    say: (line) => { process.stderr.write(`${line}\n`); },
    ask: async (q, fallback) => {
      const a = (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim();
      return a || fallback || '';
    },
    confirm: async (q, fallback) => {
      const a = (await rl.question(`${q} [${fallback ? 'Y/n' : 'y/N'}] `)).trim();
      return a ? /^y/i.test(a) : fallback;
    },
  };
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

/**
 * Asks, on a real terminal, whether to install the "Issues" library template
 * when `discover()` found no project with the tables a route needs and this
 * key's own role is a workspace/platform admin (ISSUE-419). Returns the
 * newly-installed project's slug on success, so the caller can re-run
 * `discover()` with it named explicitly; `undefined` on "no" or on anything
 * that stops this from being a clean install (no matching template, or a
 * conflict `install-preview` already reports) — the caller falls back to the
 * existing "unresolved" message either way, never half-applies anything.
 */
async function offerTemplateInstall(
  authOpts: { baseUrl: string; apiKey: string; userAgent?: string },
  workspaceId: string,
): Promise<string | undefined> {
  const templates = await listLibraryTemplates(authOpts);
  const template = templates.find((t) => t.identifier === ISSUES_TEMPLATE_IDENTIFIER);
  if (!template) {
    process.stderr.write(`\n  No template with identifier "${ISSUES_TEMPLATE_IDENTIFIER}" is published to the Library yet — nothing to offer to install.\n`);
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answer: string;
  try {
    answer = (await rl.question(
      `\nNo project here has what a route needs. Install the "${template.name}" library template into a new project? [y/N] `,
    )).trim();
  } finally {
    rl.close();
  }
  if (!/^y/i.test(answer)) return undefined;

  const preview = await previewTemplateInstall(authOpts, template.id, workspaceId);
  if (preview.hasUnresolvedConflicts) {
    const names = [
      ...preview.dataModels.conflicts.map((c) => c.name),
      ...preview.fieldTypes.conflicts.map((c) => c.name),
    ];
    process.stderr.write(
      `\n  "${template.name}" collides with something already in this workspace (${names.join(', ') || 'see the app for detail'})` +
        ' — resolve that in the app before installing, or rename the conflicting table/type.\n',
    );
    return undefined;
  }
  const installed = await installTemplate(authOpts, template.id, workspaceId);
  process.stderr.write(`\n  Installed "${installed.project.name}" (${installed.project.slug}).\n`);
  return installed.project.slug;
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
  crew doctor [route] [--fix]    preflight; --fix enables clean routes and offers crew install
  crew ports [route]             which checkout owns which ports, and what is up
  crew reap [route]              kill orphaned servers, drop worktrees for closed tickets
  crew drop [route] NNN          remove a merged ticket's worktree and branch
  crew rotate-passenger-url [route]   force a Host Passengers tunnel to reconnect with a fresh public URL
  crew worktree [route] NNN      cut (or refresh) this run's worktree for a ticket from the remote; prints its path
  crew unassign [route] NNN      hand back a session's ticket — clears assignee, next cycle picks it up
  crew sync [route]              fast-forward the checkout and its worktrees from the remote
  crew pause|resume [route] [R|release]  pause everything, one role, or releases only (merge/deploy/release; passengers keeps running).
                                 resume with no argument clears only the whole-crew pause; a role or release pause needs its own resume
  crew log [route]               tail the log
  crew inbox [--member NAME]    your tickets across every workspace (or a colleague's)
  crew connect                  resolve a workspace's ids into a crew.yaml block (--no-mcp skips registering the Tablation MCP server with Claude Code; --mcp replace overwrites a different one)
  crew agents sync [route] [--force]   push crew's personas AND skill files into the workspace Agents/Agent Skills tables (--force overwrites even a diverged persona)
  crew agents prompt R [route] print one persona's current prompt (e.g. R=pair, for a SessionStart hook)
  crew skills sync [route]      push only crew's skill files (e.g. grill-me) into the workspace Agent Skills table
  crew repos add [ROUTE] [NAME] [PATH]  attach a local checkout to a route in crew.yaml (--dry-run previews)
  crew repos list ROUTE         the checkouts a route has, with the tracker's Repos row each matches
  crew logbook list [route]     recent Agent Log entries, filterable by --role/--ticket
  crew logbook show [route] ID [--prompt]   one entry; --prompt reconstructs and verifies its prompt
  crew passengers [route]       sync Host Passengers containers/tunnels once; what the passengers unit invokes
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
 * Defence-in-depth for CREW-978's incident: a QA agent ran `crew connect`
 * "as a manual sanity check" against this ship's real `~/.config/crew/
 * crew.yaml` and live `stateDir`, corrupting the `issues/issues` route's
 * resolved-ids file and taking down polling for every lane until a person
 * restored it by hand. CREW-978 fixed the two concrete write-safety bugs
 * that let that corrupt a file at all, and added a "never run a
 * state-writing crew command against the live config" warning to the
 * shared lane policy (`common.md`) — but that warning is still just
 * instructions a session can ignore or forget. This is the structural half
 * (ISSUE-980): refuse outright, before touching the config the session
 * might otherwise clobber.
 *
 * `CREW_LANE_ROLE_VAR` is already set on every headless session `agent.ts`
 * launches (`planAgentRun`'s `setEnv`) for an unrelated reason (telling the
 * operator's `pair-context-hook.sh` apart from a real lane run) — reused
 * here as "this process is a crew-launched agent session", since an
 * operator's own terminal never has it set.
 *
 * Deliberately narrow: only the commands `common.md` already warns never to
 * run against the live config (`connect`, `agents sync`, `skills sync`,
 * `install`, `uninstall`, `release`, `merge`, `deploy`) are refused. `sync`
 * is NOT here — Step 3.1 of every lane's own policy has every session run
 * `crew sync` at the start of each ticket, and that's a fetch/fast-forward
 * of git refs, not a write to `crew.yaml`/`stateDir`, so blocking it would
 * break the one legitimate `crew` call a session is actually supposed to
 * make.
 */
const STATE_WRITING_COMMANDS = new Set(['connect', 'install', 'uninstall', 'release', 'merge', 'deploy']);
const STATE_WRITING_SUBCOMMANDS: Partial<Record<string, Set<string>>> = {
  agents: new Set(['sync']),
  skills: new Set(['sync']),
};
const sessionRole = process.env[CREW_LANE_ROLE_VAR];
if (sessionRole && (
  STATE_WRITING_COMMANDS.has(command) ||
  STATE_WRITING_SUBCOMMANDS[command]?.has(positional[1] ?? '')
)) {
  const full = positional[1] && STATE_WRITING_SUBCOMMANDS[command] ? `${command} ${positional[1]}` : command;
  process.stderr.write(
    `crew: refusing to run "${full}" — this process is a crew-launched agent session ` +
      `(${CREW_LANE_ROLE_VAR}=${sessionRole}), and "${full}" writes to this ship's real ` +
      `crew.yaml/stateDir. A session must never touch the live config (CREW-978 — this took ` +
      `down polling for every lane, once). If exercising the CLI genuinely needs to run, point ` +
      `it at a throwaway config first: CREW_CONFIG=/tmp/... crew ${full} ...\n`,
  );
  process.exit(2);
}

// `passenger-sync-daemon` (ISSUE-554) is not an operator-facing command —
// it's what `syncPassengerSyncDaemons` (passenger-sync-daemon.ts) spawns
// detached, one per Host Passengers container, re-running this same binary
// with a different subcommand rather than a second entry script. It takes
// no route argument and needs no `crew.yaml` at all (everything it needs
// travels in via env vars its own spawn call set), so it deliberately
// bypasses the route-scoped config-loading/locking pipeline every other
// command below goes through — a ship with more than one route would
// otherwise hit `findRoute`'s "name one" `ConfigError` immediately, since
// this command names none.
if (command === 'passenger-sync-daemon') {
  runSyncDaemonFromEnv();
  // Deliberately falls through to nothing further: the listening HTTP
  // server keeps the event loop alive on its own, same as any other
  // long-running Node server.
} else {

/**
 * A bad config is an operator's mistake, not a crash. Print what is wrong and
 * exit — a stack trace naming this file's internals tells them nothing about
 * their YAML.
 */
let cfg: ReturnType<typeof loadConfig>;
// CREW-1286: a first-run `crew connect` (a terminal, and no crew.yaml anywhere
// crew would look) asks the `ship:` questions itself and loads that answer
// in-memory — the file is written only once the connection resolves.
let firstRun: { answers: WizardAnswers; configPath: string } | undefined;
try {
  if (command === 'connect' && !flag('dry-run') && shouldRunWizard({
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY), crewHome: CREW_HOME,
  })) {
    // Closed in a finally: an open readline on stdin keeps the event loop (and
    // so the process) alive, and later prompts open their own interface.
    const prompter = terminalPrompter();
    let answers: WizardAnswers;
    try {
      answers = await runWizard(prompter, {
        hostname: hostname(), platform: hostPlatform(), pathEnv: process.env.PATH ?? '',
        nodePath: process.execPath, dockerAvailable: dockerAvailable(),
      });
    } finally {
      prompter.close();
    }
    const configPath = firstRunConfigPath();
    firstRun = { answers, configPath };
    cfg = loadConfig(CREW_HOME, configPath, { text: renderShipBlock(answers), allowNoRoutes: true });
  } else {
    // `repos` edits a route that may be dropped for lacking a checkout, so it
    // must load even when every route is (CREW-1287).
    cfg = loadConfig(CREW_HOME, undefined, command === 'repos' ? { allowNoRoutes: true } : {});
  }
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`crew: ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}
// One-time async hydrate (ISSUE-966): fills in `route.apiKey` in memory for
// any route with no explicit `apiKey`/working `apiKeyFile`, from whatever
// the OS keychain already holds for it — `resolveApiKey`'s ~15 call sites
// below all stay synchronous and unaware this ran. See `hydrateApiKeys`'s
// own doc comment in config.ts.
await hydrateApiKeys(cfg.routes);
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
// `passengers` spans every route this ship declares the same way `poll`/
// `run` do (see `syncHostPassengers`'s own doc comment) — it must not
// demand one be named either.
const FLEET_CAPABLE = new Set(['poll', 'run', 'passengers']);
// `--fleet` is release/merge/deploy's own opt-in to the same fleet-wide path
// `poll`/`run` take automatically — release stays "a deliberate act on one
// repo" by default (README), so an operator naming no route on a multi-route
// ship still gets "name one" unless they say `--fleet` explicitly.
const releaseFleetWide = ['merge', 'deploy', 'release'].includes(command) && flag('fleet');
// `crew daemon start/stop/status/restart` (ISSUE-763/764) take their
// subcommand at positional[1] the way `crew agents prompt <role>` does,
// which shifts a route name (if given) out to positional[2] — the bare
// `crew daemon [route]` form (still the foreground loop) is unaffected,
// since its route stays at positional[1].
const DAEMON_SUBCOMMANDS = new Set(['start', 'stop', 'status', 'restart']);
const named = command === 'daemon' && DAEMON_SUBCOMMANDS.has(positional[1] ?? '')
  ? positional[2]
  : positional[1];
// `pause`/`resume` (CREW-1372) need no route: their markers live in the ship's
// own stateDir, so the word `release` or a role name sits at positional[1] and
// must never be read as a route name (QA, on a one-route ship).
const fleetWide = command === 'inbox' || command === 'connect' || command === 'agents' || command === 'skills' || command === 'logbook' || command === 'repos' || releaseFleetWide ||
  command === 'pause' || command === 'resume' ||
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
// CREW-1055: `crew agents sync --force` only — overwrites a persona's
// prompt with crew's own local default even when it looks diverged,
// for the case where a local edit really is meant to be discarded.
const force = flag('force');

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
 *
 * `passengers` (ISSUE-677) DOES get a blanket lock here — unlike `run`, it
 * has no role-distinct/capacity-limited concept to be more precise about,
 * and container/tunnel sync is cheap enough that a scheduler firing again
 * before the previous sync finished should simply skip, not queue up a
 * second concurrent `docker` sweep.
 */
const EXCLUSIVE: Record<string, string> = { passengers: 'passengers' };

// A dry run writes to the terminal ONLY.
//
// It used to append to the shared event file and log, with nothing marking it
// hypothetical — so `crew watch` showed a dry run's "released 1.2.3" among the
// real ones, and the ship's own history recorded things that never happened.
// An inspection belongs to whoever ran it, not to the record.
// `route` is undefined for fleet-wide commands on a config with no loadable
// route (`crew repos add` on a route that has no checkout yet).
const emit = new Emitter({
  route: route?.route ?? '',
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
 * The bare ticket number out of whatever an operator typed at `crew
 * drop`/`unassign` — `326`, `ISSUE-326`, or a workspace's own Issue Tag
 * form (`TABL-326`) (ISSUE-969). The number is what's globally unique and
 * how every lookup here actually works; the prefix, if any, is never
 * checked against the ticket's real one — an operator typing the wrong
 * project's tag by mistake still finds the right ticket.
 */
function parseTicketNumber(input: string): string | null {
  const m = /^(?:[A-Za-z]+-)?(\d+)$/.exec(input.trim());
  return m ? m[1]! : null;
}

/**
 * Host Passengers container + tunnel lifecycle (ISSUE-553), spanning every
 * route this ship declares — not scoped to whichever route/workspace a
 * particular `run` cycle's fleet-wide pick happens to be, since a
 * workspace's container has to stay up even on a cycle where nothing in it
 * won the pick.
 *
 * This used to run inline at the top of `case 'run'`, but `run` only fires
 * every `StartInterval` and a scheduler will not start an overlapping
 * instance while one is still executing — so a single long agent turn
 * blocked the next passenger sync check for as long as that turn took, even
 * though container/tunnel health has nothing to do with which ticket a
 * cycle happens to work (ISSUE-677, observed live: a 20+ minute agent turn
 * left a freshly-fixed container sync unable to get a second attempt at
 * all). `crew install` now writes this its own `passengers` unit on its own
 * timer, decoupled entirely from poll/select/agent execution — see
 * `install.ts`'s `InstallJob`.
 *
 * `--dry-run`'s whole point is "perform nothing", so this is a no-op under
 * it — same guard `beatShip`'s call site further down uses.
 */
async function syncHostPassengers(): Promise<void> {
  if (dryRun) return;
  const passengerRoutes = cfg.routes.filter((r) => r.enabled && r.hostPassengers);
  if (passengerRoutes.length === 0) return;
  if (!dockerAvailable()) {
    // Under the timer there is no interactive PATH, so look in Docker's usual
    // directories to tell "docker is not on our PATH" from "the daemon is down".
    const pathProblem = dockerPathProblem(cfg.ship, COMMON_DOCKER_DIRS);
    emit.warn(
      `Host Passengers is on for at least one route but ${pathProblem ?? 'Docker is not available'} — skipping container sync this cycle`,
      { step: 'passengers' },
    );
    return;
  }
  try {
    // Dedicated checkouts (ISSUE-554, decision 7 in the Map) must be
    // cloned and fast-forwarded to `branch.base` BEFORE the container
    // sync below can mount them — decision 8's poll-cadence half of
    // freshness. A checkout that won't fast-forward (diverged
    // upstream) is reported, not force-reset past.
    for (const r of syncAllPassengerCheckouts(cfg)) {
      if (r.outcome.action === 'diverged' || r.outcome.action === 'ff-failed') {
        emit.warn(
          `passenger checkout for ${r.name} is stale: ${r.outcome.detail}`,
          { step: 'passengers', data: { workspaceId: r.workspaceId, repo: r.name } },
        );
      }
    }
    const tablationApiBaseUrl = passengerRoutes[0]!.baseUrl || DEFAULT_BASE_URL;
    // Sync-daemon listeners (ISSUE-554, decision 8's `initialize`-
    // triggered half) MUST be resolved before `syncPassengerContainers`
    // below — a container's env (including its callback secret) is
    // fixed at `docker run` time, so the daemon it's told to call has
    // to already exist, with a matching secret, by the time that runs.
    let syncEndpoints;
    try {
      syncEndpoints = syncPassengerSyncDaemons(planContainers(cfg), cfg, cfg.ship.stateDir);
    } catch (e) {
      emit.warn(`passenger sync-daemon lifecycle failed: ${(e as Error).message}`, { step: 'passengers' });
      syncEndpoints = new Map();
    }
    const result = syncPassengerContainers(cfg, tablationApiBaseUrl, undefined, syncEndpoints);
    if (result.started.length || result.recreated.length || result.stopped.length) {
      emit.emit(
        `passenger containers: ${result.started.length} started, ${result.recreated.length} recreated, ` +
          `${result.stopped.length} stopped`,
        { step: 'passengers', data: { ...result } },
      );
    }
    // The tunnel needs this ship's own keypair, minted by `crew
    // connect` (or here, best-effort, if it's somehow still
    // missing) — and a relay to dial, which `ship.relayHost` may
    // legitimately be unset for (containers still run locally with
    // no tunnel; `crew doctor` says so). Neither missing piece
    // should stop the container sync above, which already ran.
    if (cfg.ship.relayHost) {
      try {
        const { privateKeyPath } = ensureShipSshKeypair(cfg.ship.stateDir);
        const plans = planContainers(cfg);
        // ISSUE-685: same secret already threaded into the container itself
        // (above, via `syncEndpoints` -> `startContainer`'s PASSENGER_MCP_SECRET).
        const mcpSecrets = new Map([...syncEndpoints].map(([workspaceId, e]) => [workspaceId, e.secret]));
        const relayHost = cfg.ship.relayHost;
        const reconcile = endpointReconcileDeps(passengerRoutes, relayHost);
        const pending: Array<Promise<void>> = [];
        syncPassengerTunnels(plans, relayHost, cfg.ship.relayPort, privateKeyPath, cfg.ship.stateDir, mcpSecrets, {
          apiKeys: passengerApiKeys(passengerRoutes),
          onStatus: (workspaceId, status, info) => {
            const owningRoute = passengerRoutes.find((r) => r.resolved?.workspaceId === workspaceId);
            if (!owningRoute) return;
            pending.push(
              new Tracker(owningRoute, cfg.ship).updateTunnelState(cfg.ship.name, { tunnel_status: status })
                .catch((e) => { emit.warn(`could not write tunnel_status: ${(e as Error).message}`, { step: 'passengers' }); }),
            );
            if (status === 'disconnected') pending.push(unregisterEndpoint(workspaceId, info, reconcile));
          },
        });
        // Every cycle, not just on the connected transition: a 403 or a
        // network error registering the endpoint is retried next cycle
        // without ever touching the tunnel.
        for (const plan of plans) pending.push(reconcileEndpoint(plan.workspaceId, reconcile));
        await Promise.all(pending);
      } catch (e) {
        emit.warn(`passenger tunnel sync failed: ${(e as Error).message}`, { step: 'passengers' });
      }
    }
  } catch (e) {
    emit.warn(`passenger container sync failed: ${(e as Error).message}`, { step: 'passengers' });
  }
}

/** workspaceId -> the owning route's own API key, for the relay's `/auth/me` entitlement check (CREW-1320). */
function passengerApiKeys(routes: Route[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const r of routes) {
    const ws = r.resolved?.workspaceId;
    if (!ws) continue;
    try { keys.set(ws, resolveApiKey(r)); } catch { /* no key: the tunnel step reports this workspace disconnected */ }
  }
  return keys;
}

function endpointApiFor(routes: Route[]): (workspaceId: string) => EndpointApi | undefined {
  return (workspaceId) => {
    const r = routes.find((x) => x.resolved?.workspaceId === workspaceId);
    if (!r) return undefined;
    try {
      return { baseUrl: r.baseUrl || DEFAULT_BASE_URL, apiKey: resolveApiKey(r), userAgent: cfg.ship.userAgent };
    } catch {
      return undefined;
    }
  };
}

function endpointReconcileDeps(routes: Route[], relayHost: string): ReconcileDeps {
  return {
    stateDir: cfg.ship.stateDir,
    shipName: cfg.ship.name,
    apiFor: endpointApiFor(routes),
    urlFor: (slug) => publicUrlFor(slug, relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain),
    warn: (m) => emit.warn(m, { step: 'passengers' }),
  };
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
async function releaseFleet(
  opts: { mergeOnly?: boolean; force?: boolean; isDeployCommand?: boolean } = {},
): Promise<void> {
  if (releaseRefused()) return;
  const summaries: RoutedReleaseSummary[] = [];
  // Touched at both ends so a long deploy does not read as a stopped timer
  // (`release_stale`, CREW-1373).
  if (!dryRun) state.releaseHeartbeat().touch();
  for (const c of cfg.routes) {
    if (!dryRun && !c.enabled) continue;
    // No route-wide platform gate: releasePhase checks each repo's own
    // requirement, and a route can span repos with different needs.
    for (const r of reposOf(c)) summaries.push({ ...(await releasePhase(c, r, opts)), route: c.route });
  }
  emitReleaseSummary(emit, summaries);
  if (!dryRun) state.releaseHeartbeat().touch();
}

/**
 * ISSUE-1372: a paused ship must not merge, deploy or file release alerts,
 * and `crew pause` only ever stopped `run`/`poll`. The release timer runs
 * `crew release --fleet` on its own schedule, so it reaches here too. Logs one
 * line and returns true when the release must not run.
 */
function releaseRefused(): boolean {
  const why = state.releaseSkipReason();
  if (!why) return false;
  emit.emit(`${why} — release skipped`, { step: 'release' });
  return true;
}

/**
 * Release every repository of the route in play.
 *
 * `crew run` on a single route still has to cover all of its
 * repositories: a verified branch in the second one is no less ready than a
 * verified branch in the first.
 */
async function releaseTargets(
  opts: { mergeOnly?: boolean; force?: boolean; isDeployCommand?: boolean } = {},
): Promise<void> {
  if (releaseRefused()) return;
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
  const summaries: RoutedReleaseSummary[] = [];
  if (!dryRun) state.releaseHeartbeat().touch();
  for (const t of chosen) summaries.push({ ...(await releasePhase(route, t, opts)), route: route.route });
  emitReleaseSummary(emit, summaries);
  if (!dryRun) state.releaseHeartbeat().touch();

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
 * Write and load the scheduler units. Shared by `crew install` and
 * `crew doctor --fix` (CREW-1288), which offers it once a route is enabled.
 */
async function installScheduler(opts: { replace?: boolean } = {}): Promise<boolean> {
  const host = hostPlatform();
  if (host === 'windows') {
    process.stderr.write('crew install: no scheduler support yet for Windows (Task Scheduler is planned, not built)\n');
    process.exit(2);
  }
  // launchd units from a different checkout hash (CREW-1376): a stale one
  // whose program is gone is removed, a live other install is refused before
  // anything of this checkout is written, unless --replace.
  if (host === 'macos') {
    const ok = clearForeignLaunchdUnits(CREW_HOME, !!opts.replace, dryRun, {
      emit: (m) => process.stdout.write(`${m}\n`),
      warn: (m) => process.stderr.write(`crew install: ${m}\n`),
    }, undefined, loadedCrewLabels());
    if (!ok) return false;
  }
  // Three units, not one: `run` (poll/select/one agent session), `release`
  // (test/build/deploy) and `passengers` (Host Passengers container/tunnel
  // sync) now run on independent lifecycles, so a slow release or a long
  // agent turn no longer holds the others hostage — see the release-lane
  // comment on `case 'run'` and `syncHostPassengers`'s own doc comment
  // (ISSUE-677). `release`/`passengers` stay one-shot-per-fire on their own
  // fixed timers; `run` (ISSUE-763) is now the persistent `crew daemon`
  // loop on launchd/systemd — see `install.ts`'s `subcommandFor`.
  // Host Passengers' image is pulled here, not left to the passengers timer's
  // first fire (CREW-1369): a missing image or a bad Docker Hub namespace
  // should show up in the install output. A failure is reported and sets a
  // non-zero exit, but the units still install so the ship is not left
  // half-configured.
  const installPathProblem = cfg.routes.some((r) => r.enabled && r.hostPassengers) ? dockerPathProblem(cfg.ship) : undefined;
  if (installPathProblem) {
    // The pull below would succeed in this shell and leave the passengers
    // timer a silent no-op (CREW-1375), so fail the way the timer will.
    process.stderr.write(`crew install: Host Passengers is on but ${installPathProblem}\n`);
    process.exitCode = 1;
  } else if (!dryRun && cfg.routes.some((r) => r.enabled && r.hostPassengers) && dockerAvailable()) {
    const image = passengerImageRef(cfg);
    if (imagePresent(image)) {
      process.stdout.write(`Host Passengers image ${image} is already present\n`);
    } else {
      process.stdout.write(`pulling Host Passengers image ${image}\n`);
      try {
        ensureImage(image);
      } catch (e) {
        process.stderr.write(`crew install: could not pull Host Passengers image ${image}: ${(e as Error).message}\n`);
        process.exitCode = 1;
      }
    }
  }
  const hasSystemd = detectSystemd();
  for (const job of ['run', 'release', 'passengers'] as const) {
    const plan = planInstall(cfg.ship, CREW_HOME, host, hasSystemd, job);
    process.stdout.write(`installing ${job} via ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}\n`);
    await applyInstall(plan, CREW_HOME, dryRun, {
      emit: (m) => process.stdout.write(`${m}\n`),
      warn: (m) => process.stderr.write(`crew install: ${m}\n`),
    });
  }
  // Hard cutover (ISSUE-763), systemd only: a host that had `run` on the
  // old service+timer pair now has an orphaned `<label>.timer` once install
  // starts writing only a persistent `.service` for it — same label, same
  // checkout, no coexistence flag. launchd needs no equivalent step: the
  // `run` job's plist keeps the same path/label whether it's periodic or
  // persistent, so a reinstall simply overwrites it in place.
  if (host === 'linux' && hasSystemd) {
    const label = labelFor(CREW_HOME, 'run');
    const staleTimer = join(homedir(), '.config', 'systemd', 'user', `${label}.timer`);
    if (existsSync(staleTimer)) {
      process.stdout.write(
        `removing stale run timer from before the persistent-service cutover: ${staleTimer}${dryRun ? ' (dry run)' : ''}\n`,
      );
      if (!dryRun) {
        spawnSync('systemctl', ['--user', 'disable', '--now', `${label}.timer`], { cwd: CREW_HOME });
        try { unlinkSync(staleTimer); } catch { /* already gone */ }
      }
    }
  }
  return true;
}

/**
 * Every check `crew doctor` prints for one route, as lines, for `--fix` to
 * decide whether the route is clean. Mirrors the `doctor` report above; a
 * check that cannot even run (a tracker call that throws) counts as failed.
 */
async function routeProblems(c: Route): Promise<string[]> {
  const host = hostPlatform();
  const problems: string[] = [];
  // Host Passengers preflight, as `doctor` prints it: a route that needs Docker
  // or ssh-keygen must not be enabled while they are missing.
  if (c.hostPassengers) {
    if (!dockerAvailable()) problems.push('host passengers: docker is not available');
    if (!sshKeygenAvailable()) problems.push('host passengers: ssh-keygen is not available');
  }
  const tracker = new Tracker(c, cfg.ship);
  problems.push(...validateContract(tracker.contract).map((p) => `contract: ${p}`));
  for (const r of await resolvedRepos(c)) {
    if (!existsSync(r.dir)) problems.push(`repo ${r.name}: ${r.dir} is missing on disk`);
    if (!satisfies(host, r.config.platform)) problems.push(`repo ${r.name}: requires ${r.config.platform}, this host is ${host}`);
    problems.push(...validateEffective(r.config).map((p) => `repo ${r.name}: ${p}`));
  }
  try {
    const ships = await tracker.shipRows();
    // No Ships table is fine; a table with no (or an ambiguous) row for this ship is not.
    if (ships.length > 0) {
      const mine = ships.filter((s2) => (s2.name ?? '').trim() === cfg.ship.name.trim());
      if (mine.length !== 1) problems.push(`ship record: ${mine.length} rows named "${cfg.ship.name}"`);
      else if (mine[0]!.platform && mine[0]!.platform !== host) problems.push(`ship record: declares ${mine[0]!.platform}, this host is ${host}`);
    }
  } catch (e) {
    problems.push(`tracker unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}

/**
 * `crew doctor --fix` / the end-of-run offer (CREW-1288). Plans from doctor's
 * own checks (`planFix`), asks one yes/no per action when `prompt` is set,
 * writes only the `enabled` key for an accepted route, and prints everything it
 * changed so no edit is silent.
 */
async function doctorFix(o: { prompt: boolean; host: ReturnType<typeof hostPlatform> }): Promise<void> {
  const routes = await Promise.all(routesInScope(cfg.routes, named).map((c) =>
    gatherHealth({ route: c.route, enabled: c.enabled, hasRepos: reposOf(c).length > 0 }, () => routeProblems(c))));
  const unitExists = (p: string) => existsSync(p);
  const crontab = o.host === 'linux' ? (spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout ?? '') : '';
  const schedulerAbsent = o.host !== 'windows'
    ? !schedulerInstalled(planInstall(cfg.ship, CREW_HOME, o.host, detectSystemd(), 'run'), unitExists, crontab)
    : true;
  const plan = planFix({ routes, schedulerAbsent, host: o.host });
  for (const n of plan.notes) process.stdout.write(`fix: ${n}\n`);
  if (plan.actions.length === 0) {
    process.stdout.write('fix: nothing to change\n');
    return;
  }
  const prompter = o.prompt ? terminalPrompter() : undefined;
  const changed: string[] = [];
  const enabledSound = new Set(routes.filter((r) => r.enabled && r.hasRepos && r.problems.length === 0).map((r) => r.route));
  try {
    for (const a of plan.actions) {
      if (a.kind === 'enable') {
        if (prompter && !(await prompter.confirm(`Route ${a.route} passes every check — set enabled: true in ${cfg.configFile}?`, false))) continue;
        writeFileSync(cfg.configFile, planEnable(readFileSync(cfg.configFile, 'utf8'), a.route));
        enabledSound.add(a.route);
        changed.push(`enabled route ${a.route} in ${cfg.configFile}`);
      } else {
        // Offered only once something is enabled: installing a scheduler for a
        // ship whose every route is still off would just poll nothing.
        if (enabledSound.size === 0) continue;
        if (prompter && !(await prompter.confirm('No scheduler is installed for this ship — run `crew install` now?', false))) continue;
        if (await installScheduler()) changed.push('ran `crew install` (scheduler units written and loaded)');
      }
    }
  } finally {
    prompter?.close();
  }
  process.stdout.write(changed.length ? `fix: changed\n${changed.map((c) => `  - ${c}\n`).join('')}` : 'fix: nothing changed\n');
}

/**
 * Read-only base-branch health for one repo (CREW-1379): fetches but never
 * fast-forwards. `unsafe` is the stop condition for cutting a worktree.
 */
function baseHealth(r: { dir: string; config: { branch: { remote: string; base: string } } }) {
  const { remote, base } = r.config.branch;
  const out = refreshBaseBranch(r.dir, remote, base, true);
  const unsafe = baseBranchUnsafe(out);
  return { action: out.action, unsafe, detail: unsafe ? describeUnsafeBase(out, remote, base) : out.detail };
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
  const tracker = new Tracker(c, cfg.ship);
  const contract = tracker.contract;
  // Every repository the route serves, not just the first. Which one
  // THIS ticket's work happens in is unknowable here — the brief describes
  // them all (ISSUE-350). `ticket`, when the caller already resolved one
  // before building the environment, is only used for filing guidance
  // (ISSUE-411) — it names the ticket a spotted-bug report should reference,
  // never which repo section applies.
  return renderEnvironment({
    route: c, userAgent: cfg.ship.userAgent, repos: await resolvedRepos(c), contract, sourceTicket: ticket,
    authorship: await tracker.authorshipProbe().catch(() => null),
    shipName: cfg.ship.name,
  });
}

/**
 * `crew status`'s per-repo release line (CREW-1384): which ship releases the
 * repo and whether its board lock row exists and who holds it.
 */
async function releaserLine(
  tracker: Tracker, routeName: string, repo: string, release: Parameters<typeof releaserFor>[0],
): Promise<string> {
  const who = release.ship ? `released by ${release.ship}` : 'any ship may release';
  let lock: string;
  try {
    const st = await tracker.lockState(releaseLockScope(routeName, repo));
    lock = st === undefined ? 'no Locks table'
      : !st.exists ? 'lock row MISSING (run crew connect)'
      : st.holder ? `lock held by ${st.holder}` : 'lock row free';
  } catch (e) {
    lock = `lock unreadable (${(e as Error).message})`;
  }
  return `${who}; ${lock}`;
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
  c: typeof route, target: RepoTarget,
  opts: { mergeOnly?: boolean; force?: boolean; isDeployCommand?: boolean } = {},
): Promise<RepoReleaseSummary> {
  const scope = releaseLockScope(c.route, target.name);
  // Route-scoped: a fleet-wide release runs this once per (route, repo), but
  // the top-level `emit` is stamped with just routes[0] for the whole run
  // (see the `fleetWide` Emitter construction above) — every event this
  // phase reports needs ITS OWN route, not whichever one happened to be
  // first (CREW-979).
  const remit = emit.forRoute(c.route);
  // Per REPOSITORY, not per route. A board's area spans several repos and
  // each releases on its own: they have separate versions, separate tags and
  // separate deploy targets, and a long release of one must not hold up
  // another. Scoping this to the route meant only `route.dir` was ever
  // released — every other repo on the board was silently never shipped.
  const relLock = dryRun ? undefined : state.acquire(`release-${scope}`);
  if (relLock && !relLock.ok) {
    remit.emit(`a previous release (pid ${relLock.heldBy}) is still running — skipping`, { step: 'release' });
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
    for (const p of problems) remit.warn(`${scope}: ${p}`);

    // What a host must be to build THIS repo is that repo's own fact
    // (`.crew.yaml`), not the route's — a route can span repos with
    // different needs. Skip only this one; the rest of the route's
    // repos may still be releasable here.
    if (!satisfies(cfg.ship.platform, repo.platform)) {
      const detail = explain(cfg.ship.platform, repo.platform);
      remit.emit(`${scope}: skipping — ${detail}`, { step: 'release' });
      return { scope, tests: 'skipped', outcome: 'skipped', detail };
    }

    // A repo that names its releaser (`release.ship`) is released by that ship
    // alone; every other ship reports where it runs and does nothing (CREW-1384).
    // Checked before the board lock so a non-releaser never touches it.
    const who = releaserFor(repo.release, cfg.ship.name);
    if (!who.releases) {
      const note = nonReleaserNote(target.name, who.releaser as string);
      remit.emit(note, { step: 'release' });
      return { scope, tests: 'skipped', outcome: 'skipped', detail: note };
    }

    if (!dryRun && !c.enabled) return { scope, tests: 'skipped', outcome: 'skipped', detail: 'route not enabled' };
    const tracker = new Tracker(c, cfg.ship);

    if (!dryRun) {
      const holderLabel = `${cfg.ship.name}:${process.pid}`;
      const got = await tracker.acquireBoardLock(scope, holderLabel, RELEASE_LOCK_TTL_MS);
      if (!got.ok && got.reason === 'missing') {
        const detail = `no Locks row for ${scope} — run \`crew connect ${c.route}\` to provision it`;
        remit.warn(`release for ${scope} refused: ${detail}`, { step: 'release' });
        return { scope, tests: 'skipped', outcome: 'skipped', detail };
      }
      if (!got.ok) {
        const why = got.reason === 'held' ? `held by ${got.heldBy ?? 'another ship'}` : 'claimed by another ship mid-check';
        remit.emit(`release for ${scope} is ${why} on the board — skipping`, { step: 'release' });
        return { scope, tests: 'skipped', outcome: 'skipped', detail: `release ${why} on the board` };
      }
      boardLock = got;
      remit.emit(
        got.exclusion === 'taken'
          ? `took board lock ${scope}`
          : `this board has no Locks table — cross-ship exclusion for ${scope} is OFF`,
        { step: 'release' },
      );
    }

    const all = await tracker.openTickets();

    // Only this repository's tickets. Handing the whole board's tickets to a
    // release would look for their branches in the wrong checkout — and on a
    // near-miss (a branch of the same name in two repos) merge the wrong work.
    const { byRepo, unplaceable } = ticketsByRepo(c, all);
    const tickets = byRepo.get(target.name) ?? [];
    reportUnplaceable(c, unplaceable, tracker.contract.statuses.verified, remit);

    const outcome = await runRelease({
      cwd: target.dir, repo, contract: tracker.contract, tickets, emit: remit, scope,
      state: state.release(scope),
      reviewColumns: repo.release.mode === 'external' ? await tracker.reviewColumns() : undefined,
      dryRun, skipTests: flag('skip-tests'), shell: cfg.ship.shell,
      mergeOnly: command === 'merge',
      // `deploy` is the "go now" button: it exists for a commit a previous
      // deploy failed on, where nothing new will merge but the work is
      // genuinely unreleased.
      force: command === 'deploy' || flag('force'),
      isDeployCommand: opts.isDeployCommand,
      attention: {
        raise: (item) => raiseShipAttention({ state, emit: remit, route: c, ship: cfg.ship }, item),
        clear: (key) => clearShipAttention(state, key),
      },
    });
    const summary = summarizeOutcome(outcome, scope, !!repo.hooks.test && !flag('skip-tests'));

    // Stamping is deliberately last and deliberately non-fatal: the work is
    // already live, and a tracker blip must not turn a good release into a
    // failed one. Untouched tickets are still `verified` and still named in
    // the released range, so the next cycle picks them up.
    if (outcome.deployed || outcome.confirmed || outcome.alreadyLive || outcome.integrated) {
      remit.enter('reconcile');
      const plan = planStamp(
        target.dir, tickets, tracker.contract,
        outcome.stampFrom ?? outcome.decision.lastReleased, outcome.decision.head,
        new Map(outcome.merged.map((m) => [m.ticket.issue_id, m.sha])),
      );
      if (plan.length) await applyStamp(tracker, plan, outcome.version, tracker.contract, remit, dryRun, target.dir);
    } else if (outcome.stopped) {
      remit.emit(`nothing stamped — ${outcome.stopped}`);
    }

    // A verified ticket with no branch whose commit is already inside a
    // release tag: it shipped, the board just never heard (it was bounced off
    // `verified` across a release cut, or the stamp never ran). `planStamp`
    // only reads the latest release's range, so it can never close these —
    // stamp them against the tag that actually carries the commit (CREW-1368).
    // Non-fatal, like the stamp above.
    for (const m of outcome.decision.merges) {
      if (m.skipReason !== 'already-released' || !m.mergedSha) continue;
      const tag = firstReleaseTagContaining(target.dir, m.mergedSha, repo.release.tagPattern ?? 'v*');
      if (!tag) continue;
      remit.enter('reconcile');
      await applyStamp(
        tracker, [{ ticket: m.ticket, reason: `carried by ${tag}`, sha: m.mergedSha }],
        tag.replace(/^v/, ''), tracker.contract, remit, dryRun, target.dir,
      );
    }

    // The test gate has been red on this head for several cycles running:
    // say so on each ticket it is holding back, once (gate-red.ts).
    if (outcome.gateRed && !dryRun) {
      try {
        const g = outcome.gateRed;
        const comments = await tracker.comments();
        const seat = releaseSeat(c);
        for (const t of gateRedTickets(outcome.merged, outcome.decision.merges)) {
          if (alreadyReported(t, g, comments)) continue;
          await tracker.postEvent(t.id, gateRedComment(g), seat);
          remit.warn(`test gate red for ${g.count} cycles — noted on the ticket`, { ticket: t.issue_id, step: 'merge' });
        }
        state.release(scope).noteTestGateReported(g.sha);
      } catch (e) {
        remit.warn(`could not note the red test gate on the board: ${(e as Error).message}`, { step: 'merge' });
      }
    }

    // `release.mode: external`: the crew ships nothing itself, but a ticket
    // whose branch has landed on the other side of the hand-off still gets
    // its `commit_sha`/`merged_at` written, same as the block above does for
    // tickets this release actually stamped `deployed` itself — and, once a
    // repo-defined `hooks.released` confirms the landing actually shipped,
    // the ticket closes out to `deployed` too (ISSUE-811).
    if (outcome.externalClosures?.length) {
      await applyExternalClosures(tracker, outcome.externalClosures, tracker.contract, remit, dryRun, target.dir);
    }

    // `release.mode: external` with a `reviewing` status: the branches this
    // cycle pushed for review move to it, and any whose branch moved past
    // what QA verified go back to QA (review.ts).
    if (outcome.review) {
      await applyReview(
        tracker, tracker.contract, outcome.review, repo.branch.remote, remit, releaseSeat(c),
        await tracker.reviewColumns(), dryRun,
      );
    }

    // Last, and non-fatal: whatever happened has happened, and telling someone
    // about it must not be able to change the outcome.
    const news = describeRelease(outcome, scope);
    if (news) {
      const notified = await notify(c, cfg.ship, news, remit, dryRun);
      // No `hooks.notify` configured on this route — the common case, since
      // the key has existed since the Node port and nobody has wired it
      // (notify.ts's own header). A failure must not go silent just because
      // nobody has hooked up a notifier: fall back to filing/updating a
      // tracker ticket directly, the same way synthesis's bash dev-loop.sh
      // has always done for a deploy failure.
      if (!notified && news.level === 'fail') {
        const memberId = releaseSeat(c);
        await applyFailureAlert(tracker, news, scope, all, memberId, remit, dryRun).catch((e) => {
          remit.warn(`could not file/update a failure ticket: ${(e as Error).message}`, { step: 'release' });
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
      const seat = releaseSeat(c);

      for (const f of outcome.conflicts ?? []) {
        try {
          const bounce = planConflictBounce(
            target.dir, f.candidate.ticket, f.candidate.branch!, repo.branch.base, f.paths, comments,
          );
          const r = await applyConflictBounce(tracker, bounce, tracker.contract, seat, remit, dryRun);
          if (r.kind === 'failed') {
            remit.warn(`could not hand back ${f.candidate.ticket.issue_id}: ${r.why}`, { step: 'merge' });
          }
        } catch (e) {
          remit.warn(
            `could not hand back ${f.candidate.ticket.issue_id}: ${(e as Error).message}`,
            { step: 'merge' },
          );
        }
      }

      for (const cand of outcome.unbuildable ?? []) {
        try {
          const stranded = planStrandedVerified(cand, repo.branch.base, repo.branch.remote, comments);
          const r = await applyStrandedVerified(
            tracker, stranded, tracker.contract, c.resolved?.operator, seat, remit, dryRun,
          );
          if (r.kind === 'failed') {
            remit.warn(`could not flag ${cand.ticket.issue_id}: ${r.why}`, { step: 'merge' });
          }
        } catch (e) {
          remit.warn(`could not flag ${cand.ticket.issue_id}: ${(e as Error).message}`, { step: 'merge' });
        }
      }
    }

    // Also non-fatal, and last of all: a ticket that reached a terminal
    // status (here or on an earlier cycle) is done with its worktree. A
    // tracker blip here must not turn a good release into a failed one, the
    // same reasoning as stamping above (ISSUE-346).
    try {
      const terminal = await tracker.terminalTickets();
      const verifiedNow = (await tracker.openTickets()).filter((t) => t.status === tracker.contract.statuses.verified);
      const scoped = ticketsByRepo(c, terminal).byRepo.get(target.name) ?? [];
      const actions = planWorktreeSweep(target, [...scoped, ...(ticketsByRepo(c, verifiedNow).byRepo.get(target.name) ?? [])], tracker.contract);
      if (actions.length) {
        remit.enter('worktree');
        const r = await applyWorktreeSweep(target.dir, actions, dryRun, remit, repo.branch.remote);
        remit.emit(`swept ${r.removed} worktree(s), kept ${r.keptBranches} branch(es)`, { step: 'worktree' });
      }
      // CREW-1364: the pushed copy of a branch this ship may never have had a
      // worktree for. After the stamp, so a ticket is `deployed` by now.
      const stale = planRemoteBranchCleanup(target.dir, repo.branch.remote, repo.branch.base, scoped, tracker.contract);
      if (stale.length) applyRemoteBranchCleanup(target.dir, repo.branch.remote, stale, dryRun, remit);
    } catch (e) {
      remit.warn(`worktree sweep failed: ${(e as Error).message}`, { step: 'worktree' });
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
    remit.warn(`release phase failed: ${(e as Error).message}`, { step: 'release' });
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
        enabledOnly: !dryRun, dryRun,
      });

      // The single-route path below applies its sweep before doing
      // anything else; the fleet-wide path must too, and for EVERY
      // reachable route, not just the winner — otherwise a route that
      // never wins (lower weight, or consistently out-ranked) never
      // parks or restores a blocked ticket at all, silently, forever.
      // CREW-1255: the same reasoning holds for the epic sync, so it is
      // applied per route too. Two routes of one workspace plan the same
      // correction; the conditional write lets the second one lose quietly.
      for (const e of fleet.entries) {
        if (e.error || !e.decision || !e.decision.epicSync.length) continue;
        const remit = emit.forRoute(e.route.route);
        if (dryRun) {
          for (const s of e.decision.epicSync) remit.emit(`would move ${describeEpicStep(s)}`, { step: 'sweep' });
          continue;
        }
        const tracker = new Tracker(e.route, cfg.ship);
        await applyEpicSync(tracker, e.decision.epicSync, tracker.contract, remit);
      }

      // CREW-1386: a ship hold ends when the ticket leaves the building roles.
      for (const e of fleet.entries) {
        if (dryRun || e.error || !e.decision?.holdReleases?.length) continue;
        const tracker = new Tracker(e.route, cfg.ship);
        await applyHoldReleases(tracker, e.decision.holdReleases, tracker.contract, emit.forRoute(e.route.route));
      }

      for (const e of fleet.entries) {
        if (e.error || !e.decision || !e.decision.sweep.length) continue;
        // Route-scoped (CREW-979): this loop covers every reachable route,
        // not just the winner, so the top-level `emit` (stamped routes[0]
        // for the whole fleet-wide run) would mislabel every route but the
        // first.
        const remit = emit.forRoute(e.route.route);
        if (dryRun) {
          for (const s of e.decision.sweep) {
            remit.emit(`would ${s.action} -> ${s.to} (blockers: ${s.blockers})`, {
              ticket: s.ticket.issue_id, step: 'sweep',
            });
          }
          continue;
        }
        const seat = e.route.resolved?.seats.qa ?? e.route.resolved?.seats.dev;
        try {
          const r = await applySweep(new Tracker(e.route, cfg.ship), e.decision.sweep, seat ?? '', remit);
          remit.emit(
            `swept ${r.parked} parked, ${r.restored} restored` +
              `${r.failed ? `, ${r.failed} failed` : ''}${r.contended ? `, ${r.contended} contended` : ''} (${e.route.route})`,
            { step: 'sweep', data: r },
          );
        } catch (err) {
          remit.warn(`could not sweep ${e.route.route}: ${(err as Error).message}`, { step: 'sweep' });
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
            emit.forRoute(c.route).warn(`could not beat ship for ${c.route}: ${(e as Error).message}`, { step: 'poll' });
          }
        }));
      }

      if (!fleet.winner) {
        emit.emit('nothing to run across the fleet');
        if (!skipInlineRelease) await releaseFleet();
        break;
      }

      const w = fleet.winner;
      // Route-scoped (CREW-994): everything from here to the end of the fleet
      // branch is about the WINNING route, not whichever route the top-level
      // `emit` was stamped with (routes[0]) — same rule as releasePhase.
      const wemit = emit.forRoute(w.route.route);
      if (!(await anyRepoServable(w.route))) {
        wemit.error(
          `refusing ${w.route.route} — this ship is ${cfg.ship.platform}, but ` +
            `${await explainUnservable(w.route)}`,
        );
        break;
      }
      if (!dryRun && !w.route.enabled) {
        wemit.emit(`route "${w.route.route}" is not enabled — not running`);
        break;
      }
      if (dryRun) {
        const fleetPlan = planAgentRun({
          role: w.role, route: w.route, ship: cfg.ship,
          stateDir: cfg.ship.stateDir, roster: rosterFor(w.decision, w.route, w.role),
          environment: await environmentFor(w.route, w.decision.actionable.top?.issue_id),
          apiKey: resolveApiKey(w.route),
          cycle: wemit.cycle, ticket: w.decision.actionable.top?.issue_id,
          divergedPrompt: await fetchDivergedPrompt(w.route, w.role, { userAgent: cfg.ship.userAgent }),
          agentModel: await fetchSeatAgentModel(w.route, w.role, { userAgent: cfg.ship.userAgent }),
          resolvedAgentId: await resolveAgentId(w.route, w.role, { userAgent: cfg.ship.userAgent }),
        });
        process.stdout.write(`${describePlan(fleetPlan)}\n`);
        break;
      }

      // Role-distinct, capacity-limited (ISSUE-381) — see State.acquireRun.
      // Taken here, once the winning role is known, not up front: the fleet
      // poll above is read-only and must run every cycle regardless.
      const fleetLock = state.acquireRun(w.role, cfg.ship.maxConcurrentAgents);
      if (!fleetLock.ok) {
        wemit.emit(`${w.role} skipped this cycle — ${fleetLock.reason}`);
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
      if (w.role === 'dev' || w.role === 'design' || w.role === 'qa') {
        const seat = w.route.resolved?.seats[w.role];
        if (seat) {
          const candidates = rankedCandidates(w.role, w.decision.selectionInput);
          const contract = w.decision.selectionInput.contract ?? DEFAULT_CONTRACT;
          const result = await resolveTopCandidate(
            fleetTracker, candidates, seat,
            claimStatuses(w.role, contract).approved,
            claimStatuses(w.role, contract).building,
            (t) => dirForRepo(w.route, t.repo_id) !== null,
            withHoldCheck(await fleetTracker.claimAffinity(), w.decision.selectionInput),
          );
          if (result.contended.length) {
            wemit.emit(`claim contended for ${result.contended.join(', ')} — moved to the next candidate`, {
              step: 'select', role: w.role,
            });
          }
          if (result.unservable.length) {
            wemit.emit(
              `skipped ${result.unservable.join(', ')} — no local checkout for their repo`,
              { step: 'select', role: w.role },
            );
          }
          if (result.held.length) {
            wemit.emit(`skipped ${result.held.join(', ')} — held by another live ship`, { step: 'select', role: w.role });
          }
          await noteReaccepted(fleetTracker, result, seat, cfg.ship.name);
          await noteTakeover(
            fleetTracker, result, seat, w.decision.selectionInput.ships?.rows ?? [], cfg.ship.name,
            (t) => { const d = dirForRepo(w.route, t.repo_id); return d ? originBranchSha(d, t, gitResolve) : null; },
          );
          if (!result.ticket) {
            wemit.emit(`${w.role} skipped this cycle — every candidate was already claimed elsewhere`);
            if (!skipInlineRelease) await releaseFleet();
            break;
          }
          if (result.claimed) {
            const idx = w.decision.tickets.findIndex((t) => t.id === result.ticket!.id);
            if (idx >= 0) w.decision.tickets[idx] = result.ticket;
            writeDigest({ route: w.route, ship: cfg.ship, state, emit: wemit }, w.decision, w.role, cfg.ship.stateDir);
          }
          fleetTicketHint = result.ticket.issue_id;
          fleetWorkingId = result.ticket.id;

          // Lazy: only the repo THIS ticket actually names, only now that
          // it's the one about to be worked — not every repo `reposOf`
          // could derive a path for. See `ensureRepoCheckout`'s own doc.
          const target = repoTargetFor(w.route, result.ticket.repo_id);
          try {
            if (target && ensureRepoCheckout(target.dir, target.remote)) {
              wemit.emit(`cloned ${target.name} into ${target.dir}`, { step: 'select', role: w.role });
            }
          } catch (e) {
            wemit.error(`could not check out ${target?.name ?? '(unknown repo)'} for ${result.ticket.issue_id}: ${(e as GitError).message}`);
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
        cycle: wemit.cycle, ticket: fleetTicketHint,
        divergedPrompt: await fetchDivergedPrompt(w.route, w.role, { userAgent: cfg.ship.userAgent }),
        agentModel: await fetchSeatAgentModel(w.route, w.role, { userAgent: cfg.ship.userAgent }),
        resolvedAgentId: await resolveAgentId(w.route, w.role, { userAgent: cfg.ship.userAgent }),
      });
      wemit.enter('agent', w.role);
      wemit.emit(`starting agent run for ${w.route.route}`);
      const fleetMemberId = w.route.resolved?.seats[w.role];
      if (fleetMemberId) {
        try {
          await fleetTracker.setCrewStatus(fleetMemberId, 'working', fleetWorkingId);
        } catch (e) {
          wemit.warn(`could not set crew status: ${(e as Error).message}`, { step: 'agent' });
        }
      }
      try {
        await fleetTracker.beatEngaged(cfg.ship.name, w.route.route, fleetWorkingId);
      } catch (e) {
        wemit.warn(`could not beat ship engaged: ${(e as Error).message}`, { step: 'agent' });
      }
      try {
        await spawnAgent(fleetPlan, wemit);
        await guardRunHandoff(w.route, cfg.ship, fleetTracker, w.role, fleetWorkingId, wemit);
      } finally {
        dropLock();
        if (fleetMemberId) {
          try {
            await fleetTracker.setCrewStatus(fleetMemberId, 'idle');
          } catch (e) {
            wemit.warn(`could not clear crew status: ${(e as Error).message}`, { step: 'agent' });
          }
        }
        try {
          await fleetTracker.beatIdle(cfg.ship.name);
        } catch (e) {
          wemit.warn(`could not beat ship idle: ${(e as Error).message}`, { step: 'agent' });
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
    // ISSUE-928: persist this cycle's attention set so next cycle's diff
    // sees it — never under --dry-run, which performs nothing.
    if (!dryRun) state.attention(route.route).persist(decision.attention);

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

    if (decision.epicSync.length) {
      if (dryRun) {
        for (const s of decision.epicSync) emit.emit(`would move ${describeEpicStep(s)}`, { step: 'sweep' });
      } else {
        const tracker = new Tracker(route, cfg.ship);
        await applyEpicSync(tracker, decision.epicSync, tracker.contract, emit);
      }
    }
    if (!dryRun && decision.holdReleases?.length) {
      const tracker = new Tracker(route, cfg.ship);
      await applyHoldReleases(tracker, decision.holdReleases, tracker.contract, emit);
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
      if (!dryRun && (current === 'dev' || current === 'design' || current === 'qa')) {
        const seat = route.resolved?.seats[current];
        if (seat) {
          const candidates = rankedCandidates(current, decision.selectionInput);
          const contract = decision.selectionInput.contract ?? DEFAULT_CONTRACT;
          const result = await resolveTopCandidate(
            tracker2, candidates, seat,
            claimStatuses(current, contract).approved,
            claimStatuses(current, contract).building,
            (t) => dirForRepo(route, t.repo_id) !== null,
            withHoldCheck(await tracker2.claimAffinity(), decision.selectionInput),
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
          if (result.held.length) {
            emit.emit(`skipped ${result.held.join(', ')} — held by another live ship`, { step: 'select', role: current });
          }
          await noteReaccepted(tracker2, result, seat, cfg.ship.name);
          await noteTakeover(
            tracker2, result, seat, decision.selectionInput.ships?.rows ?? [], cfg.ship.name,
            (t) => { const d = dirForRepo(route, t.repo_id); return d ? originBranchSha(d, t, gitResolve) : null; },
          );
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
        agentModel: await fetchSeatAgentModel(route, current, { userAgent: cfg.ship.userAgent }),
        resolvedAgentId: await resolveAgentId(route, current, { userAgent: cfg.ship.userAgent }),
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
        await guardRunHandoff(route, cfg.ship, tracker2, current, workingId, emit);
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

  case 'daemon': {
    // The persistent supervisor loop (ISSUE-762), for the `run` route only —
    // `release`/`passengers` keep their own fixed-timer units untouched, and
    // this command is not fleet-wide: name a route the same way a
    // single-route `crew run` would need to on a multi-route ship.
    //
    // `start`/`stop`/`status` (ISSUE-763) are thin wrappers around whatever
    // OS service manager `crew install` already handed the `run` job to —
    // see `install.ts#planDaemonControl` for the mechanism-specific commands
    // and, for launchd, why `stop`/`start` are unload/load rather than the
    // more obvious `launchctl stop`/`start`. They take no route argument on
    // a single-route ship; `crew daemon start <route>` on a multi-route ship
    // targets that route's own unit, matching the bare-form convention below.
    //
    // `restart` (ISSUE-764) is the deterministic manual sibling to the
    // loop's own self-update check below: `git pull && crew daemon restart`
    // forces a relaunch right away instead of waiting for the next idle
    // staleness tick. It is just `stop` then `start` — launchd has no atomic
    // "restart" verb (see `planDaemonControl`'s doc comment), and reusing
    // the same two commands for every mechanism keeps this one code path
    // rather than a systemd-specific `restart` verb plus a launchd fallback.
    const daemonSub = positional[1];
    if (daemonSub === 'start' || daemonSub === 'stop' || daemonSub === 'status' || daemonSub === 'restart') {
      const host = hostPlatform();
      if (host === 'windows') {
        process.stderr.write('crew daemon: no scheduler support yet for Windows (Task Scheduler is planned, not built)\n');
        process.exit(2);
      }
      const control = planDaemonControl(CREW_HOME, host, detectSystemd());
      if (!control.startCommand && !control.stopCommand && !control.statusCommand) {
        process.stdout.write(
          control.mechanism === 'cron'
            ? `crew daemon ${daemonSub}: this host has no systemd, so the \`run\` job stays on the old periodic crontab invocation — there is no persistent process to ${daemonSub}.\n`
            : `crew daemon ${daemonSub}: nothing to control on this platform.\n`,
        );
        break;
      }
      if (daemonSub === 'restart') {
        const commands = [control.stopCommand!, control.startCommand!];
        if (dryRun) {
          for (const c of commands) process.stdout.write(`would run: ${c.join(' ')}\n`);
          break;
        }
        let failed = false;
        for (const cmd of commands) {
          const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: CREW_HOME, encoding: 'utf8' });
          if (res.stdout) process.stdout.write(res.stdout);
          if (res.stderr) process.stderr.write(res.stderr);
          // The stop half (launchd `unload`) fails harmlessly if the unit
          // isn't loaded yet — same tolerance `applyInstall`'s
          // preLoadCommands give it. Only the start half failing actually
          // means the daemon isn't running afterward.
          if (cmd === control.startCommand && (res.error || res.status !== 0)) {
            process.stderr.write(`crew daemon restart: ${cmd.join(' ')} exited ${res.status ?? 'error'}\n`);
            failed = true;
          }
        }
        process.exitCode = failed ? 1 : 0;
        break;
      }
      const cmd = daemonSub === 'start' ? control.startCommand! : daemonSub === 'stop' ? control.stopCommand! : control.statusCommand!;
      if (dryRun) { process.stdout.write(`would run: ${cmd.join(' ')}\n`); break; }
      const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: CREW_HOME, encoding: 'utf8' });
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      // `status` reports through its own exit code (e.g. launchctl list /
      // systemctl is-active both exit non-zero for "not running") — that is
      // the answer, not a failure of this command.
      if (daemonSub !== 'status' && (res.error || res.status !== 0)) {
        process.stderr.write(`crew daemon ${daemonSub}: ${cmd.join(' ')} exited ${res.status ?? 'error'}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = res.status ?? 0;
      }
      break;
    }
    // This just makes the loop itself (`daemon.ts`) invocable and testable
    // end-to-end, running in the foreground until the process is killed or
    // (ISSUE-764) it detects the installed tree has changed under it.
    if (dryRun) {
      process.stderr.write('crew: daemon does not support --dry-run — it only ever performs real cycles.\n');
      process.exit(2);
    }
    if (!(await anyRepoServable(route))) {
      emit.error(
        `refusing this route — this ship is ${cfg.ship.platform}, but ${await explainUnservable(route)}`,
      );
      process.exit(1);
    }
    requireArmed('run the daemon loop');

    // Self-update detection (ISSUE-764): watch whichever paths actually
    // determine this process's own code. `bin/crew` prefers `dist/cli.js`
    // over `src/cli.ts` when both exist (see that file), so both are
    // watched — a build landing in `dist` is a real update even though
    // `src` also changed to produce it. A compiled binary (`isCompiledBinary`)
    // has no `src`/`dist` next to it at all; there, the binary file itself is
    // what a redeploy replaces.
    const watchPaths = isCompiledBinary(import.meta.url)
      ? [process.execPath]
      : [join(CREW_HOME, 'src'), join(CREW_HOME, 'dist'), join(CREW_HOME, 'bin')];

    // One breaker for the whole daemon process, so a role's failed starts are
    // remembered across passes (ISSUE-1365).
    const spawnBreaker = new SpawnBreaker();
    const stopReason = await runDaemonLoop({
      runPass: () => runOnePass({
        route, ship: cfg.ship, state,
        maxConcurrentAgents: cfg.ship.maxConcurrentAgents,
        spawnBreaker,
        newEmitter: () => new Emitter({
          route: route.route,
          eventFile: eventFileFor(cfg.ship.stateDir),
          logFile: cfg.ship.logFile,
          console: (l) => process.stderr.write(`${l}\n`),
        }),
      }),
      checkStale: makeStaleChecker(watchPaths),
      onPass: (result) => {
        if (result.started.length) emit.emit(`daemon pass started: ${result.started.join(', ')}`);
        for (const s of result.skipped) emit.emit(`daemon pass skipped ${s.role} — ${s.reason}`);
      },
    });
    if (stopReason === 'stale') {
      emit.emit('crew daemon: installed tree changed on disk — exiting cleanly so the OS-level restart relaunches with the update');
      process.exit(0);
    }
    break;
  }

  case 'merge':
  case 'deploy':
  case 'release': {
    const opts = {
      mergeOnly: command === 'merge', force: command === 'deploy' || flag('force'),
      isDeployCommand: command === 'deploy',
    };
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
      process.stderr.write('crew agents sync [route] [--force]    push crew\'s personas (Developer/Design/QA/Triage/Pair) AND skill files (e.g. grill-me) into the workspace Agents/Agent Skills tables (--force overwrites even a diverged persona)\n');
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
      personaResult = await syncPersonas(target, { userAgent: cfg.ship.userAgent, dryRun, force });
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

  case 'repos': {
    // `crew repos add <route> <path>` / `crew repos list <route>` (CREW-1287).
    // Works on crew.yaml's raw text rather than `cfg.routes`: a route that
    // names no `dir`/`repos` yet fails config validation and is dropped from
    // `cfg.routes`, and that is exactly the route `add` is for.
    const sub = positional[1];
    const usage = () => {
      process.stderr.write('crew repos add [workspace/project] [name] [path] [--name N] [--project P] [--dry-run] [--no-create]\ncrew repos list <workspace/project>\n');
      process.exit(2);
    };
    if (sub !== 'add' && sub !== 'list') usage();
    const configText = readFileSync(cfg.configFile, 'utf8');
    let routeName = positional[2];
    let addPath = '.';
    let addName: string | undefined;
    if (sub === 'list' && !routeName) usage();
    if (sub === 'add') {
      try {
        const a = parseAddArgs(positional.slice(2), routeNamesOf(configText), (p) => existsSync(resolvePath(p.replace(/^~(?=\/|$)/, homedir()))));
        routeName = a.route; addPath = a.path; addName = a.name;
      } catch (e) {
        if (e instanceof ReposError) { process.stderr.write(`crew repos: ${e.message}\n`); process.exit(2); }
        throw e;
      }
    }
    const resolvedFile = resolvedPathFor(cfg.ship.stateDir, routeName!);
    let resolvedRemotes: RepoRemotes | undefined;
    if (existsSync(resolvedFile)) {
      try { resolvedRemotes = JSON.parse(readFileSync(resolvedFile, 'utf8')) as RepoRemotes; } catch { /* unreadable: treated as not connected */ }
    }
    const originOf = (dir: string) => gitOk(dir, ['remote', 'get-url', 'origin']) ?? undefined;
    const text = configText;
    const base = dirname(cfg.configFile);
    try {
      if (sub === 'list') {
        const repos = configuredRepos(text, routeName!, base);
        if (repos.length === 0) process.stdout.write(`route ${routeName} has no checkout configured — \`crew repos add ${routeName} <path>\`\n`);
        for (const r of repos) {
          const origin = originOf(r.dir);
          const row = matchRepoName(origin, resolvedRemotes);
          const note = !existsSync(r.dir) ? 'missing on disk'
            : row ? `Repos row: ${row}`
            : `no Repos row matches ${normalizeRemote(origin) ?? 'this checkout (no origin remote)'}`;
          process.stdout.write(`${r.name}\t${r.dir}\t${note}\n`);
        }
        break;
      }
      const target = resolvePath(addPath.replace(/^~(?=\/|$)/, homedir()));
      const top = existsSync(target) ? gitOk(target, ['rev-parse', '--show-toplevel']) : null;
      if (!top) throw new ReposError(`${target} is not a git checkout`);
      const origin = originOf(top);
      const plan = planRepoAdd({
        text, base, route: routeName!, path: top, origin, resolved: resolvedRemotes, name: value('name') ?? addName,
        nameForExisting: (d) => matchRepoName(originOf(d), resolvedRemotes),
      });
      // No Repos row for this checkout: create one (CREW-1310) unless told not to.
      // Everything that can fail on the tracker is done before crew.yaml is
      // written, so a refused create leaves the config alone and the command
      // can simply be re-run.
      let rowTracker: Tracker | undefined;
      let rowPayload: Record<string, unknown> | undefined;
      if (plan.unmatched && origin && !flag('no-create')) {
        // The route may be one `loadConfig` drops for lacking a checkout, so
        // load it from the planned text rather than the file on disk.
        const planned = loadConfig(CREW_HOME, cfg.configFile, { text: plan.text, allowNoRoutes: true });
        const planRoute = planned.routes.find((r) => r.route === routeName);
        if (!planRoute) throw new ReposError(`route ${routeName} did not load from the planned config; use --no-create`);
        try {
          rowTracker = new Tracker(planRoute, cfg.ship);
        } catch (e) {
          if (e instanceof ConfigError) throw new ReposError(`${e.message}; or pass --no-create`);
          throw e;
        }
        const projectId = resolveRepoProject(await rowTracker.projectRows(), value('project'), planRoute.resolved?.areaId);
        let spec: Parameters<typeof planRepoRow>[0]['spec'];
        try {
          const rc = loadRepoConfig(top);
          if (rc) spec = { platform: rc.platform, releaseMode: rc.release.mode, ciProvider: rc.release.ci.provider };
        } catch { /* a malformed .crew.yaml is `crew doctor`'s to report; fall to defaults */ }
        rowPayload = planRepoRow({ name: plan.name, origin, spec, projectId });
      } else if (plan.warning) {
        process.stderr.write(`crew repos: warning — ${plan.warning}\n`);
      }
      if (dryRun) {
        process.stdout.write(`${plan.block}\n`);
        if (rowPayload) process.stdout.write(`would create Repos row: ${JSON.stringify(rowPayload)}\n`);
        break;
      }
      if (rowTracker && rowPayload) {
        const created = await rowTracker.createRepoRow(rowPayload);
        process.stdout.write(`created Repos row ${String(rowPayload.name)} (${String(rowPayload.remote)}) ${created.id}\n`);
        // Mirror it into the resolved file so `crew repos list` matches at once.
        if (existsSync(resolvedFile)) {
          const raw = JSON.parse(readFileSync(resolvedFile, 'utf8')) as RepoRemotes & Record<string, unknown>;
          raw.repoNames = { ...raw.repoNames, [created.id]: String(rowPayload.name) };
          raw.repoRemotes = { ...raw.repoRemotes, [created.id]: String(rowPayload.remote) };
          writeFileSync(resolvedFile, `${JSON.stringify(raw, null, 2)}\n`);
        }
      }
      writeFileSync(cfg.configFile, plan.text);
      process.stdout.write(`added ${top} to ${routeName} as ${plan.mode === 'dir' ? 'dir' : `repos.${plan.name}`} in ${cfg.configFile}\n`);
    } catch (e) {
      if (e instanceof ReposError) { process.stderr.write(`crew repos: ${e.message}\n`); process.exit(2); }
      throw e;
    }
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
    // `crew connect foo` (just the workspace slug) is the normal form
    // (ISSUE-967): `discover()` defaults the project to whichever one is
    // installed from the `crew.issues` Library template (falling back to
    // slug `issues`), offering to install it when it's missing. `crew
    // connect foo/bar` (workspace/project) names a project explicitly —
    // only needed for a deliberately non-default tracker project, in which
    // case `discover()` falls back to offering every project in that
    // workspace with the tables a route needs, when there's more than one
    // candidate. Bare `crew connect` (no argument at all) offers every
    // workspace this key's identity can see. `--workspace-id` (a uuid OR a
    // slug — `discover()` accepts either) and `--project` remain for
    // scripting and for a project named rather than slugged.
    const arg = positional[1];
    const [argWorkspace, argProject] = arg?.includes('/') ? arg.split(/\/(.*)/s) : [arg, undefined];
    let workspace = argWorkspace ?? value('workspace-id') ?? value('workspace');
    const project = argProject ?? value('project');
    const baseUrl = value('base-url') ?? cfg.routes[0]?.baseUrl ?? DEFAULT_BASE_URL;
    // No bare `cfg.ship.apiKey` to read here — it's only a fallback SOURCE the
    // route parser merges in, not a field of its own on `Ship`. Any
    // already-configured route's (already-merged) key is the next best
    // guess, and exactly what a ship-level key resolves to in practice.
    let apiKey = value('key') ?? process.env.CREW_CONNECT_KEY ?? cfg.routes.find((c) => c.apiKey)?.apiKey;
    // The OS keychain store `@tablation/client` reads/writes sessions
    // through (ISSUE-966) — the same one `hydrateApiKeys` reads on every
    // `crew` invocation, and `tablation login` already writes into.
    // `undefined` when this platform has no backend implemented at all
    // (`getSessionStore` throws synchronously in that case); every other
    // failure (no Secret Service, no Credential Manager reachable) is
    // reported lazily, per call, since it can't be told apart from "not
    // logged in yet" until the call is actually made.
    let store: SessionStore | undefined;
    try {
      store = getSessionStore();
    } catch {
      store = undefined;
    }
    // Set once this route's key is known to live in (or was just written
    // to) the OS keychain — `runConnect` below uses this to skip the
    // apiKeyFile fallback entirely and tell `renderConnection` to omit
    // apiKeyFile/apiKeyVar from the pasted route block, since
    // `hydrateApiKeys` (config.ts) resolves this route's key from the
    // keychain on every future `crew` run regardless of how it got there.
    let keychainBacked = false;
    // Reuse an already-stored session for this exact host+workspace instead
    // of starting a second browser round-trip — only possible when the
    // workspace is already known (an explicit `crew connect ws[/proj]` or
    // `--workspace`); a bare `crew connect` doesn't know which workspace to
    // look up until AFTER a login (device or otherwise) says so.
    if (!apiKey && workspace && store) {
      try {
        const existing = await store.get(hostFromUrl(baseUrl), workspace);
        if (existing?.apiKey) {
          apiKey = existing.apiKey;
          keychainBacked = true;
          process.stderr.write(`Reusing the existing keychain session for ${hostFromUrl(baseUrl)}/${workspace}.\n`);
        }
      } catch {
        // No Secret Service / Credential Manager reachable right now — fall
        // through to the device-login flow below exactly as if nothing had
        // ever been stored.
      }
    }
    // Set only when THIS run minted the key via device-login and could NOT
    // store it in the OS keychain — `runConnect` below uses this to fall
    // back to writing the key to apiKeyPathFor and print real
    // apiKeyFile/apiKeyVar values in the rendered route block, the same way
    // every device-authorization key had to before the keychain existed.
    // A key that DID make it into the keychain needs neither: `crew.yaml`
    // names no `apiKey`/`apiKeyFile` at all for that route, and
    // `hydrateApiKeys` resolves it from the keychain on every future run.
    let mintedFromDevice = false;
    if (!apiKey) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write(
          'crew connect [<workspace>[/<project>]] --key K (or CREW_CONNECT_KEY, or ship.apiKey in crew.yaml)\n' +
          '  workspace/project may be slugs, ids, or (project) a name. Omit workspace to list them.\n' +
          '  Omit --key from a real terminal instead to sign in via device authorization.\n',
        );
        process.exit(2);
      }
      // No `--key`, and a real terminal on both ends — offer the
      // device-authorization handshake (ISSUE-609) rather than just
      // refusing: Synthesis already exposes this for exactly this case
      // (a CLI with no key yet, run by someone who already has workspace
      // access — typically via SSO). Goes through `@tablation/client`'s own
      // `loginWithDeviceCode` (ISSUE-966) — the same flow `tablation login`
      // uses — rather than crew's own now-deleted copy of it.
      let result;
      try {
        // `@tablation/client` takes the `.../api` base and appends
        // `/auth/device/authorize` itself; the bare route URL hits the SPA (405 HTML).
        result = await loginWithDeviceCode(`${baseUrl}/api`, {
          deviceName: `crew on ${hostname()}`,
          // Lets the approval page preselect the workspace this connect is for.
          // A bare `crew connect` has none and passes nothing.
          ...(workspace ? { workspaceSlug: workspace } : {}),
          onCode: (info) => {
            process.stderr.write(
              'No API key given — approve this device from a browser you\'re already signed into Tablation with:\n\n' +
              `  ${info.verificationUriComplete}\n\n` +
              `  (user code, if not already filled in: ${info.userCode})\n\nWaiting for approval`,
            );
          },
        });
      } catch (e) {
        process.stderr.write('\n');
        if (e instanceof DeviceLoginError) {
          process.stderr.write(`crew connect: ${e.message}\n`);
        } else {
          process.stderr.write(`crew connect: device authorization failed — ${(e as Error).message}\n`);
        }
        process.exit(2);
      }
      process.stderr.write(
        `\nSigned in as ${result.identity.email} — minted an API key in workspace "${result.workspace.name}".\n`,
      );
      apiKey = result.apiKey.key;
      mintedFromDevice = true;
      // The device flow just said exactly which workspace this key is
      // scoped to — no reason to make the operator retype what there was
      // no ambiguity in, the same reasoning as the single-workspace
      // shortcut below.
      if (!workspace) workspace = result.workspace.slug;
      if (store) {
        try {
          await store.set(hostFromUrl(baseUrl), result.workspace.slug, {
            apiKey: result.apiKey.key,
            shipId: getOrCreateShipId(),
            workspaceId: result.workspace.id,
            identityId: result.identity.id,
            createdAt: result.apiKey.createdAt,
          });
          keychainBacked = true;
          process.stderr.write(
            `API key stored in the OS keychain for ${hostFromUrl(baseUrl)}/${result.workspace.slug}.\n`,
          );
        } catch (e) {
          process.stderr.write(
            `(could not store the key in the OS keychain — ${(e as Error).message} — ` +
            'falling back to a key file)\n',
          );
        }
      } else {
        process.stderr.write('(no OS keychain support on this platform — falling back to a key file)\n');
      }
    }
    const authOpts = { baseUrl, apiKey, userAgent: cfg.ship.userAgent };

    // Provisioning (ISSUE-610) needs to know which machine this is — the
    // same `ship.name`/`ship.platform` `doctor` already matches Ships rows
    // against. Threaded through explicitly rather than read again inside
    // `discover()`: this file already has `cfg` in scope, and `discover()`
    // stays a pure function of its options, testable without a config file.
    //
    // `hostPassengers` (ISSUE-644) comes from whatever route this exact
    // `workspace/project` argument already names in crew.yaml, if any — a
    // brand-new connect (nothing configured yet) has no preference to sync,
    // so it stays false until the operator adds `hostPassengers: true` to
    // the pasted route block and reconnects.
    const existingRoute = arg ? cfg.routes.find((r) => r.route === arg) : undefined;
    // This ship's own SSH identity for the Host Passengers tunnel
    // (ISSUE-553) — found-or-generated once per machine (`ensureShipSshKeypair`
    // persists it under stateDir, same convention as `apiKeyPathFor`), then
    // synced onto this workspace's Ships row the same way `hostPassengers`
    // is, right below. Best-effort: no `ssh-keygen` on PATH (or a dry run)
    // must not block `crew connect` itself — the row simply keeps whatever
    // key (or none) it already had until a machine that CAN generate one
    // connects.
    let sshPublicKey: string | undefined;
    if (!dryRun) {
      try {
        sshPublicKey = ensureShipSshKeypair(cfg.ship.stateDir).publicKey;
      } catch (e) {
        process.stderr.write(`(no SSH keypair synced — ${(e as Error).message})\n`);
      }
    }
    const ship = {
      name: cfg.ship.name, platform: cfg.ship.platform,
      hostPassengers: firstRun?.answers.hostPassengers ?? existingRoute?.hostPassengers === true,
      sshPublicKey,
    };

    const runConnect = async (ws: string, proj: string | undefined): Promise<void> => {
      let found = await discover({ ...authOpts, workspace: ws, project: proj, area: value('area'), ship, dryRun });
      if (!found.projectId && found.offerTemplateInstall && process.stdin.isTTY && process.stdout.isTTY) {
        const installedSlug = await offerTemplateInstall(authOpts, found.workspaceId);
        if (installedSlug) {
          found = await discover({ ...authOpts, workspace: ws, project: installedSlug, area: value('area'), ship, dryRun });
        }
      }
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
      // One release-lock row per repo of this route (CREW-1384): every repo the
      // board's Repos table names plus every checkout this ship configured for
      // the route. Idempotent and safe against another ship connecting at once.
      if (found.locksModelId && !dryRun) {
        const configured = cfg.routes.find((r) => r.route === route);
        const repoNames = [...Object.values(found.repoNames ?? {}), ...(configured ? reposOf(configured).map((t) => t.name) : [])]
          .filter((n) => !!n);
        try {
          const made = await provisionReleaseLocks(authOpts, found.locksModelId, route, repoNames);
          for (const sc of made) process.stderr.write(`created release lock row ${sc}\n`);
        } catch (e) {
          process.stderr.write(`(could not provision release lock rows — ${(e as Error).message})\n`);
        }
      }
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
        | {
            contract?: { statuses?: { resolved?: string[] } } | null;
            reviewedStatuses?: string[];
            operator?: string;
            agentPersonas?: unknown;
            agentSkills?: unknown;
          }
        | undefined;
      const hadPreviousFile = existsSync(resolvedPath);
      if (hadPreviousFile) {
        try { previous = JSON.parse(readFileSync(resolvedPath, 'utf8')); } catch { /* treated as no previous file below */ }
      }
      // Same "never clobber what a previous run/hand-edit wrote" rule
      // `contract`/`reviewedStatuses` already follow (ISSUE-467) — a skipped
      // picker (blank answer, or no TTY to ask at all) must not wipe an
      // operator a prior run or a hand-edit already resolved.
      if (!operator) operator = previous?.operator;
      // CREW-978: a non-interactive `connect` with no previous file and no
      // operator resolvable (several holds, none matching this key's email)
      // used to write a resolved file with no `operator` key at all — which
      // `loadConfig` then silently drops the whole route for (`operator is
      // required`), on every cycle after this one, with nothing at connect
      // time to say why. A re-run that already HAS a previous file is fine
      // to proceed without one (the loop already accepted this route before;
      // don't turn a routine reconnect into a hard failure over a field nothing
      // new was asked to resolve) — this only refuses a *first* write.
      if (!operator && !hadPreviousFile) {
        process.stderr.write(
          `crew connect ${route}: cannot determine the operator — ${found.holds.length} Crew row(s) ` +
          `could be it, none matching this key's own email, and there's no terminal to ask.\n` +
          `  Re-run from a real terminal to pick one, or pass --key for a key whose own\n` +
          `  identity email matches exactly one Crew row.\n`,
        );
        process.exit(2);
      }
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
        recordLinkViewId: found.recordLinkViewId,
        reposModelId: found.reposModelId, repoNames: found.repoNames, repoRemotes: found.repoRemotes,
        models: found.models, seats: found.seats, holds: found.holds.map((h) => ({ id: h.id, role: h.name })),
        ...(found.releaseSeat ? { releaseSeat: found.releaseSeat } : {}),
        ...(operator ? { operator } : {}),
        ...(contract ? { contract } : {}),
        ...(reviewedStatuses.length > 0 ? { reviewedStatuses } : {}),
        // CREW-1055: connect only ever discovers ids — it never syncs
        // personas/skills itself — so carry forward whatever `crew agents
        // sync`/`crew skills sync` last wrote here rather than dropping it.
        // A reconnect that clobbers these strands every role's divergence
        // baseline (`agents.ts`'s `knownBaseline`), which then reads every
        // role as "diverged by definition" on the next sync even though
        // nothing about its prompt actually changed.
        ...(previous?.agentPersonas ? { agentPersonas: previous.agentPersonas } : {}),
        ...(previous?.agentSkills ? { agentSkills: previous.agentSkills } : {}),
      };
      if (dryRun) {
        process.stderr.write(`(dry run) would write resolved ids to ${resolvedPath}\n`);
      } else {
        mkdirSync(dirname(resolvedPath), { recursive: true });
        // CREW-978: a `.bak` of whatever this route already had, and an
        // atomic rename over the real path (write-to-temp + rename, rather
        // than writing resolvedPath directly) — a bad connect (this run
        // crashing, or the process getting killed) mid-write used to be able
        // to leave a truncated/partial resolved file behind; a rename is a
        // single filesystem operation, so the route ends up either fully the
        // old file or fully the new one, never a half-written one, and the
        // `.bak` means a bad WRITE (as opposed to a crash) is still one `mv
        // route.json.bak route.json` away from undone.
        if (hadPreviousFile) copyFileSync(resolvedPath, `${resolvedPath}.bak`);
        const tmpPath = `${resolvedPath}.tmp${process.pid}`;
        writeFileSync(tmpPath, `${JSON.stringify(resolved, null, 2)}\n`);
        renameSync(tmpPath, resolvedPath);
        process.stderr.write(`Resolved ids written to ${resolvedPath}\n`);
      }
      // A device-authorization key that made it into the OS keychain
      // (ISSUE-966) needs no file at all — `hydrateApiKeys` resolves it from
      // there on every future `crew` run, keyed by this route's own
      // baseUrl host + workspace slug. Only a key that COULDN'T be stored
      // there (no keychain support on this platform, or the store's `set`
      // itself failed) falls back to the old plaintext-file convention:
      // persist it the same shape apiKeyFile/apiKeyVar already expect
      // (a `VAR=value` line), rather than printing it to a terminal for
      // the operator to paste somewhere themselves the way a `--key`
      // value never had to be, since it was already in a file before
      // this ran. 0600: this file holds a live credential.
      let apiKeyFile: string | undefined;
      const apiKeyVar = 'CREW_API_KEY';
      if (mintedFromDevice && !keychainBacked) {
        apiKeyFile = apiKeyPathFor(cfg.ship.stateDir, route);
        if (dryRun) {
          process.stderr.write(`(dry run) would write the minted API key to ${apiKeyFile}\n`);
        } else {
          mkdirSync(dirname(apiKeyFile), { recursive: true });
          writeFileSync(apiKeyFile, `${apiKeyVar}=${apiKey}\n`, { mode: 0o600 });
          process.stderr.write(`API key written to ${apiKeyFile}\n`);
        }
      }
      // CREW-1286: the first-run wizard writes crew.yaml itself instead of
      // printing a block to paste — but only when the route's key has somewhere
      // to live (keychain or a key file). A `--key` connect with neither has no
      // key a written file could name, so it keeps today's print-and-paste.
      const keyPersisted = keychainBacked || apiKeyFile !== undefined;
      const wizard = firstRun;
      const writeFirstRun = wizard !== undefined && !dryRun && keyPersisted;
      const routeDir = value('dir') ?? (writeFirstRun ? join(DEFAULT_REPOS_BASE_PATH, found.workspaceSlug) : undefined);
      const routeBlock = renderConnection(
        found, route,
        routeDir ?? 'REPLACE — the local checkout this route works',
        {
          area: value('area'), apiKeyFile, apiKeyVar: apiKeyFile ? apiKeyVar : undefined, keychainBacked,
          ...(writeFirstRun ? { baseUrl, hostPassengers: wizard.answers.hostPassengers } : {}),
        },
      );
      let wroteConfig = false;
      if (writeFirstRun) {
        wroteConfig = writeNewConfig(wizard.configPath, renderFullConfig(wizard.answers, routeBlock));
        if (!wroteConfig) process.stderr.write(`(${wizard.configPath} appeared while connecting — leaving it alone)\n`);
      }
      if (!wroteConfig) process.stdout.write(routeBlock);
      // CREW-1378: give interactive Claude Code sessions the tablation MCP tools.
      if (!flag('no-mcp') && apiKey) {
        const replace = value('mcp') === 'replace';
        process.stderr.write(`${ensureClaudeMcp({ bin: cfg.ship.agent.bin, url: mcpUrlFor(baseUrl), key: apiKey, replace, dryRun })}\n`);
      }
      // CREW-1390: name every hold resolved, so a missing operator is visible now
      // rather than when a comment from them reads as "(no identity)".
      if (found.holds.length) {
        process.stderr.write(
          `\n  Holds resolved (${found.holds.length}): ` +
          `${found.holds.map((h) => `${h.name || h.id}${h.id === operator ? ' [operator]' : ''}`).join(', ')}\n`,
        );
      }
      if (found.provisioning.length) {
        process.stderr.write(`\n  Provisioned for this machine (${ship.name}):\n`);
        for (const p of found.provisioning) process.stderr.write(`    - ${p}\n`);
      }
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
      if (wroteConfig) {
        process.stderr.write(nextSteps({
          route, configPath: wizard!.configPath, platform: cfg.ship.platform, needsRepos: !value('dir'),
        }));
        if (!operator) process.stderr.write(`  Also set operator in ${resolvedPath} before arming it.\n`);
      } else if (operator) {
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
    // Deliberately still `ISSUE-{n}` (ISSUE-969): `ticketForPort` derives
    // {n, role} from port arithmetic alone, with no route/tracker in hand to
    // look the ticket up in — and this route may not even be the one whose
    // board owns it. A live lookup per row would turn an offline port scan
    // into one that can hang or fail on a flaky tracker, for a display-only
    // improvement. Not worth it; see the ticket's own tag with `crew inbox`.
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
    // Same call as `ports`, same reasoning (ISSUE-969): `o.n` came from a
    // port scan, not a ticket lookup, so this stays `ISSUE-{n}` rather than
    // paying for a tracker round trip per orphan just to print its tag.
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
    // (ISSUE-346). Matched by ticket number, not by that repo's prefix
    // (ISSUE-969) — see `planWorktreeSweep`'s own doc comment for why a
    // fixed prefix can no longer be trusted to find every worktree here.
    const tracker = new Tracker(route, cfg.ship);
    const terminal = await tracker.terminalTickets();
    const { byRepo } = ticketsByRepo(route, terminal);
    const verifiedByRepo = ticketsByRepo(
      route, (await tracker.openTickets()).filter((t) => t.status === tracker.contract.statuses.verified),
    ).byRepo;
    for (const r of await resolvedRepos(route)) {
      const actions = planWorktreeSweep(r, [...(byRepo.get(r.name) ?? []), ...(verifiedByRepo.get(r.name) ?? [])], tracker.contract);
      const stale = planRemoteBranchCleanup(r.dir, r.config.branch.remote, r.config.branch.base, byRepo.get(r.name) ?? [], tracker.contract);
      if (stale.length) { anything = true; applyRemoteBranchCleanup(r.dir, r.config.branch.remote, stale, dryRun, emit); }
      if (!actions.length) continue;
      anything = true;
      const res = await applyWorktreeSweep(r.dir, actions, dryRun, emit, r.config.branch.remote);
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
    const raw = positional[2] ?? positional[1];
    const n = raw ? parseTicketNumber(raw) : null;
    if (!n) { process.stderr.write('drop: need a ticket number (326, ISSUE-326, or TABL-326)\n'); process.exit(2); }
    const num = Number(n);
    // The messages below stay `ISSUE-{n}` rather than the ticket's own tag
    // (ISSUE-969): everything here works from the bare number the operator
    // typed, with no board fetch at all — that's deliberate, since `drop` is
    // a destructive git operation that should keep working offline/against a
    // flaky tracker. Paying for a lookup here just to prettify a log line
    // isn't worth trading that away; unlike `unassign` below, which already
    // fetches the full ticket for other reasons and uses its tag for free.
    // Which repository's worktree? Each names them after itself (ISSUE-350),
    // so the number alone does not say — look for it in all of them. Found by
    // scanning each repo's actual `git worktree list`, not by constructing a
    // path from a guessed prefix (ISSUE-969) — see `worktreeForNumber`'s own
    // doc comment. Removing one is destructive, so an ambiguous answer stops
    // rather than picks.
    const repos = await resolvedRepos(route);
    const candidates = repos
      .map((r) => ({ repo: r, found: worktreeForNumber(r.dir, n) }))
      .filter((c): c is { repo: typeof repos[number]; found: NonNullable<typeof c.found> } => c.found !== null);
    if (candidates.length === 0) {
      process.stderr.write(
        `drop: no worktree for ISSUE-${n} in any of this route's repositories ` +
          `(looked in: ${repos.map((r) => r.dir).join(', ')})\n`,
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
    const { repo: target, found } = candidates[0]!;
    const wt = found.path;
    // The branch actually checked out in the worktree we just found — not
    // re-derived from today's template, which may not be what created it
    // (ISSUE-969: the default template itself changed under some tickets).
    const branch = found.branch ?? branchForIssue(target.dir, `ISSUE-${n}`, {
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
    if (branch) {
      gitOk(target.dir, ['branch', '-D', branch]);
      // CREW-1364: the pushed copy goes too, but only once the work is known
      // to have landed — `drop` is also how an abandoned branch is removed,
      // and the remote may then hold the only copy. "Landed" is the same test
      // closure detection uses: the ticket key names a commit on the base.
      const { remote, base } = target.config.branch;
      if (remoteConfigured(target.dir, remote) && remoteBranchExists(target.dir, remote, branch)) {
        if (findKeyInRange(target.dir, `ISSUE-${n}`, `${remote}/${base}`)) {
          emit.emit(deleteRemoteBranch(target.dir, remote, branch)
            ? `deleted ${remote}/${branch}`
            : `could not delete ${remote}/${branch}`);
        } else {
          emit.warn(`${remote}/${branch} kept — nothing on ${remote}/${base} names ISSUE-${n} yet, so it may be the only copy`);
        }
      }
    }
    else emit.warn(`no branch found for ISSUE-${n} in ${target.name} — worktree removed, nothing to delete`);
    emit.emit(`dropped ISSUE-${n} from ${target.name}`);
    break;
  }

  case 'rotate-passenger-url': {
    // The escape hatch for a leaked passenger URL (CREW-1320): the slug is
    // this ship's own, so rotation is replacing it, respawning the tunnel
    // under the new one, and updating the registered endpoint. The ship's
    // SSH keypair is never touched.
    emit.enter('passengers');
    if (!route.hostPassengers) {
      process.stderr.write(
        `crew rotate-passenger-url: route "${route.route}" does not have hostPassengers enabled\n`,
      );
      process.exit(2);
    }
    if (!cfg.ship.relayHost) {
      process.stderr.write('crew rotate-passenger-url: this ship has no relayHost configured — nothing to rotate\n');
      process.exit(2);
    }
    const workspaceId = route.resolved?.workspaceId;
    if (!workspaceId) {
      process.stderr.write(`crew rotate-passenger-url: route "${route.route}" has no resolved ids — run \`crew connect\`\n`);
      process.exit(2);
    }
    const plans = planContainers(cfg).filter((p) => p.workspaceId === workspaceId);
    if (!plans.length) {
      process.stderr.write(
        `crew rotate-passenger-url: no Host Passengers container is planned for "${route.route}" right now\n`,
      );
      process.exit(2);
    }
    const existing = readPersistedTunnel(cfg.ship.stateDir, workspaceId);
    const hasLiveTunnel = existing !== undefined && isPidAlive(existing.pid);
    if (dryRun) {
      emit.emit(
        hasLiveTunnel
          ? `would kill tunnel pid ${existing!.pid} for ${route.route} and reconnect with a fresh public URL`
          : `would reconnect ${route.route} with a fresh public URL (no live tunnel to kill)`,
      );
      break;
    }
    // The new slug is persisted first (`syncPassengerTunnels` respawns any
    // tunnel whose live slug differs), then the old tunnel is killed — the
    // same kill-then-respawn shape it uses when a container's mounts change
    // under a running tunnel.
    rotatePersistedSlug(cfg.ship.stateDir, workspaceId);
    if (hasLiveTunnel) {
      try { process.kill(existing!.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    const { privateKeyPath } = ensureShipSshKeypair(cfg.ship.stateDir);
    // No sync-daemon lookup happens on this manual, one-off path (ISSUE-685)
    // — the rotated tunnel just omits PASSENGER_MCP_SECRET until the next
    // regular `passengers` cycle re-syncs it; `validateCredential`'s
    // real-API-key path still works for anyone with a real credential in
    // the meantime, same graceful-degradation shape as a missing sync daemon.
    const rotateReconcile = endpointReconcileDeps([route], cfg.ship.relayHost);
    const rotatePending: Array<Promise<void>> = [];
    syncPassengerTunnels(plans, cfg.ship.relayHost, cfg.ship.relayPort, privateKeyPath, cfg.ship.stateDir, new Map(), {
      apiKeys: passengerApiKeys([route]),
      onStatus: (wsId, status, info) => {
        rotatePending.push(
          new Tracker(route, cfg.ship).updateTunnelState(cfg.ship.name, { tunnel_status: status })
            .catch((e) => { emit.warn(`could not write tunnel_status: ${(e as Error).message}`, { step: 'passengers' }); }),
        );
        if (status === 'disconnected') rotatePending.push(unregisterEndpoint(wsId, info, rotateReconcile));
      },
    });
    // The new tunnel is still `connecting` here, so the endpoint is updated
    // by the next regular `passengers` cycle once it has settled `connected`.
    await Promise.all(rotatePending);
    emit.emit(`rotated the passenger tunnel for ${route.route} — it reconnects under a fresh slug and the registered endpoint follows on the next passengers cycle`);
    break;
  }

  case 'worktree': {
    // CREW-1385: a run's worktree is materialized from the remote, never
    // assumed to exist. Prints the path on stdout (everything else goes to the
    // log) so a session can `cd "$(crew worktree NNN)"`; exits 1 when the
    // existing worktree was left alone (dirty / unpushed commits) so the
    // session knows to say so rather than work in it.
    emit.enter('worktree');
    const rawWt = positional[2] ?? positional[1];
    const nWt = rawWt ? parseTicketNumber(rawWt) : null;
    if (!nWt) { process.stderr.write('worktree: need a ticket number (326, ISSUE-326, or TABL-326)\n'); process.exit(2); }
    const trackerWt = new Tracker(route, cfg.ship);
    const cWt = trackerWt.contract;
    const ticketWt = (await trackerWt.openTickets()).find((t) => t[cWt.columns.key] === `ISSUE-${nWt}`);
    if (!ticketWt) { process.stderr.write(`worktree: no open ticket ISSUE-${nWt} on ${route.route}\n`); process.exit(2); }
    const repoWt = (await resolvedRepos(route)).find((r) => r.id === ticketWt.repo_id) ?? (await resolvedRepos(route))[0];
    if (!repoWt) { process.stderr.write('worktree: this route has no repository\n'); process.exit(2); }
    const roleWt = positional.find((p) => p === 'dev' || p === 'design' || p === 'qa');
    const planWt = planRunWorktree(repoWt.dir, repoWt.config, ticketWt, roleWt);
    if (dryRun) { emit.emit(`would ${describeRunWorktreePlan(planWt)}`); break; }
    const pathWt = applyRunWorktree(repoWt.dir, repoWt.config, planWt);
    emit.emit(describeRunWorktreePlan(planWt));
    if (pathWt) process.stdout.write(`${pathWt}\n`);
    if (!planIsUsable(planWt)) process.exitCode = 1;
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
    const rawUnassign = positional[2] ?? positional[1];
    const n = rawUnassign ? parseTicketNumber(rawUnassign) : null;
    if (!n) { process.stderr.write('unassign: need a ticket number (326, ISSUE-326, or TABL-326)\n'); process.exit(2); }
    const tracker3 = new Tracker(route, cfg.ship);
    const c = tracker3.contract;
    const key = `ISSUE-${n}`;
    const open = await tracker3.openTickets();
    const ticket = open.find((t) => t[c.columns.key] === key);
    if (!ticket) {
      process.stderr.write(`unassign: no open ticket ${key} on ${route.route} (already resolved, or not this route's)\n`);
      process.exit(2);
    }
    // Found it — from here on, show its own project tag where it has one
    // (ISSUE-969) rather than the bare `ISSUE-{n}` used to find it. `key`
    // stays the lookup value above; `label` is purely for what a human reads.
    const label = displayKey(ticket);
    if (!ticket[c.columns.assignee]) {
      process.stdout.write(`${label} already has no assignee\n`);
      break;
    }
    if (dryRun) {
      emit.emit(`would clear assignee on ${label} (status stays ${ticket[c.columns.status]})`);
      break;
    }
    try {
      await tracker3.updateTicket(ticket.id, { [c.columns.assignee]: null }, ticket.updated_at);
      emit.emit(`cleared assignee on ${label} — back up for grabs next cycle`);
    } catch (e) {
      if (e instanceof StaleWriteError) {
        process.stderr.write(`unassign: ${label} changed on the board since it was read — re-run to retry\n`);
        process.exit(2);
      }
      throw e;
    }
    break;
  }

  case 'sync': {
    // A reviewer's commits land on the remote; until a worktree takes them the
    // dev seat builds on stale code and QA verifies something nobody reviewed.
    // The PRIMARY checkout's own base branch needs the same treatment, for a
    // different reason: an agent's `git worktree add` cuts a new ticket's
    // worktree from `base`'s CURRENT local commit (docs/loop personas, Step
    // 3.1), so a checkout that has not fetched recently hands that agent a
    // worktree missing whatever landed on the remote since (ISSUE-635).
    emit.enter('worktree');
    let tracked = 0;
    let acted = 0;
    let baseChecked = 0;
    let baseActed = 0;
    let baseUnsafe = 0;
    // Every repository of the route: a reviewer's commits on the second
    // repo's branch are no less stale for being next door (ISSUE-350), and
    // neither is a second repo's own base branch.
    for (const r of await resolvedRepos(route)) {
      const base = refreshBaseBranch(r.dir, r.config.branch.remote, r.config.branch.base, dryRun);
      // CREW-1388: the stop is also written on the ship (not just this exit
      // code and the ticket comment), and clears itself the next time the
      // base checks level — a dry run decides nothing, so it neither raises nor clears.
      const att = dryRun ? null : baseAttention(r.name, base, r.config.branch.remote, r.config.branch.base);
      if (att && 'raise' in att) await raiseShipAttention({ state, emit, route, ship: cfg.ship }, att.raise);
      else if (att) clearShipAttention(state, att.clear);
      if (base.action !== 'not-applicable') {
        baseChecked++;
        if (base.action === 'fetch-failed') emit.warn(base.detail);
        else if (baseBranchUnsafe(base)) {
          // A hard stop for cutting a worktree (CREW-1379), not a note: the
          // dev/design persona reads this exit code before `git worktree add`.
          baseActed++; baseUnsafe++;
          emit.error(`${r.name}: DO NOT CUT A WORKTREE FROM THIS BASE — ${describeUnsafeBase(base, r.config.branch.remote, r.config.branch.base)}`);
        }
        else if (base.action === 'would-fast-forward' || base.action === 'fast-forwarded') { baseActed++; emit.emit(base.detail); }
      }

      fetchRemote(r.dir);
      for (const w of worktrees(r.dir)) {
        if (!w.branch) continue;
        // A worktree someone deleted by hand (or a prior sweep already
        // dropped) rather than through `git worktree remove` stays
        // registered but has no directory to run git in — skip it rather
        // than letting one stale entry take the whole multi-route sync
        // down (ISSUE-820).
        if (w.prunable) { emit.warn(`${w.branch}: worktree at ${w.path} no longer exists — skipping (run \`git worktree prune\` in ${r.dir} to clear it)`); continue; }
        let s2: SyncState;
        try {
          s2 = syncState(w.path, w.branch);
        } catch (e) {
          emit.warn(`${w.branch}: could not check sync state — ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
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
    if (baseUnsafe > 0) process.exitCode = 1;
    if (baseChecked > 0 && baseActed === 0) emit.emit(`${baseChecked} base branch(es) checked, all level with the remote`);
    if (tracked === 0) emit.emit('no worktree tracks a remote branch — nothing to sync');
    else if (acted === 0) emit.emit(`${tracked} worktree(s) tracking a remote, all level with it`);
    break;
  }

  case 'pause':
  case 'resume': {
    // `crew pause release` stops only the release phase (ISSUE-1372); the
    // word may sit where a route or role would, so check both positions.
    if (positional[1] === 'release' || positional[2] === 'release') {
      state.setReleasePaused(command === 'pause');
      process.stdout.write(`${command}d releases\n`);
      break;
    }
    const role = positional[2] ?? (['dev', 'design', 'qa'].includes(positional[1] ?? '') ? positional[1] : undefined);
    if (command === 'pause') state.pause(role as RoleName | undefined);
    else state.resume(role as RoleName | undefined);
    process.stdout.write(`${command}d${role ? ` role ${role}` : ''}\n`);
    break;
  }

  case 'install': {
    if (!(await installScheduler({ replace: flag('replace') }))) process.exit(2);
    break;
  }

  case 'uninstall': {
    const host = hostPlatform();
    if (host === 'windows') {
      process.stdout.write('nothing installed on Windows\n');
      break;
    }
    for (const job of ['run', 'release', 'passengers'] as const) {
      const plan = planUninstall(cfg.ship, CREW_HOME, host, detectSystemd(), job);
      process.stdout.write(`uninstalling ${job} ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}\n`);
      await applyUninstall(plan, CREW_HOME, dryRun, {
        emit: (m) => process.stdout.write(`${m}\n`),
        warn: (m) => process.stderr.write(`crew uninstall: ${m}\n`),
      });
    }
    // --all (CREW-1376): every com.tablation.crew* launchd unit, whichever
    // checkout's hash it carries — the cleanup for a crew that was moved.
    if (flag('all') && host === 'macos') {
      process.stdout.write(`uninstalling every crew launchd unit${dryRun ? ' (dry run)' : ''}\n`);
      removeAllLaunchdUnits(dryRun, {
        emit: (m) => process.stdout.write(`${m}\n`),
        warn: (m) => process.stderr.write(`crew uninstall: ${m}\n`),
      }, undefined, loadedCrewLabels());
    }
    break;
  }

  case 'passengers': {
    // The standalone entry point the `passengers` scheduler unit invokes
    // (ISSUE-677) — see `syncHostPassengers`'s own doc comment for why this
    // is no longer inline in `case 'run'`.
    await syncHostPassengers();
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

    // What a person owes (CREW-1402). A board that cannot be read leaves the
    // block out rather than failing `status`, which is also a health check.
    const todo = await statusTracker.openTickets()
      .then((open) => operatorTodo(open, statusTracker.contract, route.resolved?.operator ?? ''))
      .catch(() => []);

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
          // Additive (CREW-1373): open ship-level items, including the
          // derived `release_stale`. `version` stays 1.
          attention: openShipAttention(state),
        },
        // Additive (CREW-1402): what the operator owes. `version` stays 1.
        todo: todo.map((i) => ({ ticket: displayKey(i.ticket), title: i.ticket.title ?? null, reasons: i.reasons })),
        crew: {
          paused: state.isPaused(),
          // The release timer honors the whole-crew pause too, so this is
          // true whenever releases are stopped for either reason.
          releasePaused: state.releaseSkipReason() !== null,
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
            // Additive (CREW-1379): `unsafe` means a ship must not cut a
            // worktree or release from this base. `version` stays 1.
            baseBranch: baseHealth(r),
            worktreePrefix: r.config.worktrees.prefix,
            // A repo with no explicit `worktrees.prefix` no longer names its
            // worktrees `<prefix><number>` (ISSUE-969) — the checkout's own
            // directory name plus the ticket's branch name, e.g.
            // `synthesis-tabl-123`. `worktreePrefix` above is kept for
            // config-provenance display; this is the field that actually
            // describes where a worktree lands by default.
            worktreeDirPattern: r.config.provenance['worktrees.prefix'] !== 'default'
              ? `${r.config.worktrees.prefix}<number>`
              : `${basename(r.dir.replace(/[/\\]+$/, ''))}-<branch>`,
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
          attention: s.attention ?? [],
        })),
      }, null, 2)}\n`);
      break;
    }

    const owed = [
      ...todo.map((i) => `${displayKey(i.ticket)} — ${i.reasons.join(', ')}${i.ticket.title ? ` — ${i.ticket.title}` : ''}`),
      ...openShipAttention(state).map((i) => `ship ${cfg.ship.name}: ${i.kind} — ${i.message}`),
      ...shipRows.filter((s) => s.name !== cfg.ship.name)
        .flatMap((s) => (s.attention ?? []).map((i) => `ship ${s.name}: ${i.kind} — ${i.message}`)),
    ];
    if (owed.length) process.stdout.write(`to do (${owed.length}):\n${owed.map((l) => `  ${l}\n`).join('')}\n`);
    process.stdout.write(
      `ship:       ${cfg.ship.name} (${cfg.ship.platform})\n` +
        `route:      ${route.route} -> ${route.dir}\n` +
        `enabled:    ${route.enabled}\n` +
        `crew:       ${state.isPaused() ? 'paused' : 'active'}\n` +
        `release:    ${state.releaseSkipReason() ? 'paused' : 'active'}\n` +
        `watermark:  ${state.watermark()}\n`,
    );
    for (const r of ['dev', 'design', 'qa'] as RoleName[]) {
      if (state.isRolePaused(r)) process.stdout.write(`role ${r}: paused\n`);
    }
    for (const i of openShipAttention(state)) {
      process.stdout.write(`attention:  ${i.kind} — ${i.message}\n`);
    }
    for (const r of await resolvedRepos(route)) {
      const bh = baseHealth(r);
      if (bh.unsafe) process.stdout.write(`base:       ${r.name} — UNSAFE, no worktree cuts or releases: ${bh.detail}\n`);
      process.stdout.write(`releaser:   ${r.name} — ${await releaserLine(statusTracker, route.route, r.name, r.config.release)}\n`);
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
        // Other ships' items come from their own Ships rows; this ship's were printed above.
        if (s.name !== cfg.ship.name) {
          for (const i of s.attention ?? []) process.stdout.write(`    attention: ${i.kind} — ${i.message}\n`);
        }
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
      // Default worktree naming is now `<checkout dir>-<branch>` (ISSUE-969),
      // derived per ticket from its own branch name rather than a repo-wide
      // prefix — an explicit `worktrees.prefix` (repo or ship) still wins and
      // keeps the older `<prefix><number>` form.
      const worktreePattern = config.provenance['worktrees.prefix'] !== 'default'
        ? `${config.worktrees.prefix}<number>`
        : `${basename(r.dir.replace(/[/\\]+$/, ''))}-${effectiveBranchTemplate(config, undefined)}`;
      process.stdout.write(
        `${`repo ${r.name}:`.padEnd(19)}${r.dir}\n` +
          `                   worktrees at ../${worktreePattern} ` +
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
      const bh = baseHealth(r);
      if (bh.action !== 'not-applicable') {
        process.stdout.write(`                   base ${config.branch.base}: ${bh.unsafe ? 'ERROR — ' : ''}${bh.detail}\n`);
        if (bh.unsafe) process.exitCode = 1;
      }
      // Who releases this repo (CREW-1384): the named ship, or a warning when
      // a locally-released repo names none and several ships could race.
      if (config.release.ship) {
        process.stdout.write(`                   release.ship ${config.release.ship}${config.release.ship === cfg.ship.name ? ' (this ship)' : ''}\n`);
      } else {
        const warn = missingReleaserWarning(r.name, config.release, await tracker.shipRows().catch(() => []));
        if (warn) process.stdout.write(`                   WARNING ${warn}\n`);
      }
    }

    // Authorship columns (CREW-1371). A missing one is not a fault — the write
    // just leaves it empty — so this reports it without gating `--fix`.
    const missingAuthorship = await tracker.missingAuthorshipColumns();
    process.stdout.write(
      missingAuthorship.length === 0
        ? 'authorship:       filed_by_id, ship_id present\n'
        : `authorship:       missing ${missingAuthorship.join(', ')} — update the Issues template\n`,
    );
    // Release seat (CREW-1371 D5). Absent is not a fault: release comments are
    // credited to the dev seat instead, which is what they were before.
    process.stdout.write(
      route.resolved?.releaseSeat
        ? 'release seat:    this ship has its own Release Crew row\n'
        : 'release seat:    none — release comments are credited to the dev seat; run `crew connect` once the Crew table has this ship\'s row\n',
    );

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

    // CREW-1390: the operator comments from the app, where a comment carries only
    // the server-stamped identity — so it is attributed only if the operator's
    // Crew row links to it (`user_id`). Without that, their answer reads "(no
    // identity)" and a seat refuses to act on it.
    {
      const op = route.resolved?.operator;
      const row = op ? crewRows.find((c) => c.id === op) : undefined;
      if (!op) {
        process.stdout.write('operator identity: no operator on this route — run `crew connect`\n');
      } else if (!row) {
        process.stdout.write(`operator identity: ERROR operator ${op} is not a row of the Crew table\n`);
        process.exitCode = 1;
      } else if (!row.user_id) {
        process.stdout.write(
          `operator identity: ERROR Crew row "${row.name ?? op}" has no user_id — their UI comments will read ` +
            '"(no identity)"; link it to the account they sign in with\n',
        );
        process.exitCode = 1;
      } else {
        const resolves = memberByIdentity(buildRoster(configuredMembers(route), crewRows), row.user_id);
        process.stdout.write(
          resolves
            ? `operator identity: comments from ${row.name ?? op} resolve to ${crewLabel(resolves)}\n`
            : `operator identity: ERROR user_id ${row.user_id} does not resolve through the roster\n`,
        );
        if (!resolves) process.exitCode = 1;
      }
    }

    // CREW-1389: in-flight tickets with no ship hold, or held by a ship that has gone quiet.
    if (ships.length > 0) {
      try {
        const humanHolds = new Set(holdIds(buildRoster(configuredMembers(route), crewRows)));
        const warnings = holdWarnings(await tracker.openTickets(), ships, tracker.contract, humanHolds);
        process.stdout.write(
          warnings.length === 0
            ? 'ship holds:       every in-flight ticket is held by a live ship\n'
            : warnings.map((w) => `ship holds:       WARNING ${w}\n`).join(''),
        );
      } catch (e) {
        process.stdout.write(`ship holds:       could not check — ${(e as Error).message}\n`);
      }
    }

    // The daemon runs under launchd/systemd with `pathFor(ship)`, not this
    // shell's PATH, so the agent binary and git are checked against that PATH.
    // A miss here is the CREW-1365 failure mode: every spawn ENOENTs.
    const schedulerPath = pathFor(cfg.ship);
    const agentBinPath = findOnPath(cfg.ship.agent.bin, schedulerPath);
    const gitPath = findOnPath('git', schedulerPath);
    process.stdout.write(
      `agent binary:      ${cfg.ship.agent.bin} — ${agentBinPath ? `OK (${agentBinPath})` : 'NOT FOUND on the scheduler PATH'}\n` +
        `git:               ${gitPath ? `OK (${gitPath})` : 'NOT FOUND on the scheduler PATH'}\n`,
    );
    if (!agentBinPath || !gitPath) {
      process.stdout.write(
        `                   scheduler PATH is ${schedulerPath} — ` +
          'add the directory holding the missing binary to ship.extraPath in crew.yaml, then re-run `crew doctor`.\n',
      );
    }

    // CREW-1378: is the Tablation MCP server registered with Claude Code for this route?
    if (route.apiKey) {
      const mcpUrl = mcpUrlFor(route.baseUrl);
      const m = inspectClaudeMcp({ bin: cfg.ship.agent.bin, url: mcpUrl, key: route.apiKey });
      process.stdout.write(
        m.state === 'registered' ? `mcp:               tablation registered (user scope) → ${m.url}\n`
          : m.state === 'no-claude' ? `mcp:               claude not found — Claude Code was not checked\n`
          : m.state === 'different' ? `mcp:               tablation registered but not for this route — ${m.detail}\n`
          : `mcp:               not registered — run crew connect\n`,
      );
    }

    // Repo hook commands against the same scheduler PATH (CREW-1373): a hook
    // whose command is missing exits 127 under the scheduler and, until now,
    // was visible only because the failed release filed a ticket. Raised here
    // as `hook_missing` so it shows on the board and in `crew status`; the
    // release phase raises the same key when it actually sees the exit.
    for (const c of cfg.routes.filter((r) => r.enabled)) {
      let repos: Awaited<ReturnType<typeof resolvedRepos>>;
      try { repos = await resolvedRepos(c); } catch { continue; }
      for (const r of repos) {
        for (const name of ['setup', 'test', 'build', 'deploy'] as const) {
          const script = r.config.hooks[name];
          const cmd = script ? hookCommand(script) : null;
          if (!cmd) continue;
          const key = `hook_missing:${c.route}/${r.name}/${name}`;
          if (findOnPath(cmd, schedulerPath)) { clearShipAttention(state, key); continue; }
          process.stdout.write(`hook ${c.route}/${r.name} ${name}: \`${cmd}\` NOT FOUND on the scheduler PATH\n`);
          await raiseShipAttention({ state, emit, route: c, ship: cfg.ship }, {
            kind: 'hook_missing', key,
            message: `${c.route}/${r.name}: the ${name} hook runs \`${cmd}\`, which is not on the scheduler PATH — add its directory to ship.extraPath in crew.yaml`,
            since: new Date().toISOString(),
          });
        }
      }
    }
    for (const i of openShipAttention(state)) {
      process.stdout.write(`attention:         ${i.kind} — ${i.message} (since ${i.since})\n`);
    }

    // Foreign launchd units (CREW-1376): another checkout's, or a stale one
    // from before this checkout moved. Listed with load state and last exit
    // so a unit firing into a dead path is visible here, not only in launchctl.
    if (host === 'macos') {
      const foreign = describeForeignLaunchdUnits(CREW_HOME);
      if (foreign.length > 0) {
        process.stdout.write(`foreign launchd units (not this checkout's — \`crew install\` or \`crew uninstall --all\` clears them):\n${foreign.join('\n')}\n`);
      }
    }

    // Host Passengers preflight (ISSUE-553): a route can declare
    // `hostPassengers: true` with no way for `crew connect`/`crew run` to
    // have warned about it yet, so `doctor` is where a missing prerequisite
    // has to surface — clearly, not as a container-lifecycle crash three
    // commands from now.
    const passengerRoutes = cfg.routes.filter((r) => r.enabled && r.hostPassengers);
    if (passengerRoutes.length === 0) {
      process.stdout.write('host passengers:   off (no enabled route sets hostPassengers: true)\n');
    } else {
      const dockerOk = dockerAvailable();
      const dockerPathIssue = dockerPathProblem(cfg.ship);
      const dockerKey = 'docker_missing';
      if (dockerPathIssue) {
        process.stdout.write(`docker on scheduler PATH: NOT FOUND — ${dockerPathIssue}\n`);
        await raiseShipAttention({ state, emit, route: passengerRoutes[0]!, ship: cfg.ship }, {
          kind: 'docker_missing', key: dockerKey,
          message: `Host Passengers is on but ${dockerPathIssue}`,
          since: new Date().toISOString(),
        });
      } else {
        clearShipAttention(state, dockerKey);
      }
      const keygenOk = sshKeygenAvailable();
      const image = passengerImageRef(cfg);
      const imageOk = dockerOk && imagePresent(image);
      process.stdout.write(
        `host passengers:   ON for ${passengerRoutes.map((r) => r.route).join(', ')}\n` +
          `                   docker:     ${dockerOk ? 'OK' : 'NOT AVAILABLE'}\n` +
          `                   ssh-keygen: ${keygenOk ? 'OK' : 'NOT AVAILABLE'}\n` +
          `                   image:      ${image} (${imageOk ? 'present' : 'missing'})\n` +
          `                   relay host: ${cfg.ship.relayHost ? `${cfg.ship.relayHost}:${cfg.ship.relayPort}` : 'not set (ship.relayHost) — containers will run with no tunnel'}\n`,
      );
      if (!dockerOk) {
        process.stdout.write(
          '                   Docker Desktop (or another Docker daemon) is required for Host Passengers — ' +
            'install/start it, then re-run `crew doctor`. The toggle stays armed in crew.yaml but nothing will ' +
            'start until Docker answers `docker info`.\n',
        );
      }
      if (!keygenOk) {
        process.stdout.write(
          '                   `ssh-keygen` is required to mint this ship\'s tunnel identity — install OpenSSH, ' +
            'then re-run `crew connect` to sync a key onto this workspace\'s Ships row.\n',
        );
      }
      if (cfg.ship.relayHost) {
        // The URL a tunnel would register, for a slug that is already persisted.
        for (const r of passengerRoutes) {
          const ws = r.resolved?.workspaceId;
          const slug = ws ? readPersistedTunnel(cfg.ship.stateDir, ws)?.slug : undefined;
          if (!ws) continue;
          process.stdout.write(
            `                   ${r.route} url: ${slug ? publicUrlFor(slug, cfg.ship.relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain) : 'not minted yet (first tunnel cycle creates it)'}\n`,
          );
          const api = endpointApiFor([r])(ws);
          if (!api) continue;
          const probe = await probeEndpointAccess(api, ws);
          process.stdout.write(
            `                   ${r.route} mcp endpoints: ` +
              (probe === 'ok' ? 'OK (key may register its endpoint)'
                : probe === 'forbidden' ? `403 — ${REGISTER_MCP_ENDPOINTS_HINT}`
                : `could not check (${probe.error})`) + '\n',
          );
        }
      }
      for (const r of passengerRoutes) {
        const included = passengerRepoTargets(r);
        process.stdout.write(
          `                   ${r.route}: ${included.length ? included.map((t) => t.name).join(', ') : '(no repos included)'}\n`,
        );
      }
    }
    // CREW-1288: the opt-in action phase. `--fix` is itself the consent (so it
    // also works unattended); a plain run only ever offers, and only on a real
    // terminal. A script or non-TTY run without `--fix` never prompts and
    // never changes anything.
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
    if (flag('fix') || interactive) {
      await doctorFix({ prompt: !flag('fix') || interactive, host });
    }
    break;
  }

  default:
    usage();
}

lock?.release();
}
