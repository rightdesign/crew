#!/usr/bin/env node
/**
 * `crew` — the CLI.
 *
 * Every command that could change something takes `--dry-run`, and the
 * interlock (`enabled: false` per route) refuses anything that writes
 * until an operator arms it deliberately.
 */

import { doctorBaseReport } from './doctor-repo.ts';
import { periscopeSummary, previewHostProblem, previewHostFinding, routePeriscopeProblems, duplicateLivePeriscopes, type PeriscopeProblem } from './periscopes.ts';
import { prepareDropFile, readPointedAt } from './periscope-pointed.ts';
import { registerCodeServer } from './intel-register.ts';
import { dropSerenaFolder, missingPrerequisites, realSerenaDeps, startSerena } from './intel-serena.ts';
import { intelFlavor, wantsCodeBridge, lspFlavor, lspBinaryFound, ensureLspPlugin, LSP_SERVERS } from './intel.ts';
import { periscopesForStatus, portListening, urlPort, writePeriscopeSidecar, removePeriscopeSidecar, readPeriscopeSidecars as readSidecars, updatePeriscopeSidecar } from './periscope-state.ts';
import { openPreviewTunnel, stopRecordedTunnel, type PreviewRelay } from './periscope-relay.ts';
import { SHELLS, shellFor, shellInitScript } from './shell-init.ts';
import { dockerGate } from './passengers-cycle.ts';
import { repoFindings, attentionProblems, visibleAttention, dockerDaemonFinding, deadTunnelFindings, type DoctorProblem } from './doctor-problems.ts';
import { sandboxHookGaps, imageHasBinary, imageStoreProblem } from './sandbox-hooks.ts';
import {
  planSandbox, shipSandboxRef, SHIP_SANDBOX_KEY, readBridgeBundle, readWarmFiles, type WarmFiles, readSandboxState, sandboxImageFor, sandboxBuildTick, sandboxImageStatus, spawnBuildRunner, engineHasImage, engineRemoveImage,
  sandboxFailedKey, type SandboxRepoRef, type TickDeps,
} from './sandbox-image.ts';
import { settleRepos, probePushAuth, toolChecks, isPrBased, mentionsNode, formatToolCheck, formatPushAuth, probeCredentialHelper, staleOwnLockClaim, formatStaleOwnLock, roleCapWarnings, managedRuntimeWarnings, managedGitIdentityWarnings, readGlobalGitIdentity, runtimeDirWarning, type PushAuthResult, type ToolCheck } from './doctor-checks.ts';
import { describeClaudeAuth, inferenceBaseUrl } from './adapters/claude.ts';
import { runSelftest, recordSelftest, readSelftest, formatResult, doctorSelftestLines, REMEDY, type SelftestResult } from './selftest.ts';
import { runSelfLaunchCheck } from './self-launch-check.ts';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, homedir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { pickWorktreeRoute, positionalArgs, helpRequest, versionRequest, splitConnectArg, splitWorktreeArgs } from './argv.ts';
import {
  loadConfig, findConfigFile, findRoute, routeForDir, locateDir, resolveApiKey, hydrateApiKeys, reposOf, repoIdForName, shipWorktreePrefixFor,
  ticketsByRepo, configuredMembers, crewVersion, routeSlug,
  DEFAULT_BASE_URL, DEFAULT_REPOS_BASE_PATH, resolvedPathFor, apiKeyPathFor, dirForRepo, repoTargetFor, mergeRouteRelease, passengerRepoTargets,
  type Unplaceable, type UnplaceableReason,
  splitRoute, ConfigError, ROLE_NAMES, ROLE_LABEL, type RoleName, type RepoTarget, type Route, type Ship, releaseSeat, shipPair,
} from './config.ts';
import { buildRoster, crewLabel, holdIds, memberByIdentity } from './roster.ts';
import { State } from './state.ts';
import { adoptSessionAddress, rememberedAddressFor, resumableSessions, rememberSession, rememberedSessions, signOutSessions } from './connect-resume.ts';
import { runReset, recordClonedCheckout, describeResetStep, resetIncomplete, type ResetEffects, type ResetStep } from './reset.ts';
import { runDeprovision } from './deprovision.ts';
import { realDeprovisionDeps } from './deprovision-host.ts';
import { runPoolMember, poolConfigFrom, httpPoolApi, fileMemberStore, defaultMemberDir } from './pool-member.ts';
import { realPoolMemberDeps } from './pool-member-host.ts';
import { Emitter, eventFileFor, rotateEventsFile } from './events.ts';
import { belowFloor, readCrewFloor, sentVersion } from './crew-floor.ts';
import { decideCycle, rosterFor, writeDigest } from './poll.ts';
import { claimStatuses, rankedCandidates, withHoldCheck } from './select.ts';
import { applyHoldReleases, noteReaccepted, holdWarnings, noteTakeover, originBranchSha } from './ship-affinity.ts';
import { resolveTopCandidate } from './claim.ts';
import { markCrewAssistedAtLaunch } from './crew-assisted.ts';
import { refreshUnknownRepos, persistRepoRows } from './repo-refresh.ts';
import { applySweep, blockerInfoMap, missingBlockerIds } from './blocked.ts';
import { applyEpicSync, describeEpicStep } from './epics.ts';
import { planConflictBounce, applyConflictBounce } from './conflict.ts';
import { planBuildFailureBounce, applyBuildFailureBounce, priorBuildFailures, priorFailureNote } from './build-failure.ts';
import { planStrandedVerified, applyStrandedVerified } from './stranded-verified.ts';
import { gateRedTickets, gateRedComment, alreadyReported } from './gate-red.ts';
import { localRefSkipComment, localRefSkipReported } from './local-ref-skip.ts';
import { checkSandboxRunner } from './runner.ts';
import { planAgentRun, describePlan, spawnAgent, CREW_LANE_ROLE_VAR, sandboxPolicyInputFor } from './agent.ts';
import { generateSandboxPolicy } from './sandbox-policy.ts';
import { guardRunHandoff, describeHandoffPush, repoConfigFor, pushedEventBody } from './handoff-guard.ts';
import { planRunWorktree, applyRunWorktree, describeRunWorktreePlan, planIsUsable } from './run-worktree.ts';
import { hostPlatform, satisfies, explain, isShipPlatform } from './platform.ts';
import { platformAdmitters, platformStuckNote } from './platform-gate.ts';
import {
  runWizard, shouldRunWizard, firstRunConfigPath, renderShipBlock, renderFullConfig, writeNewConfig, nextSteps,
  type Prompter, type WizardAnswers,
} from './connect-wizard.ts';
import {
  CHOICE_EXIT_CODE, choiceData, createEmitter, flagWizardAnswers, parseChoices, usesFlagAnswers, type ChoiceOption,
} from './connect-json.ts';
import { runProvision, provisionOptionsFrom, realProvisionDeps, isManagedShipKind } from './provision.ts';
import { collectDiagnostics } from './diagnostics.ts';
import { schedulerLogFor } from './install.ts';
import { crewInvocation, unitAbandonsAgents, installContext, planInstall, planUninstall, applyInstall, applyUninstall, detectSystemd, planDaemonControl, labelFor, systemUnitPathFor, pathFor, findOnPath, dockerPathProblem, COMMON_DOCKER_DIRS, clearForeignLaunchdUnits, removeAllLaunchdUnits, loadedCrewLabels, describeForeignLaunchdUnits, withUserBusEnv } from './install.ts';
import { REPO_CONFIG_FILENAMES, parseRepoConfig, loadRepoConfig, loadRepoConfigTolerant, resolveRepoConfig, validateEffective, renderBranchName, effectiveBranchTemplate, type ShipRepoSettings, type RepoConfig } from './repo-config.ts';
import { runRelease, selfRepairLine, summarizeOutcome, emitReleaseSummary, type RepoReleaseSummary, type RoutedReleaseSummary } from './release-run.ts';
import { decideRelease, describeHeld, heldByBlockers, planReleasedBranches, releaseIdle, reportUnplaceable } from './release.ts';
import { locateBranchForTicket, pushedBranchForTicket } from './ticket-branch.ts';
import { remoteOf } from './remote-dir.ts';
import { planStamp, applyStamp, applyMergeStamp, applyExternalClosures } from './stamp.ts';
import { applyReview } from './review.ts';
import { verifiedShaFor } from './verified-tip.ts';
import { sandboxEnv } from './sandbox-brief.ts';
import { renderEnvironment } from './environment.ts';
import { withRepoMaps, mapFilePath, inspectMapFile } from './repo-map.ts';
import { notify, describeRelease, recoveredFailureHeadlines } from './notify.ts';
import { applyFailureAlert, applyFailureRecovery } from './failure-alert.ts';
import { describeRun, liveRuns, settleRunEnd } from './live-runs.ts';
import { lastRunsBySeat } from './run-snapshot.ts';
import { anyRunAcceptsInput, COMMENT_DELIVERY_BACKOFF_MS, runCommentDeliveryPass } from './comment-delivery.ts';
import { startLaunchdDaemon } from './launchd-start.ts';
import { probeDaemonUnit, readDaemonStamp, daemonLineText, daemonKnownDead, reloadRequestText, daemonProblem, type DaemonLiveness } from './daemon-liveness.ts';
import { Tracker, type Ticket, displayKey } from './tracker.ts';
import { discoverForRoute, linkDoctorLines } from './pr-links.ts';
import { reportStartFailure, clearStartFailure, fallbackStateDir } from './daemon-start-failure.ts';
import { buildProjectsReport, formatProjectsReport } from './projects-cmd.ts';
import { runCredential, runForge } from './forge-cmd.ts';
import { repositoryEnvCount } from './repo-env.ts';
import { gitCredentialEnv, crewCommandLine, isCompiledCrew, hasForgeToken, forgeOfRemote, readForgeToken, forgeFor, forgeDescriptorFor } from './forges.ts';
import { judgeServable, explainRefusal, lacksCheckout, cacheRepoOfTarget, mirrorRepoOfTarget, readMirrorContract, readMirrorWarmFiles, noCheckoutReleaseNote, releasesFromSandbox, skipsHostCheckout, firstReport, repoContractFor } from './mirror-contract.ts';
import { openReleaseSandbox } from './release-sandbox.ts';
import { sandboxImageForRun } from './sandbox-image.ts';
import { makeSandboxHygiene, diskFullStop } from './sandbox-hygiene.ts';
import { SandboxCache, type CacheRepo, cacheSettingsOf, makeCachePass, unmirroredRepos, sandboxCacheKey, parseRemote, type PassRepo, type RefreshOutcome } from './sandbox-cache.ts';
import { buildWhoami, formatWhoami } from './whoami.ts';
import { projectModeLabels, withoutManualVerified } from './work-mode.ts';
import { operatorTodo } from './attention.ts';
import { probeSeatWrites, seatCannotWriteMessage, SEAT_NO_WRITE_REMEDY, probeSeatReads, describeSeatForbidden, describeSeatTables, isForbiddenError, seatForbiddenItem, seatForbiddenRepoLine, SEAT_FORBIDDEN_KEY, SEAT_NO_READ_REMEDY } from './seat-read-probe.ts';
import { StaleWriteError } from '@tablation/client';
import { releaseLockScope, type BoardLockResult } from './board-lock.ts';
import { releaserFor, nonReleaserNote, missingReleaserWarning } from './release-ship.ts';
import { validateContract, DEFAULT_CONTRACT, EVENT_LOG_STATUS_UNTRACKED } from './contract.ts';
import { startWatch } from './watch.ts';
import { findOrphansIn, listeners, ticketForPort, killGently, pidsInWorktree, worktreeExistsIn } from './ports.ts';
import { gatherInbox, renderInbox } from './inbox.ts';
import { renderStatus, type StatusRepo, type StatusLastRun } from './status-render.ts';
import { decideFleet, renderFleet, snapshot, changed, nextRoles, since } from './fleet.ts';
import {
  discover, get as connectGet, listWorkspaces, renderConnection, ConnectHttpError, provisionReleaseLocks, linkOperatorRow, createOperatorRow,
  listLibraryTemplates, previewTemplateInstall, installTemplate, ISSUES_TEMPLATE_IDENTIFIERS, resolveIssuesTemplateKeys,
} from './connect.ts';
import {
  hostFromUrl, loginWithDeviceCode, DeviceLoginError,
  type SessionStore,
} from '@tablation/client';
import { getSessionStore, describeKeyStore } from './secret-store.ts';
import { mintMissingSeatKeys, describeMintOutcome, type MintOutcome, revokeSeatKeys, describeRevokeOutcome, canMintAgentKeys, withFoundSeats, resolveSeatKey, resolveReleaseKey, SEAT_KEY_ROLES } from './seat-keys.ts';
import { checkCapabilities, describeCapability, missLine } from './capability-check.ts';
import { routeAvatarFailures } from './persona-avatars.ts';
import { syncPersonas, fetchKeyRole, isAdminRole, isForbidden, personaDefaultPrompt, describeSyncOutcome, describeCrewLink, AgentsSyncError, fetchPersonaPrompt, personaPromptOptions, fetchSeatPersona, resolveAgentId, currentPersonaPrompt, PERSONA_NAME } from './agents.ts';
import { runAgentsSync } from './agents-sync-run.ts';
import { summarizeOutcomes, summarizeJobs, withFix, describeRunOutcome, type JobResult } from './cli-output.ts';
import { syncSkills, fetchSkillOverrides, skillMarkerWarnings, describeSkillSyncOutcome, SkillSyncError } from './skills.ts';
import { listLogEntries, showLogEntry, formatBeforeEdit, LogbookError } from './logbook.ts';
import { checkRepoSpec, checkHookSyntax, renderRepoCheck } from './repos-check.ts';
import { parseHooksArgs, repoDirOf, suggestHooks, selectRecipes, parseHookOverrides, planRouteHooks, clearRouteHooks, starterRepoConfig, existingRepoConfig } from './repos-hooks.ts';
import { runAgentSuggest, AgentSuggestError, type AgentSuggestion } from './repos-hooks-agent.ts';
import { SAMPLE_REPO, SAMPLE_REMOTE, SAMPLE_CREW_YAML, SAMPLE_README, sampleDir, isSampleTicket, planSampleTicket } from './sample-ticket.ts';
import { parseAddArgs, parseCloneArgs, planRepoClone, routeNamesOf, planRepoAdd, planRepoRemove, planRepoRow, resolveRepoProject, configuredRepos, cloneBaseOf, listRepoRows, matchRepoName, normalizeRemote, ReposError, type RepoRemotes } from './repos-cmd.ts';
import { mcpUrlFor } from './claude-mcp.ts';
import { pairInstallerFor, harnessPromptNote, isPairHarness } from './pair-install.ts';
import { adapterFor, resolveSeat, resolveToolchain, shipToolchains, toolchainVendor, isOriLauncher, isOmlxLauncher } from './toolchain.ts';
import { launcherExecutable, readOmlxSettings, interpretOmlxProbe, omlxModelPresent } from './launcher.ts';
import { compareSnapshot, isStale, liveReleaseSeat, snapshotAge, staleSnapshotMessage, type SnapshotDiff } from './snapshot-staleness.ts';
import { gatherHealth, planFix, planEnable, routesInScope, schedulerInstalled } from './doctor-fix.ts';
import { DoctorReport, renderDoctor, fixPhaseNothingToOffer } from './doctor-report.ts';
import {
  resolve as gitResolve, worktrees, git, gitOk, syncState, fastForward, fetchRemote, branchForIssue, worktreeForNumber,
  remoteConfigured, remoteBranchExists, deleteRemoteBranch, findKeyInRange, firstReleaseTagContaining,
  ensureRepoCheckout, acquireCheckoutLock, originUrlOf, setCloneRecorder, setForgeTokenHosts, status as gitWorkingTreeStatus, pushBranchUpstream, headSha, GitError, refreshBaseBranch, baseBranchUnsafe, describeUnsafeBase, type SyncState,
} from './git.ts';
import { planWorktreeSweep, applyWorktreeSweep, planRemoteBranchCleanup, applyRemoteBranchCleanup, planLocalBranchCleanup, applyLocalBranchCleanup, sweepCandidatesExist, worktreeTicketNumbers, draftWorktrees, orphanedWorktreeDirs, warnOrphanedWorktreeDirs, remoteBranchTicketNumbers, localBranchTicketNumbers } from './worktree-sweep.ts';
import { planStreamSweep, planEventsSweep, applyStreamSweep } from './stream-sweep.ts';
import { realpathSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, unlinkSync, copyFileSync, renameSync, statSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { runScript, resolveShell } from './shell.ts';
import { runPeriscopeResume } from './periscope-resume.ts';
import { periscopeIdleKey } from './periscope-idle.ts';
import {
  PeriscopeError, LivePeriscopeError, assertNoLivePeriscope, existingRefusal, readPeriscopePrior, writePeriscopePrior, removePeriscopePrior, parsePeriscopeUpArgs, parsePeriscopeDownArgs, periscopeCaps, periscopePreflight, runPeriscopeUp, runPeriscopeDown,
  upOutput, shouldOpen, openerFor, rowForCwd, defaultTopic, type PeriscopeUpArgs,
  periscopeListEntries, formatPeriscopeList, type PeriscopeDeps, type PeriscopeDownDeps, type PeriscopeLimits, type PeriscopeRowInfo,
} from './periscope-cmd.ts';
import { dirname as dirOf, resolve as resolvePath } from 'node:path';
import { isCompiledBinary, selfLaunch } from './runtime-info.ts';
import { builtVersion, bundleStaleness, REBUILD_HINT } from './bundle-staleness.ts';
import { ensureShipSshKeypair, sshKeygenAvailable } from './ssh-keys.ts';
import { describeRelayProbe, probeRelayControl } from './relay-probe.ts';
import { shipIdentityJson } from './ship-status.ts';
import { ensureMachineId, matchShipRows } from './machine-id.ts';
import { ShipNameError, reconcileRouteShipName, validateShipName, setShipNameInYaml, pickShipRow, readSyncedName, writeSyncedName } from './ship-name.ts';
import {
  dockerAvailable, ensureImage, imagePresent, passengerImageRef, passengerCheckoutSyncSpecs, planContainers, syncAllPassengerCheckouts, syncPassengerContainers,
  type ContainerPlan,
} from './passenger-containers.ts';
import {
  syncPassengerTunnels, startPreviewTunnel, generateTunnelSlug, readPersistedTunnel, isPidAlive, publicUrlFor, relayBaseUrlFor, rotatePersistedSlug, updatePersistedTunnel, type TunnelPlan,
  TUNNEL_REJECTED_KEY, TUNNEL_REJECTED_AFTER, tunnelRejectedMessage, rejectedTunnels, deadTunnels,
  RELAY_CONTROL_UNSUPPORTED_KEY, relayControlUnsupportedMessage, controlRefusedTunnels, staleTunnelAttentionKeys,
} from './tunnel.ts';
import {
  reconcileEndpoint, unregisterEndpoint, probeEndpointAccess, REGISTER_MCP_ENDPOINTS_HINT,
  type EndpointApi, type ReconcileDeps,
} from './mcp-endpoint-registry.ts';
import { runSyncDaemonFromEnv, syncPassengerSyncDaemons } from './passenger-sync-daemon.ts';
import { launchProxy, runProxyFromEnv } from './periscope-proxy.ts';
import { runBridge } from './intel-bridge.ts';
import { startWorktreeIntel } from './intel-worktree.ts';
import { materializeMirrorCheckouts } from './passenger-mirror.ts';
import { describeCause, TRACKER_OUTAGE_KEY } from './outage.ts';
import { contractFixers } from './contract-refusal.ts';
import { reconcileHeldWorktrees, openShipAttention, raiseShipAttention, clearShipAttention, hookCommand, baseAttention, seatKeyUnreadableItem, seatKeyUnreadableKey, repoContractRefusedItem, repoContractRefusedKey, repoPlatformUnreleasableItem, repoPlatformUnreleasableKey, dockerDaemonItem, DOCKER_DAEMON_KEY, DOCKER_REMEDY } from './ship-attention.ts';
import {
  runDaemonLoop, runFleetPass, makeStaleChecker, SpawnBreaker,
  reloadSentinelFor, readReloadRequestedAt, noteDaemonStarted, readDaemonStarted, configChangedAfter,
} from './daemon.ts';
import { ControlAuth, controlSocketFor, crewJson, schedulerHandler, startControlServer } from './control-api.ts';
import { runCrew } from './periscope-control.ts';
import { handlePeriscopeMcp, findPeriscope, type PeriscopeHook } from './periscope-mcp.ts';
import {
  mintPeriscopeSecret, readPeriscopeSecret, removePeriscopeSecret, listPeriscopeEndpoints, registerPeriscopeEndpoint, removeEndedPeriscopeEndpoints,
  type PeriscopeEndpointDeps,
} from './periscope-endpoints.ts';
import { readPeriscopeSidecars } from './periscope-state.ts';

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
/** CREW-2871: issues with more than one live Periscopes row on this route, for doctor; empty when the table is absent or unreadable. */
/**
 * CREW-3255: clears `branch_url` on a deployed ticket once its remote branch is
 * gone. `pr_url` stays: it is the record of the review.
 */
function clearBranchLink(tracker: Tracker): (t: Ticket) => Promise<void> {
  return async (t) => {
    const col = tracker.contract.columns.branchUrl;
    const v = (t as Record<string, unknown>)[col];
    if (typeof v !== 'string' || !v.trim()) return;
    await tracker.updateTicket(t.id, { [col]: null });
  };
}

async function duplicateLivePeriscopeProblems(route: Route, ship: ConstructorParameters<typeof Tracker>[1]): Promise<PeriscopeProblem[]> {
  try {
    const tr = new Tracker(route, ship);
    const rows = await tr.livePeriscopesAllShips();
    const refOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id);
    const counts = new Map<string, number>();
    for (const r of rows) { const t = refOf(r.issue_id); if (t) counts.set(t, (counts.get(t) ?? 0) + 1); }
    const dupIds = [...counts].filter(([, n]) => n > 1).map(([t]) => t);
    if (dupIds.length === 0) return [];
    const tags = new Map((await tr.ticketsByIds(dupIds)).map((t) => [t.id, t.issue_tag ?? t.issue_id]));
    const ships = new Map((await tr.shipRows()).map((x) => [x.id, x.name ?? x.id]));
    return duplicateLivePeriscopes(rows, (id) => tags.get(id) ?? id, (id) => (id ? ships.get(id) ?? id : 'an unknown ship'), route.route);
  } catch { return []; }
}

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
async function pickOperator(
  holds: Array<{ id: string; name: string; user_id?: string | null; detail?: string }>,
  me: { id?: string; name?: string; email?: string },
): Promise<string | undefined> {
  // A row carrying another identity is someone else's, not an option.
  const choices = holds.filter((h) => !h.user_id || h.user_id === me.id);
  const canCreate = !!me.id;
  process.stderr.write('\nWhich of these Crew rows is you?\n');
  choices.forEach((h, i) => process.stderr.write(`  ${i + 1}. ${h.name || 'unnamed row'}${h.detail ? ` <${h.detail}>` : ''}\n`));
  if (canCreate) process.stderr.write(`  0. Create a new Crew row for ${me.name ?? ''} ${me.email ?? ''}`.trimEnd() + '\n');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // With no plausible listed row, creating one is the default.
    const fallback = canCreate && choices.length === 0 ? '0' : '';
    const answer = ((await rl.question(`Enter a number (blank to ${fallback ? 'create one' : 'skip'}): `)).trim()) || fallback;
    const n = Number(answer);
    if (!answer || !Number.isInteger(n) || n < 0 || n > choices.length) return undefined;
    return n === 0 ? (canCreate ? NEW_OPERATOR_ROW : undefined) : choices[n - 1]!.id;
  } finally {
    rl.close();
  }
}

/** `pickOperator`'s answer for "make me a new Crew row" (CREW-1798). */
const NEW_OPERATOR_ROW = 'new';

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
  /** Set when the answer came from `--choose install-template=` rather than a terminal: no prompt is shown. */
  decided?: boolean,
): Promise<string | undefined> {
  const templates = await listLibraryTemplates(authOpts);
  // Offer the preferred identifier; fall back to an older one (or whatever
  // the platform resolves them to) only when it is the sole thing published.
  const keys = await resolveIssuesTemplateKeys(authOpts);
  const template = templates.find((t) => t.identifier === ISSUES_TEMPLATE_IDENTIFIERS[0])
    ?? templates.find((t) => keys.has(t.identifier) || keys.has(t.id));
  if (!template) {
    process.stderr.write(`\n  No template with identifier "${ISSUES_TEMPLATE_IDENTIFIERS[0]}" is published to the Library yet — nothing to offer to install.\n`);
    return undefined;
  }
  if (decided === undefined) {
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
  } else if (!decided) {
    return undefined;
  }

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

/**
 * Usage on request (`crew --help`, `-h`, `help`; CREW-2410) goes to stdout and
 * exits 0. Usage on error goes to stderr and exits 2, led by a line naming what
 * was not understood when there is one.
 */
function usage(problem?: string, requested = false): never {
  const text = `crew — a standing team of headless agents

  crew poll [route] [--verbose]  decide a cycle and report it; writes nothing; --verbose adds counts and timestamps
  crew run [route] [--role R]    run the winning role's session
  crew release [route]           merge what QA verified, version it, ship it
  crew merge [route]             merge verified branches and stop
  crew deploy [route]            release now, even with nothing new to merge
  crew watch [route]             live view of what the crew is doing
  crew --version [--json]        print the crew version on one line (also: crew version); --json adds home and compiled
  crew status [route] [--json] [--verbose]   what is running and what needs a person; --verbose adds configuration and full lists; --json for a machine reader
  crew projects [--route R] [--json]   the Projects rows each route can read (id, name, prefix, work mode)
  crew provision --key K --route WS[/PROJECT] [--forge-host H] [--ship-name N] [--json]   one non-interactive run: connect, forge tokens,
                                 enable routes, install units with lingering, start the daemon; safe to re-run (CREW_CONNECT_KEY,
                                 CREW_PROVISION_ROUTES, CREW_SHIP_NAME, CREW_FORGE_TOKEN[_<HOST>] also read)
  crew pool-member [--url U] [--token-stdin]   a host with no tenant: register with the platform, wait for a lease, provision from it, wipe at release
                                 (CREW_POOL_URL, CREW_POOL_TOKEN also read; docs/pool-member.md)
  crew deprovision [--dry-run] [--json]   wipe everything a lease left on this host: runs, sandboxes, Ships-row state, seat keys, forge tokens,
                                 checkouts, labeled cache volumes and image layers, state directory, crew.yaml; exits non-zero listing what remains
  crew forge [set|rotate <host>] [--token T | --token-stdin] [--source file|keychain|env]   this ship's git-forge tokens (ship.forges)
  crew credential get|store|erase   git credential helper answering from ship.forges (git runs it; not for hand use)
  crew whoami [route] [--json]   the signed-in identity, key role, operator Crew row and credential source per route
  crew reload                    make the running daemon re-read crew.yaml (--now: restart it immediately)
  crew doctor [route] [--fix] [--offline] [--verbose] [--json]   preflight: findings first, then a verdict; --verbose lists every check; --fix enables clean routes and offers crew install;
                                 --offline skips push probes; --json prints push-auth and tool checks only
  crew selftest [route] [--toolchain NAME] [--json]   launch each toolchain as a run would and prove it reaches the tracker
  crew sample-ticket [route] [--remove] [--dry-run] [--json]   file one ticket on a throwaway repo that walks the dev, QA and release loop
  crew ports [route]             which checkout owns which ports, and what is up
  crew sandbox policy --route R --role ROLE [--repo NAME] [--json]   print the sandbox policy a run of that role would get
  crew reap [route]              kill orphaned servers, drop worktrees for closed tickets
  crew drop [route] NNN          remove a merged ticket's worktree and branch
  crew rotate-passenger-url [route]   force a Host Passengers tunnel to reconnect with a fresh public URL
  crew periscope up [[route] REPO] [--topic TEXT|--issue NNN] [--isolate] [--serve-mcp] [--host H] [--no-relay] [--assignee ID] [--no-open] [--open] [--dry-run] [--json]
  crew periscope up --resume NNN restart the preview an idle periscope's server was stopped for
                                 file a draft ticket, cut and prepare its worktree, start the repo's preview hook and record a Periscopes row (alias: start)
  crew periscope down [[route] NNN] --keep|--discard [--allow-empty] [--json]
                                 end a periscope: commit and push its branch (ticket back to new), or throw it away (alias: end)
  crew periscope list [route] [--json]   the live periscopes on this ship, their idle minutes and whether each server is listening
  crew shell-init [--shell zsh|bash|fish]   print the periscope shell function (install: eval "\$(crew shell-init)")
  crew worktree [route] NNN      cut (or refresh) this run's worktree for a ticket from the remote; prints its path
  crew unassign [route] NNN      hand back a session's ticket — clears assignee, next cycle picks it up
  crew sandbox cache [--refresh|--prune|--reset] [--json]   list the sandbox cache volume's mirrors; --refresh runs the daemon's cache pass once (creates missing mirrors), --prune drops unserved repositories, --reset recreates the volume
  crew sync [route]              fast-forward the checkout and its worktrees from the remote
  crew pause|resume [route] [R|release]  pause everything, one role, or releases only (merge/deploy/release; passengers keeps running).
                                 resume with no argument clears only the whole-crew pause; a role or release pause needs its own resume
  crew log [route]               tail the log
  crew inbox [--member NAME]    your tickets across every workspace (or a colleague's)
  crew connect --sign-out [--host H] [--workspace W] [--json]  clear the keychain session a dry-run connect stored (no crew.yaml needed; nothing to remove still exits 0)
  crew connect                  resolve a workspace's ids into a crew.yaml block, then (admin key) sync personas/skills and mint seat keys (--no-agents-sync skips that; --no-mcp skips registering the Tablation MCP server with Claude Code; --mcp replace overwrites a different one; --dry-run works with no crew.yaml and writes none: no file, no rows, no seat keys — the device approval and workspace credential behave as in a real run; with no workspace named it first reuses the keychain session a previous dry-run stored for the host, falling back to device approval when that is missing or rejected, and the signed_in event's session field says which)
  crew disconnect               remove what connect installed for Pair (Claude MCP; Codex/Gemini instructions block and MCP entry per ship.pair)
  crew disconnect --reset [--remove-checkouts] [--dry-run] [--json]   remove everything connect and install wrote on this machine: scheduler units, Pair/MCP entries, seat keys, keychain credential, resolved state, then crew.yaml (--remove-checkouts also deletes checkouts crew cloned, never one with local changes)
  crew agents sync [route] [--force] [--revoke-seat-keys]   push crew's personas AND skill files into the workspace Agents/Agent Skills tables (--force overwrites even a diverged persona or skill; never one marked Customize prompt)
  crew agents prompt R [route] print one persona's current prompt (e.g. R=pair, for a SessionStart hook; --harness H adds which CLI it serves)
  crew skills sync [route]      push only crew's skill files (e.g. grill-me) into the workspace Agent Skills table
  crew ship rename NAME [--json] rename this ship in crew.yaml and on every workspace's Ships row
  crew repos add [ROUTE] [NAME] [PATH]  attach a local checkout to a route in crew.yaml (--dry-run previews)
  crew repos check [PATH]       validate a checkout's .crew.yaml without attaching it (--route ROUTE, --strict, --json)
  crew repos clone [ROUTE] NAME  clone a Repos row's remote into the route directory and attach it (--dir PATH, --dry-run, --json)
  crew repos hooks [ROUTE] NAME suggest test/build hooks for a checkout (--agent, --write route|repo, --recipes, --json)
  crew repos list ROUTE         the checkouts a route has, with the tracker's Repos row each matches (--json: every Repos row too)
  crew logbook list [route]     recent Agent Log entries, filterable by --role/--ticket; --before-edit sorts by searches before the first edit, --bounces by acceptance bounces
  crew logbook show [route] ID [--prompt]   one entry; --prompt reconstructs and verifies its prompt
  crew passengers [route]       sync Host Passengers containers/tunnels once; what the passengers unit invokes
  crew install                  write and load this platform's scheduler unit
  crew uninstall                unload and remove it
     --workspace-id ID --key K [--project NAME] [--area NAME] [--dir PATH] [--name N]
     --json  --machine-id ID  --ship-name N --ship-kind KIND --instance-class KEY --agent-bin PATH --extra-path DIRS --host-passengers --no-wizard --choose KEY=VALUE   (non-interactive: docs/commands.md)

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
`;
  if (requested) {
    process.stdout.write(text);
    process.exit(0);
  }
  process.stderr.write(problem ? `crew: ${problem}\n\n${text}` : text);
  process.exit(2);
}

const argv = process.argv.slice(2);
// `crew --version` (CREW-2404) answers before any config is loaded: it works
// with no crew.yaml and never touches the tracker. stdout carries only the
// version (or the --json object), which the Crew macOS app reads.
if (helpRequest(argv)) usage(undefined, true);
const versionReq = versionRequest(argv);
if (versionReq) {
  const version = crewVersion(CREW_HOME);
  // CREW-3236: a checkout bundle built from another release says so; --json carries it in `builtVersion`.
  const stale = bundleStaleness({ built: builtVersion(), current: version, home: CREW_HOME, compiled: isCompiledBinary(import.meta.url) });
  process.stdout.write(versionReq.json
    ? `${JSON.stringify({ version, home: CREW_HOME, compiled: isCompiledBinary(import.meta.url), builtVersion: builtVersion(), stale: stale !== null })}\n`
    : `${stale ? `${version} (${stale.kind === 'version' ? `running a bundle built from ${stale.builtVersion}` : 'running a bundle older than the source in src/'}; ${REBUILD_HINT})` : version}\n`);
  process.exit(0);
}
// CREW-3279: undocumented build-time check, answered before any config is loaded:
// start a child through selfLaunch() and require it to report this process's own
// version and compiled flag. scripts/build-binaries.sh runs it on the built binary.
if (argv[0] === 'self-launch-check') {
  const verdict = await runSelfLaunchCheck({ version: crewVersion(CREW_HOME), compiled: isCompiledBinary(import.meta.url) });
  (verdict.ok ? process.stdout : process.stderr).write(`${verdict.message}\n`);
  process.exit(verdict.ok ? 0 : 1);
}
// CREW-3236: one stderr line, never stdout, never a failure.
const staleBundle = bundleStaleness({ built: builtVersion(), current: crewVersion(CREW_HOME), home: CREW_HOME, compiled: isCompiledBinary(import.meta.url) });
if (staleBundle) process.stderr.write(`crew: warning: ${staleBundle.message}\n`);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = positionalArgs(argv);
const command = positional[0];
// `crew connect --json` (CREW-2235): events on stdout, human text stays on stderr.
const connectEvents = createEmitter(command === 'connect' && flag('json'), (l) => { process.stdout.write(l); });
const connectChoices = parseChoices(argv);
if (!command) usage(argv.length ? `unknown option "${argv[0]}"` : undefined);

/**
 * Every command the dispatch `switch` below handles, plus `passenger-sync-daemon`
 * above it. An unknown command is rejected here, before any config is loaded
 * (CREW-2492): on a machine with no crew.yaml (CI) `loadConfig` would otherwise
 * throw "no config found" before the dispatch's own `default:` was reached.
 * test/help-cli.test.ts checks this set against the `case` labels.
 */
const KNOWN_COMMANDS = new Set([
  'passenger-sync-daemon', 'periscope-proxy', 'intel', 'agents', 'connect', 'credential', 'provision', 'pool-member', 'deprovision', 'forge', 'daemon', 'deploy', 'disconnect', 'doctor', 'drop', 'inbox',
  'install', 'log', 'logbook', 'merge', 'passengers', 'pause', 'periscope', 'poll', 'ports', 'projects', 'reap', 'release',
  'reload', 'repos', 'resume', 'rotate-passenger-url', 'run', 'sample-ticket', 'sandbox', 'selftest', 'shell-init', 'ship', 'skills', 'status',
  'sync', 'unassign', 'uninstall', 'watch', 'whoami', 'worktree',
]);
if (!KNOWN_COMMANDS.has(command)) usage(`unknown command "${command}"`);
// CREW-2866: the shell function needs no config (it is installed from an rc
// file, before or without a ship), so it is answered before one is loaded.
if (command === 'shell-init') {
  const asked = value('shell');
  if (asked !== undefined && !(SHELLS as readonly string[]).includes(asked)) {
    process.stderr.write(`crew shell-init: unknown shell "${asked}" (have: ${SHELLS.join(', ')})\n`);
    process.exit(2);
  }
  process.stdout.write(shellInitScript(shellFor(asked, process.env.SHELL)));
  process.exit(0);
}

/**
 * `crew repos check` (CREW-2590): print the report for the spec file in `dir`
 * and set the exit status. Prints nothing else, so `--json` stays parseable.
 */
function runReposCheck(dir: string, ship?: ShipRepoSettings): void {
  const report = checkRepoSpec(dir, { ship, strict: flag('strict') });
  if (flag('json')) {
    const { exitCode: _exit, ...rest } = report;
    process.stdout.write(`${JSON.stringify(rest)}\n`);
  } else {
    process.stdout.write(renderRepoCheck(report));
  }
  process.exitCode = report.exitCode;
}

// A bare `repos check [PATH]` names no route, so it must work on a machine
// with no crew.yaml (a freshly cloned repo, CI): answer before config loads.
const reposCheckBare = command === 'repos' && positional[1] === 'check' && !value('route') && positional.length < 4;
if (reposCheckBare) {
  runReposCheck(resolvePath(positional[2] ?? '.'));
  process.exit(process.exitCode ?? 0);
}

/**
 * Route for `agents sync` / `skills sync`, which write to a workspace. Unlike
 * `findRoute`, an unnamed route is only accepted on a one-route ship: falling
 * back to "the single enabled route" on a multi-route ship let a mistyped
 * invocation silently sync the wrong workspace (CREW-1539).
 */
function findSyncRoute(c: Parameters<typeof findRoute>[0], name: string | undefined): ReturnType<typeof findRoute> {
  if (!name && c.routes.length > 1) {
    throw new ConfigError(`this ship has ${c.routes.length} routes — name one: ${c.routes.map((r) => r.route).join(', ')}`);
  }
  return findRoute(c, name);
}

/** crew.yaml plus every route's apiKeyFile: the files a daemon reads once, at startup (CREW-1532). */
function daemonConfigPaths(c: { configFile: string; ship: { stateDir: string }; routes: Array<{ route: string; apiKeyFile?: string }> }): string[] {
  const files = [c.configFile];
  for (const r of c.routes) if (r.apiKeyFile && !files.includes(r.apiKeyFile)) files.push(r.apiKeyFile);
  // CREW-2887: `crew connect` rewrites a route's resolved file, which the daemon reads only at startup.
  for (const r of c.routes) files.push(resolvedPathFor(c.ship.stateDir, r.route));
  return files;
}

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
const STATE_WRITING_COMMANDS = new Set(['connect', 'provision', 'pool-member', 'deprovision', 'disconnect', 'install', 'uninstall', 'reload', 'release', 'merge', 'deploy']);
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

// `provision` (CREW-2792) orchestrates `connect`, `forge`, `install` as child
// processes and needs no crew.yaml at start, so it answers before config loads.
if (command === 'provision') {
  const outcome = await runProvision(
    provisionOptionsFrom(argv, process.env), realProvisionDeps(CREW_HOME),
    (l) => { process.stdout.write(l); }, (l) => { process.stderr.write(l); },
  );
  process.exit(outcome.code);
}

// `pool-member` (CREW-2882): a long-running command for a host with no tenant yet.
// It provisions itself from a lease and wipes itself at release, so like
// `provision` it needs no crew.yaml at start.
if (command === 'pool-member') {
  const pool = poolConfigFrom(argv, process.env, () => readFileSync(0, 'utf8'));
  if (typeof pool === 'string') { process.stderr.write(`crew pool-member: ${pool}\n`); process.exit(2); }
  let stop = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stop = true; });
  const memberDir = process.env.CREW_POOL_DIR ?? defaultMemberDir();
  const code = await runPoolMember(realPoolMemberDeps({
    crewHome: CREW_HOME, platformUrl: pool.url, env: process.env,
    api: httpPoolApi(pool), store: fileMemberStore(memberDir),
    stopping: () => stop,
    log: (l) => { process.stderr.write(`${new Date().toISOString()} pool-member: ${l}\n`); },
  }));
  process.exit(code);
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
} else if (command === 'periscope-proxy') {
  // CREW-2880: the detached process `launchProxy` starts; like the sync daemon it needs no crew.yaml.
  const dropFile = positional[1];
  if (!dropFile) { process.stderr.write('crew periscope-proxy is started by `crew periscope up`, not run by hand\n'); process.exit(2); }
  runProxyFromEnv(dropFile);
} else if (command === 'intel') {
  // CREW-2912: hidden. The stdio server a lane run registers as `code` at launch; like the proxy it needs no crew.yaml
  // (the state directory travels in as an argument). Can be run by hand against a cut worktree for debugging.
  const [, sub, bridgeRoute, bridgeTicket] = positional;
  const stateDir = value('state-dir');
  if (sub !== 'bridge' || !bridgeRoute || !bridgeTicket || !stateDir) {
    process.stderr.write('usage: crew intel bridge <route> <ticket number> --state-dir DIR (registered by a lane run, not run by hand)\n');
    process.exit(2);
  }
  await runBridge(stateDir, bridgeRoute, bridgeTicket);
} else {


/**
 * CREW-3064: a `crew daemon` that cannot start for a reason that will repeat on
 * relaunch leaves a `daemon_start_failed` ship attention item and an `error`
 * event, then (from the second identical failure) sleeps before exiting so the
 * unit's relaunch is one scheduler-log line a minute. It needs nothing that may
 * have failed: the record lives in the state directory, and the Ships row is
 * published on every enabled route whose key resolves, best effort.
 */
async function failDaemonStart(o: {
  stateDir: string; reason: string; fix?: string; code: number;
  routes?: Array<ReturnType<typeof findRoute>>; ship?: Ship; logFile?: string;
}): Promise<never> {
  const failEmit = new Emitter({
    route: '', eventFile: eventFileFor(o.stateDir), logFile: o.logFile, console: () => {},
  });
  const failState = new State(o.stateDir);
  const ship = o.ship;
  await reportStartFailure({
    state: failState, stateDir: o.stateDir, emit: failEmit, reason: o.reason, fix: o.fix,
    logPath: o.logFile ? schedulerLogFor(o.logFile, 'run') : undefined,
    publish: ship ? async () => {
      await Promise.all((o.routes ?? []).filter((r) => r.enabled).map(async (r) => {
        try { await new Tracker(r, ship).publishShipAttention(ship.name); } catch { /* this route's key or tracker may be what failed */ }
      }));
    } : undefined,
  });
  process.exit(o.code);
}

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
// CREW-2235: answers came from flags, so the key must be persisted for the file to be written.
let firstRunFromFlags = false;
// CREW-2416: set when flag answers found no agent binary; a dry run reports it, a real run fails on it.
let agentBinSearched: string[] | undefined;
try {
  const connectIsTTY = !!(process.stdin.isTTY && process.stdout.isTTY);
  const wizardFlags = {
    shipName: value('ship-name'), agentBin: value('agent-bin'), extraPath: value('extra-path'),
    hostPassengers: flag('host-passengers'), noWizard: flag('no-wizard'),
  };
  if (command === 'connect' && !flag('sign-out') && usesFlagAnswers(wizardFlags, connectIsTTY)
    && shouldRunWizard({ isTTY: true, crewHome: CREW_HOME })) {
    // CREW-2235: every answer comes from a flag, so no terminal is needed.
    const flagged = flagWizardAnswers(wizardFlags, {
      hostname: hostname(), platform: hostPlatform(), pathEnv: process.env.PATH ?? '',
      nodePath: process.execPath, dockerAvailable: dockerAvailable(),
    });
    if ('error' in flagged) {
      connectEvents.emit('problem', flagged.error, { stage: 'wizard' });
      process.stderr.write(`crew connect: ${flagged.error}\n`);
      process.exit(2);
    }
    const configPath = firstRunConfigPath();
    firstRun = { answers: flagged.answers, configPath };
    firstRunFromFlags = true;
    agentBinSearched = flagged.agentBinSearched;
    cfg = loadConfig(CREW_HOME, configPath, { text: renderShipBlock(flagged.answers), allowNoRoutes: true });
  } else if (command === 'connect' && !flag('sign-out') && shouldRunWizard({
    isTTY: connectIsTTY, crewHome: CREW_HOME,
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
    const toleratesNoRoutes = command === 'credential' || command === 'forge' || command === 'repos' || command === 'ship' || (command === 'disconnect' && flag('reset')) || command === 'deprovision' || (command === 'connect' && flag('sign-out'));
    // CREW-2443: sign-out and reset exist for a machine whose only trace is a
    // dry-run connect's keychain session, so they must load with NO crew.yaml.
    // Load an empty ship block at the path a config-less connect would have
    // used, which puts stateDir where that connect's `rememberSession` wrote.
    const configless = (command === 'connect' && flag('sign-out')) || (command === 'disconnect' && flag('reset')) || command === 'deprovision';
    if (configless && !existsSync(findConfigFile(CREW_HOME))) {
      cfg = loadConfig(CREW_HOME, firstRunConfigPath(), { text: 'ship: {}\n', allowNoRoutes: true });
    } else {
      cfg = loadConfig(CREW_HOME, undefined, toleratesNoRoutes ? { allowNoRoutes: true } : {});
    }
  }
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`crew: ${e.message}\n`);
    if (command === 'daemon' && !['start', 'stop', 'status', 'restart'].includes(positional[1] ?? '')) {
      await failDaemonStart({
        stateDir: fallbackStateDir(findConfigFile(CREW_HOME)), reason: e.message,
        fix: 'Fix crew.yaml (`crew doctor` names what is wrong)', code: 2,
      });
    }
    process.exit(2);
  }
  throw e;
}
// CREW-2783: `credential` is git calling us, so it answers before anything
// else loads (nothing but stdout may be written), and `forge` needs no route.
if (command === 'credential') {
  const r = runCredential(positional[1], readFileSync(0, 'utf8'), cfg.ship.forges, cfg.ship.stateDir, process.env, !flag('no-miss'));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exit(r.code);
}
if (command === 'forge') {
  const r = runForge(
    { sub: positional[1], host: positional[2], token: value('token'), tokenStdin: flag('token-stdin'), source: value('source'), var: value('var'), path: value('path'), service: value('service') },
    {
      forges: cfg.ship.forges, stateDir: cfg.ship.stateDir, configFile: cfg.configFile,
      readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, t) => writeFileSync(p, t),
      stdin: () => readFileSync(0, 'utf8'), env: process.env,
    },
  );
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exit(r.code);
}
// CREW-2783: with forges configured, every git command crew runs itself goes
// through the ship's credential helper, and clones of a host with a token use
// HTTPS. Nothing is written to disk: this is process environment only.
if (cfg.ship.forges) {
  Object.assign(process.env, gitCredentialEnv({ crewCommand: crewCommandLine(), configFile: cfg.configFile }));
  setForgeTokenHosts(Object.keys(cfg.ship.forges).filter((h) => hasForgeToken(cfg.ship.forges, h, cfg.ship.stateDir)));
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
// `daemon` serves every enabled route when none is named (CREW-3063): the unit
// `crew install` writes names none, and its start/stop/status/restart are per
// ship, not per route.
const FLEET_CAPABLE = new Set(['poll', 'run', 'passengers', 'daemon']);
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
// `crew worktree NNN` (CREW-1551) names no route: the ticket's own repo picks it.
const worktreeArgs = command === 'worktree' ? splitWorktreeArgs(positional, cfg.routes.map((r) => r.route)) : undefined;
const named = worktreeArgs
  ? worktreeArgs.route
  : command === 'daemon' && DAEMON_SUBCOMMANDS.has(positional[1] ?? '')
    ? positional[2]
    : positional[1];
// `pause`/`resume` (CREW-1372) need no route: their markers live in the ship's
// own stateDir, so the word `release` or a role name sits at positional[1] and
// must never be read as a route name (QA, on a one-route ship).
const fleetWide = command === 'inbox' || command === 'connect' || command === 'disconnect' || command === 'deprovision' || command === 'agents' || command === 'skills' || command === 'logbook' || command === 'repos' || command === 'ship' || command === 'projects' || command === 'periscope' || command === 'whoami' || command === 'sandbox' || releaseFleetWide ||
  command === 'pause' || command === 'resume' || command === 'reload' ||
  (FLEET_CAPABLE.has(command) && !named && cfg.routes.length > 1) ||
  (worktreeArgs !== undefined && !named && cfg.routes.length > 1);
let route: ReturnType<typeof findRoute>;
try {
  route = fleetWide ? (cfg.routes[0] as ReturnType<typeof findRoute>) : findRoute(cfg, named);
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`crew: ${e.message}\n`);
    if (command === 'daemon' && !DAEMON_SUBCOMMANDS.has(positional[1] ?? '')) {
      await failDaemonStart({
        stateDir: cfg.ship.stateDir, reason: e.message, fix: 'Name a route in the unit (`crew install`) or correct crew.yaml',
        code: 2, routes: cfg.routes, ship: cfg.ship, logFile: cfg.ship.logFile,
      });
    }
    process.exit(2);
  }
  throw e;
}
const state = new State(cfg.ship.stateDir);
setCloneRecorder((dir) => recordClonedCheckout(cfg.ship.stateDir, dir));
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
  rotateBytes: cfg.ship.eventsRotateBytes,
  logFile: dryRun ? undefined : cfg.ship.logFile,
  console: (l) => process.stderr.write(`${l}\n`),
  // CREW-3266: a person at a terminal gets terse, untimestamped lines and routine
  // progress only under --verbose. The daemon and timer units are not a TTY and
  // keep the full log form.
  verbose: flag('verbose'),
  plain: !!process.stderr.isTTY,
});

/** CREW-3270: routine confirmation lines from a command (`connect`, `install`) show only under `--verbose`. */
function routineLine(line: string): void {
  if (flag('verbose')) process.stderr.write(`${line}\n`);
}

/**
 * CREW-3267: a command's own failure, through the Emitter (so it is logged and
 * rendered like every other event) and ending with what to run next. Exits.
 */
function die(command: string, message: string, fix: string, code = 2): never {
  emit.error(withFix(`${command}: ${message}`, fix));
  return process.exit(code);
}

/**
 * The interlock. A dry run is exempt because it writes nothing — being able
 * to inspect a disarmed installation is the point of having one.
 */
function requireArmed(what: string): void {
  if (dryRun || route.enabled) return;
  emit.warn(withFix(
    `crew: route "${route.route}" is not enabled in ${cfg.configFile} — refusing to ${what}`,
    'add --dry-run to see what it would do, or set `enabled: true` on the route',
  ));
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
/**
 * CREW-2807: on a sandbox-runner ship the passenger checkouts are written from
 * the cache volume's mirrors, not cloned from the forge. Failures are reported
 * once per pass; the previous contents stay in place.
 */
async function materializePassengerMirrors(emit: Emitter): Promise<void> {
  const specs = passengerCheckoutSyncSpecs(cfg).filter((s) => s.mirror);
  if (specs.length === 0) return;
  for (const r of await materializeMirrorCheckouts(specs)) {
    if (r.action === 'failed') {
      emit.warn(`passenger checkout for ${r.name} could not be written from its mirror: ${r.detail}`, { step: 'passengers', data: { workspaceId: r.workspaceId, repo: r.name } });
    }
  }
}

async function syncHostPassengers(): Promise<void> {
  if (dryRun) return;
  const passengerRoutes = cfg.routes.filter((r) => r.enabled && r.hostPassengers);
  if (passengerRoutes.length === 0) {
    // CREW-2803: no passengers, but a ship with a relay still opens the tunnel for control alone.
    await syncShipTunnels([], new Map(), []);
    // A stale daemon item would otherwise never clear once passengers are off and no sandbox needs Docker.
    if (!(await shipNeedsDocker())) clearShipAttention(state, DOCKER_DAEMON_KEY);
    return;
  }
  // Under the timer there is no interactive PATH, so look in Docker's usual
  // directories to tell "docker is not on our PATH" from "the daemon is down".
  const gate = await dockerGate({
    dockerUp: dockerAvailable(),
    passengerRoutes,
    pathProblem: () => dockerPathProblem(cfg.ship, COMMON_DOCKER_DIRS),
    warn: (message) => emit.warn(message, { step: 'passengers' }),
    raise: (item, route) => raiseShipAttention({ state, emit, route, ship: cfg.ship }, item),
    clear: (key) => clearShipAttention(state, key),
    syncTunnels: (plans, targets, routes) => syncShipTunnels(plans, targets, routes),
  });
  if (gate === 'handled') return;
  try {
    // Dedicated checkouts (ISSUE-554, decision 7 in the Map) must be
    // cloned and fast-forwarded to `branch.base` BEFORE the container
    // sync below can mount them — decision 8's poll-cadence half of
    // freshness. A checkout that won't fast-forward (diverged
    // upstream) is reported, not force-reset past.
    const refusedRepos = new Map<string, string>();
    const checkouts = syncAllPassengerCheckouts(cfg, (repo, e) => refusedRepos.set(repo, e.message));
    // CREW-2928: a refused contract skips that repository alone — one warning
    // and one attention item, raised when it first appears and cleared once
    // the file loads again.
    for (const [repo, detail] of refusedRepos) {
      if (await raiseShipAttention({ state, emit }, repoContractRefusedItem(repo, detail))) {
        emit.warn(`passenger sync skips ${repo}: ${detail}`, { step: 'passengers', data: { repo } });
      }
    }
    for (const item of state.shipAttention().previous()) {
      if (item.kind === 'repo_contract_refused' && !refusedRepos.has(item.key.slice(repoContractRefusedKey('').length))) {
        clearShipAttention(state, item.key);
      }
    }
    for (const r of checkouts) {
      // Once per repo: a repeat means the same clone URL already failed and
      // was skipped (git.ts#syncPassengerCheckout), so there is nothing new to say.
      if (r.outcome.action === 'clone-failed') {
        if (!r.outcome.repeat) {
          emit.warn(
            `passenger checkout for ${r.name} could not be cloned (not retried until its clone URL changes): ${r.outcome.detail}`,
            { step: 'passengers', data: { workspaceId: r.workspaceId, repo: r.name } },
          );
        }
        continue;
      }
      if (r.outcome.action === 'diverged' || r.outcome.action === 'ff-failed') {
        emit.warn(
          `passenger checkout for ${r.name} is stale: ${r.outcome.detail}`,
          { step: 'passengers', data: { workspaceId: r.workspaceId, repo: r.name } },
        );
      }
    }
    await materializePassengerMirrors(emit);
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
    await syncShipTunnels(planContainers(cfg), new Map([...syncEndpoints].map(([workspaceId, e]) => [workspaceId, e.secret])), passengerRoutes);
  } catch (e) {
    emit.warn(`passenger container sync failed: ${(e as Error).message}`, { step: 'passengers' });
  }
}

/**
 * The ship's relay tunnels (ISSUE-553 passengers, CREW-2803 control): one per
 * workspace, one `ssh` process, up to two forwards. A workspace with a
 * passenger container carries `mcp` and `control`; any other enabled route's
 * workspace carries `control` alone, so a ship with passengers off is still
 * reachable at its Ships row's `relay_url`. Needs `ship.relayHost`; without
 * one nothing is dialed (`crew doctor` says so). The tunnel needs this ship's
 * own keypair, minted by `crew connect`; a missing piece must not stop the
 * container sync that already ran.
 */
async function syncShipTunnels(
  containerPlans: ContainerPlan[], mcpSecrets: Map<string, string>, passengerRoutes: Route[],
): Promise<void> {
  if (!cfg.ship.relayHost) return;
  const relayHost = cfg.ship.relayHost;
  try {
    const { privateKeyPath } = ensureShipSshKeypair(cfg.ship.stateDir);
    const controlRoutes = cfg.routes.filter((r) => r.enabled && r.resolved?.workspaceId);
    const planned = new Set(containerPlans.map((p) => p.workspaceId));
    const plans: TunnelPlan[] = [...containerPlans];
    for (const r of controlRoutes) {
      const ws = r.resolved!.workspaceId;
      if (planned.has(ws)) continue;
      planned.add(ws);
      plans.push({ workspaceId: ws });
    }
    const apiRoutes = controlRoutes;
    const reconcile = endpointReconcileDeps(passengerRoutes, relayHost);
    const pending: Array<Promise<void>> = [];
    syncPassengerTunnels(plans, relayHost, cfg.ship.relayPort, privateKeyPath, cfg.ship.stateDir, mcpSecrets, {
      apiKeys: passengerApiKeys(apiRoutes),
      controlSocket: controlSocketFor(cfg.ship.stateDir),
      onStatus: (workspaceId, status, info) => {
        // CREW-3239: a retired workspace has no owning route (its route is disabled), so this must run before the early return below.
        if (status === 'disconnected' && !planned.has(workspaceId)) {
          clearShipAttention(state, `${TUNNEL_REJECTED_KEY}:${workspaceId}`);
          clearShipAttention(state, `${RELAY_CONTROL_UNSUPPORTED_KEY}:${workspaceId}`);
        }
        const owningRoute = apiRoutes.find((r) => r.resolved?.workspaceId === workspaceId);
        if (!owningRoute) return;
        pending.push(
          new Tracker(owningRoute, cfg.ship).updateTunnelState(cfg.ship.name, { tunnel_status: status })
            .catch((e) => { emit.warn(`could not write tunnel_status: ${(e as Error).message}`, { step: 'passengers' }); }),
        );
        if (status === 'disconnected') pending.push(unregisterEndpoint(workspaceId, info, reconcile));
        // CREW-2932: a tunnel that keeps dying before it settles was refused.
        const rejectedKey = `${TUNNEL_REJECTED_KEY}:${workspaceId}`;
        if ((info?.quickExits ?? 0) >= TUNNEL_REJECTED_AFTER) {
          pending.push(raiseShipAttention({ state, emit, route: owningRoute, ship: cfg.ship }, {
            kind: TUNNEL_REJECTED_KEY, key: rejectedKey, message: tunnelRejectedMessage(workspaceId, info!.quickExits!), since: new Date().toISOString(),
          }).then(() => undefined).catch(() => undefined));
        } else if (status === 'connected') clearShipAttention(state, rejectedKey);
        // CREW-2939: the relay refused the control forward; passengers carry on without it.
        const controlKey = `${RELAY_CONTROL_UNSUPPORTED_KEY}:${workspaceId}`;
        if (info?.controlRefusedAt) {
          pending.push(raiseShipAttention({ state, emit, route: owningRoute, ship: cfg.ship }, {
            kind: RELAY_CONTROL_UNSUPPORTED_KEY, key: controlKey, message: relayControlUnsupportedMessage(workspaceId), since: new Date().toISOString(),
          }).then(() => undefined).catch(() => undefined));
        } else if (status === 'connected') clearShipAttention(state, controlKey);
      },
    });
    // Every cycle, not just on the connected transition: a 403 or a
    // network error registering the endpoint is retried next cycle
    // without ever touching the tunnel.
    for (const plan of containerPlans) pending.push(reconcileEndpoint(plan.workspaceId, reconcile));
    for (const plan of plans) pending.push(reconcileRelayUrl(plan.workspaceId, apiRoutes));
    await Promise.all(pending);
    // CREW-3239: repairs a ship that already carries items for a workspace it no longer serves.
    for (const key of staleTunnelAttentionKeys(openShipAttention(state).map((i) => i.key), planned)) clearShipAttention(state, key);
    await reconcilePeriscopeEndpoints();
  } catch (e) {
    emit.warn(`ship tunnel sync failed: ${(e as Error).message}`, { step: 'passengers' });
  }
}

/**
 * Writes a settled tunnel's relay URL to the owning route's Ships row
 * (CREW-2803). A respawn drops the persisted `relayUrl`, so every
 * re-registration rewrites it; a failed write is retried next cycle.
 */
async function reconcileRelayUrl(workspaceId: string, routes: Route[]): Promise<void> {
  if (!cfg.ship.relayHost) return;
  const persisted = readPersistedTunnel(cfg.ship.stateDir, workspaceId);
  if (!persisted?.slug || persisted.status !== 'connected') return;
  const url = relayBaseUrlFor(persisted.slug, cfg.ship.relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain);
  if (persisted.relayUrl === url) return;
  const route = routes.find((r) => r.resolved?.workspaceId === workspaceId);
  if (!route) return;
  try {
    await new Tracker(route, cfg.ship).updateRelayUrl(cfg.ship.name, url);
    updatePersistedTunnel(cfg.ship.stateDir, workspaceId, { relayUrl: url });
  } catch (e) {
    emit.warn(`could not write relay_url: ${(e as Error).message}`, { step: 'passengers' });
  }
}

/** The relay base URL a route's workspace tunnel is reachable at, from its persisted slug (CREW-2803); null with no relay or no tunnel yet. */
function routeRelayUrl(route: Route): string | null {
  const ws = route.resolved?.workspaceId;
  const slug = ws ? readPersistedTunnel(cfg.ship.stateDir, ws)?.slug : undefined;
  if (!cfg.ship.relayHost || !slug) return null;
  return relayBaseUrlFor(slug, cfg.ship.relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain);
}

/** workspaceId -> the owning route's own API key, for the relay's `/auth/me` entitlement check (CREW-1320). */
/**
 * The relayed-preview settings for one route's periscopes (CREW-3059), or undefined when
 * `ship.relayPreviews` is off. A missing route key or ship keypair does not fail `up`: the
 * tunnel's outcome says why the preview is not relayed.
 */
function previewRelayFor(route: Route): PreviewRelay | undefined {
  if (!cfg.ship.relayPreviews || !cfg.ship.relayHost) return undefined;
  const relayHost = cfg.ship.relayHost;
  const workspaceId = route.resolved?.workspaceId;
  return {
    newSlug: generateTunnelSlug,
    publicUrl: (slug) => relayBaseUrlFor(slug, relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain),
    open: async (slug, localUrl) => {
      if (!workspaceId) return { ok: false, reason: `route ${route.route} is not connected` };
      let apiKey: string;
      let privateKeyPath: string;
      try {
        apiKey = resolveApiKey(route);
        privateKeyPath = ensureShipSshKeypair(cfg.ship.stateDir).privateKeyPath;
      } catch (e) { return { ok: false, reason: (e as Error).message }; }
      return openPreviewTunnel({
        start: (target) => startPreviewTunnel({
          relayHost, relayPort: cfg.ship.relayPort, workspaceId, slug, apiKey, privateKeyPath, targetHost: target.host, targetPort: target.port,
        }),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        kill: (pid) => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } },
      }, localUrl);
    },
    stop: (pid) => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } },
  };
}

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

function periscopeEndpointDeps(): PeriscopeEndpointDeps {
  return {
    stateDir: cfg.ship.stateDir,
    shipName: cfg.ship.name,
    apiFor: endpointApiFor(cfg.routes.filter((r) => r.enabled)),
    warn: (m) => emit.warn(m, { step: 'passengers' }),
  };
}

/** Last time a periscope's activity was written to its row, so a burst of tool calls is one write. */
const periscopeTouched = new Map<string, number>();
const PERISCOPE_TOUCH_EVERY_MS = 30_000;

/** What the per-periscope MCP server needs from this ship (CREW-2862). */
function periscopeMcpDeps(): import('./periscope-mcp.ts').PeriscopeMcpDeps {
  const stateDir = cfg.ship.stateDir;
  return {
    stateDir,
    find: (segment) => findPeriscope(readPeriscopeSidecars(stateDir), segment),
    runHook: async (sc, name: PeriscopeHook, env) => {
      const rt = cfg.routes.find((r) => r.route === sc.route && r.enabled);
      const repo = rt && (await resolvedRepos(rt)).find((r) => r.name === sc.repo);
      const script = repo?.config.hooks[name as keyof typeof repo.config.hooks] as string | undefined;
      if (!repo || !script) return null;
      return runScript(script, {
        cwd: sc.worktree, env, shell: resolveShell(repo.config.shell ?? cfg.ship.shell),
        timeoutMs: name === 'preview' ? 180_000 : 15 * 60_000,
      });
    },
    touch: async (sc) => {
      const now = Date.now();
      if (now - (periscopeTouched.get(sc.ticketRecordId) ?? 0) < PERISCOPE_TOUCH_EVERY_MS) return;
      periscopeTouched.set(sc.ticketRecordId, now);
      const rt = cfg.routes.find((r) => r.route === sc.route && r.enabled);
      if (!rt) return;
      const { idleMinutes } = periscopeCaps(cfg.ship as typeof cfg.ship & PeriscopeLimits);
      const at = new Date(now).toISOString();
      const expiresAt = new Date(now + idleMinutes * 60_000).toISOString();
      await new Tracker(rt, cfg.ship).updatePeriscope(sc.periscopeRecordId, { last_activity_at: at, expires_at: expiresAt });
      writePeriscopeSidecar(stateDir, { ...sc, lastActivityAt: at, expiresAt });
    },
    log: (m) => emit.warn(m, { step: 'passengers' }),
  };
}

/**
 * Per cycle (CREW-2862): drops the workspace endpoint of every periscope that
 * ended, whichever way, and registers one that is live but has none yet (the
 * relay URL did not exist when it opened, or the registration failed).
 */
async function reconcilePeriscopeEndpoints(): Promise<void> {
  const d = periscopeEndpointDeps();
  await removeEndedPeriscopeEndpoints(d);
  const have = new Set(listPeriscopeEndpoints(cfg.ship.stateDir).map((e) => e.ticketRecordId));
  for (const sc of readPeriscopeSidecars(cfg.ship.stateDir)) {
    if (have.has(sc.ticketRecordId) || !sc.route || !readPeriscopeSecret(cfg.ship.stateDir, sc.ticketRecordId)) continue;
    const rt = cfg.routes.find((r) => r.route === sc.route && r.enabled);
    const ws = rt?.resolved?.workspaceId;
    const relayUrl = rt && routeRelayUrl(rt);
    if (!rt || !ws || !relayUrl) continue;
    const out = await registerPeriscopeEndpoint(d, { ticket: sc.ticket, ticketRecordId: sc.ticketRecordId, route: sc.route, workspaceId: ws, relayUrl });
    if (!out.ok) d.warn(`could not register the MCP endpoint of ${sc.ticket}: ${out.message}`);
  }
}

function endpointReconcileDeps(routes: Route[], relayHost: string): ReconcileDeps {
  return {
    stateDir: cfg.ship.stateDir,
    shipName: cfg.ship.name,
    apiFor: endpointApiFor(routes),
    urlFor: (slug) => publicUrlFor(slug, relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain),
    controlUrlFor: (slug) => `${relayBaseUrlFor(slug, relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain)}/control`,
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
  precheckTickets.clear();
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
  // The timer fired and crew ran; declining to release is the operator's
  // choice, not a stalled timer (CREW-2679).
  if (!dryRun) state.releaseHeartbeat().touch();
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
  precheckTickets.clear();
  const only = value('repo');
  const targets = reposOf(route);
  const chosen = only ? targets.filter((t) => t.name === only) : targets;
  if (only && chosen.length === 0) {
    die('crew', `no repo named "${only}" on route "${route.route}" (have: ${targets.map((t) => t.name).join(', ')})`, `\`crew repos\` to list or add one`);
  }
  const summaries: RoutedReleaseSummary[] = [];
  if (!dryRun) state.releaseHeartbeat().touch();
  for (const t of chosen) summaries.push({ ...(await releasePhase(route, t, opts)), route: route.route });
  emitReleaseSummary(emit, summaries);
  if (!dryRun) state.releaseHeartbeat().touch();

  // Ship-wide, not per-repo — one sweep per release cycle, alongside the
  // worktree sweep each repo just ran above (ISSUE-401).
  try {
    const paths = [
      ...planStreamSweep(cfg.ship.stateDir, cfg.ship.streamRetentionDays),
      ...planEventsSweep(cfg.ship.stateDir, cfg.ship.streamRetentionDays),
    ];
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
    die('crew install', 'no scheduler support yet for Windows (Task Scheduler is planned, not built)', 'run `crew daemon` in a terminal instead');
  }
  // CREW-3284: the install log. Per-step progress is a note (shown under
  // --verbose); a warning ends with the command to run next.
  const installLog = {
    emit: (m: string) => emit.note(m),
    warn: (m: string) => emit.warn(withFix(`crew install: ${m}`, '`crew doctor`')),
  };
  // launchd units from a different checkout hash (CREW-1376): a stale one
  // whose program is gone is removed, a live other install is refused before
  // anything of this checkout is written, unless --replace.
  if (host === 'macos') {
    const ok = clearForeignLaunchdUnits(CREW_HOME, !!opts.replace, dryRun, {
      // A removed foreign unit is a real change, so it is shown by default.
      emit: (m) => emit.emit(m),
      warn: (m) => emit.warn(withFix(`crew install: ${m}`, '`crew install --replace`')),
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
    emit.error(withFix(`crew install: Host Passengers is on but ${installPathProblem}`, '`crew doctor`'));
    process.exitCode = 1;
  } else if (!dryRun && cfg.routes.some((r) => r.enabled && r.hostPassengers) && dockerAvailable()) {
    const image = passengerImageRef(cfg);
    if (imagePresent(image)) {
      emit.note(`Host Passengers image ${image} is already present`);
    } else {
      emit.note(`pulling Host Passengers image ${image}`);
      try {
        ensureImage(image);
        emit.emit(`pulled Host Passengers image ${image}`);
      } catch (e) {
        emit.warn(withFix(`crew install: could not pull Host Passengers image ${image}: ${(e as Error).message}`, '`crew doctor`'));
        process.exitCode = 1;
      }
    }
  }
  const hasSystemd = detectSystemd();
  const results: JobResult[] = [];
  for (const job of ['run', 'release', 'passengers'] as const) {
    const plan = planInstall(cfg.ship, CREW_HOME, host, hasSystemd, job, installContext());
    emit.note(`installing ${job} via ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}`);
    try {
      const { action } = await applyInstall(plan, CREW_HOME, dryRun, installLog);
      results.push({ job, mechanism: plan.mechanism, action });
    } catch (e) {
      return die('crew install', (e as Error).message.replace(/^crew install:\s*/, ''), '`crew doctor`', 1);
    }
  }
  for (const l of summarizeJobs(results, { dryRun, verbose: flag('verbose'), host })) emit.emit(l);
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
      emit.emit(
        `removing stale run timer from before the persistent-service cutover: ${staleTimer}${dryRun ? ' (dry run, not applied)' : ''}`,
      );
      if (!dryRun) {
        spawnSync('systemctl', ['--user', 'disable', '--now', `${label}.timer`], { cwd: CREW_HOME, env: withUserBusEnv() });
        try { unlinkSync(staleTimer); } catch { /* already gone */ }
      }
    }
  }
  return true;
}

/**
 * CREW-3274: how this route's connect snapshot differs from the workspace now,
 * with the same lookups `discover()` uses. Undefined when the workspace cannot
 * be read (offline, or the listing failed): an unchecked snapshot is never
 * called stale, and never called fresh either.
 */
async function snapshotDiffFor(c: Route): Promise<SnapshotDiff | undefined> {
  const r = c.resolved;
  if (!r?.projectId || flag('offline')) return undefined;
  try {
    const models = await connectGet<Array<{ id: string; name: string }>>(
      { baseUrl: c.baseUrl, apiKey: resolveApiKey(c), userAgent: cfg.ship.userAgent }, `/data-models?projectId=${r.projectId}`);
    const tracker = new Tracker(c, cfg.ship);
    const [ships, crew] = await Promise.all([tracker.shipRows(), tracker.crewRows()]);
    const matched = matchShipRows(ships, cfg.ship.name, doctorMachineId(cfg.ship.stateDir));
    const row = matched.rows.length === 1 ? matched.rows[0]! : undefined;
    return compareSnapshot(r, {
      models,
      releaseSeat: liveReleaseSeat(crew, row?.id),
      shipRowHasMachineId: row && matched.hasColumn ? matched.by === 'machine_id' : undefined,
    });
  } catch { return undefined; }
}

/**
 * Every check `crew doctor` prints for one route, as lines, for `--fix` to
 * decide whether the route is clean. Mirrors the `doctor` report above; a
 * check that cannot even run (a tracker call that throws) counts as failed.
 */
async function routeProblems(c: Route): Promise<{ problems: string[]; readiness: string[]; snapshotStale: boolean }> {
  const host = hostPlatform();
  const problems: string[] = [];
  // Release readiness (CREW-2537) is reported apart: none of it stops a poll
  // cycle, so it must not keep a route from being enabled.
  const readiness: string[] = [];
  // Host Passengers preflight, as `doctor` prints it: a route that needs Docker
  // or ssh-keygen must not be enabled while they are missing.
  if (c.hostPassengers) {
    if (!dockerAvailable()) problems.push('host passengers: docker is not available');
    if (!sshKeygenAvailable()) problems.push('host passengers: ssh-keygen is not available');
  }
  const tracker = new Tracker(c, cfg.ship);
  problems.push(...validateContract(tracker.contract).map((p) => `contract: ${p}`));
  // The doctor keeps reporting a refused contract (CREW-2928), which every other pass now skips.
  const { settled: doctorRepos, errors: refusedRepos } = await settleRepos(reposOf(c), (t) => t.name, (t) => resolveOneRepo(c, t));
  for (const e of refusedRepos) problems.push(`repo ${e.repo}: ${e.detail}`);
  for (const r of doctorRepos) {
    if (!existsSync(r.dir)) problems.push(`repo ${r.name}: ${r.dir} is missing on disk`);
    if (!satisfies(host, r.config.platform)) problems.push(`repo ${r.name}: requires ${r.config.platform}, this host is ${host}`);
    readiness.push(...validateEffective(r.config).map((p) => `repo ${r.name}: ${p}`));
  }
  try {
    const ships = await tracker.shipRows();
    // No Ships table is fine; a table with no (or an ambiguous) row for this ship is not.
    if (ships.length > 0) {
      const mine = matchShipRows(ships, cfg.ship.name, doctorMachineId(cfg.ship.stateDir)).rows;
      if (mine.length !== 1) problems.push(`ship record: ${mine.length} rows named "${cfg.ship.name}"`);
      else if (mine[0]!.platform && mine[0]!.platform !== host) problems.push(`ship record: declares ${mine[0]!.platform}, this host is ${host}`);
      // CREW-3104: a repository whose contract no registered ship can satisfy is never released, and nothing else says so.
      const fleet = ships.map((x) => x.platform ?? '').filter(isShipPlatform);
      if (fleet.length > 0) {
        for (const r of doctorRepos) {
          if (!fleet.some((p) => satisfies(p, r.config.platform))) {
            problems.push(`repo ${r.name}: requires ${r.config.platform}, but no registered ship satisfies it (ships: ${[...new Set(fleet)].join(', ')})`);
          }
        }
      }
    }
  } catch (e) {
    problems.push(`tracker unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  // CREW-3144: the acceptor is read from the event log's status rows.
  if ((await tracker.eventLogTracksStatus()) === false) problems.push(EVENT_LOG_STATUS_UNTRACKED(tracker.contract.columns.status));
  const diff = await snapshotDiffFor(c);
  return { problems, readiness, snapshotStale: !!diff && isStale(diff) };
}

/** CREW-2910: this ship's `Ships.kind` on a route's workspace, null when there is no Ships table, no single matching row or no kind column. Never throws. */
async function doctorShipKind(route: Route, ship: Ship): Promise<string | null> {
  try {
    const rows = await new Tracker(route, ship).shipRows();
    const mine = matchShipRows(rows, ship.name, doctorMachineId(ship.stateDir)).rows;
    return mine.length === 1 ? mine[0]!.kind ?? null : null;
  } catch { return null; }
}

/** This machine's hashed id for doctor's read-only row matching; `--machine-id` is honored like connect's. */
function doctorMachineId(stateDir: string): string | undefined {
  try { return ensureMachineId(stateDir, { override: value('machine-id') }); } catch { return undefined; }
}

/**
 * `crew doctor --fix` / the end-of-run offer (CREW-1288). Plans from doctor's
 * own checks (`planFix`), asks one yes/no per action when `prompt` is set,
 * writes only the `enabled` key for an accepted route, and prints everything it
 * changed so no edit is silent.
 */
async function doctorFix(o: { prompt: boolean; host: ReturnType<typeof hostPlatform>; fixFlag: boolean; blockers: number; warnings: number }): Promise<void> {
  const routes = await Promise.all(routesInScope(cfg.routes, named).map((c) =>
    gatherHealth({ route: c.route, enabled: c.enabled, hasRepos: reposOf(c).length > 0 }, () => routeProblems(c))));
  const unitExists = (p: string) => existsSync(p);
  const crontab = o.host === 'linux' ? (spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout ?? '') : '';
  const schedulerAbsent = o.host !== 'windows'
    ? !schedulerInstalled(planInstall(cfg.ship, CREW_HOME, o.host, detectSystemd(), 'run', installContext()), unitExists, crontab)
    : true;
  const plan = planFix({ routes, schedulerAbsent, host: o.host });
  if (plan.actions.length === 0) {
    // CREW-3272: silent unless asked; "nothing to change" after a blocker read as a clean bill of health.
    for (const l of fixPhaseNothingToOffer({ notes: plan.notes, fixFlag: o.fixFlag, blockers: o.blockers, warnings: o.warnings })) process.stdout.write(`${l}\n`);
    return;
  }
  for (const n of plan.notes) process.stdout.write(`fix: ${n}\n`);
  const prompter = o.prompt ? terminalPrompter() : undefined;
  const changed: string[] = [];
  const enabledSound = new Set(routes.filter((r) => r.enabled && r.hasRepos && r.problems.length === 0).map((r) => r.route));
  try {
    for (const a of plan.actions) {
      if (a.kind === 'refresh-snapshot') {
        if (prompter && !(await prompter.confirm(`${a.route}: the connect snapshot is out of date — run \`crew connect ${a.route}\` and reload the daemon?`, true))) continue;
        // Same crew, same CREW_CONFIG (inherited), so the child connects the config this doctor loaded.
        const self = selfLaunch();
        const run = (args: string[]) => spawnSync(self.command, [...self.args, ...args], { stdio: 'inherit', cwd: process.cwd(), env: process.env });
        const conn = run(['connect', a.route]);
        if (conn.status !== 0) { process.stdout.write(`fix: crew connect ${a.route} exited ${conn.status ?? 'abnormally'} — snapshot not refreshed\n`); continue; }
        const rel = run(['reload']);
        changed.push(`refreshed the connect snapshot for ${a.route} (\`crew connect\`)${rel.status === 0 ? ' and reloaded the daemon' : '; `crew reload` failed — run it by hand'}`);
      } else if (a.kind === 'enable') {
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
/** CREW-2799: the repositories of a route as the sandbox cache knows them, with the forge credential for each host. */
function sandboxCacheRepos(c: typeof route, ship: Ship): PassRepo[] {
  const out: PassRepo[] = [];
  let images: ReturnType<typeof readSandboxState> | undefined;
  for (const t of reposOf(c)) {
    const origin = originUrlOf(t.dir, 'origin');
    // CREW-2940: with no checkout there is no origin to read; the Repos row's remote and forge host name the mirror.
    const repo = cacheRepoOfTarget(ship, t, origin);
    if (!repo) continue;
    let token: string | null = null;
    try { token = readForgeToken(ship.forges, repo.host, ship.stateDir); } catch { /* the doctor reports an unreadable token */ }
    // CREW-2924: only a repository declaring `intel: serena` is indexed, in its own built sandbox image
    // (none built yet means no index this pass; a later pass retries).
    let intelImage: string | null = null;
    try {
      if (intelFlavor(loadRepoConfig(t.dir)?.hooks.intel) === 'serena') intelImage = sandboxImageFor(images ??= readSandboxState(ship.stateDir), t.name);
    } catch { /* a malformed .crew.yaml is reported where it is read */ }
    out.push({ ...repo, dir: t.dir, token, username: forgeFor(ship.forges, repo.host)?.entry.username || forgeDescriptorFor(repo.host).credentialUsername, intelImage });
  }
  return out;
}

function buildSandboxCachePass(c: typeof route, ship: Ship, state: State, emit: Emitter): (() => Promise<RefreshOutcome[]>) | undefined {
  const settings = cacheSettingsOf(ship.sandbox);
  if (!settings) return undefined;
  const pass = makeCachePass({
    cache: new SandboxCache(settings), volume: settings.volume,
    repos: () => sandboxCacheRepos(c, ship),
    lock: (dir) => acquireCheckoutLock(dir),
    fail: (key, message, failedAt) => raiseShipAttention({ state, emit, route: c, ship }, { kind: 'sandbox_cache', key, message, since: failedAt, lastFailedAt: failedAt }).then(() => undefined),
    ok: (key) => clearShipAttention(state, key),
  });
  // CREW-2807: right after a mirror refresh, passengers get the same tip.
  return async () => {
    const outcomes = await pass();
    if (outcomes.length > 0) await materializePassengerMirrors(emit).catch((e) => emit.warn(`passenger mirror sync failed: ${(e as Error).message}`, { step: 'passengers' }));
    return outcomes;
  };
}

/**
 * Every repo of the route whose contract loads (CREW-2928). A repo whose
 * `.crew.yaml` is refused is left out and reported as one attention item, never
 * thrown: this runs at daemon start (`anyRepoServable`), and one repository's
 * bad file must not take down every lane on the ship.
 */
async function resolvedRepos(c: typeof route) {
  return (await resolveRoute(c)).settled;
}

/** `resolvedRepos` plus the repositories whose contract could not be read, each with why. */
async function resolveRoute(c: typeof route) {
  const { settled, errors } = await settleRepos(reposOf(c), (t) => t.name, (t) => resolveOneRepo(c, t));
  for (const e of errors) {
    try { await raiseShipAttention({ state, emit }, repoContractRefusedItem(e.repo, e.detail)); } catch { /* the skip below still holds */ }
  }
  const refused = new Set(errors.map((e) => e.repo));
  for (const t of reposOf(c)) if (!refused.has(t.name)) clearShipAttention(state, repoContractRefusedKey(t.name));
  return { settled, errors };
}

/** Every repo of `routes` that declares a `sandbox:` section, once per repo name (CREW-2794). */
/** CREW-3275: does this ship need a Docker daemon: Host Passengers on, a declared sandbox, or a repository hook that runs `docker`. */
async function shipNeedsDocker(): Promise<boolean> {
  const enabled = cfg.routes.filter((r) => r.enabled);
  if (enabled.some((r) => r.hostPassengers)) return true;
  if (withShipSandbox(await sandboxReposOf(enabled)).length > 0) return true;
  for (const c of enabled) {
    let repos: Awaited<ReturnType<typeof resolvedRepos>>;
    try { repos = await resolvedRepos(c); } catch { continue; }
    if (repos.some((r) => Object.values(r.config.hooks).some((h) => typeof h === 'string' && hookCommand(h) === 'docker'))) return true;
  }
  return false;
}

async function sandboxReposOf(routes: Array<typeof route>): Promise<SandboxRepoRef[]> {
  const out = new Map<string, SandboxRepoRef>();
  for (const c of routes) {
    const { settled } = await settleRepos(reposOf(c), (t) => t.name, (t) => resolveOneRepo(c, t));
    for (const r of settled) if (r.config.sandbox && !out.has(r.name)) {
      const patterns = r.config.sandbox.warm ?? [];
      const base = r.config.branch.base;
      let warm: WarmFiles = {};
      // CREW-3010: a ship with no checkout has no directory to run git in; read the mirror instead.
      const target = reposOf(c).find((t) => t.name === r.name);
      const noCheckout = lacksCheckout(cfg.ship, r.dir);
      const mirror = target && noCheckout ? mirrorRepoOfTarget(target) : null;
      const settings = cfg.ship.runner === 'sandbox' ? cacheSettingsOf(cfg.ship.sandbox) : null;
      const source = mirror ? `the mirror of ${mirror.host}/${mirror.path} at ${base}` : `${r.dir} at ${r.config.branch.remote}/${base}`;
      let failure = '';
      try {
        if (mirror && settings) warm = await readMirrorWarmFiles(new SandboxCache(settings), mirror, base, patterns);
        else if (!noCheckout) warm = readWarmFiles(r.dir, `${r.config.branch.remote}/${base}`, patterns);
        else failure = 'no checkout and no mirror to read';
      } catch (e) {
        // An unreadable ref builds without warm files; the next tick retries with a different tag.
        failure = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      }
      if (patterns.length > 0 && Object.keys(warm).length === 0 && firstReport(`warm-empty:${r.name}:${failure}`)) {
        emit.emit(`${r.name}: sandbox.warm declares ${patterns.join(', ')} but no file could be read from ${source}${failure ? ` (${failure})` : ''}; the image is built without warm files`);
      }
      out.set(r.name, { name: r.name, ...(patterns.length > 0 && failure ? { unreadable: `sandbox.warm files could not be read (${failure})` } : {}), decl: intelFlavor(r.config.hooks.intel) === 'serena' ? { ...r.config.sandbox, intel: 'serena' } : r.config.sandbox, warm, ...(wantsCodeBridge(r.config.hooks.intel) ? { bridge: readBridgeBundle() } : {}) });
    }
  }
  return [...out.values()];
}

/** CREW-2956: the ship's crew layer first when the ship is a sandbox ship, then every declaring repository. */
const withShipSandbox = (declared: SandboxRepoRef[]): SandboxRepoRef[] =>
  cfg.ship.runner === 'sandbox' ? [shipSandboxRef(), ...declared] : declared;

/** The injectable pieces of a sandbox image build, bound to the real container engine and this ship's state. */
function sandboxTickDeps(emit: Emitter, c: typeof route): TickDeps {
  return {
    stateDir: cfg.ship.stateDir,
    run: spawnBuildRunner(),
    hasImage: engineHasImage(),
    removeImage: engineRemoveImage(),
    raise: (item) => { void raiseShipAttention({ state, emit, route: c, ship: cfg.ship }, item); },
    clear: (key) => clearShipAttention(state, key),
    log: (m) => emit.emit(m),
    daemonDown: () => {
      if (!dockerAvailable()) return dockerDaemonItem();
      clearShipAttention(state, DOCKER_DAEMON_KEY);
      return null;
    },
  };
}

/**
 * A repository's own contract: its checkout's `.crew.yaml`, or, on a sandbox-runner ship with no
 * checkout of it, the one committed on the base branch in its mirror (CREW-2940). A mirror not yet
 * fetched, or one carrying no contract, reads as no contract, the same as an empty checkout.
 */
async function loadContractOf(c: typeof route, t: RepoTarget): Promise<RepoConfig | null> {
  if (!lacksCheckout(cfg.ship, t.dir)) return loadRepoConfig(t.dir);
  const settings = cacheSettingsOf(cfg.ship.sandbox);
  const mirror = mirrorRepoOfTarget(t);
  if (!settings || !mirror) return null;
  return readMirrorContract(new SandboxCache(settings), mirror, c.branch?.base ?? 'main');
}

/** CREW-3032: the contract of the repository a run is planned for, resolved where a sandbox ship has no checkout. Undefined when no repository is named. */
async function planContractOf(c: typeof route, repo: string | null | undefined): Promise<RepoConfig | null | undefined> {
  const t = repo ? reposOf(c).find((r) => r.name === repo) : undefined;
  return t && cfg.ship.runner === 'sandbox' ? repoContractFor(cfg.ship, c, t) : undefined;
}

/** One repo of a route, resolved on its own so a caller can survive a bad contract in a sibling. */
async function resolveOneRepo(c: typeof route, t: ReturnType<typeof reposOf>[number]) {
  {
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
      config: resolveRepoConfig(await loadContractOf(c, t), {
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
        worktrees: { prefix: shipWorktreePrefixFor(c) ?? await areaWorktreePrefix(c, id), nameOverride: o?.worktreeName },
      }, t.dir),
    };
  }
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
async function anyRepoServable(c: typeof route, tolerateUnmirrored = false): Promise<boolean> {
  const { settled, errors } = await resolveRoute(c);
  return judgeServable({
    platforms: settled.map((r) => r.config.platform), satisfied: (p) => satisfies(cfg.ship.platform, p),
    unreadable: errors.map((e) => e.repo), tolerateUnmirrored,
    unmirrored: tolerateUnmirrored && errors.length > 0 ? await unmirroredTargets(c) : new Set(),
  });
}

/**
 * CREW-2993: the names of this route's repositories that are served from a mirror
 * (no checkout on a sandbox-runner ship) and have none in the cache volume yet.
 * Empty when the cache cannot be listed; the caller then judges as it always did.
 */
async function unmirroredTargets(c: typeof route): Promise<Set<string>> {
  const settings = cfg.ship.runner === 'sandbox' ? cacheSettingsOf(cfg.ship.sandbox) : null;
  if (!settings) return new Set();
  try {
    const have = new Set((await new SandboxCache(settings).list()).map((m) => `${m.repo.host}/${m.repo.path}`));
    const out = new Set<string>();
    for (const t of reposOf(c)) {
      if (!lacksCheckout(cfg.ship, t.dir)) continue;
      const m = mirrorRepoOfTarget(t);
      if (m && !have.has(`${m.host}/${m.path}`)) out.add(t.name);
    }
    return out;
  } catch { return new Set(); }
}

/**
 * Why `anyRepoServable` refused a route: each readable repo's own requirement, and each
 * repo whose contract could not be read, so the line is never left dangling (CREW-2993).
 */
async function explainUnservable(c: typeof route): Promise<string> {
  const { settled, errors } = await resolveRoute(c);
  return explainRefusal(settled.map((r) => ({ name: r.name, platform: String(r.config.platform) })), errors);
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
    route: c, userAgent: cfg.ship.userAgent, repos: await withRepoMaps(await resolvedRepos(c), cfg.ship.mapTokenBudget, cfg.ship.shell), contract, sourceTicket: ticket,
    authorship: await tracker.authorshipProbe().catch(() => null),
    attachments: await tracker.attachmentsProbe().catch(() => null),
    shipName: cfg.ship.name,
    ...sandboxEnv(cfg.ship),
  });
}

/**
 * `crew status`'s per-repo release line (CREW-1384): which ship releases the
 * repo and whether its board lock row exists and who holds it.
 */
async function releaserLine(
  tracker: Tracker, routeName: string, repo: string, release: Parameters<typeof releaserFor>[0],
): Promise<{ line: string; lockHeld: boolean }> {
  const who = release.ship ? `released by ${release.ship}` : 'any ship may release';
  let lock: string;
  let lockHeld = false;
  try {
    const st = await tracker.lockState(releaseLockScope(routeName, repo));
    lock = st === undefined ? 'no Locks table'
      : !st.exists ? 'lock row MISSING (run crew connect)'
      : st.holder ? ((lockHeld = true), `lock held by ${st.holder}`) : 'lock row free';
  } catch (e) {
    lock = `lock unreadable (${(e as Error).message})`;
  }
  return { line: `${who}; ${lock}`, lockHeld };
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
/**
 * The per-cycle cleanup of finished tickets in one repo: worktrees whose
 * ticket reached a terminal status (ISSUE-346), a deployed ticket's pushed
 * branch (CREW-1364) and its local branch once no worktree holds it
 * (CREW-1592). Runs from every exit of the release phase, not only the one
 * that released — on a route served by two ships the builder is often not the
 * releaser, and would otherwise never clean up. Takes no board lock, never
 * throws, and costs no tracker call when the checkout has nothing to sweep.
 */
async function sweepClosedTickets(
  c: typeof route, target: RepoTarget, branch: { base: string; remote: string },
  tracker: Tracker, dryRun: boolean, remit: ReturnType<typeof emit.forRoute>,
  idle = false,
): Promise<void> {
  // CREW-2940: a release sandbox's clone has no worktrees or local branches to sweep; it is deleted whole.
  if (remoteOf(target.dir)) return;
  try {
    // The idle path runs every cycle, so it skips the tracker reads when the
    // checkout has nothing local to sweep. After a release the pushed-branch
    // cleanup below must still run: it exists for a ship with no local trace.
    if (!dryRun) reconcileHeldWorktrees(state, target.name, remit);
    if (idle && !sweepCandidatesExist(target.dir, branch.base)) return;
    // CREW-1593: resolve only the tickets this repo has a worktree, a local
    // branch or a pushed branch for, instead of paging a global closed-ticket
    // list that a busy board outgrows.
    const truncated = (limit: number) => remit.warn(`ticket lookup for the sweep hit its ${limit}-row limit; some tickets may be missed`, { step: 'worktree' });
    const nums = new Set([
      ...worktreeTicketNumbers(target),
      ...localBranchTicketNumbers(target.dir, branch.base),
      ...remoteBranchTicketNumbers(target.dir, branch.remote, branch.base),
    ]);
    const scoped = ticketsByRepo(c, await tracker.ticketsByNumbers([...nums], truncated)).byRepo.get(target.name) ?? [];
    const actions = planWorktreeSweep(target, scoped, tracker.contract);
    const orphanDirs = orphanedWorktreeDirs(target, scoped, tracker.contract);
    warnOrphanedWorktreeDirs(orphanDirs, remit, dryRun ? undefined : { state, repo: target.name });
    if (actions.length) {
      remit.enter('worktree');
      const r = await applyWorktreeSweep(target.dir, actions, dryRun, remit, branch.remote, branch.base, { state, repo: target.name }, clearBranchLink(tracker));
      remit.emit(`swept ${r.removed} worktree(s), kept ${r.keptBranches} branch(es)`, { step: 'worktree' });
      if (!dryRun) reconcileHeldWorktrees(state, target.name, remit, new Set([...r.refused, ...orphanDirs]));
    } else if (!dryRun) reconcileHeldWorktrees(state, target.name, remit, new Set(orphanDirs));
    // After the worktrees, so a branch freed by the removal above is seen.
    const orphaned = planLocalBranchCleanup(target.dir, branch.base, scoped, tracker.contract);
    if (orphaned.length) applyLocalBranchCleanup(target.dir, orphaned, dryRun, remit);
    // CREW-1364: the pushed copy of a branch this ship may never have had a
    // worktree for. After the stamp, so a ticket is `deployed` by now.
    const stale = planRemoteBranchCleanup(target.dir, branch.remote, branch.base, scoped, tracker.contract);
    if (stale.length) applyRemoteBranchCleanup(target.dir, branch.remote, stale, dryRun, remit);
  } catch (e) {
    remit.warn(`worktree sweep failed: ${(e as Error).message}`, { step: 'worktree' });
  }
}

/** One open-ticket read per route per release cycle, for the lock-free pre-check. */
const precheckTickets = new Map<string, Promise<Ticket[]>>();
const scope0 = (c: { route: string }, t: { name: string }): string => releaseLockScope(c.route, t.name);

/**
 * CREW-2940: the release of a repository this ship has no checkout of. Nothing
 * verified means nothing is created (a sandbox per poll would be wasteful);
 * otherwise a release sandbox holds a shallow clone from the mirror, the whole
 * release phase runs against it, and the sandbox is deleted afterwards.
 */
async function releaseFromSandbox(
  c: typeof route, target: RepoTarget, contract: RepoConfig, mirror: CacheRepo,
  opts: { mergeOnly?: boolean; force?: boolean; isDeployCommand?: boolean },
): Promise<RepoReleaseSummary> {
  const scope = releaseLockScope(c.route, target.name);
  const remit = emit.forRoute(c.route);
  const identity = await resolveReleaseKey(c);
  const tracker = new Tracker(c, cfg.ship, { apiKey: identity.apiKey });
  const { byRepo } = ticketsByRepo(c, await tracker.openTickets());
  const modes = { modes: await tracker.projectWorkModes(), agentAssignees: new Set<string>() };
  const verified = withoutManualVerified(byRepo.get(target.name) ?? [], tracker.contract.statuses.verified, modes)
    .filter((t) => t.status === tracker.contract.statuses.verified);
  const force = command === 'deploy' || flag('force');
  if (!dryRun && verified.length === 0 && !force) {
    return { scope, tests: 'skipped', outcome: 'skipped', detail: 'nothing verified — no release sandbox created' };
  }
  const o = c.repoOverrides[target.name];
  const effective = resolveRepoConfig(contract, {
    hooks: { ...c.hooks, ...o?.hooks }, labels: { ...c.labels, ...o?.labels },
    release: mergeRouteRelease(c.release, o?.release),
    branch: { ...c.branch, ...o?.branch },
    worktrees: { prefix: shipWorktreePrefixFor(c), nameOverride: o?.worktreeName },
  }, target.dir);
  const forgeHost = mirror.host;
  let token: string | null = null;
  try { token = readForgeToken(cfg.ship.forges, forgeHost, cfg.ship.stateDir); } catch { /* the push then fails with git's own message */ }
  const sandbox = await openReleaseSandbox({
    sandbox: cfg.ship.sandbox ?? {}, route: c.route, repoName: target.name,
    image: sandboxImageForRun(readSandboxState(cfg.ship.stateDir), target.name, Boolean(contract.sandbox)) ?? undefined,
    policy: {
      forgeHosts: [...new Set(reposOf(c).map((r) => r.forgeHost ?? 'github.com'))],
      tablationUrl: c.baseUrl, authMode: 'workspace', provider: 'anthropic', harnessBin: 'claude',
      ...(contract.sandboxNetwork ? { extraHosts: contract.sandboxNetwork.hosts, toolchains: contract.sandboxNetwork.toolchains } : {}),
    },
    policyFile: join(cfg.ship.stateDir, 'release', `${target.name}.policy.yaml`),
    repo: mirror, origin: forgeDescriptorFor(forgeHost).httpsUrl(mirror.host, mirror.path),
    base: effective.branch.base,
    branches: verified.map((t) => pushedBranchForTicket(effective, t)),
    tagPattern: effective.release.tagPattern ?? 'v*',
    token, username: forgeFor(cfg.ship.forges, forgeHost)?.entry.username || forgeDescriptorFor(forgeHost).credentialUsername,
    emit: remit,
  }).catch((e: Error) => {
    remit.warn(`${scope}: could not start the release sandbox: ${e.message}`, { step: 'release' });
    return null;
  });
  if (!sandbox) return { scope, tests: 'skipped', outcome: 'skipped', detail: 'could not start the release sandbox' };
  remit.emit(`${scope}: releasing from sandbox ${sandbox.sandbox}`, { step: 'release', data: { event: 'release_sandbox', sandbox: sandbox.sandbox } });
  try {
    const summary = await releasePhase(c, { ...target, dir: sandbox.dir }, opts);
    return { ...summary, detail: `${summary.detail ? `${summary.detail}; ` : ''}ran in sandbox ${sandbox.sandbox}` };
  } finally {
    await sandbox.close();
  }
}

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
  // CREW-2938: a sandbox-runner ship with no primary checkouts has no directory to run git in and no
  // `.crew.yaml` to read; the contract comes from the mirror, and one line says what happens instead.
  // CREW-3006: a sandbox ship decides on its runner, not on whether a host checkout happens to exist;
  // a checkout there (an operator's, or left by an older version) must not send the phase down the host path.
  if (cfg.ship.runner === 'sandbox') {
    let mode: string | null = null;
    let contract: RepoConfig | null = null;
    const settings = cacheSettingsOf(cfg.ship.sandbox);
    const mirror = mirrorRepoOfTarget(target);
    if (settings && mirror) {
      try {
        contract = await readMirrorContract(new SandboxCache(settings), mirror, c.branch?.base ?? 'main');
        mode = contract?.release.mode ?? null;
      }
      catch (e) { if (firstReport(`${scope0(c, target)}:contract`)) remit.warn(`${target.name}: could not read the contract from the mirror: ${(e as Error).message}`, { step: 'release' }); }
    }
    // CREW-2940: `integrate` and `ci_*` repositories are released from a sandbox over a mirror-fed clone.
    if (releasesFromSandbox(mode) && settings && mirror && contract) {
      return releaseFromSandbox(c, target, contract, mirror, opts);
    }
    if (lacksCheckout(cfg.ship, target.dir)) {
      const note = noCheckoutReleaseNote(target.name, mode);
      if (firstReport(`${scope0(c, target)}:release`)) remit.emit(note, { step: 'release' });
      return { scope: releaseLockScope(c.route, target.name), tests: 'skipped', outcome: 'skipped', detail: note };
    }
    // `local`/`external` with a checkout present: the host path below is the one that owns it.
  }
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

    // CREW-2928: a refused base contract is held, not thrown, so the ticket
    // that replaces it can still be released (decided once the candidates are known).
    let contractRefusal: Error | null = null;
    const repoFile = loadRepoConfigTolerant(target.dir, (e) => { contractRefusal = e; });
    const o = c.repoOverrides[target.name];
    const repo = resolveRepoConfig(repoFile, {
      hooks: { ...c.hooks, ...o?.hooks }, labels: { ...c.labels, ...o?.labels },
      release: mergeRouteRelease(c.release, o?.release),
      branch: { ...c.branch, ...o?.branch },
      worktrees: { prefix: shipWorktreePrefixFor(c), nameOverride: o?.worktreeName },
    }, target.dir);
    const problems = validateEffective(repo);
    for (const p of problems) remit.warn(`${scope}: ${p}`);

    // What a host must be to build THIS repo is that repo's own fact
    // (`.crew.yaml`), not the route's — a route can span repos with
    // different needs. Skip only this one; the rest of the route's
    // repos may still be releasable here.
    // CREW-3104: the base contract alone is self-sealing (the branch that
    // changes `platform` to admit this ship is the one it would refuse to
    // look at), so a live release defers this decision until the verified
    // branches are known; a dry run has none and keeps the base verdict.
    const baseAdmitsShip = satisfies(cfg.ship.platform, repo.platform);
    if (!baseAdmitsShip && dryRun) {
      const detail = explain(cfg.ship.platform, repo.platform);
      remit.emit(`${scope}: skipping — ${detail}`, { step: 'release' });
      return { scope, tests: 'skipped', outcome: 'skipped', detail };
    }
    if (baseAdmitsShip) {
      try { clearShipAttention(new State(cfg.ship.stateDir), repoPlatformUnreleasableKey(target.name)); } catch { /* attention is a convenience */ }
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
    // CREW-1605: release comments, failure tickets and stamps write as the
    // release seat's own agent principal; without a stored key they stay on the
    // ship key, with the reason on the run log.
    const releaseIdentity = await resolveReleaseKey(c);
    // CREW-2785: an unreadable key store refuses the release rather than releasing as the ship.
    const releaseRouteSlug = routeSlug(c.route);
    if (releaseIdentity.kind === 'ship' && releaseIdentity.storeError) {
      const detail = `release refused: its agent key cannot be read (${releaseIdentity.storeError})`;
      remit.warn(`${scope}: ${detail}`, { step: 'release' });
      try {
        await raiseShipAttention({ state: new State(cfg.ship.stateDir), emit: remit, route: c, ship: cfg.ship },
          seatKeyUnreadableItem(releaseRouteSlug, 'release', releaseIdentity.storeError));
      } catch { /* the warn line above still says it */ }
      return { scope, tests: 'skipped', outcome: 'skipped', detail };
    }
    try { clearShipAttention(new State(cfg.ship.stateDir), seatKeyUnreadableKey(releaseRouteSlug, 'release')); } catch { /* attention is a convenience */ }
    if (releaseIdentity.kind === 'ship') remit.warn(`release writes as the ship, not its own agent: ${releaseIdentity.reason}`, { step: 'release' });
    const tracker = new Tracker(c, cfg.ship, { apiKey: releaseIdentity.apiKey });

    // Lock-free pre-check (CREW-1415): the lock exists to cover a decision to
    // release, so a repo with nothing verified and a base level with its last
    // tag never needs it. One ticket read per route per cycle, shared by
    // every repo on it.
    if (!dryRun) {
      const force = command === 'deploy' || flag('force');
      let seen = precheckTickets.get(c.route);
      if (!seen) precheckTickets.set(c.route, (seen = tracker.openTickets()));
      const { byRepo: preByRepo, unplaceable: preUnplaceable } = ticketsByRepo(c, await seen);
      clearShipAttention(state, SEAT_FORBIDDEN_KEY);
      const preModes = { modes: await tracker.projectWorkModes(), agentAssignees: new Set<string>() };
      const pre = withoutManualVerified(
        preByRepo.get(target.name) ?? [], tracker.contract.statuses.verified, preModes,
      );
      // A verified ticket with no (or an unknown) repo belongs to no repo's
      // list, so every repo can read as idle and skip before the report below
      // — which would leave it stranded in silence. Reporting takes no lock.
      reportUnplaceable(c.route, preUnplaceable, tracker.contract.statuses.verified, remit);
      // CREW-2603: same ref the release itself will decide on, so a dirty or
      // off-base primary does not read as "blocked" or stale before the lock.
      const remoteBase = remoteBranchExists(target.dir, repo.branch.remote, repo.branch.base);
      if (!baseAdmitsShip) {
        const baseRef = remoteBase ? `${repo.branch.remote}/${repo.branch.base}` : repo.branch.base;
        const verifiedPre = pre.filter((t) => t.status === tracker.contract.statuses.verified);
        const admitters = platformAdmitters(
          target.dir, baseRef, cfg.ship.platform, verifiedPre,
          (t) => locateBranchForTicket(target.dir, repo, t as Ticket)?.branch ?? null,
        );
        if (admitters.length === 0) {
          const detail = explain(cfg.ship.platform, repo.platform);
          const ids = verifiedPre.map((t) => t.issue_id);
          if (firstReport(`${scope}:platform:${ids.join(',')}`)) remit.emit(`${scope}: skipping — ${detail}`, { step: 'release' });
          if (ids.length) {
            try {
              await raiseShipAttention({ state, emit: remit, route: c, ship: cfg.ship },
                repoPlatformUnreleasableItem(target.name, platformStuckNote(target.name, repo.platform, cfg.ship.platform, ids)));
            } catch { /* the skip line above still says it */ }
          } else {
            try { clearShipAttention(state, repoPlatformUnreleasableKey(target.name)); } catch { /* attention is a convenience */ }
          }
          return { scope, tests: 'skipped', outcome: 'skipped', detail };
        }
        try { clearShipAttention(state, repoPlatformUnreleasableKey(target.name)); } catch { /* attention is a convenience */ }
        remit.emit(
          `${scope}: the base contract requires ${repo.platform}, but ${admitters.map((a) => a.issueId).join(', ')} change${admitters.length === 1 ? 's' : ''} platform to ${admitters[0]!.platform}, which this ship satisfies — releasing`,
          { step: 'release' },
        );
      }
      const d = decideRelease(target.dir, pre, tracker.contract, {
        tagPattern: repo.release.tagPattern ?? 'v*', base: repo.branch.base,
        ...(remoteBase ? { ref: `${repo.branch.remote}/${repo.branch.base}`, guard: false } : {}),
      });
      const unstamped = planReleasedBranches(
        target.dir, pre, tracker.contract,
        (t) => locateBranchForTicket(target.dir, repo, t)?.branch ?? null,
        repo.branch.base, repo.release.tagPattern ?? 'v*',
      ).length;
      if (releaseIdle({
        tickets: pre, verifiedStatus: tracker.contract.statuses.verified, force,
        external: repo.release.mode === 'external', upToDate: d.upToDate, unseeded: d.unseeded, unstamped,
      })) {
        remit.emit(`${target.name}: nothing verified — not locking`, { step: 'release' });
        await sweepClosedTickets(c, target, repo.branch, tracker, dryRun, remit, true);
        return { scope, tests: 'skipped', outcome: 'skipped', detail: 'nothing verified — not locking' };
      }
    }

    if (!dryRun) {
      const holderLabel = `${cfg.ship.name}:${process.pid}`;
      const got = await tracker.acquireBoardLock(scope, holderLabel, RELEASE_LOCK_TTL_MS, {
        warn: (m) => remit.warn(m, { step: 'release' }), debug: (m) => remit.emit(m, { step: 'release' }),
      });
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
    const releaseModes = { modes: await tracker.projectWorkModes(), agentAssignees: new Set<string>() };
    const tickets = withoutManualVerified(
      byRepo.get(target.name) ?? [], tracker.contract.statuses.verified, releaseModes,
    );
    reportUnplaceable(c.route, unplaceable, tracker.contract.statuses.verified, remit);
    if (contractRefusal) {
      const refusal: Error = contractRefusal;
      const baseRef = remoteBranchExists(target.dir, repo.branch.remote, repo.branch.base)
        ? `${repo.branch.remote}/${repo.branch.base}` : repo.branch.base;
      const fixers = contractFixers(
        target.dir, baseRef, tickets.filter((t) => t.status === tracker.contract.statuses.verified),
        (t) => locateBranchForTicket(target.dir, repo, t as Ticket)?.branch ?? null,
      );
      if (fixers.length === 0) throw refusal;
      remit.emit(
        `${target.name}: the base contract is refused (${refusal.message}); ` +
          `${fixers.map((f) => f.issueId).join(', ')} replace${fixers.length === 1 ? 's' : ''} ${fixers[0]!.file} — merging first`,
        { step: 'release' },
      );
    }
    // Blocker statuses for the verified tickets only (CREW-1506): `all` is open
    // tickets, and a blocker already closed is not in it, so fetch the rest.
    const blockerInfo = blockerInfoMap(all, await tracker.ticketsByIds(missingBlockerIds(all)));

    // What QA verified, per ticket (CREW-1637): the release leaves out a
    // branch that has moved past it. A board with no event log reads as none
    // known, so nothing is held back for want of a sha.
    const verifiedStatus = tracker.contract.statuses.verified;
    const verifiedTickets = tickets.filter((t) => t.status === verifiedStatus);
    const verifiedShas = new Map<string, string>();
    if (verifiedTickets.length && repo.release.mode !== 'external') {
      let pushedEvents: Awaited<ReturnType<Tracker['events']>> = [];
      try {
        pushedEvents = await tracker.events('pushed');
      } catch (e) {
        remit.warn(`could not read hand-off events; not checking branches against what QA verified: ${(e as Error).message}`);
      }
      for (const t of verifiedTickets) {
        const sha = verifiedShaFor(t, tracker.contract.columns.verifiedSha, pushedEvents);
        if (sha) verifiedShas.set(t.id, sha);
      }
    }

    const outcome = await runRelease({
      cwd: target.dir, repo,
      reloadRepo: (dir) => resolveRepoConfig(loadRepoConfig(dir), {
        hooks: { ...c.hooks, ...o?.hooks }, labels: { ...c.labels, ...o?.labels },
        release: mergeRouteRelease(c.release, o?.release),
        branch: { ...c.branch, ...o?.branch },
        worktrees: { prefix: shipWorktreePrefixFor(c), nameOverride: o?.worktreeName },
      }, dir),
      contract: tracker.contract, tickets, blockerInfo, emit: remit, scope, verifiedShas,
      ...(contractRefusal ? { contractRefusal: (contractRefusal as Error).message } : {}),
      state: state.release(scope),
      reviewColumns: repo.release.mode === 'external' ? await tracker.reviewColumns() : undefined,
      forge: { host: target.forgeHost, remote: target.remote },
      dryRun, skipTests: flag('skip-tests'), shell: cfg.ship.shell,
      mergeOnly: command === 'merge',
      // ci_* modes: record the merge on the board when it lands on base,
      // not only once CI confirms the release live (CREW-2820).
      onBasePushed: async (merged) => {
        remit.enter('reconcile');
        await applyMergeStamp(
          tracker, new Map(merged.map((m) => [m.ticket.issue_id, m.sha])),
          merged.map((m) => m.ticket), remit, dryRun, target.dir,
        );
      },
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
        new Map([
          // Squashed onto an untagged base by an earlier cycle: no release range
          // names it, so the first release carries it out here (CREW-2925).
          ...outcome.decision.merges.filter((m) => m.skipReason === 'already-merged' && m.mergedSha)
            .map((m): [string, string | undefined] => [m.ticket.issue_id, m.mergedSha]),
          ...outcome.merged.map((m): [string, string | undefined] => [m.ticket.issue_id, m.sha]),
        ]),
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

    // A ticket another ship released and a second ship bounced back to
    // `in_progress`/`needs_info`: its branch tip is the one a tagged squash
    // recorded, so nothing new was built — stamp it (CREW-1408).
    for (const r of planReleasedBranches(
      target.dir, tickets, tracker.contract,
      (t) => locateBranchForTicket(target.dir, repo, t)?.branch ?? null,
      repo.branch.base, repo.release.tagPattern ?? 'v*',
    )) {
      remit.enter('reconcile');
      await applyStamp(
        tracker, [{ ticket: r.ticket, reason: `branch already released in ${r.tag}`, sha: r.sha }],
        r.tag.replace(/^v/, ''), tracker.contract, remit, dryRun, target.dir,
      );
    }

    // The test gate has been red on this head for several cycles running:
    // say so on each ticket it is holding back, once (gate-red.ts).
    if (outcome.gateRed && !dryRun) {
      try {
        const g = outcome.gateRed;
        const reported = await tracker.events('gate_red');
        const seat = releaseSeat(c);
        for (const t of gateRedTickets(outcome.merged, outcome.decision.merges)) {
          if (alreadyReported(t, g, reported)) continue;
          await tracker.postEvent(t.id, gateRedComment(g), seat, 'gate_red');
          remit.warn(`test gate red for ${g.count} cycles — noted on the ticket`, { ticket: t.issue_id, step: 'merge' });
        }
        state.release(scope).noteTestGateReported(g.sha);
      } catch (e) {
        remit.warn(`could not note the red test gate on the board: ${(e as Error).message}`, { step: 'merge' });
      }
    }

    // A verified ticket skipped for a stale local ref says so on the ticket
    // (CREW-2528), once per distinct problem, not only in the event log.
    if (outcome.localRefSkips?.length && !dryRun) {
      try {
        const reported = await tracker.events('local_ref_skip');
        const seat = releaseSeat(c);
        for (const s of outcome.localRefSkips) {
          if (localRefSkipReported(s.ticket, s.problem, reported)) continue;
          await tracker.postEvent(s.ticket.id, localRefSkipComment(cfg.ship.name, s.problem), seat, 'local_ref_skip');
        }
      } catch (e) {
        remit.warn(`could not note the skipped release on the board: ${(e as Error).message}`, { step: 'merge' });
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

    // Verified tickets whose branch moved past what QA verified were left out
    // of the release above: send them back to QA (CREW-1637).
    if (outcome.movedPast?.length) {
      await applyReview(
        tracker, tracker.contract, { handoffs: [], requeues: outcome.movedPast }, repo.branch.remote, remit,
        releaseSeat(c), { verifiedSha: false, prRef: false }, dryRun,
      );
    }

    // File an alert under the failing repo's project so that project's lanes can
    // take it (CREW-1632). A failed lookup files it unplaced, as before.
    const alertPlacement = async (): Promise<{ repo_id?: string; project_id?: string }> => {
      const placement: { repo_id?: string; project_id?: string } = {};
      try {
        const repoId = repoIdForName(c, target.name);
        if (repoId) {
          placement.repo_id = repoId;
          const projectId = (await tracker.repoRow(repoId))?.project_id;
          if (projectId) placement.project_id = projectId;
        }
      } catch { /* unplaced beats no alert */ }
      return placement;
    };

    // Last, and non-fatal: whatever happened has happened, and telling someone
    // about it must not be able to change the outcome.
    const news = describeRelease(outcome, scope, { ship: cfg.ship.name, runner: cfg.ship.runner });
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
        const placement = await alertPlacement();
        await applyFailureAlert(tracker, news, scope, all, memberId, remit, dryRun, placement).catch((e) => {
          remit.warn(`could not file/update a failure ticket: ${(e as Error).message}`, { step: 'release' });
        });
      }
    }

    // The other direction (CREW-2211): a stage this release got past is a
    // failure alert for that stage now stale. Non-fatal for the same reason.
    const recovered = recoveredFailureHeadlines(outcome, scope);
    if (recovered.length) {
      const passed = outcome.version
        ? `${scope} released ${outcome.version}`
        : outcome.deployed || outcome.integrated ? `${scope} release passed` : `${scope} release got past this stage`;
      await applyFailureRecovery(
        tracker, recovered, all, tracker.contract, releaseSeat(c), passed, remit, dryRun,
      ).catch((e) => {
        remit.warn(`could not resolve failure tickets: ${(e as Error).message}`, { step: 'release' });
      });
    }

    // A verified branch that would not merge, or a verified ticket with
    // nothing to merge at all. Non-fatal like everything else down here —
    // the release has already shipped whatever could ship — but unlike the
    // old behaviour neither evaporates: a conflict goes back to a lane that
    // can fix it (ISSUE-346 failed six times in an hour that way), and a
    // ticket the release cannot place at all is flagged and, if it repeats,
    // escalated to a person (ISSUE-379).
    if (outcome.buildCulprits?.length) {
      const seat = releaseSeat(c);
      const prior = [...await tracker.events('build_failed'), ...await tracker.events('pushed')];
      for (const cu of outcome.buildCulprits) {
        try {
          const bounce = planBuildFailureBounce(target.dir, cu, repo.branch.base, repo.branch.remote);
          const r = await applyBuildFailureBounce(
            tracker, bounce, tracker.contract, seat, remit, dryRun,
            { count: priorBuildFailures(cu.ticket, prior), operatorId: c.resolved?.operator, previousNote: priorFailureNote(cu.ticket, prior) },
          );
          if (r.kind === 'failed') {
            remit.warn(`could not hand back ${displayKey(cu.ticket)}: ${r.why}`, { step: 'release' });
          }
          if (r.kind === 'escalated' && !dryRun) {
            // Loop guard (CREW-2777): the same ticket broke the gate again after
            // a hand-back, so the alert is the fallback and says what was tried.
            const key = cu.ticket.issue_tag ?? cu.ticket.issue_id;
            await applyFailureAlert(tracker, {
              level: 'fail',
              headline: `${scope}: release blocked — ${key} broke the ${cu.hook} gate twice`,
              detail: `${key} (\`${cu.branch}\`) was handed back after a failed ${cu.hook} gate, pushed and re-verified, and failed it again. Isolation found it both times (${cu.how}), so it is escalated to the operator instead of another lap.\n\n\`\`\`\n${cu.tail.trimEnd()}\n\`\`\``,
            }, scope, all, seat, remit, dryRun, await alertPlacement()).catch((e) => {
              remit.warn(`could not file/update a failure ticket: ${(e as Error).message}`, { step: 'release' });
            });
          }
        } catch (e) {
          remit.warn(`could not hand back ${displayKey(cu.ticket)}: ${(e as Error).message}`, { step: 'release' });
        }
      }
    }

    // A gate hook that failed once and passed on the immediate rerun
    // (CREW-3220): the release went on, and the flake is recorded on a ticket
    // (one per route and hook; a recurrence comments on it) so it gets fixed.
    if (outcome.flakes?.length && !dryRun) {
      const seat = releaseSeat(c);
      for (const f of outcome.flakes) {
        const files = f.files.length ? f.files.map((p) => `\`${p}\``).join(', ') : 'no file named in the output';
        await applyFailureAlert(tracker, {
          level: 'warn',
          headline: `${scope}: flaky ${f.hook} gate`,
          detail: `The \`${f.hook}\` hook (${f.label}) failed once during a release and passed on an immediate rerun of the same composition, so no branch was blamed and the release went on. Failing: ${files}.\n\n\`\`\`\n${f.tail.trimEnd()}\n\`\`\``,
        }, scope, all, seat, remit, dryRun, await alertPlacement()).catch((e) => {
          remit.warn(`could not file/update a flaky-gate ticket: ${(e as Error).message}`, { step: 'release' });
        });
      }
    }

    if ((outcome.conflicts?.length || outcome.unbuildable?.length)) {
      // Prior hand-back/flag events are fetched only when one of these actually happens, which
      // is almost never — it costs a request on the rare cycle that needs
      // one, and none at all on the rest. Shared between both loops below.
      const handedBack = [...await tracker.events('conflict_handed_back'), ...await tracker.events('pushed')];
      const flagged = await tracker.events('stranded_flagged');
      const seat = releaseSeat(c);

      for (const f of outcome.conflicts ?? []) {
        try {
          const bounce = planConflictBounce(
            target.dir, f.candidate.ticket, f.candidate.branch!, repo.branch.base, f.paths, handedBack,
            outcome.merged.filter((m) => m.branch).map((m) => ({ key: m.ticket.issue_id, branch: m.branch! })),
          );
          const r = await applyConflictBounce(tracker, bounce, tracker.contract, seat, remit, dryRun);
          if (r.kind === 'failed') {
            remit.warn(`could not hand back ${displayKey(f.candidate.ticket)}: ${r.why}`, { step: 'merge' });
          }
        } catch (e) {
          remit.warn(
            `could not hand back ${displayKey(f.candidate.ticket)}: ${(e as Error).message}`,
            { step: 'merge' },
          );
        }
      }

      for (const cand of outcome.unbuildable ?? []) {
        try {
          const stranded = planStrandedVerified(cand, repo.branch.base, repo.branch.remote, flagged);
          const r = await applyStrandedVerified(
            tracker, stranded, tracker.contract, c.resolved?.operator, seat, remit, dryRun,
          );
          if (r.kind === 'failed') {
            remit.warn(`could not flag ${displayKey(cand.ticket)}: ${r.why}`, { step: 'merge' });
          }
        } catch (e) {
          remit.warn(`could not flag ${displayKey(cand.ticket)}: ${(e as Error).message}`, { step: 'merge' });
        }
      }
    }

    // Also non-fatal, and last of all: a ticket that reached a terminal
    // status (here or on an earlier cycle) is done with its worktree. A
    // tracker blip here must not turn a good release into a failed one, the
    // same reasoning as stamping above (ISSUE-346).
    await sweepClosedTickets(c, target, repo.branch, tracker, dryRun, remit);

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
    // CREW-2549: a 403 is the release seat's key lacking a project role, the
    // same for every repository on every cycle — one ship attention item with
    // the remedy, and a short line here, not a URL stack per repository.
    if (isForbiddenError(e)) {
      await raiseShipAttention({ state, emit: remit, route: c, ship: cfg.ship }, seatForbiddenItem(new Date(), e, c));
      const line = seatForbiddenRepoLine(scope);
      remit.warn(line, { step: 'release' });
      return { scope, tests: 'skipped', outcome: 'error', detail: line };
    }
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
// Set by a command that handles Ctrl-C itself (`repos hooks --agent` aborts its
// toolchain session and reports `cancelled`); the global exit-0 handler below
// would otherwise end the process first, silently, and leave the child running.
let sigintOwnedByCommand = false;
if (!dryRun) {
  process.on('exit', dropLock);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { if (sig === 'SIGINT' && sigintOwnedByCommand) return; dropLock(); process.exit(0); });
  }
}
if (EXCLUSIVE[command] && !dryRun) {
  const got = state.acquire(EXCLUSIVE[command]!);
  if (!got.ok) {
    emit.note(`a previous ${command} (pid ${got.heldBy}) is still running — skipping this cycle`);
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

    // CREW-2495: reconcile the ship name with each route's Ships row before
    // the heartbeat (which finds the row by name). Routes go in turn, so a
    // name adopted from one workspace is pushed to the next. Not on --dry-run.
    if (!dryRun) {
      for (const r of fleetWide ? cfg.routes : [route]) {
        await reconcileRouteShipName({ route: r, ship: cfg.ship, configFile: cfg.configFile, emit: emit.forRoute(r.route) });
      }
    }

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
      // CREW-3255: a pull request a person opened is linked on the ticket.
      for (const e of fleet.entries) {
        if (dryRun || e.error || !e.decision) continue;
        await discoverForRoute(e.route, cfg.ship, e.decision.tickets, emit.forRoute(e.route.route));
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
          repoContract: await planContractOf(w.route, repoTargetFor(w.route, w.decision.actionable.top?.repo_id)?.name),
          role: w.role, route: w.route, ship: cfg.ship,
          stateDir: cfg.ship.stateDir, roster: rosterFor(w.decision, w.route, w.role),
          environment: await environmentFor(w.route, w.decision.actionable.top?.issue_id),
          apiKey: resolveApiKey(w.route),
          cycle: wemit.cycle, ticket: w.decision.actionable.top?.issue_id,
          repo: repoTargetFor(w.route, w.decision.actionable.top?.repo_id)?.name,
          ...personaPromptOptions(await fetchPersonaPrompt(w.route, w.role, { userAgent: cfg.ship.userAgent })),
          skillOverrides: await fetchSkillOverrides(w.route, { userAgent: cfg.ship.userAgent }),
          agentPersona: await fetchSeatPersona(w.route, w.role, { userAgent: cfg.ship.userAgent }),
          resolvedAgentId: await resolveAgentId(w.route, w.role, { userAgent: cfg.ship.userAgent }),
        });
        process.stdout.write(`${describePlan(fleetPlan)}\n`);
        break;
      }

      // Role-distinct, capacity-limited (ISSUE-381) — see State.acquireRun.
      // Taken here, once the winning role is known, not up front: the fleet
      // poll above is read-only and must run every cycle regardless.
      const fleetLock = state.acquireRun(w.role, cfg.ship.maxConcurrentAgents, cfg.ship.roleConcurrency[w.role] ?? 1);
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
      let fleetTicketRepo = repoTargetFor(w.route, w.decision.actionable.top?.repo_id)?.name;
      let fleetWorkingId = w.decision.actionable.top?.id ?? null;
      if (w.role === 'dev' || w.role === 'design' || w.role === 'qa') {
        const seat = w.route.resolved?.seats[w.role];
        if (seat) {
          const candidates = rankedCandidates(w.role, w.decision.selectionInput);
          const contract = w.decision.selectionInput.contract ?? DEFAULT_CONTRACT;
          await refreshUnknownRepos({ route: w.route, stateDir: cfg.ship.stateDir, fetchRows: () => fleetTracker.repoRowsForMap(), tickets: candidates });
          const result = await resolveTopCandidate(
            fleetTracker, candidates, seat,
            claimStatuses(w.role, contract).approved,
            claimStatuses(w.role, contract).building,
            (t) => dirForRepo(w.route, t.repo_id) !== null,
            withHoldCheck(await fleetTracker.claimAffinity(), w.decision.selectionInput),
            (t) => {
              const got = state.acquireTicket(t.id);
              return got.ok ? got.release : null;
            },
          );
          if (result.releaseTicket) {
            // The ticket lock lives exactly as long as the role/slot lock does (CREW-2821).
            const roleLock = lock;
            const releaseTicket = result.releaseTicket;
            lock = { release: () => { roleLock?.release(); releaseTicket(); } };
          }
          if (result.contended.length) {
            wemit.note(`claim contended for ${result.contended.join(', ')} — moved to the next candidate`, {
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
          fleetTicketRepo = target?.name;
          try {
            if (target && !skipsHostCheckout(cfg.ship) && ensureRepoCheckout(target.dir, target.remote, { scheme: cfg.ship.cloneScheme, host: target.forgeHost })) {
              wemit.note(`cloned ${target.name} into ${target.dir}`, { step: 'select', role: w.role });
            }
          } catch (e) {
            wemit.error(`could not check out ${target?.name ?? '(unknown repo)'} for ${displayKey(result.ticket)}: ${(e as GitError).message}`);
            if (!skipInlineRelease) await releaseFleet();
            break;
          }
        }
      }

      const fleetPlan = planAgentRun({
        repoContract: await planContractOf(w.route, fleetTicketRepo),
        role: w.role, route: w.route, ship: cfg.ship,
        stateDir: cfg.ship.stateDir, roster: rosterFor(w.decision, w.route, w.role),
        environment: await environmentFor(w.route, fleetTicketHint),
        apiKey: resolveApiKey(w.route),
        cycle: wemit.cycle, ticket: fleetTicketHint, repo: fleetTicketRepo,
        ...personaPromptOptions(await fetchPersonaPrompt(w.route, w.role, { userAgent: cfg.ship.userAgent })),
        skillOverrides: await fetchSkillOverrides(w.route, { userAgent: cfg.ship.userAgent }),
        agentPersona: await fetchSeatPersona(w.route, w.role, { userAgent: cfg.ship.userAgent }),
        resolvedAgentId: await resolveAgentId(w.route, w.role, { userAgent: cfg.ship.userAgent }),
      });
      wemit.enter('agent', w.role);
      wemit.note(`starting agent run for ${w.route.route}`);
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
        const runStart = new Date().toISOString();
        await markCrewAssistedAtLaunch(fleetTracker, w.route, w.role, fleetWorkingId ?? null, undefined, (m) => wemit.warn(m, { step: 'agent' }));
        const fleetRun = await spawnAgent(fleetPlan, wemit);
        const fleetHandoff = await guardRunHandoff(w.route, cfg.ship, fleetTracker, w.role, fleetWorkingId, wemit, runStart);
        wemit.echo(describeRunOutcome({ role: w.role, route: w.route.route, ticket: fleetTicketHint, run: fleetRun, handoff: fleetHandoff }));
      } finally {
        dropLock();
        await settleRunEnd({
          tracker: fleetTracker, shipName: cfg.ship.name, route: w.route, role: w.role, memberId: fleetMemberId, ownTicketRecordId: fleetWorkingId,
          stateDir: cfg.ship.stateDir, emit: wemit,
        });
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
    if (!dryRun) {
      state.attention(route.route).persist(decision.attention);
      state.unroutable(route.route).persist(decision.unroutable);
    }

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
        emit.note(
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
    if (!dryRun) await discoverForRoute(route, cfg.ship, decision.tickets, emit);

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
        const got = state.acquireRun(current, cfg.ship.maxConcurrentAgents, cfg.ship.roleConcurrency[current] ?? 1);
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
      let ticketRepo = repoTargetFor(route, decision.actionable.top?.repo_id)?.name;
      let workingId = decision.actionable.top?.id ?? null;
      if (!dryRun && (current === 'dev' || current === 'design' || current === 'qa')) {
        const seat = route.resolved?.seats[current];
        if (seat) {
          const candidates = rankedCandidates(current, decision.selectionInput);
          const contract = decision.selectionInput.contract ?? DEFAULT_CONTRACT;
          await refreshUnknownRepos({ route, stateDir: cfg.ship.stateDir, fetchRows: () => tracker2.repoRowsForMap(), tickets: candidates });
          const result = await resolveTopCandidate(
            tracker2, candidates, seat,
            claimStatuses(current, contract).approved,
            claimStatuses(current, contract).building,
            (t) => dirForRepo(route, t.repo_id) !== null,
            withHoldCheck(await tracker2.claimAffinity(), decision.selectionInput),
            (t) => {
              const got = state.acquireTicket(t.id);
              return got.ok ? got.release : null;
            },
          );
          if (result.releaseTicket) {
            // The ticket lock lives exactly as long as the role/slot lock does (CREW-2821).
            const roleLock = lock;
            const releaseTicket = result.releaseTicket;
            lock = { release: () => { roleLock?.release(); releaseTicket(); } };
          }
          if (result.contended.length) {
            emit.note(`claim contended for ${result.contended.join(', ')} — moved to the next candidate`, {
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
          ticketRepo = target?.name;
          try {
            if (target && !skipsHostCheckout(cfg.ship) && ensureRepoCheckout(target.dir, target.remote, { scheme: cfg.ship.cloneScheme, host: target.forgeHost })) {
              emit.note(`cloned ${target.name} into ${target.dir}`, { step: 'select', role: current });
            }
          } catch (e) {
            emit.error(`could not check out ${target?.name ?? '(unknown repo)'} for ${displayKey(result.ticket)}: ${(e as GitError).message}`);
            dropLock();
            if (explicitRole) { current = undefined; break; }
            const remaining = nextRoles(decision, [...ran, current]);
            current = remaining[0];
            continue;
          }
        }
      }

      const plan = planAgentRun({
        repoContract: await planContractOf(route, ticketRepo),
        role: current, route, ship: cfg.ship,
        stateDir: cfg.ship.stateDir, roster: rosterFor(decision, route, current),
        environment: await environmentFor(route, ticketHint),
        apiKey: resolveApiKey(route),
        cycle: emit.cycle, ticket: ticketHint, repo: ticketRepo,
        ...personaPromptOptions(await fetchPersonaPrompt(route, current, { userAgent: cfg.ship.userAgent })),
        skillOverrides: await fetchSkillOverrides(route, { userAgent: cfg.ship.userAgent }),
        agentPersona: await fetchSeatPersona(route, current, { userAgent: cfg.ship.userAgent }),
        resolvedAgentId: await resolveAgentId(route, current, { userAgent: cfg.ship.userAgent }),
      });
      if (dryRun) {
        process.stdout.write(`${describePlan(plan)}\n`);
        // CREW-2579: a hand-off the guard would complete is reported, never done.
        if (workingId && (current === 'dev' || current === 'design')) {
          try {
            const t = await tracker2.ticket(workingId);
            const r = repoConfigFor(route, t);
            const would = r && describeHandoffPush(r.target.dir, r.cfg, t, current);
            if (would) process.stdout.write(`${would}\n`);
          } catch { /* a dry run reports what it can */ }
        }
        break;
      }
      const before = snapshot(await tracker2.openTickets());
      emit.enter('agent', current);
      emit.note('starting agent run');
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
        const runStart = new Date().toISOString();
        await markCrewAssistedAtLaunch(tracker2, route, current, workingId ?? null, undefined, (m) => emit.warn(m, { step: 'agent' }));
        const agentRun = await spawnAgent(plan, emit);
        const handoff = await guardRunHandoff(route, cfg.ship, tracker2, current, workingId, emit, runStart);
        emit.echo(describeRunOutcome({ role: current, route: route.route, ticket: ticketHint, run: agentRun, handoff }));
      } finally {
        dropLock();
        await settleRunEnd({
          tracker: tracker2, shipName: cfg.ship.name, route, role: current, memberId, ownTicketRecordId: workingId,
          stateDir: cfg.ship.stateDir, emit,
        });
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
    // The persistent supervisor loop (ISSUE-762), for the `run` job only —
    // `release`/`passengers` keep their own fixed-timer units untouched.
    // Naming no route on a multi-route ship serves every enabled route
    // (CREW-3063), as `crew run` does; `crew daemon <route>` serves one.
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
        die('crew daemon', 'no scheduler support yet for Windows (Task Scheduler is planned, not built)', '`crew run <route>` from your own scheduler');
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
      // CREW-3237: launchd's start is planned from what the service manager reports
      // (loaded/running/unloaded), not a blind `load` that fails on a loaded unit.
      const launchdStart = (o: { verifyAfterLoad?: boolean; assumeUnloaded?: boolean }): boolean => {
        const runPlan = planInstall(cfg.ship, CREW_HOME, host, detectSystemd(), 'run', installContext());
        const label = labelFor(CREW_HOME, 'run');
        const r = startLaunchdDaemon({
          unitPath: runPlan.unitPaths[0]!, label, uid: process.getuid?.() ?? 0,
          schedulerLog: runPlan.schedulerLog, dryRun, ...o,
          run: (c) => {
            const res = spawnSync(c[0]!, c.slice(1), { cwd: CREW_HOME, encoding: 'utf8', env: withUserBusEnv() });
            return res.error ? null : { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
          },
        });
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
        process.exitCode = r.exitCode;
        return true;
      };
      if (control.mechanism === 'launchd' && daemonSub === 'start') { launchdStart({}); break; }
      if (control.mechanism === 'launchd' && daemonSub === 'restart') {
        if (dryRun) process.stdout.write(`would run: ${control.stopCommand!.join(' ')}\n`);
        else {
          // The unit may not be loaded yet; unloading it then is harmless.
          const res = spawnSync(control.stopCommand![0]!, control.stopCommand!.slice(1), { cwd: CREW_HOME, encoding: 'utf8', env: withUserBusEnv() });
          if (res.stdout) process.stdout.write(res.stdout);
          if (res.stderr) process.stderr.write(res.stderr);
        }
        launchdStart({ verifyAfterLoad: true, assumeUnloaded: true });
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
          const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: CREW_HOME, encoding: 'utf8', env: withUserBusEnv() });
          if (res.stdout) process.stdout.write(res.stdout);
          if (res.stderr) process.stderr.write(res.stderr);
          // The stop half (launchd `unload`) fails harmlessly if the unit
          // isn't loaded yet — same tolerance `applyInstall`'s
          // preLoadCommands give it. Only the start half failing actually
          // means the daemon isn't running afterward.
          if (cmd === control.startCommand && (res.error || res.status !== 0)) {
            emit.error(withFix(`crew daemon restart: ${cmd.join(' ')} exited ${res.status ?? 'error'}`, '`crew doctor`'));
            failed = true;
          }
        }
        process.exitCode = failed ? 1 : 0;
        break;
      }
      const cmd = daemonSub === 'start' ? control.startCommand! : daemonSub === 'stop' ? control.stopCommand! : control.statusCommand!;
      if (dryRun) { process.stdout.write(`would run: ${cmd.join(' ')}\n`); break; }
      const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: CREW_HOME, encoding: 'utf8', env: withUserBusEnv() });
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      // `status` reports through its own exit code (e.g. launchctl list /
      // systemctl is-active both exit non-zero for "not running") — that is
      // the answer, not a failure of this command.
      if (daemonSub !== 'status' && (res.error || res.status !== 0)) {
        emit.error(withFix(`crew daemon ${daemonSub}: ${cmd.join(' ')} exited ${res.status ?? 'error'}`, '`crew doctor`'));
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
      die('crew', 'daemon does not support --dry-run — it only ever performs real cycles', 'run `crew daemon` without --dry-run, or `crew poll --dry-run` to preview a cycle');
    }
    // CREW-3238: the interlock applies to what the daemon will serve. A fleet-wide daemon's `route` is just
    // `cfg.routes[0]`, so testing it refused a ship whose first route is disabled; the `no enabled routes`
    // failure below covers the fleet. A named route (or a one-route ship) still refuses, and through
    // `failDaemonStart` so a supervised relaunch surfaces as an attention item instead of a silent exit 0.
    if (!fleetWide && !route.enabled) {
      const reason = `route "${route.route}" is not enabled in ${cfg.configFile} — refusing to run the daemon loop`;
      emit.error(withFix(`crew: ${reason}`, `set \`enabled: true\` on route "${route.route}" in crew.yaml`));
      await failDaemonStart({
        stateDir: cfg.ship.stateDir, reason,
        fix: `Set \`enabled: true\` on route "${route.route}" in crew.yaml, or name an enabled route in the unit`, code: 1,
        routes: cfg.routes, ship: cfg.ship, logFile: cfg.ship.logFile,
      });
    }
    // CREW-3063: the routes this daemon serves. Named, or a one-route ship: that route. Otherwise every enabled one.
    const daemonRoutes = fleetWide ? cfg.routes.filter((r) => r.enabled) : [route];
    if (!daemonRoutes.length) {
      emit.error('no enabled routes — nothing for the daemon to serve');
      await failDaemonStart({
        stateDir: cfg.ship.stateDir, reason: 'no enabled routes — nothing for the daemon to serve',
        fix: 'Set `enabled: true` on a route in crew.yaml, or run `crew connect`', code: 1,
        routes: cfg.routes, ship: cfg.ship, logFile: cfg.ship.logFile,
      });
    }
    // The control API's status/doctor answer for one route; a fleet answers for the first it serves.
    const primary = daemonRoutes[0]!;
    // CREW-2993: on a fresh sandbox ship the mirrors the contracts are read from do not exist yet and
    // only the cache pass creates them, so run it before judging servability, and do not exit over
    // a repository that is merely unmirrored (the loop's own pass repairs it on a later tick).
    const sandboxCachePasses = new Map<string, () => Promise<unknown>>();
    const servable: typeof daemonRoutes = [];
    const unservable: string[] = [];
    for (const r of daemonRoutes) {
      const pass = cfg.ship.runner === 'sandbox' ? buildSandboxCachePass(r, cfg.ship, state, emit.forRoute(r.route)) : undefined;
      if (pass) sandboxCachePasses.set(r.route, pass);
      if (pass && (await unmirroredTargets(r)).size > 0) {
        emit.emit('sandbox cache: some served repositories have no mirror yet; refreshing before reading their contracts');
        try { await pass(); } catch (e) { emit.warn(`sandbox cache refresh failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (await anyRepoServable(r, true)) servable.push(r);
      else {
        const why = await explainUnservable(r);
        unservable.push(`route ${r.route}: this ship is ${cfg.ship.platform}, but ${why}`);
        emit.forRoute(r.route).error(`refusing route ${r.route} — this ship is ${cfg.ship.platform}, but ${why}`);
      }
    }
    // A route this machine cannot serve is left out while another can be; with none the daemon cannot run.
    if (!servable.length) {
      await failDaemonStart({
        stateDir: cfg.ship.stateDir, reason: `no route can be served on this machine (${unservable.join('; ')})`,
        fix: 'Run `crew doctor` to see what each route needs', code: 1,
        routes: daemonRoutes, ship: cfg.ship, logFile: cfg.ship.logFile,
      });
    }
    // A route that is servable here but has no resolved ids or no readable key
    // fails every pass with a ConfigError, which the loop logs and carries on
    // from: the daemon would run, doing nothing, and say so only in the scheduler
    // log. When no route can run a pass at all, that is a startup failure.
    const unready: string[] = [];
    const ready = servable.filter((r) => {
      if (!r.resolved) { unready.push(`route ${r.route} has no resolved ids`); return false; }
      try { resolveApiKey(r); } catch (e) { unready.push(`route ${r.route}: ${e instanceof Error ? e.message : String(e)}`); return false; }
      return true;
    });
    if (!ready.length) {
      await failDaemonStart({
        stateDir: cfg.ship.stateDir, reason: `no route can run a pass (${unready.join('; ')})`,
        fix: 'Run `crew connect` for a route without ids, or restore its API key file or `apiKeyVar`', code: 1,
        routes: daemonRoutes, ship: cfg.ship, logFile: cfg.ship.logFile,
      });
    }

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
    // CREW-1532: crew.yaml and every route's apiKeyFile are read once at
    // startup, so an edit to either is as much an update as a new `dist/`.
    const configPaths = daemonConfigPaths(cfg);
    watchPaths.push(...configPaths);
    // Clears the reload request that may have triggered this launch, and
    // stamps the start time for `crew doctor`.
    noteDaemonStarted(cfg.ship.stateDir);

    // One breaker for the whole daemon process, so a role's failed starts are
    // remembered across passes (ISSUE-1365).
    const spawnBreaker = new SpawnBreaker();
    // CREW-2788: the ship control API on a unix socket. It reuses the CLI's own
    // JSON for status and doctor, and the pause sentinels `crew pause` writes.
    const controlRoutes = cfg.routes.filter((r) => r.resolved?.workspaceId);
    const controlAuth = new ControlAuth({
      baseUrl: route.baseUrl || DEFAULT_BASE_URL,
      workspaceIds: [...new Set(controlRoutes.map((r) => r.resolved!.workspaceId))],
      shipKeys: () => cfg.routes.flatMap((r) => { try { return [resolveApiKey(r)]; } catch { return []; } }),
      workspaceSecrets: (ws) => { const sec = readPersistedTunnel(cfg.ship.stateDir, ws)?.mcpSecret; return sec ? [sec] : []; },
      userAgent: cfg.ship.userAgent,
    });
    const controlServer = await startControlServer({
      stateDir: cfg.ship.stateDir,
      state,
      auth: controlAuth,
      // CREW-2859: Passenger periscopes, only on a route that sets hostPeriscopes.
      periscopes: {
        routes: controlRoutes.filter((r) => r.enabled).map((r) => ({ route: r.route, workspaceId: r.resolved!.workspaceId, hostPeriscopes: r.hostPeriscopes === true })),
        previewHost: cfg.ship.previewHost,
        relayPreviews: cfg.ship.relayPreviews,
        maxPeriscopes: cfg.ship.maxPeriscopes,
        run: runCrew,
        verifyIn: (token, ws) => controlAuth.verifyIn(token, ws),
        previewRepos: (routeName) => {
          const r = controlRoutes.find((x) => x.route === routeName);
          if (!r) return [];
          return reposOf(r).filter((t) => { try { return !!loadRepoConfig(t.dir)?.hooks.preview; } catch { return false; } }).map((t) => t.name);
        },
        mcp: {
          onUp: async (r, done) => {
            const id = typeof done.ticketRecordId === 'string' ? done.ticketRecordId : '';
            const ticket = typeof done.ticket === 'string' ? done.ticket : '';
            const relayUrl = routeRelayUrl(cfg.routes.find((x) => x.route === r.route)!);
            if (!relayUrl) return { mcpEndpointId: null, mcpWarning: 'this ship has no relay URL yet, so the periscope\'s MCP endpoint is not registered; it is retried each cycle' };
            const out = await registerPeriscopeEndpoint(periscopeEndpointDeps(), { ticket, ticketRecordId: id, route: r.route, workspaceId: r.workspaceId, relayUrl });
            return out.ok ? { mcpEndpointId: out.endpointId, mcpUrl: out.url } : { mcpEndpointId: null, mcpWarning: out.message };
          },
          onDown: async () => { await removeEndedPeriscopeEndpoints(periscopeEndpointDeps()); },
        },
      },
      periscopeMcp: controlRoutes.some((r) => r.enabled && r.hostPeriscopes)
        ? (req, res, ticket) => handlePeriscopeMcp(periscopeMcpDeps(), req, res, ticket)
        : undefined,
      route: primary.route,
      status: () => crewJson(['status', primary.route, '--json']),
      doctor: () => crewJson(['doctor', primary.route, '--json', '--offline']),
      diagnostics: () => collectDiagnostics({
        stateDir: cfg.ship.stateDir,
        workspaceIds: [...new Set(controlRoutes.map((r) => r.resolved!.workspaceId))],
        runner: cfg.ship.runner ?? 'host',
        unitStems: detectSystemd() ? (['run', 'release', 'passengers'] as const).map((j) => labelFor(CREW_HOME, j)) : [],
        userScope: process.getuid?.() !== 0,
        doctor: async () => { const o = await crewJson(['doctor', primary.route, '--json', '--offline']); return o.ok ? o.doc : null; },
      }),
      scheduler: schedulerHandler(planDaemonControl(CREW_HOME, hostPlatform(), detectSystemd())),
      log: (m) => emit.warn(m),
    });
    if (controlServer) emit.emit(`control API listening on ${controlServer.path}`);
    const inFlight = new Set<Promise<void>>();
    const sandboxHygienePass = cfg.ship.runner === 'sandbox' ? makeSandboxHygiene({ state, emit, ship: cfg.ship }) : undefined;
    // CREW-2794: sandbox images build in the background between passes, one at
    // a time, never on the cycle path. A build still running skips the tick.
    let sandboxBuilding = false;
    const stopReason = await runDaemonLoop({
      inFlight,
      onStaleDeferred: ({ runs, waitedMs }) => emit.warn(
        `reload or update pending for ${Math.round(waitedMs / 1000)}s — waiting for ${runs} agent run(s) to end before relaunching (\`crew reload --now\` forces it)`,
      ),
      // CREW-3170: while a run this daemon started takes input, keep passes quick and hand it the ticket's new comments.
      backoffCapMs: () => (anyRunAcceptsInput(liveRuns(cfg.ship.stateDir)) ? COMMENT_DELIVERY_BACKOFF_MS : undefined),
      runPass: async () => {
        const result = await runFleetPass({
        inFlight,
        sandboxCache: (r) => sandboxCachePasses.get(r.route)?.() ?? Promise.resolve(),
        sandboxHygiene: sandboxHygienePass,
        routes: servable, ship: cfg.ship, state,
        maxConcurrentAgents: cfg.ship.maxConcurrentAgents,
        roleConcurrency: cfg.ship.roleConcurrency,
        spawnBreaker,
        configFile: cfg.configFile,
        newEmitter: (r) => new Emitter({
          route: r.route,
          eventFile: eventFileFor(cfg.ship.stateDir),
          rotateBytes: cfg.ship.eventsRotateBytes,
          logFile: cfg.ship.logFile,
          console: (l) => process.stderr.write(`${l}\n`),
        }),
      });
        await runCommentDeliveryPass({
          runs: () => liveRuns(cfg.ship.stateDir),
          warn: (m) => emit.warn(m),
          fetch: async (slug) => {
            const rt = servable.find((r) => routeSlug(r.route) === slug);
            if (!rt) return null;
            const tr = new Tracker(rt, cfg.ship);
            const [comments, crewRows] = await Promise.all([tr.comments(200), tr.crewRows()]);
            return {
              comments,
              roster: buildRoster(configuredMembers(rt), crewRows),
              seatId: (role) => rt.resolved?.seats[role],
            };
          },
        });
        return result;
      },
      onTransient: ({ err, consecutive, backoffMs }) => emit.warn(
        `tracker unavailable (${describeCause(err)}); attempt ${consecutive}, retrying in ${Math.round(backoffMs / 1000)}s`,
      ),
      onOutage: ({ err, downMs }) => {
        const msg = `tracker unreachable for ${Math.max(1, Math.round(downMs / 60_000))} minutes: ${describeCause(err)}`;
        emit.error(msg);
        void raiseShipAttention({ state, emit, route, ship: cfg.ship }, {
          kind: 'tracker_unreachable', key: TRACKER_OUTAGE_KEY, message: msg, since: new Date().toISOString(),
        });
      },
      onRecovered: ({ downMs }) => {
        clearShipAttention(state, TRACKER_OUTAGE_KEY);
        emit.emit(`tracker is back after ${Math.max(1, Math.round(downMs / 1000))}s`);
      },
      onPassError: (err) => emit.error(
        `daemon pass failed, continuing: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      ),
      checkStale: makeStaleChecker(watchPaths, { reloadSentinel: reloadSentinelFor(cfg.ship.stateDir) }),
      onPass: (result) => {
        // CREW-3064: a completed pass means the start failure is over.
        clearStartFailure(state, cfg.ship.stateDir);
        // CREW-3034: a full docker host builds nothing.
        if (!sandboxBuilding && !diskFullStop(state)) {
          sandboxBuilding = true;
          void sandboxReposOf(cfg.routes.filter((r) => r.enabled))
            .then(withShipSandbox)
            .then((repos) => (repos.length ? sandboxBuildTick(repos, sandboxTickDeps(emit, primary)) : null))
            .catch((err) => emit.warn(`sandbox image build tick failed: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => { sandboxBuilding = false; });
        }
        if (result.started.length) emit.emit(`daemon pass started: ${result.started.join(', ')}`);
        for (const s of result.skipped) emit.emit(`daemon pass skipped ${s.role} — ${s.reason}`);
      },
    });
    await controlServer?.close();
    if (stopReason === 'stale') {
      emit.emit(
        'crew daemon: installed tree, crew.yaml or a reload request changed on disk — exiting cleanly so the OS-level restart relaunches with the update',
      );
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
        if (e instanceof ConfigError) die('crew', e.message, '`crew doctor`');
        throw e;
      }
      if (!promptTarget.resolved) {
        die('crew agents prompt', `route "${promptTarget.route}" has no resolved ids`, '`crew connect`');
      }
      try {
        const prompt = await currentPersonaPrompt(promptTarget, role, { userAgent: cfg.ship.userAgent });
        process.stdout.write(prompt + (role === 'pair' ? harnessPromptNote(value('harness')) : ''));
      } catch (e) {
        if (e instanceof AgentsSyncError) { die('crew agents prompt', e.message, '`crew doctor`', 2); }
        throw e;
      }
      break;
    }
    if (sub !== 'sync') {
      process.stderr.write('crew agents sync [route] [--force]    push crew\'s personas (Developer/Design/QA/Triage/Pair) AND skill files (e.g. grill-me) into the workspace Agents/Agent Skills tables (--force overwrites even a diverged persona or skill; never one marked Customize prompt; --revoke-seat-keys deletes this ship\'s seat keys server-side and from the keychain, so the next sync mints fresh ones)\n');
      process.stderr.write(`crew agents prompt <role> [route]     print a persona's current prompt (roles: ${ROLE_NAMES.join(', ')})\n`);
      process.exit(2);
    }
    let target: Route;
    try {
      target = findSyncRoute(cfg, positional[2]);
    } catch (e) {
      if (e instanceof ConfigError) die('crew agents sync', e.message, '`crew doctor`');
      throw e;
    }
    if (!target.resolved) die('crew agents sync', `route "${target.route}" has no resolved ids`, '`crew connect`');
    let run: Awaited<ReturnType<typeof runAgentsSync>>;
    try {
      run = await runAgentsSync(target, {
        userAgent: cfg.ship.userAgent, stateDir: cfg.ship.stateDir, dryRun, force, verbose: flag('verbose'),
        say: (l) => process.stdout.write(`${l}\n`),
        warn: (l) => emit.warn(`crew agents sync: ${l}`),
      });
    } catch (e) {
      if (e instanceof AgentsSyncError || e instanceof SkillSyncError) die('crew agents sync', e.message, '`crew doctor`, then `crew agents sync --verbose`');
      throw e;
    }
    const { personaResult, skillResult } = run;
    if (flag('revoke-seat-keys')) {
      // CREW-1802: rotate this ship's keys; a following sync mints fresh ones.
      for (const o of await revokeSeatKeys(target, { userAgent: cfg.ship.userAgent, dryRun, shipName: cfg.ship.name })) {
        process.stdout.write(`${describeRevokeOutcome(o)}\n`);
      }
    } else {
      // CREW-1603: each seat persona now linked to an Agents row gets its own
      // agent API key, minted once with the ship key and kept in the keychain.
      // CREW-1802: minting is gated by the server (an admin, or the "Mint agent
      // keys" capability), so a member key attempts it and reads a 403.
      for (const o of await mintMissingSeatKeys(target, { userAgent: cfg.ship.userAgent, dryRun, shipName: cfg.ship.name })) {
        process.stdout.write(`${describeMintOutcome(o)}\n`);
      }
      if (!dryRun) {
        for (const p of await probeSeatReads(target, { userAgent: cfg.ship.userAgent })) {
          if (p.state === 'forbidden') { process.stdout.write(`${describeSeatForbidden(p.role, p.tables)}\n`); process.exitCode = 1; }
        }
      }
    }
    // A diverged persona or skill is not this run's failure, but it IS
    // something an operator needs to act on (review the row, or re-sync
    // once they have) — a nonzero exit is what makes that visible to
    // whatever invoked this (a scheduler job's log, a person's own shell)
    // without erroring the whole command.
    if (run.diverged) process.exitCode = 1;
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
      target = findSyncRoute(cfg, positional[2]);
    } catch (e) {
      if (e instanceof ConfigError) die('crew skills sync', e.message, '`crew doctor`');
      throw e;
    }
    if (!target.resolved) die('crew skills sync', `route "${target.route}" has no resolved ids`, '`crew connect`');
    let result: Awaited<ReturnType<typeof syncSkills>>;
    try {
      result = await syncSkills(target, { userAgent: cfg.ship.userAgent, dryRun });
    } catch (e) {
      if (e instanceof SkillSyncError) die('crew skills sync', e.message, '`crew doctor`, then `crew skills sync --verbose`');
      throw e;
    }
    process.stdout.write(`route: ${target.route}\n`);
    for (const l of summarizeOutcomes(result.outcomes, describeSkillSyncOutcome, (o) => o.action === 'unchanged', 'skill', flag('verbose'))) process.stdout.write(`${l}\n`);
    for (const w of result.warnings) emit.warn(w);
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

  case 'ship': {
    // `crew ship rename NAME` (CREW-2495): one name for this machine in
    // crew.yaml and on every workspace's Ships row. The local rename always
    // happens; a row that refuses the write (a member key may not edit the
    // table) is reported, not fatal, and is reconciled by the next poll.
    if (positional[1] !== 'rename' || positional.length !== 3) {
      process.stderr.write('crew ship rename NAME [--json]\n');
      process.exit(2);
    }
    let newName: string;
    try { newName = validateShipName(positional[2]!); } catch (e) {
      if (e instanceof ShipNameError) { die('crew ship', e.message, '`crew doctor`', 2); }
      throw e;
    }
    const oldName = cfg.ship.name;
    writeFileSync(cfg.configFile, setShipNameInYaml(readFileSync(cfg.configFile, 'utf8'), newName));
    cfg.ship.name = newName;
    let renameMachineId: string | undefined;
    try { renameMachineId = ensureMachineId(cfg.ship.stateDir); } catch { /* name matching only */ }
    const outcomes: Array<{ route: string; status: string; rowId?: string; error?: string }> = [];
    for (const r of cfg.routes) {
      if (!r.resolved?.shipsModelId) { outcomes.push({ route: r.route, status: 'no-ships-table' }); continue; }
      const resolvedFile = resolvedPathFor(cfg.ship.stateDir, r.route);
      const tracker = new Tracker(r, cfg.ship);
      const picked = pickShipRow(await tracker.shipRows(), renameMachineId, [oldName, readSyncedName(resolvedFile) ?? '']);
      if (picked.kind !== 'row') {
        outcomes.push({ route: r.route, status: picked.kind === 'unsupported' ? 'unsupported' : picked.kind === 'none' ? 'no-row' : 'ambiguous' });
        continue;
      }
      try {
        await tracker.renameShipRow(picked.row.id, newName);
        writeSyncedName(resolvedFile, newName);
        outcomes.push({ route: r.route, status: 'renamed', rowId: picked.row.id });
      } catch (e) {
        outcomes.push({ route: r.route, status: 'refused', rowId: picked.row.id, error: (e as Error).message });
      }
    }
    if (flag('json')) {
      process.stdout.write(`${JSON.stringify({ name: newName, previous: oldName, configFile: cfg.configFile, routes: outcomes })}\n`);
    } else {
      process.stdout.write(`ship renamed "${oldName}" -> "${newName}" in ${cfg.configFile}\n`);
      for (const o of outcomes) process.stdout.write(`  ${o.route}: ${o.status}${o.error ? ` (${o.error})` : ''}\n`);
    }
    if (outcomes.some((o) => o.status === 'refused')) process.exitCode = 1;
    break;
  }

  case 'repos': {
    // `crew repos add <route> <path>` / `crew repos list <route>` (CREW-1287).
    // Works on crew.yaml's raw text rather than `cfg.routes`: a route that
    // names no `dir`/`repos` yet fails config validation and is dropped from
    // `cfg.routes`, and that is exactly the route `add` is for.
    const sub = positional[1];
    const usage = () => {
      process.stderr.write('crew repos add [workspace/project] [name] [path] [--name N] [--project P] [--dry-run] [--no-create]\ncrew repos clone [workspace/project] <name> [--dir PATH] [--dry-run] [--json]\ncrew repos list <workspace/project> [--json]\ncrew repos check [PATH | --route ROUTE [PATH] | ROUTE NAME] [--strict] [--json]\ncrew repos hooks [workspace/project] <name> [--suggest] [--agent] [--write route|repo [--replace]] [--clear route] [--recipes ID,ID] [--hook KEY=CMD ...] [--json]\n');
      process.exit(2);
    };
    if (sub !== 'add' && sub !== 'list' && sub !== 'clone' && sub !== 'hooks' && sub !== 'check') usage();
    const configText = readFileSync(cfg.configFile, 'utf8');
    if (sub === 'check') {
      // The route forms (the bare form exited above): `--route ROUTE [PATH]`, or `ROUTE NAME`.
      try {
        const routeArg = value('route') ?? positional[2];
        const found = cfg.routes.find((r) => r.route === routeArg);
        if (!found) throw new ReposError(`no route "${routeArg}" in the config (have: ${cfg.routes.map((r) => r.route).join(', ') || 'none'})`);
        const named = value('route') ? undefined : positional[3];
        const dir = named ? repoDirOf(configText, dirname(cfg.configFile), found.route, named) : resolvePath(positional[value('route') ? 2 : 3] ?? '.');
        const target = reposOf(found).find((t) => resolvePath(t.dir) === dir || t.name === named);
        const o = target ? found.repoOverrides[target.name] : undefined;
        runReposCheck(dir, {
          hooks: { ...found.hooks, ...o?.hooks }, labels: { ...found.labels, ...o?.labels },
          release: mergeRouteRelease(found.release, o?.release),
          branch: { ...found.branch, ...o?.branch },
          worktrees: { prefix: shipWorktreePrefixFor(found), nameOverride: o?.worktreeName },
          mapTokenBudget: cfg.ship.mapTokenBudget,
        });
      } catch (e) {
        if (e instanceof ReposError) { die('crew repos', e.message, '`crew doctor`', 2); }
        throw e;
      }
      break;
    }
    if (sub === 'hooks') {
      // `crew repos hooks` (CREW-2238): propose hooks for a checkout and
      // optionally write them route-level or as a starter `.crew.yaml`.
      try {
        const a = parseHooksArgs(positional.slice(2), routeNamesOf(configText));
        const dir = repoDirOf(configText, dirname(cfg.configFile), a.route, a.name);
        if (!existsSync(dir)) throw new ReposError(`${dir} does not exist on disk`);
        const files = { exists: (r: string) => existsSync(resolvePath(dir, r)), list: (r: string) => { try { return readdirSync(resolvePath(dir, r)); } catch { return []; } }, read: (r: string) => { try { return readFileSync(resolvePath(dir, r), 'utf8'); } catch { return undefined; } } };
        const suggestion = suggestHooks(files);
        const write = value('write');
        if (write !== undefined && write !== 'route' && write !== 'repo') throw new ReposError(`--write takes "route" or "repo" (got "${write}")`);
        const clear = value('clear');
        if (clear !== undefined && clear !== 'route') throw new ReposError(`--clear takes "route" (got "${clear}")`);
        if (clear && (write || flag('suggest') || flag('agent'))) throw new ReposError('--clear cannot be combined with --write, --suggest or --agent');
        if (flag('replace') && write !== 'route') throw new ReposError('--replace only applies with --write route');
        const recipeIds = (value('recipes') ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none');
        if (recipeIds.length > 0 && !write) throw new ReposError('--recipes only applies with --write route|repo');
        if (flag('agent') && write) throw new ReposError('--agent is read-only; drop --write (write the sniffed hooks, then re-run --agent to compare)');
        let agent: AgentSuggestion | null = null;
        let agentError: { reason: string; message: string } | null = null;
        if (flag('agent')) {
          // Ctrl-C cancels the session; the sniff result above is unaffected either way.
          const ac = new AbortController();
          const onSigint = () => ac.abort();
          process.once('SIGINT', onSigint);
          sigintOwnedByCommand = true;
          try {
            const routeCfg = cfg.routes.find((r) => r.route === a.route);
            agent = await runAgentSuggest({ spec: resolveToolchain(cfg.ship, routeCfg, a.name), dir, sniff: suggestion, signal: ac.signal });
          } catch (e) {
            if (!(e instanceof AgentSuggestError)) throw e;
            agentError = { reason: e.reason, message: e.message };
          } finally { process.off('SIGINT', onSigint); sigintOwnedByCommand = false; }
        }
        const hookSpecs = argv.flatMap((x, i) => (x === '--hook' && argv[i + 1] !== undefined ? [argv[i + 1] as string] : x.startsWith('--hook=') ? [x.slice(7)] : []));
        const overrides = parseHookOverrides(hookSpecs);
        if (hookSpecs.length > 0 && !write) throw new ReposError('--hook only applies with --write route|repo');
        const base = selectRecipes(suggestion, recipeIds);
        const picked = { ...base, hooks: { ...base.hooks, ...overrides } };
        let written: { target: 'route' | 'repo'; file: string; hooks: string[]; kept: string[]; replaced: string[] } | undefined;
        let cleared: { file: string; removed: string[] } | undefined;
        if (clear) {
          const plan = clearRouteHooks(configText, a.route, a.name);
          if (plan.removed.length > 0) writeFileSync(cfg.configFile, plan.text);
          cleared = { file: cfg.configFile, removed: plan.removed };
        }
        if (write && suggestion.source === null && recipeIds.length === 0 && hookSpecs.length === 0) throw new ReposError(`nothing to write: ${suggestion.notes[0]}`);
        if (write === 'route') {
          const plan = planRouteHooks(configText, a.route, a.name, picked.hooks, { replace: flag('replace') });
          writeFileSync(cfg.configFile, plan.text);
          written = { target: 'route', file: cfg.configFile, hooks: plan.written, kept: plan.kept, replaced: plan.replaced };
        } else if (write === 'repo') {
          const have = existingRepoConfig(files);
          if (have) throw new ReposError(`${resolvePath(dir, have)} already exists; not overwriting it`);
          const file = resolvePath(dir, '.crew.yaml');
          writeFileSync(file, starterRepoConfig(picked.hooks, picked.release), { flag: 'wx' });
          written = { target: 'repo', file, hooks: Object.keys(picked.hooks), kept: [], replaced: [] };
        }
        if (flag('json')) {
          process.stdout.write(`${JSON.stringify({ route: a.route, repo: a.name, dir, ...suggestion, agent, agentError, written: written ?? null, cleared: cleared ?? null })}\n`);
        } else {
          if (suggestion.source) process.stdout.write(`${a.name}: proposed from ${suggestion.source}\n`);
          for (const [k, v] of Object.entries(suggestion.hooks)) process.stdout.write(`  ${k}: ${v}\n`);
          for (const n of suggestion.notes) process.stdout.write(`note: ${n}\n`);
          for (const r of suggestion.recipes) process.stdout.write(`recipe ${r.id}${r.defaultOn ? ' (default on)' : ''}${r.writable ? '' : ' (advisory)'}: ${r.title} [${r.evidence.join(', ')}]\n`);
          if (agent) {
            process.stdout.write(`agent (${agent.toolchain}, ${agent.model}) read ${agent.filesRead.join(', ') || 'no files'}\n`);
            for (const [k, v] of Object.entries(agent.hooks)) process.stdout.write(`  ${k}: ${v}${agent.differsFromSniff.includes(k) ? '   (differs from file sniff)' : ''}\n`);
            for (const n of agent.notes) process.stdout.write(`note: ${n}\n`);
          }
          if (agentError) emit.warn(withFix(`crew repos: --agent failed (${agentError.reason}): ${agentError.message}`, '`crew repos hooks --suggest` for the deterministic suggestion'));
          if (cleared) process.stdout.write(cleared.removed.length ? `removed route hooks ${cleared.removed.join(', ')} from ${cleared.file}\n` : 'no route hooks to remove\n');
          if (written) {
            process.stdout.write(`wrote ${written.hooks.join(', ') || 'nothing new'} to ${written.file}\n`);
            if (written.replaced.length) process.stdout.write(`replaced route hooks: ${written.replaced.join(', ')}\n`);
            if (written.kept.length) process.stdout.write(`kept existing route hooks: ${written.kept.join(', ')}\n`);
            if (written.target === 'repo') process.stdout.write('review it and commit it to the repository\n');
            if (written.target === 'route' && picked.release) process.stdout.write(`note: release.mode ${picked.release.mode} is repo-level; use --write repo to set it\n`);
          }
        }
        if (agentError) process.exitCode = 1;
      } catch (e) {
        if (e instanceof ReposError) { die('crew repos', e.message, '`crew doctor`', 2); }
        throw e;
      }
      break;
    }
    let routeName = positional[2];
    let addPath = '.';
    let addName: string | undefined;
    if (sub === 'list' && !routeName) usage();
    if (sub === 'add') {
      try {
        const a = parseAddArgs(positional.slice(2), routeNamesOf(configText), (p) => existsSync(resolvePath(p.replace(/^~(?=\/|$)/, homedir()))));
        routeName = a.route; addPath = a.path; addName = a.name;
      } catch (e) {
        if (e instanceof ReposError) { die('crew repos', e.message, '`crew doctor`', 2); }
        throw e;
      }
    }
    if (sub === 'clone') {
      try {
        const a = parseCloneArgs(positional.slice(2), routeNamesOf(configText));
        routeName = a.route; addName = a.name;
      } catch (e) {
        if (e instanceof ReposError) { die('crew repos', e.message, '`crew doctor`', 2); }
        throw e;
      }
    }
    const resolvedFile = resolvedPathFor(cfg.ship.stateDir, routeName!);
    // The resolved map is a `crew connect` snapshot; a Repos row made by hand since
    // is invisible to the match below (and `add` would duplicate it) — CREW-2885.
    if (sub === 'list' || sub === 'add') {
      const liveRoute = cfg.routes.find((r) => r.route === routeName);
      if (liveRoute?.resolved?.reposModelId && existsSync(resolvedFile) && !dryRun) {
        try {
          await hydrateApiKeys([liveRoute]);
          persistRepoRows(cfg.ship.stateDir, liveRoute.route, await new Tracker(liveRoute, cfg.ship).repoRowsForMap());
        } catch { /* offline or unauthorized: fall back to the snapshot */ }
      }
    }
    let resolvedRemotes: RepoRemotes | undefined;
    if (existsSync(resolvedFile)) {
      try { resolvedRemotes = JSON.parse(readFileSync(resolvedFile, 'utf8')) as RepoRemotes; } catch { /* unreadable: treated as not connected */ }
    }
    const originOf = (dir: string) => gitOk(dir, ['remote', 'get-url', 'origin']) ?? undefined;
    const text = configText;
    const base = dirname(cfg.configFile);
    const isCheckout = (d: string) => existsSync(`${d}/.git`);
    try {
      if (sub === 'list') {
        if (flag('json')) {
          const rows = listRepoRows({
            text, route: routeName!, base, resolved: resolvedRemotes, originOf,
            exists: (d) => existsSync(d), isCheckout,
            repoHasHooks: (d) => REPO_CONFIG_FILENAMES.some((f) => {
              try { const path = resolvePath(d, f); return Object.keys(parseRepoConfig(readFileSync(path, 'utf8'), path).hooks).length > 0; } catch { return false; }
            }),
          });
          process.stdout.write(`${JSON.stringify({ route: routeName, repos: rows, cloneBase: cloneBaseOf(text, routeName!, base, isCheckout) })}\n`);
          break;
        }
        const cloneBase = cloneBaseOf(text, routeName!, base, isCheckout);
        const repos = configuredRepos(text, routeName!, base).filter((r) => r.dir !== cloneBase);
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
      if (sub === 'clone') {
        const json = flag('json');
        const say = (event: string, extra: Record<string, unknown>, human: string) =>
          process.stdout.write(json ? `${JSON.stringify({ event, ...extra })}\n` : `${human}\n`);
        const plan = planRepoClone({ text, base, route: routeName!, name: addName!, resolved: resolvedRemotes, dir: value('dir'), isCheckout });
        if (existsSync(plan.target) && (existsSync(`${plan.target}/.git`) || readdirSync(plan.target).length > 0)) {
          throw new ReposError(
            existsSync(`${plan.target}/.git`)
              ? `${plan.target} is already a checkout — attach it with \`crew repos add ${routeName} ${plan.name} ${plan.target}\``
              : `${plan.target} exists and is not empty — pass --dir to clone somewhere else`,
          );
        }
        if (dryRun) {
          say('dry-run', { remote: plan.remote, target: plan.target }, `would clone ${plan.remote} into ${plan.target}`);
          if (!json) process.stdout.write(`${plan.block}\n`);
          break;
        }
        say('cloning', { remote: plan.remote, target: plan.target }, `cloning ${plan.remote} into ${plan.target}`);
        try {
          ensureRepoCheckout(plan.target, plan.remote, { scheme: cfg.ship.cloneScheme ?? 'https', host: plan.forgeHost });
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          const authHint = /authentication failed|could not read (username|password)|permission denied|terminal prompts disabled|repository not found/i.test(e.message)
            ? '\n  hint: git could not authenticate — run `gh auth login` (or add an SSH key and set ship.cloneScheme: ssh), then re-run'
            : '';
          throw new ReposError(`${e.message}${authHint}\n  crew.yaml was not changed`);
        }
        writeFileSync(cfg.configFile, plan.text);
        if (plan.droppedDir) emit.warn(`crew repos: dropped dir: ${plan.droppedDir} from route ${routeName} — it is not a checkout (the clone base); checkouts now live under repos:`);
        say('attached', { route: routeName, name: plan.name, dir: plan.target, mode: plan.mode }, `cloned and attached ${plan.target} to ${routeName} as ${plan.mode === 'dir' ? 'dir' : `repos.${plan.name}`} in ${cfg.configFile}`);
        break;
      }
      const target = resolvePath(addPath.replace(/^~(?=\/|$)/, homedir()));
      const top = existsSync(target) ? gitOk(target, ['rev-parse', '--show-toplevel']) : null;
      if (!top) throw new ReposError(`${target} is not a git checkout`);
      const origin = originOf(top);
      const plan = planRepoAdd({
        text, base, route: routeName!, path: top, origin, resolved: resolvedRemotes, name: value('name') ?? addName,
        nameForExisting: (d) => matchRepoName(originOf(d), resolvedRemotes), isCheckout,
      });
      if (plan.droppedDir) emit.warn(`crew repos: dropped dir: ${plan.droppedDir} from route ${routeName} — it is not a checkout (the clone base); checkouts now live under repos:`);
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
        // `hydrateApiKeys` ran once at startup over `cfg.routes`; these routes
        // were freshly parsed from the planned text, so a keychain-only key
        // (ISSUE-966) has to be resolved for them too or `Tracker` finds none.
        await hydrateApiKeys([planRoute]);
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
        emit.warn(`crew repos: warning — ${plan.warning}`);
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
      if (e instanceof ReposError) { die('crew repos', e.message, '`crew doctor`', 2); }
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
        'crew logbook list [route] [--role R] [--ticket T] [--limit N] [--before-edit] [--bounces]\n' +
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
      if (e instanceof ConfigError) die('crew', e.message, '`crew doctor`');
      throw e;
    }
    try {
      if (sub === 'list') {
        const entries = await listLogEntries(target, {
          userAgent: cfg.ship.userAgent,
          role: value('role'),
          ticket: value('ticket'),
          limit: value('limit') ? Number(value('limit')) : undefined,
          beforeEdit: flag('before-edit'),
          bounces: flag('bounces'),
        });
        if (entries.length === 0) { process.stdout.write('(no Agent Log entries match)\n'); break; }
        for (const e of entries) {
          process.stdout.write(
            `${e.id}  ${e.started_at ?? '?'}  ${e.outcome ?? '?'}` +
              `${e.ticket_reference ? `  ${e.ticket_reference}` : ''}${e.model ? `  ${e.model}` : ''}${e.harness || e.provider ? `  (${[e.harness, e.provider].filter(Boolean).join(' · ')})` : ''}` +
              `${e.num_turns != null ? `  turns ${e.num_turns}` : ''}${e.prefix_tokens != null ? `  prefix ${e.prefix_tokens}` : ''}` +
              `${formatBeforeEdit(e) ? `  before edit: ${formatBeforeEdit(e)}` : ''}\n`,
          );
        }
      } else {
        const { entry, inference, reconstruction } = await showLogEntry(target, entryId!, {
          userAgent: cfg.ship.userAgent,
          withPrompt: flag('prompt'),
        });
        process.stdout.write(
          `id:         ${entry.id}\n` +
          `started:    ${entry.started_at ?? '?'}\n` +
          `finished:   ${entry.finished_at ?? '?'}\n` +
          `outcome:    ${entry.outcome ?? '?'}\n` +
          `ticket:     ${entry.ticket_reference ?? '(none)'}\n` +
          `model:      ${entry.model ?? '?'}\n` +
          `harness:    ${entry.harness ?? '?'}\n` +
          `provider:   ${entry.provider ?? '?'}\n` +
          (entry.num_turns != null ? `turns:      ${entry.num_turns}\n` : '') +
          (inference ? `calls:      ${inference.calls}\n` +
            `tokens:     in ${inference.tokensIn}, out ${inference.tokensOut}, cache read ${inference.cacheReadTokens}, cache write ${inference.cacheWriteTokens}\n` +
            `cost:       $${inference.costUsd.toFixed(4)}\n` : '') +
          (entry.prefix_tokens != null ? `prefix:     ${entry.prefix_tokens} tokens\n` : '') +
          (formatBeforeEdit(entry) ? `before edit: ${formatBeforeEdit(entry)}\n` : ''),
        );
        if (flag('prompt')) {
          process.stdout.write(`\nprompt reconstruction: ${reconstruction.status}` +
            `${reconstruction.reason ? ` — ${reconstruction.reason}` : ''}\n`);
          if (reconstruction.prompt) process.stdout.write(`\n${reconstruction.prompt}\n`);
          if (reconstruction.status !== 'exact') process.exitCode = 1;
        }
      }
    } catch (e) {
      if (e instanceof LogbookError) { die('crew logbook', e.message, '`crew doctor`', 2); }
      throw e;
    }
    break;
  }

  case 'connect': {
    // `crew connect foo` (just the workspace slug) is the normal form
    // (ISSUE-967): `discover()` defaults the project to whichever one is
    // installed from the `tablation.issues` Library template (or the retired
    // `crew.issues`), falling back to
    // slug `issues`, offering to install it when it's missing. `crew
    // connect foo/bar` (workspace/project) names a project explicitly —
    // only needed for a deliberately non-default tracker project, in which
    // case `discover()` falls back to offering every project in that
    // workspace with the tables a route needs, when there's more than one
    // candidate. Bare `crew connect` (no argument at all) offers every
    // workspace this key's identity can see. `--workspace-id` (a uuid OR a
    // slug — `discover()` accepts either) and `--project` remain for
    // scripting and for a project named rather than slugged.
    const arg = positional[1];
    if (flag('sign-out')) {
      // CREW-2440: drop the keychain session a dry-run connect stored. Needs no
      // crew.yaml, and finding nothing to remove is success, not an error.
      let signOutStore: SessionStore | undefined;
      try { signOutStore = getSessionStore(); } catch { signOutStore = undefined; }
      const outcomes = signOutStore
        ? await signOutSessions({
          store: signOutStore, stateDir: cfg.ship.stateDir, dryRun,
          host: value('host') ?? (value('base-url') ? hostFromUrl(value('base-url')!) : undefined),
          workspace: value('workspace'),
        })
        : [];
      const failed = outcomes.some((o) => o.action === 'failed');
      if (flag('json')) process.stdout.write(`${JSON.stringify({ dryRun, ok: !failed, sessions: outcomes })}\n`);
      else if (!outcomes.length) process.stdout.write('nothing to sign out of\n');
      else for (const o of outcomes) process.stdout.write(`${o.action}: ${o.host}/${o.workspace}${o.detail ? ` (${o.detail})` : ''}\n`);
      if (failed) process.exitCode = 1;
      break;
    }
    // CREW-2235: `--json` never prompts — a decision becomes a `choice` event
    // (exit CHOICE_EXIT_CODE) the caller answers with `--choose key=value`.
    const canAsk = !!(process.stdin.isTTY && process.stdout.isTTY) && !connectEvents.json;
    const stopForChoice = (key: string, message: string, options: ChoiceOption[]): never => {
      connectEvents.emit('choice', message, choiceData(key, options));
      return die('crew connect', message, `re-run with --choose ${key}=<${options.map((o) => o.value).join('|')}>`, CHOICE_EXIT_CODE);
    };
    const stopWithProblem = (message: string, stage: string): never => {
      connectEvents.emit('problem', message, { stage });
      return process.exit(2);
    };
    const [argWorkspace, argProject] = splitConnectArg(arg);
    let workspace = argWorkspace ?? value('workspace-id') ?? value('workspace') ?? connectChoices.workspace;
    const project = argProject ?? value('project') ?? connectChoices.project;
    const baseUrl = value('base-url') ?? cfg.routes[0]?.baseUrl ?? DEFAULT_BASE_URL;
    // No bare `cfg.ship.apiKey` to read here — it's only a fallback SOURCE the
    // route parser merges in, not a field of its own on `Ship`. Any
    // already-configured route's (already-merged) key is the next best
    // guess, and exactly what a ship-level key resolves to in practice.
    let apiKey = value('key') ?? process.env.CREW_CONNECT_KEY ?? cfg.routes.find((c) => c.apiKey)?.apiKey;
    // CREW-2447: where a key given up front came from, for the `signed_in` event.
    const givenKeySource: 'flag' | 'config' = value('key') ?? process.env.CREW_CONNECT_KEY ? 'flag' : 'config';
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
    // CREW-2668: the address the keychain session is stored under, so it can be
    // moved to the address the route carries once `discover` has resolved that.
    let sessionAddress: string | undefined;
    // Reuse an already-stored session for this exact host+workspace instead
    // of starting a second browser round-trip — only possible when the
    // workspace is already known (an explicit `crew connect ws[/proj]` or
    // `--workspace`); a bare `crew connect` doesn't know which workspace to
    // look up until AFTER a login (device or otherwise) says so.
    if (!apiKey && workspace && store) {
      try {
        // CREW-2668: a bare slug of a secondary workspace finds the session
        // stored under its full address, and the other way round.
        let existing = await store.get(hostFromUrl(baseUrl), workspace);
        let found = workspace;
        if (!existing?.apiKey) {
          const full = rememberedAddressFor(cfg.ship.stateDir, hostFromUrl(baseUrl), workspace);
          if (full !== workspace) { existing = await store.get(hostFromUrl(baseUrl), full); found = full; }
        }
        if (existing?.apiKey) {
          apiKey = existing.apiKey;
          keychainBacked = true;
          sessionAddress = found;
          routineLine(`Reusing the existing keychain session for ${hostFromUrl(baseUrl)}/${workspace}.`);
        }
      } catch {
        // No Secret Service / Credential Manager reachable right now — fall
        // through to the device-login flow below exactly as if nothing had
        // ever been stored.
      }
    }
    // CREW-2315/CREW-2498: a run with no workspace named (the macOS wizard's
    // dry-run sign-in, and the provisioning run that follows it) resumes a
    // keychain session this host already stored, when the server still accepts
    // it, instead of making the operator approve a device again. One remembered
    // workspace is used; several become a `workspace` choice under `--json`.
    let signInSource: 'keychain' | 'device' | 'key' = apiKey ? 'key' : 'device';
    if (!apiKey && !workspace && store) {
      const resumable = await resumableSessions({
        store, stateDir: cfg.ship.stateDir, host: hostFromUrl(baseUrl),
        verify: async (k) => {
          try { await connectGet({ baseUrl, apiKey: k, userAgent: cfg.ship.userAgent }, '/auth/me'); return true; } catch { return false; }
        },
      });
      if (resumable.length > 1 && connectEvents.json) {
        stopForChoice('workspace', `${resumable.length} workspaces have a remembered sign-in on ${hostFromUrl(baseUrl)} — which one?`,
          resumable.map((r) => ({ value: r.workspace, label: r.workspace })));
      }
      const resumed = resumable.length === 1 ? resumable[0] : undefined;
      if (resumed) {
        apiKey = resumed.apiKey;
        workspace = resumed.workspace;
        keychainBacked = true;
        sessionAddress = resumed.workspace;
        signInSource = 'keychain';
        routineLine(`Reusing the existing keychain session for ${hostFromUrl(baseUrl)}/${workspace}.`);
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
    let signedInEmitted = false;
    if (!apiKey) {
      if (!canAsk && !connectEvents.json && !flag('no-wizard')) {
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
            connectEvents.emit('device_code', 'approve this device in a browser', {
              userCode: info.userCode, verificationUri: info.verificationUri,
              verificationUriComplete: info.verificationUriComplete, expiresIn: info.expiresIn,
            });
            process.stderr.write(
              'No API key given — approve this device from a browser you\'re already signed into Tablation with:\n\n' +
              `  ${info.verificationUriComplete}\n\n` +
              `  (user code, if not already filled in: ${info.userCode})\n\nWaiting for approval`,
            );
          },
        });
      } catch (e) {
        process.stderr.write('\n');
        const why = e instanceof DeviceLoginError ? e.message : `device authorization failed — ${(e as Error).message}`;
        connectEvents.emit('problem', why, { stage: 'device_login' });
        die('crew connect', why, '`crew connect` again, or pass --key');
      }
      process.stderr.write('\n');
      emit.note(`Signed in as ${result.identity.email} — minted an API key in workspace "${result.workspace.name}".`);
      apiKey = result.apiKey.key;
      mintedFromDevice = true;
      // CREW-2668: `signed_in` is emitted by `runConnect` once `discover` has
      // resolved the workspace, so it carries the full address, not the bare slug.
      // The device flow just said exactly which workspace this key is
      // scoped to — no reason to make the operator retype what there was
      // no ambiguity in, the same reasoning as the single-workspace
      // shortcut below.
      // The client's typed workspace predates `path` (the secondary's
      // `<primary>:<slug>` segment); take it when the server sent it.
      const deviceWorkspace = 'path' in result.workspace && typeof result.workspace.path === 'string'
        ? result.workspace.path : result.workspace.slug;
      if (!workspace) workspace = deviceWorkspace;
      if (store) {
        try {
          await store.set(hostFromUrl(baseUrl), deviceWorkspace, {
            apiKey: result.apiKey.key,
            workspaceId: result.workspace.id,
            identityId: result.identity.id,
            createdAt: result.apiKey.createdAt,
          });
          keychainBacked = true;
          sessionAddress = deviceWorkspace;
          rememberSession(cfg.ship.stateDir, hostFromUrl(baseUrl), deviceWorkspace);
          emit.note(`API key stored in the OS keychain for ${hostFromUrl(baseUrl)}/${deviceWorkspace}.`);
        } catch (e) {
          emit.warn(withFix(
            `could not store the key in the OS keychain — ${(e as Error).message} — falling back to a key file`,
            '`crew doctor`',
          ));
        }
      } else {
        emit.warn('no OS keychain support on this platform — falling back to a key file');
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
        emit.warn(`no SSH keypair synced — ${(e as Error).message}`);
      }
    }
    // ISSUE-2249: a stable hashed machine id, matched before the name. Best-effort
    // like the SSH key: an unreadable id just means name matching, as before.
    let machineId: string | undefined;
    try {
      machineId = ensureMachineId(cfg.ship.stateDir, { override: value('machine-id') });
    } catch (e) {
      emit.warn(`no machine id — ${(e as Error).message}`);
    }
    const ship = {
      name: cfg.ship.name, platform: cfg.ship.platform, machineId,
      hostPassengers: firstRun?.answers.hostPassengers ?? existingRoute?.hostPassengers === true,
      hostPeriscopes: existingRoute?.hostPeriscopes === true,
      kind: value('ship-kind'), instanceClass: value('instance-class'),
      sshPublicKey,
      lastSyncedName: (r: string) => readSyncedName(resolvedPathFor(cfg.ship.stateDir, r)),
    };

    const runConnect = async (ws: string, proj: string | undefined): Promise<void> => {
      let found = await discover({ ...authOpts, workspace: ws, project: proj, area: value('area'), ship, dryRun, interactive: canAsk || connectEvents.json });
      // CREW-2668: the route and `hydrateApiKeys` use `found.workspaceSlug`, so
      // the keychain entry and remembered pointer must sit under it too.
      if (store && keychainBacked && sessionAddress && sessionAddress !== found.workspaceSlug) {
        if (await adoptSessionAddress({
          store, stateDir: cfg.ship.stateDir, host: hostFromUrl(baseUrl), from: sessionAddress, to: found.workspaceSlug,
        })) sessionAddress = found.workspaceSlug;
      }
      if (!signedInEmitted && found.meId) {
        signedInEmitted = true;
        connectEvents.emit('signed_in', mintedFromDevice ? `signed in as ${found.meEmail ?? found.meId}` : `key belongs to ${found.meEmail ?? found.meId}`, {
          identity: { id: found.meId, email: found.meEmail, name: found.meName },
          workspaces: [{ slug: found.workspaceSlug, name: found.workspaceName, role: found.role }],
          session: signInSource,
          host: hostFromUrl(baseUrl),
        });
      }
      connectEvents.emit('workspace_resolved', `workspace ${found.workspaceSlug}`, {
        workspaceId: found.workspaceId, slug: found.workspaceSlug, name: found.workspaceName, role: found.role,
      });
      if (found.projectOptions) {
        connectEvents.emit('project_options', `${found.projectOptions.length} projects qualify`, { options: found.projectOptions });
        if (connectEvents.json) {
          stopForChoice('project', `${found.projectOptions.length} projects in ${found.workspaceSlug} qualify — which one?`,
            found.projectOptions.map((p) => ({ value: p.slug ?? p.id, label: p.name })));
        }
      }
      if (!found.projectId && found.offerTemplateInstall !== undefined) {
        const canInstall = found.offerTemplateInstall === true;
        connectEvents.emit('template_missing', 'no project has the tables a route needs', { canInstall });
        // A terminal is asked; `--json` is told by `--choose install-template=yes|no`.
        const decided = connectEvents.json ? connectChoices['install-template'] : undefined;
        if (canInstall && connectEvents.json && decided === undefined) {
          stopForChoice('install-template', 'Install the Issues library template into a new project?', [
            { value: 'yes', label: 'Install it' }, { value: 'no', label: 'Do not install' },
          ]);
        }
        if (canInstall && (canAsk || decided === 'yes')) {
          const installedSlug = await offerTemplateInstall(authOpts, found.workspaceId, canAsk ? undefined : true);
          if (installedSlug) {
            connectEvents.emit('template_installed', `installed project ${installedSlug}`, { projectSlug: installedSlug });
            found = await discover({ ...authOpts, workspace: ws, project: installedSlug, area: value('area'), ship, dryRun, interactive: canAsk || connectEvents.json });
          }
        }
      }
      if (!found.projectId) {
        for (const p of found.problems) connectEvents.emit('problem', p, { stage: 'discover' });
        die(`crew connect ${ws}`, `unresolved —\n${found.problems.map((p) => `  - ${p}`).join('\n')}`, 'fix the problems above, then run `crew connect` again');
      }
      // CREW-2495: a rename made on the Ships row lands in crew.yaml here too.
      if (found.shipNameAdopted && !dryRun) {
        writeFileSync(cfg.configFile, setShipNameInYaml(readFileSync(cfg.configFile, 'utf8'), found.shipNameAdopted));
        cfg.ship.name = found.shipNameAdopted;
      }
      if (found.shipRow) {
        connectEvents.emit('ship_row', `Ships row "${found.shipRow.name}" ${found.shipRow.action}`, found.shipRow);
      }
      // The route's own identity, built from the SLUGS `discover()` resolved
      // — never from a display name, which may hold spaces/mixed case a
      // route string and a state-file path segment cannot.
      const route = `${found.workspaceSlug}/${found.projectSlug ?? found.projectId}`;
      const resolvedPath = resolvedPathFor(cfg.ship.stateDir, route);
      // CREW-2240: report what this key may do before provisioning, so a
      // member learns what to ask an admin for now rather than from a refused
      // write later. Provisioning below carries on for whatever is allowed.
      const capabilities = await checkCapabilities(authOpts, found);
      if (flag('json')) {
        process.stdout.write(`${JSON.stringify({ event: 'capabilities', route, items: capabilities })}\n`);
      } else {
        process.stderr.write('capabilities for this key:\n');
        for (const i of capabilities) process.stderr.write(`  ${describeCapability(i)}\n`);
      }
      const capabilityMisses = capabilities.filter((i) => i.status === 'missing').map(missLine);
      // One release-lock row per repo of this route (CREW-1384): every repo the
      // board's Repos table names plus every checkout this ship configured for
      // the route. Idempotent and safe against another ship connecting at once.
      if (found.locksModelId && !dryRun) {
        const configured = cfg.routes.find((r) => r.route === route);
        const repoNames = [...Object.values(found.repoNames ?? {}), ...(configured ? reposOf(configured).map((t) => t.name) : [])]
          .filter((n) => !!n);
        try {
          const made = await provisionReleaseLocks(authOpts, found.locksModelId, route, repoNames);
          for (const sc of made) emit.note(`created release lock row ${sc}`);
        } catch (e) {
          emit.warn(withFix(`could not provision release lock rows — ${(e as Error).message}`, '`crew doctor`'));
        }
      }
      // `discover()` already tried to match this key's own identity email
      // against a Crew row; ask interactively only when that came up empty
      // (or ambiguous) AND there is a person on the other end of a terminal
      // to ask — a script piping stdin gets the old file-editing fallback.
      let operator = found.operator;
      if (!operator && found.candidates.length > 0 && canAsk) {
        const picked = await pickOperator(found.candidates, { id: found.meId, name: found.meName, email: found.meEmail });
        if (picked === NEW_OPERATOR_ROW) {
          await createOperatorRow({ ...authOpts, dryRun }, found);
          operator = found.operator;
        } else if (picked) {
          operator = picked;
          const row = found.holds.find((h) => h.id === picked);
          if (row && found.meId && row.user_id !== found.meId) await linkOperatorRow({ ...authOpts, dryRun }, found, row);
        }
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
            releaseAgentId?: string;
            role?: string;
            shipName?: string;
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
      if (connectEvents.json && !operator && found.candidates.length > 0) {
        const answer = connectChoices.operator;
        if (answer === 'new') {
          await createOperatorRow({ ...authOpts, dryRun }, found);
          operator = found.operator;
        } else if (answer !== undefined) {
          const row = found.holds.find((h) => h.id === answer);
          if (!row) stopWithProblem(`--choose operator=${answer} is not one of this workspace's Crew rows`, 'operator');
          operator = row!.id;
          found.operatorAction = 'matched';
          if (found.meId && row!.user_id !== found.meId) {
            await linkOperatorRow({ ...authOpts, dryRun }, found, row!);
            found.operatorAction = 'linked';
          }
        } else {
          const mine = found.candidates.filter((h) => !h.user_id || h.user_id === found.meId);
          stopForChoice('operator', 'Which Crew row is you?', [
            ...mine.map((h) => ({ value: h.id, label: h.name || 'unnamed row', ...(h.detail ? { detail: h.detail } : { detail: h.id }) })),
            ...(found.meId ? [{ value: 'new', label: `Create a new Crew row for ${found.meName ?? found.meEmail ?? 'me'}` }] : []),
          ]);
        }
      }
      if (!operator && found.operatorCompared && found.operatorAction !== 'would-create') {
        emit.warn(`crew connect: no Crew row matched you — ${found.operatorCompared}`);
        connectEvents.emit('operator_row', 'no Crew row matched you', { action: 'unmatched', compared: found.operatorCompared });
      }
      if (operator) {
        const opRow = found.holds.find((h) => h.id === operator);
        // CREW-2431: name and email of the matched row, so a front end can show who it is.
        // A row just linked to or created for this key's own account has this key's email.
        const opEmail = opRow?.email || opRow?.memberEmail
          || (opRow?.user_id && opRow.user_id === found.meId ? found.meEmail : undefined);
        connectEvents.emit('operator_row', `operator ${opRow?.name ?? operator}`, {
          id: operator, action: found.operatorAction ?? 'previous',
          ...(opRow?.name ? { name: opRow.name } : {}),
          ...(opEmail ? { email: opEmail } : {}),
        });
      }
      // CREW-2573: a dry run on a Crew table with no person rows would create the
      // operator's own row. That is a resolved operator, just without an id yet.
      const operatorWouldBeCreated = !operator && found.operatorAction === 'would-create';
      if (operatorWouldBeCreated) {
        connectEvents.emit('operator_row', `operator ${found.meName ?? found.meEmail ?? 'you'} (would create)`, {
          action: 'would-create',
          ...(found.meName ? { name: found.meName } : {}),
          ...(found.meEmail ? { email: found.meEmail } : {}),
        });
      }
      // CREW-978: a non-interactive `connect` with no previous file and no
      // operator resolvable (several holds, none matching this key's email)
      // used to write a resolved file with no `operator` key at all — which
      // `loadConfig` then silently drops the whole route for (`operator is
      // required`), on every cycle after this one, with nothing at connect
      // time to say why. A re-run that already HAS a previous file is fine
      // to proceed without one (the loop already accepted this route before;
      // don't turn a routine reconnect into a hard failure over a field nothing
      // new was asked to resolve) — this only refuses a *first* write.
      if (!operator && !hadPreviousFile && !operatorWouldBeCreated) {
        emit.error(withFix(
          `crew connect ${route}: cannot determine the operator — ${found.candidates.length} Crew row(s) ` +
          `could be it, none matching this key's own email, and there's no terminal to ask`,
          'run `crew connect` from a real terminal to pick one, or pass --key for a key whose own identity email matches exactly one Crew row',
        ));
        stopWithProblem(`cannot determine the operator — ${found.candidates.length} Crew row(s) could be it`, 'operator');
      }
      const alreadyReviewed = new Set(previous?.reviewedStatuses ?? []);
      const stillUnrecognized = (found.unrecognizedStatuses ?? []).filter((s) => !alreadyReviewed.has(s.value));
      const canPrompt = stillUnrecognized.length > 0 && canAsk;
      // `--json`: each value is answered with `--choose status.<value>=yes|no`.
      const statusAnswer = (v: string) => connectChoices[`status.${v}`];
      const jsonClassified = connectEvents.json && stillUnrecognized.length > 0;
      if (jsonClassified) {
        const pending = stillUnrecognized.filter((s) => statusAnswer(s.value) === undefined);
        if (pending.length > 0) {
          for (const s of pending.slice(1)) {
            connectEvents.emit('choice', `Does status "${s.value}" mean the ticket is done?`, choiceData(`status.${s.value}`, [
              { value: 'yes', label: 'Resolved / terminal' }, { value: 'no', label: 'Not resolved' },
            ]));
          }
          stopForChoice(`status.${pending[0]!.value}`, `Does status "${pending[0]!.value}" mean the ticket is done?`, [
            { value: 'yes', label: 'Resolved / terminal' }, { value: 'no', label: 'Not resolved' },
          ]);
        }
      }
      const newlyResolved = canPrompt
        ? await pickResolvedStatuses(stillUnrecognized)
        : jsonClassified ? stillUnrecognized.filter((s) => /^y/i.test(statusAnswer(s.value) ?? '')).map((s) => s.value) : [];
      // Every value actually ASKED about — asked-and-declined counts as
      // reviewed too, so a `draft`-like status answered "no" isn't asked
      // about again and again on every future connect. A script run
      // (piped/non-interactive) never asked, so it must not mark them
      // reviewed — that would silently bury them until someone edits the
      // state file by hand, the same trap `operator` already avoids above.
      const reviewedStatuses = canPrompt || jsonClassified
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
        shipsModelId: found.shipsModelId, epicsModelId: found.epicsModelId, periscopesModelId: found.periscopesModelId, locksModelId: found.locksModelId,
        recordLinkViewId: found.recordLinkViewId,
        reposModelId: found.reposModelId, repoNames: found.repoNames, repoRemotes: found.repoRemotes, repoForgeHosts: found.repoForgeHosts,
        models: found.models, seats: found.seats, holds: found.holds.map((h) => ({ id: h.id, role: h.name })),
        ...(found.releaseSeat ? { releaseSeat: found.releaseSeat } : {}),
        connectedAt: new Date().toISOString(),
        ...((found.role ?? previous?.role) ? { role: found.role ?? previous?.role } : {}),
        ...(capabilityMisses.length > 0 ? { capabilityMisses } : {}),
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
        ...(previous?.releaseAgentId ? { releaseAgentId: previous.releaseAgentId } : {}),
        // CREW-2495: the ship name this route last saw agree with its Ships row.
        ...(found.shipRow ? { shipName: found.shipRow.name } : previous?.shipName ? { shipName: previous.shipName } : {}),
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
        emit.note(`Resolved ids written to ${resolvedPath}`);
      }
      // CREW-1603: seats already linked to Agents rows get their agent keys now;
      // a first connect has none linked yet, and `crew agents sync` mints them.
      let mintOutcomes: MintOutcome[] = [];
      if (!dryRun && previous?.agentPersonas && existingRoute?.resolved) {
        try {
          mintOutcomes = await mintMissingSeatKeys(withFoundSeats(existingRoute, found, previous.releaseAgentId), { userAgent: cfg.ship.userAgent, shipName: cfg.ship.name });
          for (const o of mintOutcomes) emit.note(describeMintOutcome(o));
          for (const p of await probeSeatReads({ ...existingRoute, resolved: { ...existingRoute.resolved, seats: found.seats } }, { userAgent: cfg.ship.userAgent })) {
            if (p.state === 'forbidden') emit.warn(describeSeatForbidden(p.role, p.tables));
          }
        } catch (e) {
          emit.warn(withFix(`seat keys: skipped (${(e as Error).message})`, '`crew agents sync`'));
        }
      }
      for (const sr of found.seatRows ?? []) {
        const minted = mintOutcomes.find((m) => m.role === sr.role);
        connectEvents.emit('seat', `${sr.role} seat ${sr.action}`, {
          role: sr.role, id: sr.id, action: sr.action, ...(sr.shipId ? { ship_id: sr.shipId } : {}), key: minted?.action ?? 'none', ...(minted?.detail ? { detail: minted.detail } : {}),
        });
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
      // CREW-2910: a managed ship runs its agents in the sandbox image, which carries the harness; the host has none, so a missing `claude` is expected there.
      if (firstRunFromFlags && agentBinSearched && !dryRun && !isManagedShipKind(value('ship-kind'))) {
        const msg = `no agent binary: "claude" was not found on PATH or in ${agentBinSearched.join(', ')} — pass --agent-bin /absolute/path`;
        emit.error(`crew connect: ${msg}`);
        stopWithProblem(msg, 'wizard');
      }
      if ((mintedFromDevice || firstRunFromFlags) && !keychainBacked) {
        apiKeyFile = apiKeyPathFor(cfg.ship.stateDir, route);
        if (dryRun) {
          process.stderr.write(`(dry run) would write the minted API key to ${apiKeyFile}\n`);
        } else {
          mkdirSync(dirname(apiKeyFile), { recursive: true });
          writeFileSync(apiKeyFile, `${apiKeyVar}=${apiKey}\n`, { mode: 0o600 });
          routineLine(`API key written to ${apiKeyFile}`);
        }
      }
      // CREW-1286: the first-run wizard writes crew.yaml itself instead of
      // printing a block to paste — but only when the route's key has somewhere
      // to live (keychain or a key file). A `--key` connect with neither has no
      // key a written file could name, so it keeps today's print-and-paste.
      const keyPersisted = keychainBacked || apiKeyFile !== undefined;
      const wizard = firstRun;
      const writeFirstRun = wizard !== undefined && !dryRun && keyPersisted;
      // CREW-2516: a first run has no checkout yet, and `dir:` means "the
      // checkout this route works". Write no `dir:` instead; `crew repos
      // clone` puts checkouts under reposBasePath and attaches them.
      const routeDir = value('dir');
      const routeBlock = renderConnection(
        found, route,
        routeDir ?? (writeFirstRun ? null : 'REPLACE — the local checkout this route works'),
        {
          area: value('area'), apiKeyFile, apiKeyVar: apiKeyFile ? apiKeyVar : undefined, keychainBacked,
          ...(writeFirstRun ? { baseUrl, hostPassengers: wizard.answers.hostPassengers } : {}),
        },
      );
      let wroteConfig = false;
      if (writeFirstRun) {
        wroteConfig = writeNewConfig(wizard.configPath, renderFullConfig(wizard.answers, routeBlock));
        if (!wroteConfig) emit.warn(`${wizard.configPath} appeared while connecting — leaving it alone`);
      }
      // CREW-2558: under `--json` the route block goes to stderr as prose, so say on
      // the event stream whether crew.yaml was written and, if not, why. A dry run
      // writes nothing by definition and stays quiet.
      if (!dryRun) {
        if (wroteConfig) {
          connectEvents.emit('config', `wrote ${wizard!.configPath}`, { written: true, path: wizard!.configPath });
        } else if (wizard && writeFirstRun) {
          connectEvents.emit('config', `${wizard.configPath} appeared while connecting; left alone`, { written: false, path: wizard.configPath, reason: 'appeared while connecting' });
        } else if (wizard) {
          connectEvents.emit('config', `no key file or keychain entry to name; ${wizard.configPath} not written`, { written: false, path: wizard.configPath, reason: 'no-key' });
        } else {
          connectEvents.emit('config', `${cfg.configFile} already exists; left alone`, { written: false, path: cfg.configFile, reason: 'exists' });
        }
      }
      // Under `--json` stdout is the event stream; the block goes to stderr with the rest of the prose.
      if (!wroteConfig) (connectEvents.json ? process.stderr : process.stdout).write(routeBlock);
      // CREW-1378: give interactive Claude Code sessions the tablation MCP tools.
      if (!flag('no-mcp') && apiKey) {
        const replace = value('mcp') === 'replace';
        // CREW-1511: every configured toolchain, not just Claude. Toolchains
        // that share a harness and binary are registered once.
        const seen = new Set<string>();
        for (const tc of shipToolchains(cfg.ship)) {
          const id = `${tc.harness}\0${tc.bin}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const adapter = adapterFor(tc.harness);
          const mcpUrl = mcpUrlFor(baseUrl);
          const mcpOpts = { bin: tc.bin, url: mcpUrl, key: apiKey, replace, dryRun, stateDir: cfg.ship.stateDir };
          const { line, action } = adapter.ensureMcpResult ? adapter.ensureMcpResult(mcpOpts) : { line: adapter.ensureMcp(mcpOpts), action: undefined };
          connectEvents.emit('mcp_registered', line, { harness: tc.harness, bin: tc.bin, url: mcpUrl, ...(action ? { action } : {}) });
          routineLine(line);
        }
        // CREW-1517: Pair for the other harnesses `ship.pair` lists. Claude's is
        // the registration just done above, so it is not repeated here.
        for (const h of shipPair(cfg.ship).filter((x) => x !== 'claude')) {
          const line = pairInstallerFor(h).installPair({ url: mcpUrlFor(baseUrl), replace, dryRun });
          connectEvents.emit('pair_installed', line, { harness: h });
          routineLine(line);
        }
      }
      // CREW-1390: name every hold resolved, so a missing operator is visible now
      // rather than when a comment from them reads as "(no identity)".
      if (found.holds.length) {
        emit.note(
          `Holds resolved (${found.holds.length}): ` +
          `${found.holds.map((h) => `${h.name || h.id}${h.id === operator ? ' [operator]' : ''}`).join(', ')}`,
        );
      }
      if (found.provisioning.length) {
        emit.note(`Provisioned for this machine (${ship.name}):`);
        for (const p of found.provisioning) emit.note(`  - ${p}`);
      }
      if (found.problems.length) {
        emit.warn(`Unresolved — fix these before arming it:\n${found.problems.map((p) => `  - ${p}`).join('\n')}`);
        for (const p of found.problems) connectEvents.emit('problem', p, { stage: 'discover' });
      }
      if (!canPrompt && !jsonClassified && stillUnrecognized.length > 0) {
        // Nowhere to ask (piped/non-interactive) — same reasoning as the
        // operator fallback below. Left unclassified rather than guessed;
        // a blocker sitting at one of these won't be recognised as resolved
        // until a person runs `crew connect` from a real terminal, or adds
        // it to contract.statuses.resolved in resolvedPath by hand.
        emit.warn(
          `${stillUnrecognized.length} status value(s) this workspace has that the default contract ` +
          `doesn't know the meaning of (${stillUnrecognized.map((s) => s.value).join(', ')}) — ` +
          `re-run from a terminal to classify them, or edit ${resolvedPath} by hand.`,
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
      // CREW-2241: a fresh workspace has no Agents rows until `agents sync`
      // runs, so an admin's connect does it now (the same sync, then the seat
      // key mint). A member's key links this ship's seats to whatever rows
      // exist and is told what an admin still has to do.
      if (!dryRun && !flag('no-agents-sync')) {
        const skip = (why: string) => {
          emit.warn(`agents sync: skipped (${why})`);
          connectEvents.emit('agents_synced', `agents sync skipped: ${why}`, { route, skipped: why });
        };
        let syncRoute: Route | undefined;
        try {
          const reloaded = loadConfig(CREW_HOME, wizard?.configPath ?? cfg.configFile, { allowNoRoutes: true });
          syncRoute = reloaded.routes.find((r) => r.route === route);
          if (syncRoute) await hydrateApiKeys([syncRoute]);
        } catch (e) {
          skip(`config did not load: ${(e as Error).message}`);
        }
        if (syncRoute?.resolved) {
          try {
            const run = await runAgentsSync(syncRoute, {
              userAgent: cfg.ship.userAgent, stateDir: cfg.ship.stateDir,
              say: (l) => emit.note(l),
              warn: (l) => emit.warn(`agents sync: ${l}`),
            });
            const minted = await mintMissingSeatKeys(syncRoute, { userAgent: cfg.ship.userAgent, shipName: cfg.ship.name });
            for (const m of minted) emit.note(describeMintOutcome(m));
            for (const p of await probeSeatReads(syncRoute, { userAgent: cfg.ship.userAgent })) {
              if (p.state === 'forbidden') emit.warn(describeSeatForbidden(p.role, p.tables));
            }
            if (run.readOnly) {
              const missing = run.personaResult.outcomes.some((p) => p.action === 'missing');
              if (missing) emit.warn("A workspace admin has to open the Crew app or run `crew agents sync` once before this ship's seats can run.");
              else emit.note("Seats are linked to the workspace's existing personas.");
            }
            connectEvents.emit('agents_synced', run.readOnly ? 'agents linked (read-only key)' : 'agents synced', {
              route, admin: !run.readOnly, personas: run.personaResult.outcomes,
              skills: run.skillResult?.outcomes ?? [], diverged: run.diverged,
            });
            for (const m of minted) connectEvents.emit('seat_key', describeMintOutcome(m), { route, ...m });
            if (run.diverged) process.exitCode = 1;
          } catch (e) {
            if (e instanceof AgentsSyncError || e instanceof SkillSyncError) skip(e.message);
            else throw e;
          }
        } else if (!syncRoute) {
          skip(`"${route}" is not in crew.yaml yet; add the block above, then run \`crew agents sync\``);
        }
      }
      connectEvents.emit('done', `connected ${route}`, {
        route, resolvedPath: dryRun ? undefined : resolvedPath, configPath: wroteConfig ? wizard!.configPath : undefined,
        wroteConfig, operator, dryRun, unresolved: found.problems.length,
        ...(firstRunFromFlags ? { agentBin: agentBinSearched ? null : firstRun?.answers.agentBin } : {}),
        ...(agentBinSearched ? { agentBinNote: `no \`claude\` found on PATH or in ${agentBinSearched.join(', ')}; a real run needs --agent-bin` } : {}),
      });
    };

    try {
      if (!workspace) {
        const workspaces = await listWorkspaces(authOpts);
        // CREW-2447: a key resolved without the device flow (--key, CREW_CONNECT_KEY,
        // crew.yaml or the keychain) still has to tell a JSON client who is signed in
        // before any `choice` event asks it about a workspace. Same shape as the
        // device and named-workspace emissions.
        const configWorkspaces = [...new Set(cfg.routes.map((r) => splitRoute(r.route)[0]))];
        // A dry run against a crew.yaml that names exactly one workspace has nothing to
        // ask: asking again for a workspace the config already names is the wizard
        // re-entering discovery (CMAC-2446).
        const defaulted = dryRun && givenKeySource === 'config' && configWorkspaces.length === 1
          ? workspaces.find((w) => w.slug === configWorkspaces[0]) : undefined;
        if (!signedInEmitted && (apiKey ?? '') !== '') {
          let me: { id?: string; email?: string; name?: string } = {};
          try {
            me = await connectGet<typeof me>(authOpts, '/auth/me');
          } catch { /* the workspace list above already proved the key works */ }
          if (me.id || me.email) {
            signedInEmitted = true;
            connectEvents.emit('signed_in',
              `key belongs to ${me.email ?? me.id}${defaulted ? `; using ${defaulted.slug}, the workspace crew.yaml already names` : ''}`, {
                identity: { id: me.id, email: me.email, name: me.name },
                workspaces: workspaces.map((w) => ({ slug: w.slug, name: w.name, role: w.role })),
                session: givenKeySource,
                host: hostFromUrl(baseUrl),
              });
          }
        }
        if (defaulted) {
          await runConnect(defaulted.slug, project);
        } else
        if (workspaces.length === 0) {
          connectEvents.emit('problem', 'this key\'s identity has no workspace memberships', { stage: 'workspace' });
          die('crew connect', 'this key\'s identity has no workspace memberships', 'mint a key inside a workspace and re-run with `--key K`');
        } else if (workspaces.length === 1) {
          // Only one candidate — same reasoning as an unnamed route with only
          // one enabled: nothing to disambiguate, so proceed with it directly
          // rather than making the operator retype what there was no choice in.
          await runConnect(workspaces[0]!.slug, project);
        } else {
          if (connectEvents.json) {
            stopForChoice('workspace', `${workspaces.length} workspaces reachable by this key — which one?`,
              workspaces.map((w) => ({ value: w.slug, label: `${w.name} (${w.role})` })));
          }
          die('crew connect', `${workspaces.length} workspaces reachable by this key — name one:\n` +
            workspaces.map((w) => `  ${w.slug.padEnd(24)} ${w.name} (${w.role})`).join('\n'), 'run `crew connect <workspace>` with one of the slugs above');
        }
      } else {
        await runConnect(workspace, project);
      }
    } catch (e) {
      // A bad key/workspace pairing is an operator mistake, not a crash —
      // same reasoning as the crew.yaml ConfigError handling above main().
      if (e instanceof ConnectHttpError) {
        connectEvents.emit('problem', e.message, { stage: 'http', status: e.status, path: e.path });
        if (e.status === 401 || e.status === 403) {
          die(
            'crew connect',
            `${e.path} — ${e.status} ${e.status === 401 ? '(bad or expired key)' : '(this key is not a member of that workspace)'}. ` +
              'A key only sees the workspace it was minted in, whatever role it holds there (platform admin included)',
            'pass a key minted inside the target workspace: `--key K` (or CREW_CONNECT_KEY)',
          );
        }
        die('crew connect', e.message, '`crew doctor`');
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
        emit.warn(withFix(
          `"${who}" resolved to different people on different workspaces. ` +
          `A name is a per-workspace label, not an identity — this queue is a mixture`,
          'pass an email address to --member to match exactly',
        ));
      }
      process.stdout.write('\n');
    }
    const subject = who
      ? [...new Set(resolved.flatMap((r) => r.names))].join(', ') || `"${who}"`
      : undefined;
    process.stdout.write(renderInbox(items, flag('by-route'), subject));
    for (const e of errors) emit.warn(withFix(`${e.route} unreachable: ${e.error}`, `\`crew doctor ${e.route}\``));
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

  case 'sandbox': {
    // One clause: the `case 'sandbox'` of CREW-2801 (policy), CREW-2794
    // (build, images) and CREW-2799 (cache) used to be three clauses in this
    // switch, so only the first was reachable (CREW-2908).
    switch (positional[1]) {
      case 'policy': {
        // CREW-2801: the policy a sandboxed run would get, derived exactly as
        // `planAgentRun` derives it. Prints; writes nothing.
        const only = value('route');
        const wanted = only ? cfg.routes.filter((r) => r.route === only) : cfg.routes;
        if (wanted.length !== 1) {
          die('crew sandbox policy', `${only ? `no route "${only}"` : 'no route given'} (have: ${cfg.routes.map((r) => r.route).join(', ')})`, '`--route ROUTE`');
        }
        const role = (value('role') ?? 'dev') as RoleName;
        if (!ROLE_NAMES.includes(role)) {
          die('crew sandbox policy', `--role must be one of ${ROLE_NAMES.join(', ')}`, `\`--role ${ROLE_NAMES[0]}\``);
        }
        const r = wanted[0]!;
        const repoName = value('repo');
        const seat = resolveSeat(cfg.ship, r, role, {}, repoName);
        const input = sandboxPolicyInputFor(r, seat.toolchain, { harnessBin: seat.toolchain.bin, repo: repoName, sandbox: cfg.ship.sandbox, contract: await planContractOf(r, repoName) });
        try {
          const policy = generateSandboxPolicy({ mirrorDir: cfg.ship.sandbox?.mirrorDir, workDir: cfg.ship.sandbox?.workDir, ...input });
          process.stdout.write(flag('json') ? `${JSON.stringify({ route: r.route, role, input, groups: policy.groups, yaml: policy.yaml }, null, 2)}\n` : policy.yaml);
        } catch (e) {
          die('crew sandbox policy', (e as Error).message, '`crew doctor`', 1);
        }
        break;
      }

      case 'build':
      case 'images': {
        // CREW-2794: `crew sandbox build [--route R] [REPO]` forces a rebuild of
        // the image a repo's `.crew.yaml` `sandbox:` section declares;
        // `crew sandbox images` lists tags and ages. Planning, tags and the
        // keep-the-previous-tag rule live in sandbox-image.ts.
        const subS = positional[1];
        const jsonS = flag('json');
        let routesS: Array<typeof route>;
        try {
          routesS = value('route') ? [findRoute(cfg, value('route'))] : cfg.routes.filter((r) => r.enabled);
        } catch (e) {
          if (e instanceof ConfigError) die('crew', e.message, '`crew doctor`');
          throw e;
        }
        const declared = withShipSandbox(await sandboxReposOf(routesS));
        if (subS === 'images') {
          const stateS = readSandboxState(cfg.ship.stateDir);
          const rows = declared.map((r) => {
            const plan = planSandbox(r.name, r.decl, r.warm, r.bridge);
            return { repo: r.name, wants: plan.tag, tags: stateS[r.name]?.tags ?? [], ...sandboxImageStatus(stateS, plan) };
          });
          if (jsonS) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); break; }
          if (rows.length === 0) process.stdout.write('no repository declares a sandbox: section in its .crew.yaml\n');
          for (const r of rows) {
            process.stdout.write(`${r.repo}: ${r.status} — ${r.detail}\n`);
            for (const t of r.tags) {
              const ageH = Math.max(0, Math.round((Date.now() - Date.parse(t.builtAt)) / 3_600_000));
              process.stdout.write(`  ${t.tag}  built ${t.builtAt} (${ageH}h ago), claude ${t.claude ?? 'unknown'}\n`);
            }
          }
          break;
        }
        const only = positional[2];
        const targets = only ? declared.filter((r) => r.name === only) : declared;
        if (targets.length === 0) {
          die('crew', only ? `no repository "${only}" declares a sandbox: section (${SHIP_SANDBOX_KEY} is the ship's crew layer, built only on a ship.runner: sandbox ship)` : 'this ship is not a sandbox ship and no repository declares a sandbox: section in its .crew.yaml', 'add a sandbox: section to the repository\'s .crew.yaml, or run `crew sandbox images` to list what is declared');
        }
        const emitS = new Emitter({ route: routesS[0]!.route, eventFile: eventFileFor(cfg.ship.stateDir), rotateBytes: cfg.ship.eventsRotateBytes, logFile: cfg.ship.logFile, console: (l) => process.stderr.write(`${l}\n`) });
        const depsS = sandboxTickDeps(emitS, routesS[0]!);
        let failed = false;
        for (const t of targets) {
          // Forced: ignore the retry window, and rebuild even a built tag only if the declaration moved.
          await sandboxBuildTick([t], depsS, true);
          const after = readSandboxState(cfg.ship.stateDir);
          const st = sandboxImageStatus(after, planSandbox(t.name, t.decl, t.warm, t.bridge));
          if (st.status === 'failed') failed = true;
          process.stdout.write(`${t.name}: ${st.status} — ${st.detail}\n`);
        }
        if (failed) process.exit(1);
        break;
      }

      case 'cache': {
        // CREW-2799: the sandbox cache volume of bare mirrors.
        const settings = cacheSettingsOf(cfg.ship.sandbox);
        if (!settings) die('crew sandbox cache', 'ship.sandbox.cacheVolume is not set, so there is no cache volume', 'set ship.sandbox.cacheVolume in crew.yaml');
        const cache = new SandboxCache(settings);
        const served = cfg.routes.flatMap((r) => sandboxCacheRepos(r, cfg.ship));
        try {
          if (flag('reset')) {
            await cache.reset();
            process.stdout.write(`recreated volume ${settings.volume}; the next daemon pass refreshes every mirror\n`);
            break;
          }
          // CREW-2993: the daemon's cache pass, once, in the foreground: how a fresh ship gets its mirrors by hand.
          let refreshFailed = false;
          if (flag('refresh')) {
            for (const r of cfg.routes) {
              const pass = buildSandboxCachePass(r, cfg.ship, state, emit);
              for (const out of (await pass?.()) ?? []) {
                if (!out.ok) refreshFailed = true;
                process.stdout.write(`${out.ok ? 'refreshed' : 'FAILED   '} ${out.repo.host}/${out.repo.path}${out.ok ? '' : ` (${out.detail})`}\n`);
              }
            }
          }
          const dropped = flag('prune') ? await cache.prune(served) : [];
          const mirrors = await cache.list();
          const open = openShipAttention(new State(cfg.ship.stateDir));
          const failures = served.flatMap((r) => {
            const item = open.find((i) => i.kind === 'sandbox_cache' && i.key === sandboxCacheKey(settings.volume, r));
            return item ? [{ repo: `${r.host}/${r.path}`, lastFailedAt: item.lastFailedAt ?? item.since, message: item.message }] : [];
          });
          if (flag('json')) {
            process.stdout.write(`${JSON.stringify({ volume: settings.volume, mirrors, failures, dropped }, null, 2)}\n`);
          } else {
            for (const d of dropped) process.stdout.write(`dropped ${d.host}/${d.path}\n`);
            if (mirrors.length === 0) process.stdout.write(`volume ${settings.volume}: no mirrors yet\n`);
            for (const m of mirrors) {
              process.stdout.write(`${m.repo.host}/${m.repo.path}  last refresh ${m.lastRefresh ?? 'never'}${m.intel ? `  intel ${m.intel.commit.slice(0, 12)} (${m.intel.indexedAt ?? 'age unknown'})` : ''}\n`);
            }
            // CREW-2961: a failing refresh is shown next to its repository, mirrored or not.
            for (const f of failures) process.stdout.write(`${f.repo}  REFRESH FAILING (last failed ${f.lastFailedAt}): ${f.message}\n`);
          }
          if (refreshFailed) process.exitCode = 1;
        } catch (e) {
          emit.error(withFix(`crew sandbox cache: ${e instanceof Error ? e.message : String(e)}`, '`crew doctor`'));
          process.exitCode = 1;
        }
        break;
      }

      default:
        process.stderr.write([
          'crew sandbox policy --route ROUTE --role ROLE [--repo NAME] [--json]',
          'crew sandbox build [REPO] [--route ROUTE] [--json]',
          'crew sandbox images [--route ROUTE] [--json]',
          'crew sandbox cache [--refresh|--prune|--reset] [--json]',
          '',
        ].join('\n'));
        process.exit(2);
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
    // CREW-1593: tickets are resolved from the worktrees/branches that exist,
    // not from a capped closed-ticket listing.
    const truncated = (limit: number) => emit.warn(`ticket lookup for the sweep hit its ${limit}-row limit; some tickets may be missed`, { step: 'worktree' });
    for (const r of await resolvedRepos(route)) {
      const wtTickets = ticketsByRepo(route, await tracker.ticketsByNumbers(worktreeTicketNumbers(r), truncated)).byRepo.get(r.name) ?? [];
      const brTickets = ticketsByRepo(
        route, await tracker.ticketsByNumbers(remoteBranchTicketNumbers(r.dir, r.config.branch.remote, r.config.branch.base), truncated),
      ).byRepo.get(r.name) ?? [];
      const actions = planWorktreeSweep(r, wtTickets, tracker.contract);
      for (const k of draftWorktrees(r, wtTickets, tracker.contract)) {
        anything = true;
        emit.emit(`keeping ${k.path}: ${k.ticket.issue_tag ?? k.ticket.issue_id} is a draft (a periscope) — end it with \`crew periscope down\``, { step: 'worktree' });
      }
      const orphanDirs = orphanedWorktreeDirs(r, wtTickets, tracker.contract);
      warnOrphanedWorktreeDirs(orphanDirs, emit, dryRun ? undefined : { state, repo: r.name });
      const stale = planRemoteBranchCleanup(r.dir, r.config.branch.remote, r.config.branch.base, brTickets, tracker.contract);
      if (stale.length) { anything = true; applyRemoteBranchCleanup(r.dir, r.config.branch.remote, stale, dryRun, emit); }
      if (!actions.length) {
        if (!dryRun) reconcileHeldWorktrees(state, r.name, emit, new Set(orphanDirs));
        continue;
      }
      anything = true;
      const res = await applyWorktreeSweep(r.dir, actions, dryRun, emit, r.config.branch.remote, r.config.branch.base, { state, repo: r.name }, clearBranchLink(tracker));
      if (!dryRun) reconcileHeldWorktrees(state, r.name, emit, new Set([...res.refused, ...orphanDirs]));
      emit.emit(
        `swept ${res.removed} worktree(s) for ${r.name}, kept ${res.keptBranches} branch(es)`,
        { step: 'worktree' },
      );
    }

    // Same retention rule the release phase applies on its own (ISSUE-401),
    // available by hand here for the same reason the worktree sweep is.
    // CREW-1509: a live events.jsonl already past the threshold (the writer
    // only checks on append) is rotated now, so the one-time recovery of an
    // oversized file is `crew reap`. The rotated file ages out below.
    if (!dryRun) {
      const rotated = rotateEventsFile(eventFileFor(cfg.ship.stateDir), cfg.ship.eventsRotateBytes);
      if (rotated) { anything = true; emit.emit(`rotated oversized event log to ${rotated}`, { step: 'worktree' }); }
    }
    const streamPaths = [
      ...planStreamSweep(cfg.ship.stateDir, cfg.ship.streamRetentionDays),
      ...planEventsSweep(cfg.ship.stateDir, cfg.ship.streamRetentionDays),
    ];
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
    if (!n) { die('crew drop', 'need a ticket number (326, ISSUE-326, or TABL-326)', '`crew drop 326`'); }
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
      die('crew drop', `no worktree for ISSUE-${n} in any of this route's repositories (looked in: ${repos.map((r) => r.dir).join(', ')})`, '`git worktree list` in the repository');
    }
    if (candidates.length > 1) {
      die('crew drop', `ISSUE-${n} has a worktree in more than one repository (${candidates.map((c) => c.repo.name).join(', ')})`, 'remove them one at a time by path');
    }
    const { repo: target, found } = candidates[0]!;
    const wt = found.path;
    // EPIC-077: a draft ticket's worktree is a periscope's, which holds a viewer's
    // edits. Checked against the tracker, but an unreachable one does not stop
    // `drop` (it stays usable offline, see above).
    try {
      const trD = new Tracker(route, cfg.ship);
      const tD = (await trD.ticketsByNumbers([n])).find((t) => t.issue_id.replace(/^\D+/, '') === String(num));
      if (tD && tD[trD.contract.columns.status] === trD.contract.statuses.draft) {
        die('crew drop', `${tD.issue_tag ?? tD.issue_id} is a draft ticket — its worktree belongs to a periscope`, `\`crew periscope down ${num} --keep\` or \`--discard\``);
      }
    } catch { /* tracker unreachable: fall through to the plain drop */ }
    // The branch actually checked out in the worktree we just found — not
    // re-derived from today's template, which may not be what created it
    // (ISSUE-969: the default template itself changed under some tickets).
    const branch = found.branch ?? branchForIssue(target.dir, `ISSUE-${n}`, {
      name: target.config.branch.name, push: target.config.branch.push,
    }, (t) => renderBranchName(t, { key: `ISSUE-${n}`, lowercase: target.config.branch.lowercase }));
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
      die('crew rotate-passenger-url', `route "${route.route}" does not have hostPassengers enabled`, `set hostPassengers on the route in ${cfg.configFile}`);
    }
    if (!cfg.ship.relayHost) {
      die('crew rotate-passenger-url', 'this ship has no relayHost configured — nothing to rotate', `set ship.relayHost in ${cfg.configFile}`);
    }
    const workspaceId = route.resolved?.workspaceId;
    if (!workspaceId) {
      die('crew rotate-passenger-url', `route "${route.route}" has no resolved ids`, '`crew connect`');
    }
    const plans = planContainers(cfg).filter((p) => p.workspaceId === workspaceId);
    if (!plans.length) {
      die('crew rotate-passenger-url', `no Host Passengers container is planned for "${route.route}" right now`, '`crew doctor`');
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
      controlSocket: controlSocketFor(cfg.ship.stateDir),
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
    const rawWt = worktreeArgs?.ticket;
    const nWt = rawWt ? parseTicketNumber(rawWt) : null;
    if (!nWt) { die('crew worktree', 'need a ticket number (326, ISSUE-326, or TABL-326)', '`crew worktree 326`'); }
    // No route typed on a multi-route ship: look the ticket up on each enabled
    // route and take the one that has it AND serves its repo (CREW-1551).
    const candidatesWt = !named && cfg.routes.length > 1 ? cfg.routes.filter((r) => r.enabled) : [route];
    let ticketWt: Awaited<ReturnType<Tracker['openTickets']>>[number] | undefined;
    const lookedWt: { route: string; hit?: { repoId: string | null }; servedRepoIds: string[] }[] = [];
    const hitsWt = new Map<string, NonNullable<typeof ticketWt>>();
    for (const cand of candidatesWt) {
      const tr = new Tracker(cand, cfg.ship);
      // A periscope's ticket is a draft (EPIC-077), which `openTickets` leaves out
      // on purpose; look it up by number so its worktree is recognized here too.
      const hit = (await tr.openTickets()).find((t) => t[tr.contract.columns.key] === `ISSUE-${nWt}`)
        ?? (await tr.ticketsByNumbers([nWt])).find((t) => t[tr.contract.columns.key] === `ISSUE-${nWt}` && t[tr.contract.columns.status] === tr.contract.statuses.draft);
      if (hit) hitsWt.set(cand.route, hit);
      lookedWt.push({
        route: cand.route,
        hit: hit ? { repoId: (hit.repo_id as string | null | undefined) ?? null } : undefined,
        servedRepoIds: hit ? (await resolvedRepos(cand)).flatMap((r) => (r.id ? [r.id] : [])) : [],
      });
    }
    const pickedWt = pickWorktreeRoute(Number(nWt), lookedWt);
    if ('error' in pickedWt) { die('crew worktree', pickedWt.error, '`crew doctor`'); }
    const routeWt = candidatesWt.find((r) => r.route === pickedWt.route) ?? route;
    ticketWt = hitsWt.get(pickedWt.route);
    if (!ticketWt) process.exit(2);
    const repoWt = (await resolvedRepos(routeWt)).find((r) => r.id === ticketWt.repo_id) ?? (await resolvedRepos(routeWt))[0];
    if (!repoWt) { die('crew worktree', 'this route has no repository', '`crew repos add`'); }
    const roleWt = positional.find((p) => p === 'dev' || p === 'design' || p === 'qa');
    // CREW-1775: uncommitted changes in this ticket's worktree are not a
    // stranger's when the runner itself recorded that a run on this seat was
    // cut short there and nothing has been pushed since.
    let resumeWt = false;
    try {
      const trWt = new Tracker(routeWt, cfg.ship);
      const heldWt = Object.values(routeWt.resolved?.seats ?? {}).includes(ticketWt[trWt.contract.columns.assignee] as string);
      if (heldWt) {
        const cut = await trWt.latestEvent(ticketWt.id, 'interrupted');
        const pushed = await trWt.latestEvent(ticketWt.id, 'pushed');
        const at = (e?: { occurred_at?: string | null; created_at?: string | null }) => e?.occurred_at ?? e?.created_at ?? '';
        resumeWt = cut !== undefined && at(cut) > at(pushed);
      }
    } catch { /* the event log being unreadable leaves the plan as cautious as before */ }
    const planWt = planRunWorktree(repoWt.dir, repoWt.config, ticketWt, roleWt, { resumeInterrupted: resumeWt });
    if (dryRun) { emit.emit(`would ${describeRunWorktreePlan(planWt)}`); break; }
    const pathWt = applyRunWorktree(repoWt.dir, repoWt.config, planWt);
    // CREW-3266: the path on stdout is the result; the plan is only worth a line when it cannot be used.
    if (planIsUsable(planWt)) emit.note(describeRunWorktreePlan(planWt));
    else emit.warn(describeRunWorktreePlan(planWt));
    // CREW-2912: start the repository's symbol service and hand its URL to the session's `code` bridge.
    // The path stays alone on stdout (callers `cd "$(crew worktree N)"`), so the paragraph goes to the log.
    if (pathWt && planIsUsable(planWt) && wantsCodeBridge(repoWt.config.hooks.intel)) {
      const shellWt = resolveShell(repoWt.config.shell ?? cfg.ship.shell);
      const paragraph = await startWorktreeIntel({
        worktree: pathWt, route: routeWt.route, number: String(nWt), stateDir: cfg.ship.stateDir,
        ticketTag: String(ticketWt.issue_tag ?? ticketWt.issue_id ?? `ISSUE-${nWt}`),
        branch: planWt.branch ?? '', startupSeconds: cfg.ship.intelStartupSeconds,
        prepare: async (path) => {
          for (const f of repoWt.config.worktrees.copy) {
            const src = join(repoWt.dir, f);
            if (!existsSync(src) || existsSync(join(path, f))) continue;
            mkdirSync(dirOf(join(path, f)), { recursive: true });
            copyFileSync(src, join(path, f));
          }
          const setup = repoWt.config.hooks.setup;
          return setup ? runScript(setup, { cwd: path, shell: shellWt }) : null;
        },
        runHook: async (name, cwd, env) => {
          const script = repoWt.config.hooks[name];
          // CREW-2921: the `serena` flavor is crew's own managed service (CREW-2914), not a command to run.
          if (name === 'intel' && intelFlavor(script) === 'serena') {
            return startSerena(realSerenaDeps((bin) => !!findOnPath(bin, pathFor(cfg.ship)), { ...process.env, PATH: pathFor(cfg.ship) }), {
              stateDir: cfg.ship.stateDir, route: routeWt.route, ticket: Number(nWt),
              worktree: cwd, mainCheckout: repoWt.dir,
            });
          }
          return script ? runScript(script, { cwd, env, shell: shellWt, timeoutMs: name === 'intel' ? 60_000 : undefined }) : null;
        },
      });
      emit.note(paragraph);
    }
    if (pathWt) process.stdout.write(`${pathWt}\n`);
    if (!planIsUsable(planWt)) process.exitCode = 1;
    break;
  }

  case 'periscope': {
    // EPIC-077 / CREW-2854: `crew periscope up [route] REPO --topic TEXT`. The
    // ordering, refusals and tear-down live in periscope-cmd.ts; this only
    // supplies the real git, shell and tracker.
    const subP = positional[1];
    if (subP !== 'up' && subP !== 'start' && subP !== 'down' && subP !== 'end' && subP !== 'list') {
      process.stderr.write('crew periscope up [[route] REPO] [--topic TEXT|--issue NNN] [--isolate] [--host H] [--no-relay] [--assignee ID] [--no-open] [--open] [--dry-run] [--json]\n');
      process.stderr.write('crew periscope down [[route] NNN] --keep|--discard [--allow-empty] [--json]\n');
      process.stderr.write('crew periscope list [route] [--json]\n');
      process.exit(2);
    }
    const jsonP = flag('json');
    const say = (event: string, message: string, data: Record<string, unknown> = {}) =>
      process.stderr.write(jsonP ? `${JSON.stringify({ ...data, event, message })}\n` : `${message}\n`);
    if (subP === 'down' || subP === 'end' || subP === 'list') {
      // CREW-2855: ending a periscope and listing the live ones. The decisions
      // live in periscope-cmd.ts; this supplies the real git, ports and tracker.
      try {
        const downArgs = subP === 'list' ? undefined
          : parsePeriscopeDownArgs(positional, { keep: flag('keep'), discard: flag('discard'), allowEmpty: flag('allow-empty'), json: jsonP });
        const routeName = subP === 'list' ? (positional[2] as string | undefined) : downArgs!.route;
        const routesP = (routeName ? [findRoute(cfg, routeName)] : cfg.routes.filter((r) => r.enabled))
          .filter((r) => r.resolved?.periscopesModelId);
        if (routesP.length === 0) throw new PeriscopeError('no connected route has a Periscopes table');
        // Every row of this ship on the candidate routes, joined to its ticket and repository.
        const gather = async (rt: typeof route): Promise<PeriscopeRowInfo[]> => {
          const tr = new Tracker(rt, cfg.ship);
          const repos = await resolvedRepos(rt);
          return (await tr.periscopeRows()).map(({ row, ticket }) => {
            const repo = repos.find((r) => r.id && r.id === ticket[tr.contract.columns.repo]) ?? (repos.length === 1 ? repos[0] : undefined);
            const str = (v: unknown) => (typeof v === 'string' ? v : '');
            return {
              id: row.id, ticketRecordId: ticket.id, ticket: ticket.issue_tag ?? ticket.issue_id,
              number: /(\d+)$/.exec(ticket.issue_id)?.[1] ?? '', repo: repo?.name ?? '?',
              state: str(row.state), url: str(row.url), worktree: str(row.worktree), branch: str(row.branch),
              lastActivityAt: str(row.last_activity_at) || null,
              localUrl: readSidecars(cfg.ship.stateDir).find((x) => x.ticketRecordId === ticket.id)?.localUrl,
            };
          });
        };
        if (subP === 'list') {
          const listRows = (await Promise.all(routesP.map(gather))).flat().map((r) => ({ ...r, pointedAt: readPointedAt(r.worktree) }));
          // Same port probe as `crew status`, so the two commands cannot disagree.
          const serving = new Map(await Promise.all(listRows.map(async (r) => {
            const port = urlPort(r.localUrl ?? r.url);
            return [r.id, port === undefined ? false : await portListening(port)] as const;
          })));
          const entries = periscopeListEntries(listRows, new Date(), (r) => serving.get(r.id) ?? false);
          process.stdout.write(jsonP ? `${JSON.stringify(entries)}\n` : `${formatPeriscopeList(entries)}\n`);
          break;
        }
        const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
        const gathered = await Promise.all(routesP.map(async (rt) => ({ rt, rows: await gather(rt) })));
        // No ticket number: the periscope whose worktree holds the working directory.
        const number = downArgs!.number ?? (() => {
          const here = real(process.cwd());
          for (const g of gathered) {
            const hit = rowForCwd(g.rows.map((r) => ({ ...r, worktree: real(r.worktree) })), here);
            if (hit) return hit.number;
          }
          throw new PeriscopeError('not inside a periscope worktree — name the ticket: crew periscope down NNN --keep|--discard');
        })();
        const a = { ...downArgs!, number };
        const hits: { rt: typeof route; rows: PeriscopeRowInfo[] }[] = [];
        for (const g of gathered) {
          const rows = g.rows.filter((r) => r.number === a.number);
          if (rows.length) hits.push({ rt: g.rt, rows });
        }
        if (hits.length !== 1) {
          throw new PeriscopeError(hits.length === 0
            ? `no periscope for ticket ${a.number} on this ship`
            : `ticket ${a.number} has periscopes on more than one route (${hits.map((h) => h.rt.route).join(', ')}) — name the route`);
        }
        const { rt: routeD, rows: rowsD } = hits[0]!;
        const trD = new Tracker(routeD, cfg.ship);
        const cD = trD.contract;
        const reposD = await resolvedRepos(routeD);
        const repoD = reposD.find((r) => r.name === rowsD[0]!.repo);
        if (!repoD) throw new PeriscopeError(`cannot tell which repository ${rowsD[0]!.ticket} belongs to`);
        const { remote, base } = repoD.config.branch;
        const memberD = routeD.resolved!.seats.pair ?? routeD.resolved!.operator;
        const closedD = cD.statuses.resolved.includes('closed_obsolete') ? 'closed_obsolete' : cD.statuses.wontFix;
        const depsD: PeriscopeDownDeps = {
          rowsForTicket: async () => rowsD,
          hasChanges: (wt) => gitWorkingTreeStatus(wt).length > 0,
          commitAll: (wt, msg) => { git(wt, ['add', '-A']); git(wt, ['commit', '-m', msg]); },
          push: (wt, branch) => { pushBranchUpstream(wt, remote, branch); return { sha: headSha(wt), remote }; },
          changedFiles: (wt) => {
            const out = gitOk(wt, ['diff', '--numstat', `${remote}/${base}...HEAD`]) ?? '';
            return out.split('\n').filter(Boolean).map((l) => {
              const [add, rem, ...p] = l.split('\t');
              return { path: p.join('\t'), added: Number(add) || 0, removed: Number(rem) || 0 };
            });
          },
          readTicket: async (id) => {
            const t = await trD.ticket(id);
            return { description: String(t.description ?? ''), hasProject: !!t[cD.columns.slice], hasRepo: !!t[cD.columns.repo], isDraft: t.status === cD.statuses.draft };
          },
          priorHold: (id) => readPeriscopePrior(cfg.ship.stateDir, id),
          remoteHasBranch: (_wt, branch) => remoteBranchExists(repoD.dir, remote, branch),
          updateTicket: async (id, p) => {
            const patch: Record<string, unknown> = {};
            if (p.status === 'released') {
              // An `--issue` periscope: give the hold back, leave the status.
              patch[cD.columns.assignee] = null;
              if ((await trD.authorshipProbe()).issueHeld) patch[cD.columns.heldBy] = null;
              if (p.description !== undefined) patch.description = p.description;
            } else if (p.status === 'new') {
              patch[cD.columns.status] = 'new';
              patch[cD.columns.assignee] = null;
              if (p.description !== undefined) patch.description = p.description;
              if (p.fillProjectAndRepo) {
                if (routeD.resolved!.areaId) patch[cD.columns.slice] = routeD.resolved!.areaId;
                if (repoD.id) patch[cD.columns.repo] = repoD.id;
              }
            } else {
              patch[cD.columns.status] = closedD;
              patch[cD.columns.resolutionNote] = p.note;
            }
            await trD.updateTicket(id, patch);
          },
          postPushed: (id, sha, rem, branch) => trD.postEvent(id, pushedEventBody(sha, rem, branch), memberD, 'pushed'),
          stopTunnel: (id) => {
            const sc = readSidecars(cfg.ship.stateDir).find((x) => x.ticketRecordId === id);
            return sc && stopRecordedTunnel(sc) ? 1 : 0;
          },
          stopServer: async (wt, n) => {
            const pids = pidsInWorktree(wt, Number(n));
            if (pids.length) await killGently(pids);
            return pids.length;
          },
          removeWorktree: (wt, branch, deleteBranch) => {
            gitOk(repoD.dir, ['worktree', 'remove', '--force', wt]);
            if (deleteBranch) gitOk(repoD.dir, ['branch', '-D', branch]);
          },
          dropIntel: (n) => { try { dropSerenaFolder(cfg.ship.stateDir, routeD.route, n); } catch { /* best effort; the folder is state, not the worktree */ } },
          setRowState: (id, state) => trD.updatePeriscope(id, { state }),
          forgetLocal: (id) => { removePeriscopeSecret(cfg.ship.stateDir, id); removePeriscopeSidecar(cfg.ship.stateDir, id); removePeriscopePrior(cfg.ship.stateDir, id); },
          say,
        };
        if (dryRun) {
          say('dry-run', `would end the periscope for ${rowsD[0]!.ticket} (${a.mode})`);
          break;
        }
        // `down` may be run from inside the worktree it removes; leave it for the
        // checkout first so no later step runs from a directory that is gone.
        process.chdir(repoD.dir);
        const res = await runPeriscopeDown(depsD, a);
        if (jsonP) process.stdout.write(`${JSON.stringify({ event: 'done', ...res })}\n`);
        else process.stdout.write(`${res.ticket} ${res.state}\n`);
      } catch (e) {
        if (e instanceof PeriscopeError || e instanceof ConfigError) {
          die('crew periscope', e.message, '`crew doctor`', 1);
        }
        throw e;
      }
      break;
    }
    try {
      // CREW-2856: `up --resume NNN` restarts the preview of an idle periscope.
      const resumeRaw = value('resume');
      if (resumeRaw !== undefined) {
        const nR = parseTicketNumber(resumeRaw);
        if (!nR) throw new PeriscopeError('--resume needs a ticket number (326, ISSUE-326, or CREW-326)');
        let hit: { route: typeof route; tracker: Tracker; row: Awaited<ReturnType<Tracker['liveShipPeriscopes']>>[number]; tag: string; repo: Awaited<ReturnType<typeof resolvedRepos>>[number] } | undefined;
        for (const cand of cfg.routes.filter((r) => r.enabled && r.resolved?.periscopesModelId)) {
          const tr = new Tracker(cand, cfg.ship);
          for (const row of await tr.liveShipPeriscopes()) {
            const t = await tr.ticket(row.issue_id);
            if (t.issue_id.replace(/^\D+/, '') !== String(Number(nR))) continue;
            const repo = (await resolvedRepos(cand)).find((r) => r.id === t.repo_id);
            if (!repo) throw new PeriscopeError(`route ${cand.route} has no checkout for the repository of ${t.issue_tag ?? t.issue_id}`);
            hit = { route: cand, tracker: tr, row, tag: t.issue_tag ?? t.issue_id, repo };
          }
        }
        if (dryRun) { say('dry-run', hit ? `would rerun ports${hit.row.isolated ? ', isolate' : ''} and preview in ${hit.row.worktree} and refresh the row` : `no live periscope for ISSUE-${nR} on this ship`); break; }
        const shellR = hit && resolveShell(hit.repo.config.shell ?? cfg.ship.shell);
        const resumed = await runPeriscopeResume({
          find: async () => hit && { row: hit.row, tag: hit.tag },
          worktreeExists: (p) => existsSync(p),
          prepareDropFile,
          startProxy: (wt, url, n) => launchProxy(crewInvocation(CREW_HOME), wt, url, Number(n), { host: hit!.row.host || 'localhost', inject: hit!.repo.config.periscope?.inspector !== 'repo' }),
          relay: hit && previewRelayFor(hit.route) && {
            ...previewRelayFor(hit.route)!,
            slugFor: (id) => readSidecars(cfg.ship.stateDir).find((x) => x.ticketRecordId === id)?.slug,
            record: (id, patch) => { updatePeriscopeSidecar(cfg.ship.stateDir, id, patch); },
          },
          caps: periscopeCaps(cfg.ship as typeof cfg.ship & PeriscopeLimits),
          runHook: async (name, cwd, env) => {
            const script = hit?.repo.config.hooks[name];
            return script ? runScript(script, { cwd, env, shell: shellR!, timeoutMs: name === 'preview' ? 180_000 : undefined }) : null;
          },
          update: (id, fields) => hit!.tracker.updatePeriscope(id, fields),
          clearItem: (tag) => clearShipAttention(state, periscopeIdleKey(tag)),
          now: () => new Date(),
          say,
        }, String(Number(nR)));
        if (jsonP) process.stdout.write(`${JSON.stringify({ event: 'done', ...resumed })}\n`);
        else process.stdout.write(`${resumed.ticket}\n${resumed.worktree}\n${resumed.url}\n`);
        break;
      }
      const parsedUp = parsePeriscopeUpArgs(positional, { topic: value('topic'), issue: value('issue'), host: value('host'), assignee: value('assignee'), requestedBy: value('requested-by'), isolate: flag('isolate'), json: jsonP, noRelay: flag('no-relay') });
      // CREW-2866: with no REPO, the working directory (a checkout, or a worktree of one) names the route and repository.
      let a: PeriscopeUpArgs;
      if (parsedUp.repo !== undefined) a = { ...parsedUp, repo: parsedUp.repo };
      else {
        const here = locateDir(cfg, process.cwd(), (d) => gitOk(d, ['rev-parse', '--path-format=absolute', '--git-common-dir']) ?? undefined);
        if (!here) {
          const where = cfg.routes.flatMap((r) => reposOf(r).map((x) => `  ${x.name}: ${x.dir}`));
          throw new PeriscopeError(`run it from inside a configured checkout, or name the repository (crew periscope up REPO). Configured checkouts:\n${where.join('\n')}`);
        }
        a = { ...parsedUp, repo: here.repo.name, route: parsedUp.route ?? here.route.route };
      }
      const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY && !jsonP;
      // The route is the one named, else the one whose checkout serves REPO.
      const candidatesP = a.route ? [findRoute(cfg, a.route)] : cfg.routes.filter((r) => r.enabled);
      const servedP: { route: typeof route; repo: Awaited<ReturnType<typeof resolvedRepos>>[number] }[] = [];
      for (const cand of candidatesP) {
        const hit = (await resolvedRepos(cand)).find((r) => r.name === a.repo);
        if (hit) servedP.push({ route: cand, repo: hit });
      }
      if (servedP.length !== 1) {
        throw new PeriscopeError(servedP.length === 0
          ? `no route serves a repository named "${a.repo}"`
          : `"${a.repo}" is served by more than one route (${servedP.map((x) => x.route.route).join(', ')}) — name the route`);
      }
      const { route: routeP, repo: repoP } = servedP[0]!;
      if (!routeP.resolved) throw new PeriscopeError(`route ${routeP.route} is not connected — run \`crew connect\` first`);
      const trackerP = new Tracker(routeP, cfg.ship);
      const cP = trackerP.contract;
      const periscopes = await trackerP.periscopesStatus();
      const caps = periscopeCaps(cfg.ship as typeof cfg.ship & PeriscopeLimits);
      const shellP = resolveShell(repoP.config.shell ?? cfg.ship.shell);
      const pairId = a.assignee ?? routeP.resolved.seats.pair;
      if (!pairId) throw new PeriscopeError(`route ${routeP.route} has no Pair seat — pass --assignee CREW_ROW_ID`);
      const crewP = await trackerP.crewRows();
      const operatorName = crewP.find((r) => r.id === routeP.resolved!.operator)?.name ?? 'Pair';
      const memberId = routeP.resolved.seats.pair ?? routeP.resolved.operator;
      const deps: PeriscopeDeps = {
        previewHook: repoP.config.hooks.preview,
        hasPeriscopesTable: periscopes.present,
        liveCount: () => trackerP.livePeriscopeCount(),
        caps,
        baseProblem: () => { const h = baseHealth(repoP); return h.unsafe ? h.detail : undefined; },
        askTopic: async () => {
          if (!terminal) return undefined;
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = (await rl.question(`Periscope topic for ${a.repo} (blank for "${defaultTopic(a.repo, new Date())}"): `)).trim();
            return answer || undefined;
          } finally { rl.close(); }
        },
        fileDraft: async (title) => {
          const t = await trackerP.fileTicket({
            title,
            description: `A periscope: a throwaway preview of ${a.repo} for a viewer, opened by \`crew periscope up\`.`,
            report_type: 'feature',
            reporter_name: a.requestedBy ?? operatorName,
            [cP.columns.status]: cP.statuses.draft,
            [cP.columns.assignee]: pairId,
            ...(routeP.resolved!.areaId ? { [cP.columns.slice]: routeP.resolved!.areaId } : {}),
            ...(repoP.id ? { [cP.columns.repo]: repoP.id } : {}),
          }, memberId);
          return { id: t.id, tag: t.issue_tag ?? t.issue_id, issueId: t.issue_id, prefix: t.project_issue_prefix };
        },
        cutWorktree: (draft) => {
          // The fresh ticket has no branch anywhere, so this is always a cut from the remote base.
          const plan = planRunWorktree(repoP.dir, repoP.config, { issue_id: draft.issueId, issue_tag: draft.tag, project_issue_prefix: draft.prefix }, undefined);
          if (!planIsUsable(plan)) throw new PeriscopeError(`cannot use the worktree: ${describeRunWorktreePlan(plan)}`);
          const path = applyRunWorktree(repoP.dir, repoP.config, plan);
          if (!path) throw new PeriscopeError('the worktree could not be cut');
          return { path, branch: plan.branch ?? '' };
        },
        prepare: async (path) => {
          for (const f of repoP.config.worktrees.copy) {
            const src = join(repoP.dir, f);
            if (!existsSync(src)) continue;
            mkdirSync(dirOf(join(path, f)), { recursive: true });
            copyFileSync(src, join(path, f));
          }
          const setup = repoP.config.hooks.setup;
          return setup ? runScript(setup, { cwd: path, shell: shellP, onLine: (l) => { if (l.trim()) say('setup', l.trim()); } }) : null;
        },
        runHook: async (name, cwd, env) => {
          const script = repoP.config.hooks[name];
          if (name === 'intel' && intelFlavor(script) === 'serena') {
            return startSerena(realSerenaDeps((bin) => !!findOnPath(bin, pathFor(cfg.ship)), { ...process.env, PATH: pathFor(cfg.ship) }), {
              stateDir: cfg.ship.stateDir, route: routeP.route, ticket: Number(/(\d+)$/.exec(env.CREW_TICKET ?? '')?.[1] ?? 0),
              worktree: cwd, mainCheckout: repoP.dir,
              languageServers: process.env.CREW_SERENA_LANGUAGE_SERVERS,
            });
          }
          if (name === 'intel' && lspFlavor(script)) return null;
          return script ? runScript(script, { cwd, env, shell: shellP, timeoutMs: name === 'preview' ? 180_000 : name === 'intel' ? 60_000 : undefined }) : null;
        },
        createRow: (fields) => trackerP.createPeriscope(fields),
        prepareDropFile,
        startProxy: (wt, url, n) => launchProxy(crewInvocation(CREW_HOME), wt, url, Number(n), { host: a.host ?? 'localhost', inject: repoP.config.periscope?.inspector !== 'repo' }),
        relay: previewRelayFor(routeP),
        registerCode: registerCodeServer,
        recordLocal: (sc) => {
          writePeriscopeSidecar(cfg.ship.stateDir, { ...sc, route: routeP.route });
          // CREW-2862: the daemon serves an MCP endpoint for this worktree only when asked (the control API asks).
          if (flag('serve-mcp')) mintPeriscopeSecret(cfg.ship.stateDir, sc.ticketRecordId);
        },
        comment: (ticketId, body) => trackerP.postComment(ticketId, body, memberId),
        teardown: async (path, branch) => {
          const n = Number(path.match(/(\d+)\/?$/)?.[1]);
          if (Number.isFinite(n)) await killGently(pidsInWorktree(path, n));
          gitOk(repoP.dir, ['worktree', 'remove', '--force', path]);
          gitOk(repoP.dir, ['branch', '-D', branch]);
        },
        closeDraft: async (ticketId, note) => {
          const closed = cP.statuses.resolved.includes('closed_obsolete') ? 'closed_obsolete' : cP.statuses.wontFix;
          await trackerP.updateTicket(ticketId, { [cP.columns.status]: closed, [cP.columns.resolutionNote]: note });
        },
        existing: {
          load: async (number) => {
            const t = (await trackerP.ticketsByNumbers([number])).find((x) => String(x[cP.columns.key]).replace(/^\D+/, '').replace(/^0+(?=\d)/, '') === number);
            if (!t) return undefined;
            return {
              id: t.id, tag: t.issue_tag ?? t.issue_id, issueId: t.issue_id, prefix: t.project_issue_prefix,
              status: t.status,
              closed: cP.statuses.resolved.includes(t.status) || t.status === cP.statuses.wontFix,
              repoId: (t[cP.columns.repo] as string | null | undefined) ?? null,
              assignee: (t[cP.columns.assignee] as string | null | undefined) ?? null,
              heldByShipId: (t[cP.columns.heldBy] as string | null | undefined) ?? null,
            };
          },
          repoId: repoP.id ?? null,
          repoName: a.repo,
          pairId,
          shipId: (await trackerP.authorshipProbe()).shipId,
          agentHolder: async (assigneeId) => {
            const row = crewP.find((r) => r.id === assigneeId);
            return row?.agent_id ? (row.name ?? assigneeId) : undefined;
          },
          liveRows: async (ticketRecordId) => {
            const [rows, ships] = [await trackerP.livePeriscopesForTicket(ticketRecordId), await trackerP.shipRows()];
            return rows.map((r) => ({ ship: ships.find((x) => x.id === r.ship_id)?.name ?? r.ship_id ?? 'an unknown ship', url: r.url ?? '', worktree: r.worktree }));
          },
          hasLiveRun: (ticketRecordId) => liveRuns(cfg.ship.stateDir).some((r) => r.ticketRecordId === ticketRecordId),
          hold: async (id) => {
            const auth = await trackerP.authorshipProbe();
            await trackerP.updateTicket(id, {
              [cP.columns.assignee]: pairId,
              ...(auth.issueHeld && auth.shipId ? { [cP.columns.heldBy]: auth.shipId } : {}),
            });
          },
          restore: async (id, assignee) => {
            const auth = await trackerP.authorshipProbe();
            await trackerP.updateTicket(id, { [cP.columns.assignee]: assignee, ...(auth.issueHeld ? { [cP.columns.heldBy]: null } : {}) });
          },
          remember: (id, prior) => writePeriscopePrior(cfg.ship.stateDir, id, prior),
        },
        now: () => new Date(),
        host: a.host ?? 'localhost',
        intelStartupSeconds: cfg.ship.intelStartupSeconds,
        lspPluginDir: lspFlavor(repoP.config.hooks.intel) ? ensureLspPlugin(cfg.ship.stateDir, lspFlavor(repoP.config.hooks.intel)!, repoP.dir) : undefined,
        say,
      };
      if (dryRun) {
        await periscopePreflight(deps, a.repo);
        if (a.issue) {
          const t = await deps.existing!.load(a.issue);
          if (!t) throw new PeriscopeError(`no ticket numbered ${a.issue} on this route`);
          await assertNoLivePeriscope(deps.existing!, t, a.issue);
          const refused = await existingRefusal(deps.existing!, t);
          if (refused) throw new PeriscopeError(refused);
          say('dry-run', `would hold ${t.tag} (status ${t.status} stays) for ${pairId}, cut or reuse its worktree for ${a.repo}, run setup${a.isolate ? ', isolate' : ''}, ports, handoff and preview on ${deps.host}, and record a Periscopes row`);
          break;
        }
        say('dry-run', `would file "Periscope: ${a.topic ?? defaultTopic(a.repo, new Date())}" as ${cP.statuses.draft} for ${pairId}, cut a worktree for ${a.repo}, run setup${a.isolate ? ', isolate' : ''}, ports, handoff and preview on ${deps.host}, and record a Periscopes row (expires after ${caps.idleMinutes} minutes idle)`);
        break;
      }
      const res = await runPeriscopeUp(deps, a);
      if (jsonP) process.stdout.write(`${JSON.stringify({ event: 'done', ...res })}\n`);
      else {
        process.stdout.write(upOutput(res, terminal));
        const opener = openerFor(process.platform);
        if (opener && shouldOpen({ open: flag('open'), noOpen: flag('no-open'), json: jsonP, terminal })) {
          const r = spawnSync(opener, [res.url], { stdio: 'ignore' });
          if (r.error || r.status !== 0) emit.warn(withFix(`crew periscope: could not open ${res.url} with ${opener}`, `open ${res.url} yourself`));
        }
      }
    } catch (e) {
      if (e instanceof PeriscopeError || e instanceof ConfigError) {
        emit.error(withFix(`crew periscope: ${e.message}`, '`crew periscope list`'));
        if (e instanceof LivePeriscopeError && jsonP) process.stdout.write(`${JSON.stringify(e.data)}\n`);
        process.exit(1);
      }
      throw e;
    }
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
    if (!n) { die('crew unassign', 'need a ticket number (326, ISSUE-326, or TABL-326)', '`crew unassign 326`'); }
    const tracker3 = new Tracker(route, cfg.ship);
    const c = tracker3.contract;
    const key = `ISSUE-${n}`;
    const open = await tracker3.openTickets();
    const ticket = open.find((t) => t[c.columns.key] === key);
    if (!ticket) {
      die('crew unassign', `no open ticket ${key} on ${route.route} (already resolved, or not this route's)`, '`crew inbox` to list open tickets');
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
        die('crew unassign', `${label} changed on the board since it was read`, `\`crew unassign ${key}\` again`);
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
    // CREW-3266: a series of fast-forwards and stale entries is one summary line, not one line each (--verbose lists them).
    let fastForwarded = 0;
    const prunable: string[] = [];
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
        if (w.prunable) { emit.note(`${w.branch}: worktree at ${w.path} no longer exists — skipping`); prunable.push(r.dir); continue; }
        let s2: SyncState;
        try {
          s2 = syncState(w.path, w.branch);
        } catch (e) {
          emit.warn(`${w.branch}: could not check sync state — ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (!s2.upstream) continue;
        // CREW-2528: a ticket branch whose upstream is the base (cut before
        // --no-track) must not be fast-forwarded onto it; only the base
        // branch itself follows `<remote>/<base>`.
        if (w.branch !== r.config.branch.base && s2.upstream === `${r.config.branch.remote}/${r.config.branch.base}`) continue;
        tracked++;
        if (s2.canFastForward) {
          acted++;
          if (dryRun) { emit.note(`would fast-forward ${w.branch}: ${s2.detail}`); fastForwarded++; }
          else if (fastForward(w.path, w.branch)) { emit.note(`fast-forwarded ${w.branch}`); fastForwarded++; }
          else emit.warn(`could not fast-forward ${w.branch}`);
        } else if (s2.behind > 0 || s2.ahead > 0) {
          acted++;
          emit.warn(`${w.branch}: ${s2.detail}`);
        }
      }
    }
    // Silence would read as "checked and fine"; say which it was.
    if (baseUnsafe > 0) process.exitCode = 1;
    if (baseChecked > 0 && baseActed === 0) emit.note(`${baseChecked} base branch(es) checked, all level with the remote`);
    if (prunable.length > 0) {
      emit.warn(`${prunable.length} worktree(s) no longer exist on disk and were skipped — run \`git worktree prune\` in ${[...new Set(prunable)].join(', ')} to clear them`);
    }
    if (tracked === 0) emit.emit('no worktree tracks a remote branch — nothing to sync');
    else if (fastForwarded > 0) emit.emit(`${dryRun ? 'would fast-forward' : 'fast-forwarded'} ${fastForwarded} of ${tracked} worktree(s)${acted > fastForwarded ? `; ${acted - fastForwarded} need attention` : ''}`);
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

  case 'deprovision':
  case 'disconnect': {
    // CREW-2882: `deprovision` is `disconnect --reset --remove-checkouts` plus the pooled-host wipe (deprovision.ts).
    const deprovisioning = command === 'deprovision';
    // CREW-1517: the inverse of `connect`'s harness installs — removes the Tablation
    // MCP server from Claude Code and Pair's block and MCP entry from every other
    // harness `ship.pair` lists. crew.yaml and the tracker are left alone.
    const url = mcpUrlFor(value('base-url') ?? cfg.routes[0]?.baseUrl ?? DEFAULT_BASE_URL);
    // A configured toolchain's harness counts too: `connect` registers its MCP
    // entry whether or not `ship.pair` lists it (CREW-1520).
    const disconnectHarnesses = new Set([...shipPair(cfg.ship), ...shipToolchains(cfg.ship).map((t) => t.harness).filter(isPairHarness)]);
    const removePairEntries = (mcpUrl: string, dry: boolean): string[] =>
      [...disconnectHarnesses].map((h) => pairInstallerFor(h).removePair({ url: mcpUrl, bin: cfg.ship.agent.bin, dryRun: dry }));
    // CREW-2803: this ship stops advertising a relay URL. Best effort per route: a
    // workspace that is unreachable or has no Ships row just keeps what it had.
    if (!dryRun) {
      for (const r of cfg.routes.filter((x) => x.resolved?.shipsModelId)) {
        await new Tracker(r, cfg.ship).updateRelayUrl(cfg.ship.name, null)
          .catch((e: Error) => { emit.warn(withFix(`could not clear relay_url for ${r.route}: ${e.message}`, '`crew doctor`')); });
      }
    }
    if (!flag('reset') && !deprovisioning) {
      for (const line of removePairEntries(url, dryRun)) emit.note(line);
      break;
    }
    // CREW-2243: the whole-machine inverse of connect + install. See reset.ts
    // for the fixed order and why crew.yaml goes last.
    const host = hostPlatform();
    let resetStore: SessionStore | undefined;
    try { resetStore = getSessionStore(); } catch { resetStore = undefined; }
    const effects: ResetEffects = {
      async uninstallUnits(dry) {
        const lines: string[] = [];
        if (host === 'windows') return lines;
        const log = { emit: (m: string) => { lines.push(m); }, warn: (m: string) => { lines.push(m); } };
        for (const job of ['run', 'release', 'passengers'] as const) {
          await applyUninstall(planUninstall(cfg.ship, CREW_HOME, host, detectSystemd(), job), CREW_HOME, dry, log);
        }
        return lines;
      },
      removePair: removePairEntries,
      async revokeSeatKeys(r, dry) {
        const outcomes = await revokeSeatKeys(r, { userAgent: cfg.ship.userAgent, dryRun: dry, shipName: cfg.ship.name });
        return outcomes.map((o) => ({ line: describeRevokeOutcome(o), ok: o.action !== 'failed' }));
      },
      async credential(r) {
        if (!resetStore) return { stored: false, clear: async () => {} };
        const store = resetStore;
        const h = hostFromUrl(r.baseUrl);
        const [slug] = splitRoute(r.route);
        const session = await store.get(h, slug);
        return { stored: Boolean(session?.apiKey), clear: () => store.clear(h, slug) };
      },
      async hostSessions(stateDir) {
        const store = resetStore;
        return Promise.all(rememberedSessions(stateDir).map(async ({ host: h, workspace: w }) => {
          const session = store ? await store.get(h, w).catch(() => undefined) : undefined;
          return { host: h, workspace: w, stored: Boolean(session?.apiKey), clear: async () => { await store?.clear(h, w); } };
        }));
      },
      inspectCheckout(dir) {
        const dirty = gitWorkingTreeStatus(dir).map((c) => c.path);
        const linkedWorktrees = worktrees(dir).map((w) => w.path).filter((p) => realpathSync(p) !== realpathSync(dir));
        return { dirty, linkedWorktrees };
      },
    };
    // Routes crew.yaml declares but that did not load (an interrupted first run):
    // sign-in may still have stored a credential for them.
    const droppedRoutes: Array<{ route: string; baseUrl: string }> = [];
    try {
      const rawCfg = parseYaml(readFileSync(cfg.configFile, 'utf8')) as { ship?: { baseUrl?: string }; routes?: Array<{ route?: unknown; baseUrl?: unknown }> } | null;
      for (const r of rawCfg?.routes ?? []) {
        if (typeof r?.route !== 'string' || cfg.routes.some((x) => x.route === r.route)) continue;
        try { splitRoute(r.route); } catch { continue; }
        droppedRoutes.push({ route: r.route, baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : rawCfg?.ship?.baseUrl ?? DEFAULT_BASE_URL });
      }
    } catch { /* an unreadable crew.yaml has no routes to find */ }
    const resetOptions = { routes: cfg.routes, droppedRoutes, stateDir: cfg.ship.stateDir, configFile: cfg.configFile, dryRun };
    let steps: ResetStep[];
    let remaining: string[] = [];
    if (deprovisioning) {
      const outcome = await runDeprovision(resetOptions, effects, realDeprovisionDeps(cfg, emit, CREW_HOME, getSessionStore));
      steps = outcome.steps;
      remaining = outcome.remaining;
    } else {
      steps = await runReset({ ...resetOptions, removeCheckouts: flag('remove-checkouts') }, effects);
    }
    const incomplete = resetIncomplete(steps) || remaining.length > 0;
    if (flag('json')) process.stdout.write(`${JSON.stringify({ dryRun, ok: !incomplete, steps, ...(deprovisioning ? { remaining } : {}) })}\n`);
    else {
      for (const s of steps) process.stdout.write(`${describeResetStep(s)}\n`);
      for (const r of remaining) process.stdout.write(`REMAINS: ${r}\n`);
    }
    if (incomplete) process.exitCode = 1;
    break;
  }

  case 'install': {
    if (!(await installScheduler({ replace: flag('replace') }))) process.exit(2);
    break;
  }

  case 'reload': {
    // CREW-1532: the daemon holds the config it loaded at startup. The
    // sentinel makes a busy daemon finish its in-flight pass and relaunch on
    // its next idle one; `--now` also bounces the unit for an operator who
    // does not want to wait (that interrupts an in-flight agent run).
    const sentinel = reloadSentinelFor(cfg.ship.stateDir);
    if (dryRun) { process.stdout.write(`would write ${sentinel}\n`); break; }
    const host = hostPlatform();
    const control = host === 'windows' ? null : planDaemonControl(CREW_HOME, host, detectSystemd());
    const unitStatus = control?.statusCommand
      ? spawnSync(control.statusCommand[0]!, control.statusCommand.slice(1), { cwd: CREW_HOME, encoding: 'utf8', env: withUserBusEnv() })
      : null;
    const unitRunning = unitStatus !== null && !unitStatus.error && unitStatus.status === 0;
    if (!unitRunning && control?.mechanism === 'systemd' && control.startCommand) {
      // CREW-2943: the daemon exits 0 to reload, and a unit written with
      // Restart=on-failure never relaunched it. Start it rather than say
      // nothing needs doing.
      const res = spawnSync(control.startCommand[0]!, control.startCommand.slice(1), { cwd: CREW_HOME, encoding: 'utf8' });
      if (res.error || res.status !== 0) {
        emit.error(withFix(`crew reload: ${control.startCommand.join(' ')} exited ${res.status ?? 'error'}`, '`crew doctor`'));
        process.exitCode = 1;
      } else {
        process.stdout.write('crew reload: the daemon unit was not running — started it, so it reads crew.yaml fresh\n');
      }
      break;
    }
    if (!unitRunning) {
      process.stdout.write('crew reload: no daemon unit is running — nothing to reload (the next run reads crew.yaml fresh)\n');
      break;
    }
    mkdirSync(cfg.ship.stateDir, { recursive: true });
    writeFileSync(sentinel, `${new Date().toISOString()}\n`);
    process.stdout.write(
      'crew reload: requested — the daemon relaunches with the new config once its running agents end (it starts no new work meanwhile); ' +
        'if it is busy, `crew reload --now` forces the relaunch and interrupts them\n',
    );
    if (flag('now') && control?.stopCommand && control.startCommand) {
      for (const cmd of [control.stopCommand, control.startCommand]) {
        const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: CREW_HOME, encoding: 'utf8', env: withUserBusEnv() });
        if (cmd === control.startCommand && (res.error || res.status !== 0)) {
          emit.error(withFix(`crew reload: ${cmd.join(' ')} exited ${res.status ?? 'error'}`, '`crew doctor`'));
          process.exitCode = 1;
        }
      }
      process.stdout.write('crew reload: restarted the daemon unit now\n');
    }
    break;
  }

  case 'uninstall': {
    const host = hostPlatform();
    if (host === 'windows') {
      emit.emit('nothing installed on Windows');
      break;
    }
    // CREW-3284: same shape as `crew install` — per-step progress under --verbose, one line per job removed.
    const uninstallLog = {
      emit: (m: string) => emit.note(m),
      warn: (m: string) => emit.warn(withFix(`crew uninstall: ${m}`, '`crew doctor`')),
    };
    const results: JobResult[] = [];
    for (const job of ['run', 'release', 'passengers'] as const) {
      const plan = planUninstall(cfg.ship, CREW_HOME, host, detectSystemd(), job);
      emit.note(`uninstalling ${job} ${plan.mechanism} for ${host}${dryRun ? ' (dry run)' : ''}`);
      const { changed } = await applyUninstall(plan, CREW_HOME, dryRun, uninstallLog);
      results.push({ job, mechanism: plan.mechanism, action: changed ? 'removed' : 'unchanged' });
    }
    for (const l of summarizeJobs(results, { uninstall: true, dryRun, verbose: flag('verbose'), host })) emit.emit(l);
    // --all (CREW-1376): every com.tablation.crew* launchd unit, whichever
    // checkout's hash it carries — the cleanup for a crew that was moved.
    if (flag('all') && host === 'macos') {
      emit.note(`uninstalling every crew launchd unit${dryRun ? ' (dry run)' : ''}`);
      removeAllLaunchdUnits(dryRun, {
        emit: (m) => emit.emit(m),
        warn: uninstallLog.warn,
      }, undefined, loadedCrewLabels());
    }
    break;
  }

  case 'passengers': {
    // The standalone entry point the `passengers` scheduler unit invokes
    // (ISSUE-677) — see `syncHostPassengers`'s own doc comment for why this
    // is no longer inline in `case 'run'`.
    if (positional[1] === 'status') {
      const specs = passengerCheckoutSyncSpecs(cfg);
      const rows = specs.map((s) => ({ workspaceId: s.workspaceId, repo: s.name, source: s.mirror ? 'mirror' : 'checkout', dir: s.dir }));
      if (flag('json')) process.stdout.write(`${JSON.stringify({ runner: cfg.ship.runner ?? 'host', checkouts: rows }, null, 2)}\n`);
      else if (rows.length === 0) process.stdout.write('no Host Passengers checkouts: no enabled route has hostPassengers on\n');
      else for (const r of rows) {
        process.stdout.write(`${r.repo} (${r.workspaceId}): ${r.source === 'mirror' ? 'sandbox cache mirror' : 'dedicated clone'} at ${r.dir}\n`);
      }
      break;
    }
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

  case 'sample-ticket': {
    // CREW-2242: a sandbox repo (no remote, always-green hooks, integrate
    // release) plus one approved ticket against it. Creating it is idempotent:
    // a second run reuses the checkout, the route entry and the Repos row and
    // files another ticket. `--remove` undoes all four.
    const json = flag('json');
    const say = (event: string, extra: Record<string, unknown>, human: string) =>
      process.stdout.write(json ? `${JSON.stringify({ event, ...extra })}\n` : `${human}\n`);
    const fail = (msg: string): never => {
      if (json) { process.stdout.write(`${JSON.stringify({ event: 'error', message: msg })}\n`); return process.exit(2); }
      return die('crew sample-ticket', msg, '`crew doctor`', 2);
    };
    if (!route.resolved) fail(`route ${route.route} is not connected — run \`crew connect\` first`);
    const tracker = new Tracker(route, cfg.ship);
    const configText = readFileSync(cfg.configFile, 'utf8');
    const cfgBase = dirname(cfg.configFile);
    const configured = configuredRepos(configText, route.route, cfgBase);
    const dir = configured.find((r) => r.name === SAMPLE_REPO)?.dir
      ?? sampleDir(configured.map((r) => r.dir), route.reposBasePath, route.route.split('/')[0]!);
    const resolvedFile = resolvedPathFor(cfg.ship.stateDir, route.route);
    const rows = await tracker.repoRows();
    const row = rows.find((r) => r.name === SAMPLE_REPO);

    if (flag('remove')) {
      const closed: string[] = [];
      if (row) {
        const wontFix = tracker.contract.statuses.wontFix;
        const resolved = new Set(tracker.contract.statuses.resolved);
        for (const t of await tracker.ticketsForRepo(row.id)) {
          if (resolved.has(t.status) || !isSampleTicket((t as { description?: string | null }).description)) continue;
          if (!dryRun) {
            await tracker.updateTicket(t.id, {
              [tracker.contract.columns.status]: wontFix,
              [tracker.contract.columns.resolutionNote]: 'Sample ticket removed by `crew sample-ticket --remove`; obsolete.',
            });
          }
          closed.push(t.issue_tag ?? t.issue_id);
        }
      }
      if (dryRun) {
        say('dry-run', { dir, row: row?.id ?? null, closed }, `would close ${closed.join(', ') || 'no tickets'}, delete the Repos row, detach and delete ${dir}`);
        break;
      }
      // Detach from the route first: a config still naming a deleted directory is the worse half-state.
      if (configured.some((r) => r.dir === dir)) {
        try {
          writeFileSync(cfg.configFile, planRepoRemove(configText, cfgBase, route.route, dir).text);
        } catch (e) {
          if (e instanceof ReposError) fail(e.message);
          throw e;
        }
      }
      if (row) {
        await tracker.deleteRepoRow(row.id);
        if (existsSync(resolvedFile)) {
          const raw = JSON.parse(readFileSync(resolvedFile, 'utf8')) as RepoRemotes & Record<string, unknown>;
          if (raw.repoNames) delete raw.repoNames[row.id];
          if (raw.repoRemotes) delete raw.repoRemotes[row.id];
          writeFileSync(resolvedFile, `${JSON.stringify(raw, null, 2)}\n`);
        }
      }
      // Only ever delete a directory this command made: its name, a git checkout, and nothing but sample files.
      if (existsSync(join(dir, '.git')) && basename(dir) === SAMPLE_REPO) rmSync(dir, { recursive: true, force: true });
      say('removed', { dir, closed }, `removed the sample repo${closed.length ? `, closed ${closed.join(', ')}` : ''}`);
      break;
    }

    const projectId = route.resolved!.areaId
      ?? resolveRepoProject(await tracker.projectRows(), value('project'));
    const fresh = !existsSync(join(dir, '.git'));
    if (existsSync(dir) && fresh && readdirSync(dir).length > 0) fail(`${dir} exists and is not a git checkout — move it aside`);
    if (dryRun) {
      say('dry-run', { dir, newCheckout: fresh, repoRow: row?.id ?? null }, `would ${fresh ? 'create' : 'reuse'} ${dir}${row ? '' : ', create the Repos row'}, and file one ${tracker.contract.statuses.approved} ticket`);
      break;
    }
    if (fresh) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'README.md'), SAMPLE_README);
      writeFileSync(join(dir, '.crew.yaml'), SAMPLE_CREW_YAML);
      const g = (...a: string[]) => {
        const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
        if (r.status !== 0) fail(`git ${a[0]} failed in ${dir}: ${(r.stderr || r.stdout).trim()}`);
      };
      g('init', '-b', 'main');
      g('add', '.');
      g('-c', 'user.name=crew', '-c', 'user.email=crew@localhost', 'commit', '-m', 'Initial commit');
    }
    let repoId = row?.id;
    if (!repoId) {
      const payload = planRepoRow({
        name: SAMPLE_REPO, origin: SAMPLE_REMOTE, projectId,
        spec: { platform: 'unix', releaseMode: 'integrate', ciProvider: 'none' },
      });
      repoId = (await tracker.createRepoRow(payload)).id;
      if (existsSync(resolvedFile)) {
        const raw = JSON.parse(readFileSync(resolvedFile, 'utf8')) as RepoRemotes & Record<string, unknown>;
        raw.repoNames = { ...raw.repoNames, [repoId]: SAMPLE_REPO };
        raw.repoRemotes = { ...raw.repoRemotes, [repoId]: SAMPLE_REMOTE };
        writeFileSync(resolvedFile, `${JSON.stringify(raw, null, 2)}\n`);
      }
    }
    if (!configured.some((r) => r.dir === dir)) {
      try {
        writeFileSync(cfg.configFile, planRepoAdd({ text: configText, base: cfgBase, route: route.route, path: dir, name: SAMPLE_REPO }).text);
      } catch (e) {
        if (e instanceof ReposError) fail(e.message);
        throw e;
      }
    }
    const ticket = await tracker.fileTicket(
      planSampleTicket({ projectId, repoId, approvedStatus: tracker.contract.statuses.approved }),
      route.resolved!.seats.dev ?? '',
    );
    const tag = ticket.issue_tag ?? ticket.issue_id;
    say('filed', { ticket: tag, id: ticket.id, dir, repoId }, `filed ${tag} against ${dir}; follow it with \`crew watch\``);
    break;
  }

  case 'selftest': {
    // CREW-2236: launch each configured toolchain the way a run would and ask it
    // to read the workspace's name through the tracker MCP tool. Writes nothing
    // to the tracker; the only thing stored is the result, in the state dir.
    const wanted = value('toolchain');
    const all = shipToolchains(cfg.ship);
    const chosen = wanted ? all.filter((t) => t.name === wanted) : all;
    if (chosen.length === 0) {
      die('crew selftest', `no toolchain "${wanted}" (have: ${all.map((t) => t.name).join(', ')})`, 'name one of those, or omit it to test them all');
    }
    if (!route.resolved) {
      die('crew selftest', `route ${route.route} is not connected`, '`crew connect`');
    }
    const seatKey = await resolveSeatKey(route, 'dev');
    const keychainDown = seatKey.kind === 'ship' && /keychain/i.test(seatKey.reason);
    const apiKey = keychainDown ? undefined : seatKey.apiKey;
    const baseUrl = route.baseUrl || DEFAULT_BASE_URL;
    // The tracker is asked for the name up front: it is the expected answer,
    // and a 401/403 here is the "seat key refused" class without a launch.
    let workspaceName = '';
    let upfront: Pick<SelftestResult, 'failure' | 'detail'> | undefined;
    if (apiKey) {
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/workspaces/${route.resolved.workspaceId}`, {
          headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': cfg.ship.userAgent },
        });
        if (res.status === 401 || res.status === 403) {
          upfront = { failure: 'key-refused', detail: `the tracker returned ${res.status} to the dev seat's key — ${REMEDY['key-refused']}` };
        } else if (!res.ok) {
          upfront = { failure: 'wrong-answer', detail: `the tracker answered ${res.status} when asked for the workspace's name` };
        } else {
          workspaceName = ((await res.json()) as { name?: string }).name ?? '';
          if (!workspaceName) upfront = { failure: 'wrong-answer', detail: 'the tracker returned a workspace with no name' };
        }
      } catch (e) {
        upfront = { failure: 'wrong-answer', detail: `could not reach ${baseUrl}: ${(e as Error).message}` };
      }
    }
    const results: SelftestResult[] = [];
    for (const tc of chosen) {
      const stub = { toolchain: tc.name, harness: tc.harness, model: tc.model, ms: 0, ranAt: new Date().toISOString() };
      if (upfront) { results.push({ ...stub, ok: false, ...upfront }); continue; }
      results.push(await runSelftest({
        ship: cfg.ship, toolchain: tc, baseUrl, workspaceId: route.resolved.workspaceId, apiKey,
        // Only the seat's reason: runSelftest appends the remedy itself, as for every other class.
        keyProblem: keychainDown && seatKey.kind === 'ship' ? seatKey.reason : undefined,
        workspaceName,
      }));
    }
    recordSelftest(cfg.ship.stateDir, results);
    process.stdout.write(flag('json') ? `${JSON.stringify(results, null, 2)}\n` : `${results.map(formatResult).join('\n')}\n`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    break;
  }

  case 'whoami': {
    // CREW-2350: one /auth/me call per route; positional or --route names one.
    const only = value('route') ?? positional[1];
    const wanted = only ? cfg.routes.filter((r) => r.route === only) : cfg.routes;
    if (only && wanted.length === 0) {
      die('crew whoami', `no route "${only}" (have: ${cfg.routes.map((r) => r.route).join(', ')})`, '`crew status`');
    }
    const report = await buildWhoami(wanted, {
      userAgent: cfg.ship.userAgent,
      operatorName: async (r, id) => (await new Tracker(r, cfg.ship).crewRows()).find((c) => c.id === id)?.name,
    });
    process.stdout.write(flag('json') ? `${JSON.stringify(report.length === 1 && only ? report[0] : report, null, 2)}\n` : formatWhoami(report));
    if (report.some((r) => !r.ok)) process.exitCode = 1;
    break;
  }

  case 'projects': {
    // CREW-1502: the Projects rows each route's connection can read. Works
    // across every route unless one is named (`--route R` or positionally).
    const only = value('route') ?? positional[1];
    const wanted = only ? cfg.routes.filter((r) => r.route === only) : cfg.routes;
    if (only && wanted.length === 0) {
      die('crew projects', `no route "${only}" (have: ${cfg.routes.map((r) => r.route).join(', ')})`, '`crew status`');
    }
    const report = await buildProjectsReport(
      wanted.map((r) => ({ route: r.route, areaId: r.resolved?.areaId })),
      (name) => new Tracker(wanted.find((r) => r.route === name)!, cfg.ship),
    );
    process.stdout.write(flag('json') ? `${JSON.stringify({ routes: report }, null, 2)}\n` : formatProjectsReport(report));
    // Non-zero only when every route failed.
    if (report.length > 0 && report.every((r) => 'error' in r)) process.exitCode = 1;
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
    // CREW-3064: a route whose key or ids are gone is exactly when a daemon
    // cannot start, so `status` must still say so (the ship attention set is
    // local) instead of dying with the same ConfigError the daemon exited on.
    let statusTracker: Tracker;
    try {
      statusTracker = new Tracker(route, cfg.ship);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      const attention = openShipAttention(state);
      if (flag('json')) {
        process.stdout.write(`${JSON.stringify({
          version: 1, configFile: cfg.configFile, ship: { name: cfg.ship.name, platform: cfg.ship.platform },
          route: route.route, attention, error: e.message,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`crew: ${e.message}\n`);
        for (const i of attention) process.stdout.write(`attention:  ${i.kind} — ${i.message}\n`);
      }
      process.exit(1);
    }
    const shipRows = await statusTracker.shipRows();
    const engagedTicketIds = shipRows.map((s) => s.engaged_ticket_id).filter((id): id is string => !!id);
    const engagedTickets = engagedTicketIds.length ? await statusTracker.ticketsByIds(engagedTicketIds) : [];
    const issueLabelById = new Map(engagedTickets.map((t) => [t.id, t.issue_id]));

    // What a person owes (CREW-1402). A board that cannot be read leaves the
    // block out rather than failing `status`, which is also a health check.
    const todo = await statusTracker.openTickets()
      .then((open) => operatorTodo(open, statusTracker.contract, route.resolved?.operator ?? ''))
      .catch(() => []);

    const projects = projectModeLabels(await statusTracker.projectRowsWithModes().catch(() => []));
    const crewMinVersion = (await readCrewFloor(route, cfg.ship)) ?? null;
    // Every live run on this ship, read from the run sidecars (CREW-2822), so
    // it is right across daemon restarts and for one-shot `crew run` processes.
    const runs = liveRuns(cfg.ship.stateDir);
    // CREW-3247: titles of the tickets those runs are on, so a monitor shows more than the tag.
    const runTitles = new Map(
      (await statusTracker.ticketsByIds([...new Set(runs.map((x) => x.ticketRecordId).filter((id): id is string => !!id))]).catch(() => []))
        .map((t) => [t.id, t.title ?? null] as const),
    );
    const lastRuns = lastRunsBySeat(cfg.ship.stateDir);
    const periscopes = await periscopesForStatus(cfg.ship.stateDir);
    // CREW-3248: a run's preview is its ticket's periscope, when that one is serving.
    const runPreviews = new Map(periscopes.filter((p) => p.serving).map((p) => [p.ticketRecordId, p.url] as const));
    if (flag('json')) {
      const nameSync = await reconcileRouteShipName({ route, ship: cfg.ship, configFile: cfg.configFile, readOnly: true });
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
          // Additive (CREW-2822): how many runs this seat has live right now.
          running: runs.filter((x) => x.role === r && x.route === routeSlug(route.route)).length,
          // Additive (CREW-3247): this seat's newest finished run on this ship, or null.
          lastRun: ((l) => (l ? { ticket: l.ticket, startedAt: l.startedAt, finishedAt: l.finishedAt, outcome: l.outcome, exitCode: l.exitCode } : null))(lastRuns.get(`${routeSlug(route.route)}/${r}`)),
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
          // Additive (CREW-1511): the configured toolchains and the ship's
          // default. `agent` above stays for older crew-macos builds.
          toolchain: resolveToolchain(cfg.ship).name,
          toolchains: shipToolchains(cfg.ship).map((x) => ({
            name: x.name, harness: x.harness, bin: x.bin, launcher: x.launcher ?? null, model: x.model,
          })),
          stateDir: cfg.ship.stateDir,
          // CREW-3084: how many repositories carry environment; never their names or values.
          repositoriesWithEnv: repositoryEnvCount(cfg.ship.stateDir),
          logFile: cfg.ship.logFile,
          eventFile: eventFileFor(cfg.ship.stateDir),
          // Additive (CREW-1373): open ship-level items, including the
          // derived `release_stale`. `version` stays 1.
          attention: openShipAttention(state),
          // Additive (CREW-2495): this ship's Ships-row name and whether it has drifted from `name`.
          rowName: nameSync.rowName ?? null,
          nameDrift: nameSync.drift,
          // Additive (CREW-2803): the relay URL this route's tunnel is reachable at, or null.
          relayUrl: routeRelayUrl(route),
          // Additive (CREW-2887): when a `crew reload` request was written and not yet honored, else null.
          reloadRequestedAt: ((at) => (at === null ? null : new Date(at).toISOString()))(readReloadRequestedAt(cfg.ship.stateDir)),
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
        // Additive (CREW-2822): every live run on this ship. `version` stays 1.
        runs: runs.map((x) => describeRun(x, route, seatIds, undefined, { titles: runTitles, previews: runPreviews })),
        // Additive (CREW-2857): every live periscope on this ship, from its local record. `version` stays 1.
        periscopes,
        watermark: state.watermark(routeSlug(route.route)),
        route: {
          name: route.route,
          // Additive (CREW-2248): the running version and the workspace's floor. `version` stays 1.
          crewVersion: sentVersion(cfg.ship),
          crewMinVersion,
          // Additive (CREW-1496): each project and its work mode. `version` stays 1.
          projects: projects.map((p) => ({ id: p.id, name: p.name, workMode: p.mode })),
          dir: route.dir,
          // Additive (CREW-2548): open tickets with no repository, as of the last cycle.
          unroutable: state.unroutable(route.route).previous().length,
          enabled: route.enabled,
          area: route.area ?? null,
          // Additive (CREW-1511): the toolchain this route's sessions run on.
          toolchain: resolveToolchain(cfg.ship, route).name,
          baseUrl: route.baseUrl,
          repos: repos.map((r) => ({
            name: r.name,
            dir: r.dir,
            // Additive (CREW-1529): the toolchain a ticket in this repo runs on.
            toolchain: resolveToolchain(cfg.ship, route, r.name).name,
            // Additive (CREW-1379): `unsafe` means a ship must not cut a
            // worktree or release from this base. `version` stays 1.
            baseBranch: baseHealth(r),
            // Additive (CREW-2537): gaps that only matter once a ticket reaches
            // release (no deploy hook, no CI provider...). They never stop a poll.
            releaseReadiness: validateEffective(r.config),
            // Additive (CREW-2051): worktrees the sweep refuses to remove.
            heldWorktrees: openShipAttention(state)
              .filter((i) => i.kind === 'worktree_held' && i.held?.repo === r.name)
              .map((i) => ({
                path: i.held!.path, ticket: i.held!.ticket, status: i.held!.status,
                reason: i.held!.reason, firstSeenAt: i.held!.firstSeenAt,
              })),
            worktreePrefix: r.config.worktrees.prefix,
            // A repo with no explicit `worktrees.prefix` no longer names its
            // worktrees `<prefix><number>` (ISSUE-969) — the checkout's own
            // directory name plus the ticket's branch name, e.g.
            // `synthesis-tabl-123`. `worktreePrefix` above is kept for
            // config-provenance display; this is the field that actually
            // describes where a worktree lands by default.
            worktreeDirPattern: r.config.worktrees.name
              ?? (r.config.provenance['worktrees.prefix'] !== 'default'
                ? `${r.config.worktrees.prefix}<number>`
                : `${basename(r.dir.replace(/[/\\]+$/, ''))}-<branch>`),
            worktreeParent: resolvePath(r.dir, '..'),
          })),
          waiting: waiting ? { ticket: waiting.ticket, since: waiting.since, streak: fairness.streak() } : null,
        },
        ships: shipRows.map((s) => ({
          ...shipIdentityJson(s),
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

    const shipAttention = openShipAttention(state);
    let heldReleases: string[] = [];
    // Verified tickets the release is holding back on an unresolved blocker
    // (CREW-1506), so "why hasn't this shipped" is answerable from here.
    try {
      const open = await statusTracker.openTickets();
      heldReleases = describeHeld(heldByBlockers(
        open, statusTracker.contract.statuses.verified,
        blockerInfoMap(open, await statusTracker.ticketsByIds(missingBlockerIds(open))),
      ));
    } catch { /* a tracker blip must not break `status` */ }
    const repoViews: StatusRepo[] = [];
    for (const r of await resolvedRepos(route)) {
      const bh = baseHealth(r);
      const rel = await releaserLine(statusTracker, route.route, r.name, r.config.release);
      repoViews.push({
        name: r.name, unsafeDetail: bh.unsafe ? bh.detail : undefined, releaser: rel.line,
        notable: rel.lockHeld || (!!r.config.release.ship && r.config.release.ship !== cfg.ship.name),
      });
    }
    const reloadWaitingAt = readReloadRequestedAt(cfg.ship.stateDir);
    const lastRunView: StatusLastRun[] = [...lastRuns.values()]
      .filter((l) => l.route === routeSlug(route.route))
      .map((l) => ({ role: l.role, ticket: l.ticket, finishedAt: l.finishedAt, outcome: l.outcome }));
    for (const line of renderStatus({
      ship: { name: cfg.ship.name, platform: cfg.ship.platform },
      route: { name: route.route, dir: route.dir, enabled: route.enabled },
      crewPaused: state.isPaused(),
      releasePaused: state.releaseSkipReason() !== null,
      pausedRoles: (['dev', 'design', 'qa'] as RoleName[]).filter((r) => state.isRolePaused(r)),
      periscopes: {
        summary: periscopeSummary(cfg),
        relayUrl: routeRelayUrl(route) || undefined,
        live: periscopes.map((p) => `${p.ticket} ${p.repo} ${p.url} ${p.state}${p.serving ? '' : ' (not serving)'} expires ${p.expiresAt}`),
      },
      watermark: String(state.watermark(routeSlug(route.route))),
      projects: projects.map((p) => p.label),
      reloadRequestedSecondsAgo: reloadWaitingAt === null ? null : Math.max(0, Math.round((Date.now() - reloadWaitingAt) / 1000)),
      runs: runs.map((x) => ({ role: x.role, ticket: x.ticket, repo: x.repo, pid: x.pid, spawnedAt: x.spawnedAt, deadline: x.deadline })),
      lastRuns: lastRunView,
      attention: shipAttention.map((i) => ({ kind: i.kind, message: i.message, since: i.since })),
      waiting: todo.map((i) => ({
        key: displayKey(i.ticket), title: i.ticket.title, reasons: i.reasons, updatedAt: i.ticket.updated_at,
      })),
      repos: repoViews,
      heldReleases,
      starved: waiting ? { ticket: waiting.ticket, since: waiting.since, streak: fairness.streak() } : undefined,
      ships: shipRows.map((s) => ({
        name: s.name ?? '(unnamed)',
        line: renderShipLine(s, issueLabelById),
        attention: (s.attention ?? []).map((i) => ({ kind: i.kind, message: i.message })),
      })),
    }, { verbose: flag('verbose') })) process.stdout.write(`${line}\n`);
    break;
  }

  case 'doctor': {
    const host = hostPlatform();
    // CREW-2239: push auth per checkout, and gh/node/docker as soft checks.
    // Computed once; the text report prints them, `--json` prints only them.
    const doctorSchedulerPath = pathFor(cfg.ship);
    // CREW-3065: what the service manager says about the daemon unit; null where no manager supervises it (cron, Windows).
    const daemonLiveness: DaemonLiveness | null = (() => {
      if (host === 'windows') return null;
      const hasSystemd = detectSystemd();
      if (host === 'linux' && !hasSystemd) return null;
      const plan = planInstall(cfg.ship, CREW_HOME, host, hasSystemd, 'run', installContext());
      const label = labelFor(CREW_HOME, 'run');
      return probeDaemonUnit({
        plan, label, uid: process.getuid?.() ?? 0,
        system: plan.mechanism === 'systemd' && existsSync(systemUnitPathFor(label)),
        stamp: readDaemonStamp(cfg.ship.stateDir),
      });
    })();
    const pushAuth: Array<{ route: string; repo: string; result: PushAuthResult }> = [];
    const toolRows: ToolCheck[] = [];
    {
      const prBased = new Set<string>();
      let mentionNode = false;
      for (const c of [route]) {
        // Each repo resolves on its own: one invalid `.crew.yaml` must not hide
        // the others' results, and under --json nothing else reports it.
        const { settled: repos, errors } = await settleRepos(reposOf(c), (t) => t.name, (t) => resolveOneRepo(c, t));
        for (const e of errors) {
          pushAuth.push({ route: c.route, repo: e.repo, result: { state: 'failed', detail: `could not resolve this repo's configuration: ${e.detail}`, hint: "fix the repo's .crew.yaml" } });
        }
        for (const r of repos) {
          const remote = r.config.branch.remote;
          if (existsSync(r.dir)) {
            pushAuth.push({
              route: c.route, repo: r.name,
              result: probePushAuth({
                dir: r.dir, remote, remoteUrl: originUrlOf(r.dir, remote), offline: flag('offline'),
                forge: forgeOfRemote(cfg.ship.forges, originUrlOf(r.dir, remote), (h) => hasForgeToken(cfg.ship.forges, h, cfg.ship.stateDir)),
              }),
            });
          }
          if (isPrBased(r.config.hooks)) prBased.add(r.name);
          if (Object.values(r.config.hooks).some((h) => typeof h === 'string' && mentionsNode(h))) mentionNode = true;
        }
      }
      toolRows.push(...toolChecks(
        { prBased: prBased.size > 0, hostPassengers: cfg.routes.some((x) => x.enabled && x.hostPassengers), hooksMentionNode: mentionNode },
        (bin) => findOnPath(bin, doctorSchedulerPath),
      ));
    }
    if (flag('json')) {
      // CREW-2542: the same findings the text report prints, structured. Only
      // local checks run here (no tracker round trips), and nothing is written
      // to ship state — the text report raises `hook_missing`, this only reads.
      const problems: DoctorProblem[] = [];
      let passed = 0;
      for (const c of [route]) {
        const { settled: repos, errors } = await settleRepos(reposOf(c), (t) => t.name, (t) => resolveOneRepo(c, t));
        for (const e of errors) {
          problems.push({ severity: 'blocker', kind: 'repo_config_invalid', route: c.route, repo: e.repo, message: `could not resolve this repo's configuration: ${e.detail}`, remedy: "fix the repo's .crew.yaml" });
        }
        for (const r of repos) {
          const f = repoFindings({
            route: c.route, repo: r.name, dir: r.dir, notes: validateEffective(r.config),
            base: doctorBaseReport(r, r.config.branch.base, baseHealth), hooks: r.config.hooks,
            onPath: (cmd) => !!findOnPath(cmd, doctorSchedulerPath),
            // CREW-3007: on a sandbox ship the hooks run in the image, so the host PATH is not asked.
            sandboxGaps: cfg.ship.runner === 'sandbox' ? sandboxHookGaps({
              route: c.route, repo: r.name, hooks: r.config.hooks, declares: Boolean(r.config.sandbox),
              image: sandboxImageForRun(readSandboxState(cfg.ship.stateDir), r.name, Boolean(r.config.sandbox)),
              hasBinary: imageHasBinary(),
            }) : undefined,
            sandboxStoreProblem: cfg.ship.runner === 'sandbox' ? (() => {
              const image = sandboxImageForRun(readSandboxState(cfg.ship.stateDir), r.name, Boolean(r.config.sandbox));
              return image ? imageStoreProblem()(image) : undefined;
            })() : undefined,
            mapFile: mapFilePath(r.config.hooks.map) ? inspectMapFile(r.dir, mapFilePath(r.config.hooks.map)!) : undefined,
            intelSyntax: r.config.hooks.intel && !intelFlavor(r.config.hooks.intel) ? checkHookSyntax(r.config.hooks.intel, r.config.shell) : undefined,
            intelFlavor: intelFlavor(r.config.hooks.intel) ? { name: intelFlavor(r.config.hooks.intel)!, missing: [
              ...missingPrerequisites(intelFlavor(r.config.hooks.intel)!, (bin) => !!findOnPath(bin, doctorSchedulerPath)),
              // CREW-2916: an `*-lsp` flavor needs the language server in the checkout or on PATH.
              ...(lspFlavor(r.config.hooks.intel) && !lspBinaryFound(lspFlavor(r.config.hooks.intel)!, r.dir, (bin) => !!findOnPath(bin, doctorSchedulerPath))
                ? [`${LSP_SERVERS[lspFlavor(r.config.hooks.intel)!].bin} (${LSP_SERVERS[lspFlavor(r.config.hooks.intel)!].install})`] : []),
            ] } : undefined,
          });
          problems.push(...f.problems);
          passed += f.passed;
        }
      }
      if (!flag('offline')) {
        for (const p of await probeSeatReads(route, { userAgent: cfg.ship.userAgent })) {
          if (p.state === 'forbidden') {
            problems.push({ severity: 'blocker', kind: 'seat_cannot_read_issues', route: route.route, message: `${p.role} agent key refused on ${p.tables.filter((t) => t.state === 'forbidden').map((t) => t.table).join(', ')} (403)`, remedy: describeSeatForbidden(p.role, p.tables).replace(/^.*?— /, '') });
          } else if (p.state === 'ok') passed++;
        }
        // CREW-2963: reading is not enough; a hand-off writes status, assignee and the Crew/Ships rows.
        for (const w of await probeSeatWrites(route, { userAgent: cfg.ship.userAgent })) {
          if (w.state === 'forbidden') {
            problems.push({ severity: 'blocker', kind: 'seat_cannot_write', route: route.route, message: seatCannotWriteMessage(w.role, w.tables), remedy: SEAT_NO_WRITE_REMEDY });
          } else if (w.state === 'ok') passed++;
        }
      }
      for (const message of roleCapWarnings(cfg.ship)) problems.push({ severity: 'note', kind: 'role_cap_above_ship_cap', message });
      // CREW-3117: a bundled persona image that failed to upload is a warning, not a failure.
      for (const f of routeAvatarFailures(cfg.ship.stateDir, route.route)) problems.push({ severity: 'note', kind: 'persona_avatar_upload_failed', route: route.route, message: `${f.role} persona avatar failed to upload: ${f.detail}`, remedy: 'run `crew agents sync` again' });
      if (daemonLiveness) {
        const dp = daemonProblem(daemonLiveness, route.route);
        if (dp) problems.push(dp); else passed++;
      }
      if (staleBundle) problems.push({ severity: 'blocker', kind: 'stale_bundle', message: staleBundle.message, remedy: 'npm run build' });
      const runtimeDir = runtimeDirWarning(process.platform, process.getuid?.() ?? null, existsSync, userInfo().username);
      if (runtimeDir) problems.push({ severity: 'attention', kind: 'runtime_dir_missing', message: runtimeDir });
      if (!flag('offline')) {
        const shipKind = await doctorShipKind(route, cfg.ship);
        for (const message of managedRuntimeWarnings(shipKind, cfg.ship)) problems.push({ severity: 'attention', kind: 'managed_runtime_default', message });
        for (const message of managedGitIdentityWarnings(shipKind, readGlobalGitIdentity())) problems.push({ severity: 'attention', kind: 'managed_git_identity', message });
      }
      // CREW-2961: on a sandbox ship, a served repository with no mirror cannot be cloned by any run.
      const cacheSettings = cfg.ship.runner === 'sandbox' ? cacheSettingsOf(cfg.ship.sandbox) : null;
      if (cacheSettings && !flag('offline')) {
        try {
          const missing = unmirroredRepos(sandboxCacheRepos(route, cfg.ship), await new SandboxCache(cacheSettings).list());
          for (const r of missing) problems.push({ severity: 'attention', kind: 'sandbox_cache_unmirrored', route: route.route, message: `${r} has no mirror in the cache volume ${cacheSettings.volume}, so sandboxed runs cannot clone it`, remedy: 'see `crew sandbox cache` for the last refresh failure' });
          // CREW-2966/3013: the gateway refuses to mount a volume that is not attachable or whose workspace label differs from the one sandboxes are created in.
          const cache = new SandboxCache(cacheSettings);
          const labels = await cache.volumeLabels();
          if (labels && !cache.labelsOk(labels)) {
            const kind = labels.attachable === 'true' && labels.workspace !== null ? 'sandbox_cache_workspace_mismatch' : 'sandbox_cache_unlabeled';
            problems.push({ severity: 'blocker', kind, route: route.route, message: cache.labelProblem(labels), remedy: 'run `crew sandbox cache --reset` to recreate the volume with the right labels' });
          }
        } catch { /* the container engine being down is reported by its own check */ }
      }
      const dockerDownJson = dockerDaemonFinding({ needed: await shipNeedsDocker(), up: dockerAvailable() });
      if (dockerDownJson) problems.push(dockerDownJson);
      problems.push(...deadTunnelFindings(deadTunnels(cfg.ship.stateDir), Boolean(dockerDownJson)));
      for (const t of rejectedTunnels(cfg.ship.stateDir)) {
        problems.push({ severity: 'attention', kind: TUNNEL_REJECTED_KEY, message: tunnelRejectedMessage(t.workspaceId, t.quickExits), remedy: 'rotate the slug with `crew rotate-passenger-url`' });
      }
      for (const workspaceId of controlRefusedTunnels(cfg.ship.stateDir)) {
        problems.push({ severity: 'attention', kind: RELAY_CONTROL_UNSUPPORTED_KEY, message: relayControlUnsupportedMessage(workspaceId), remedy: 'deploy crew-relay 0.2.0 or later (scripts/deploy-relay.sh in the crew-relay repository)' });
      }
      const previewProblem = await previewHostProblem(cfg);
      if (previewProblem) problems.push(previewHostFinding(previewProblem));
      const jsonDiff = await snapshotDiffFor(route);
      const jsonStale = jsonDiff ? staleSnapshotMessage(route.route, jsonDiff) : undefined;
      if (jsonStale) problems.push({ severity: 'attention', kind: 'connect_snapshot_stale', route: route.route, message: jsonStale, remedy: `crew connect ${route.route} && crew reload` });
      if (cfg.routes.some((x) => x.route === route.route && x.enabled && x.hostPeriscopes)) {
        const { settled } = await settleRepos(reposOf(route), (t) => t.name, (t) => resolveOneRepo(route, t));
        const tablePresent = flag('offline') ? undefined : (await new Tracker(route, cfg.ship).periscopesStatus().catch(() => ({ present: true }))).present;
        problems.push(...routePeriscopeProblems({ route: route.route, hosts: true, repos: settled.map((r) => ({ name: r.name, hasPreviewHook: !!r.config.hooks.preview })), tablePresent, snapshotStale: !!jsonDiff && isStale(jsonDiff) }));
        if (!flag('offline')) problems.push(...await duplicateLivePeriscopeProblems(route, cfg.ship));
      }
      problems.push(...attentionProblems(openShipAttention(state), problems));
      if (problems.some((p) => p.severity === 'blocker')) process.exitCode = 1;
      process.stdout.write(`${JSON.stringify({ offline: flag('offline'), pushAuth, tools: toolRows, daemon: daemonLiveness, problems, passed }, null, 2)}\n`);
      break;
    }
    // CREW-3272: every check below hands its line to `R`; the report is printed once, at the end.
    const R = new DoctorReport();
    R.line(
      `ship:              ${cfg.ship.name} (${host})\n` +
        `routes:            ${cfg.routes.map((c) => c.route).join(', ')}\n`,
    );

    if (staleBundle) {
      R.line(`bundle:            BLOCKER ${staleBundle.message}\n`);
      process.exitCode = 1;
    }
    // CREW-3275: one Docker finding; the passengers, sandbox image and relay lines below that fail for it say so.
    const dockerFinding = dockerDaemonFinding({ needed: await shipNeedsDocker(), up: dockerAvailable() });
    const dockerNote = dockerFinding ? ' (consequence of the Docker finding above)' : '';
    if (dockerFinding) {
      R.line(`docker:            BLOCKER ${dockerFinding.message} — ${dockerFinding.remedy}\n`);
      process.exitCode = 1;
    }
    for (const f of deadTunnelFindings(deadTunnels(cfg.ship.stateDir), Boolean(dockerFinding))) {
      R.line(`tunnel:            DEAD ${f.message} — ${f.remedy}\n`);
    }
    for (const w of roleCapWarnings(cfg.ship)) R.line(`role concurrency: WARN ${w}\n`);
    for (const r of cfg.routes) for (const f of routeAvatarFailures(cfg.ship.stateDir, r.route)) R.line(`persona avatar:    WARN ${r.route}: ${f.role} avatar failed to upload (${f.detail}); run \`crew agents sync\` again\n`);

    for (const t of rejectedTunnels(cfg.ship.stateDir)) R.line(`relay tunnel:      ATTENTION ${tunnelRejectedMessage(t.workspaceId, t.quickExits)}\n`);
    for (const workspaceId of controlRefusedTunnels(cfg.ship.stateDir)) R.line(`relay tunnel:      ATTENTION ${relayControlUnsupportedMessage(workspaceId)}\n`);

    // EPIC-077: periscopes need a host to send a Passenger to.
    R.line(`periscopes:        ${periscopeSummary(cfg)}\n`);
    R.line(`key store:         ${describeKeyStore(cfg.ship)}\n`);
    const previewProblem = await previewHostProblem(cfg);
    if (previewProblem) {
      const blocks = previewHostFinding(previewProblem).severity === 'blocker';
      R.line(`                   ${blocks ? 'BLOCKER' : 'ATTENTION'} ${previewProblem}\n`);
      if (blocks) process.exitCode = 1;
    }

    // CREW-1509: rotation runs on append, so a live file far past the
    // threshold means nothing is rotating it.
    try {
      const evFile = eventFileFor(cfg.ship.stateDir);
      const evSize = existsSync(evFile) ? statSync(evFile).size : 0;
      R.line(
        evSize > cfg.ship.eventsRotateBytes * 4
          ? `events log:        WARN ${evFile} is ${Math.round(evSize / 1048576)} MB (> 4x eventsRotateBytes); run \`crew reap\` to rotate it\n`
          : 'events log:        ok\n',
      );
    } catch { /* an unreadable state dir is reported elsewhere */ }

    // CREW-1775: a unit installed before agents got their own process group
    // kills the in-flight run whenever the daemon restarts.
    if (host !== 'windows') {
      const unitPlan = planInstall(cfg.ship, CREW_HOME, host, detectSystemd(), 'run', installContext());
      const abandons = unitAbandonsAgents(unitPlan, (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } });
      if (abandons === false) {
        R.line(
          'scheduler unit:    WARN the installed unit does not leave agent runs alone when the daemon restarts ' +
            '(no AbandonProcessGroup / KillMode=process) — a daemon crash or relaunch kills the run in flight; run `crew install`\n',
        );
      }
    }

    // CREW-2994: the passengers sync spawns the relay tunnel and exits; without
    // KillMode=process systemd kills the tunnel with the rest of the unit.
    if (host === 'linux' && detectSystemd() && cfg.ship.relayHost) {
      const pPlan = planInstall(cfg.ship, CREW_HOME, host, true, 'passengers', installContext());
      const keeps = unitAbandonsAgents(pPlan, (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } });
      if (keeps === false) {
        R.line(
          'passengers unit:  WARN the installed unit lacks KillMode=process, so systemd kills the relay tunnel each time the sync exits ' +
            '(tunnel never reaches connected); run `crew install`\n',
        );
      }
    }

    // CREW-2943: a Linux ship whose daemon unit is installed but inactive
    // (a clean exit under an older Restart=on-failure unit) sits idle.
    if (host === 'linux' && detectSystemd()) {
      const ctl = planDaemonControl(CREW_HOME, host, true);
      const unitPlan = planInstall(cfg.ship, CREW_HOME, host, true, 'run', installContext());
      if (ctl.statusCommand && unitPlan.unitPaths.some((p) => existsSync(p))) {
        const st = spawnSync(ctl.statusCommand[0]!, ctl.statusCommand.slice(1), { cwd: CREW_HOME, encoding: 'utf8' });
        if (!st.error && st.status !== 0) {
          R.line('daemon unit:      WARN installed but not running — no work is picked up; run `crew reload` (or `crew daemon start`), and `crew install` if the unit still says Restart=on-failure\n');
        }
      }
    }

    // CREW-3065: the service manager's view of the daemon comes first; the
    // reload and config checks below mean nothing without a live process.
    if (daemonLiveness) {
      R.line(`daemon:            ${daemonLineText(daemonLiveness)}\n`);
      if (daemonLiveness.state === 'exited') process.exitCode = 1;
    }
    const daemonDead = daemonKnownDead(daemonLiveness);

    // CREW-2887: a reload request the running daemon has not yet honored.
    const reloadAt = readReloadRequestedAt(cfg.ship.stateDir);
    if (reloadAt !== null) {
      R.line(
        `reload request:    ${reloadRequestText(Math.max(0, Math.round((Date.now() - reloadAt) / 1000)), daemonLiveness, liveRuns(cfg.ship.stateDir).length)}\n`,
      );
    }

    // CREW-1532: a daemon started before the last crew.yaml / apiKeyFile
    // edit is still running the old config.
    const daemonStartedAt = readDaemonStarted(cfg.ship.stateDir);
    if (daemonStartedAt !== null) {
      const changed = configChangedAfter(daemonConfigPaths(cfg), daemonStartedAt);
      if (changed) {
        R.line(
          daemonDead
            ? `daemon config:     WARN ${changed} changed at ${new Date(statSync(changed).mtimeMs).toISOString()} — no daemon is running; the new config applies when it starts\n`
            : `daemon config:     WARN ${changed} changed at ${new Date(statSync(changed).mtimeMs).toISOString()} ` +
              `but the daemon started at ${new Date(daemonStartedAt).toISOString()} — run \`crew reload\`\n`,
        );
      }
    }

    // Does this machine have a row on the board, and which seats are its own?
    // Matched by name, per Brad's call: it is what an operator recognises.
    const tracker = new Tracker(route, cfg.ship);

    // EPIC-053 §4: the version the server sees against the workspace's floor.
    {
      const have = sentVersion(cfg.ship);
      const floor = await readCrewFloor(route, cfg.ship);
      if (have && floor) {
        R.line(
          `crew version:      ${belowFloor(have, floor) ? 'WARN ' : ''}${have} (workspace requires ${floor})` +
            `${belowFloor(have, floor) ? ' — update crew (the Crew app, or `npm install -g @tablation/crew`)' : ''}\n`,
        );
      } else if (have) {
        R.line(`crew version:      ${have}${floor === null ? ' (workspace sets no minimum)' : ''}\n`);
      }
    }

    // A workspace's contract can be internally inconsistent — a status named
    // as `approved` that is not in `open`, a `handoff` listed as resolved.
    // Checked here rather than left to fail as odd behaviour later.
    const contractProblems = validateContract(tracker.contract);
    R.line(
      contractProblems.length
        ? `contract:          ${contractProblems.length} problem(s)\n` +
          contractProblems.map((p) => `                   - ${p}\n`).join('')
        : 'contract:          consistent\n',
    );

    // Per repository, because a route serves several and each carries its
    // own contract. `shadowed` was computed and never read by anything until
    // ISSUE-350 — a setting the ship declares and the repo overrides is
    // otherwise invisible, and reads as though it were in use.
    R.repoNames = reposOf(route).map((t) => t.name);
    for (const r of await resolvedRepos(route)) {
      const { config } = r;
      R.repo = r.name;
      // Default worktree naming is now `<checkout dir>-<branch>` (ISSUE-969),
      // derived per ticket from its own branch name rather than a repo-wide
      // prefix — an explicit `worktrees.prefix` (repo or ship) still wins and
      // keeps the older `<prefix><number>` form.
      const worktreePattern = config.worktrees.name
        ?? (config.provenance['worktrees.prefix'] !== 'default'
          ? `${config.worktrees.prefix}<number>`
          : `${basename(r.dir.replace(/[/\\]+$/, ''))}-${effectiveBranchTemplate(config, undefined)}`);
      R.line(
        `${`repo ${r.name}:`.padEnd(19)}${r.dir}\n` +
          `                   worktrees at ../${worktreePattern} ` +
          `(${config.provenance['worktrees.name'] ?? config.provenance['worktrees.prefix'] ?? 'default'}), ` +
          `branch ${config.branch.name}\n` +
          `                   requires ${config.platform} — ${satisfies(host, config.platform) ? 'OK' : 'MISMATCH'}\n`,
      );
      if (config.shadowed.length) {
        R.line(
          `                   this ship declares ${config.shadowed.join(', ')}, ` +
            `and ${r.name} overrides it — the repo wins\n`,
        );
      }
      for (const p2 of validateEffective(config)) {
        R.line(`                   - release readiness: ${p2}\n`);
      }
      R.line(`                   release self-repair: ${selfRepairLine(config.release.isolateFailures?.maxCandidates)}\n`);
      const dh = doctorBaseReport(r, config.branch.base, baseHealth);
      R.line(dh.text);
      if (dh.failed) process.exitCode = 1;
      if (dh.skipRest) continue;
      // Who releases this repo (CREW-1384): the named ship, or a warning when
      // a locally-released repo names none and several ships could race.
      if (config.release.ship) {
        R.line(`                   release.ship ${config.release.ship}${config.release.ship === cfg.ship.name ? ' (this ship)' : ''}\n`);
      } else {
        const warn = missingReleaserWarning(r.name, config.release, await tracker.shipRows().catch(() => []));
        if (warn) R.line(`                   WARNING ${warn}\n`);
      }
      // CREW-2412: a stale claim by this ship's own dead process.
      const scope = releaseLockScope(route.route, r.name);
      const lock = await tracker.lockState(scope).catch(() => undefined);
      if (lock?.holder && staleOwnLockClaim(lock.holder, cfg.ship.name)) {
        R.line(`                   ${formatStaleOwnLock(scope, lock.holder)}`);
      }
    }

    R.repo = undefined;

    // Authorship columns (CREW-1371). A missing one is not a fault — the write
    // just leaves it empty — so this reports it without gating `--fix`.
    const missingAuthorship = await tracker.missingAuthorshipColumns();
    R.line(
      missingAuthorship.length === 0
        ? 'authorship:       filed_by_id, ship_id present\n'
        : `authorship:       missing ${missingAuthorship.join(', ')} — update the Issues template\n`,
    );
    // ISSUE-2791: forge host / ship kind / relay URL columns. Absent reads as
    // the default, so this reports without gating `--fix`.
    const missingRuntime = await tracker.missingRuntimeColumns();
    R.line(
      missingRuntime.length === 0
        ? 'runtime columns: forge_host, kind, instance_class, relay_url present\n'
        : `runtime columns: missing ${missingRuntime.join(', ')} — read as their defaults; update the Issues template\n`,
    );
    // CREW-3255: the optional branch/pull request link columns, and whether a
    // forge token exists for discovery to use. Notes only.
    {
      const have = await tracker.linkColumns();
      const lines = linkDoctorLines(have, reposOf(route).map((t) => ({ name: t.name, host: t.forgeHost })), cfg.ship.forges, cfg.ship.stateDir);
      R.line(`${lines.join('\n')}\n`);
    }
    // CREW-1811: informational only — without the column the tracker has no
    // public intake form and nothing to guard against.
    R.line(
      await tracker.hasPublicReplyColumn()
        ? `public replies:  Comments.${tracker.contract.comments.publicReply} present — public reporters are labelled in the digest\n`
        : `public replies:  Comments.${tracker.contract.comments.publicReply} absent — no public intake form, nothing to guard\n`,
    );
    // CREW-3258: informational only — a table without the column has not adopted the marking.
    R.line(
      await tracker.hasCrewAssistedColumn()
        ? `crew assisted:   Issues.${tracker.contract.columns.crewAssisted} present — Dev/QA runs mark the ticket\n`
        : `crew assisted:   Issues.${tracker.contract.columns.crewAssisted} absent — tickets are not marked; update the Issues template to adopt it\n`,
    );
    // EPIC-077: the optional Periscopes table. Absent is a legitimate shape;
    // a present table missing a column the crew writes is named by column.
    const periscopes = await tracker.periscopesStatus();
    // CREW-3274: the periscopes and release-seat lines below read the connect
    // snapshot. Compare it with the workspace once, so a snapshot that predates
    // a table is reported as old rather than the workspace as lacking it.
    const snapDiff = await snapshotDiffFor(route);
    const snapStale = !!snapDiff && isStale(snapDiff);
    const offlineNote = flag('offline') ? ' (from the last connect; not checked against the workspace under --offline)' : '';
    if (flag('verbose')) R.line(`connect snapshot: taken ${snapshotAge(route.resolved?.connectedAt)} ago${offlineNote}\n`);
    if (snapDiff && snapStale) R.line(`connect snapshot: WARN ${staleSnapshotMessage(route.route, snapDiff)}\n`);
    // CREW-2857: what hosting needs on a route that opted in. A missing table is a
    // blocker for hosting only; the rest of the crew carries on, so no exit code.
    if (cfg.routes.some((x) => x.route === route.route && x.enabled && x.hostPeriscopes)) {
      const { settled } = await settleRepos(reposOf(route), (t) => t.name, (t) => resolveOneRepo(route, t));
      for (const f of routePeriscopeProblems({
        route: route.route, hosts: true, tablePresent: flag('offline') ? undefined : periscopes.present, snapshotStale: snapStale,
        repos: settled.map((r) => ({ name: r.name, hasPreviewHook: !!r.config.hooks.preview })),
      })) {
        R.line(`periscopes:      ${f.severity.toUpperCase()} ${f.message}\n`);
      }
      if (!flag('offline')) {
        for (const f of await duplicateLivePeriscopeProblems(route, cfg.ship)) {
          R.line(`periscopes:      ${f.severity.toUpperCase()} ${f.message}\n`);
        }
      }
    }
    R.line(
      snapStale && snapDiff!.added.includes('Periscopes')
        ? 'periscopes:      Periscopes table is in the workspace but not in the connect snapshot — see the connect snapshot line above\n'
        : !periscopes.present
        ? `periscopes:      ${flag('offline') ? `no Periscopes table in the snapshot${offlineNote}` : 'Periscopes table absent — this workspace cannot host periscopes'}\n`
        : periscopes.missing.length === 0
          ? `periscopes:      Periscopes table present (${periscopes.modelId})\n`
          : `periscopes:      Periscopes table present (${periscopes.modelId}) but missing ${periscopes.missing.join(', ')} — update the Issues template\n`,
    );
    // Release seat (CREW-1371 D5). Absent is not a fault: release comments are
    // credited to the dev seat instead, which is what they were before.
    R.line(
      route.resolved?.releaseSeat
        ? 'release seat:    this ship has its own Release Crew row\n'
        : snapDiff?.releaseSeatNew
          ? 'release seat:    the workspace has this ship\'s Release row but the connect snapshot does not — see the connect snapshot line above\n'
        : flag('offline')
          ? `release seat:    none in the snapshot${offlineNote}\n`
        : 'release seat:    none — release comments are credited to the dev seat; run `crew connect` once the Crew table has this ship\'s row\n',
    );

    // CREW-1797: the key's role decides which hints below make sense. A
    // route connected before it was recorded asks `/auth/me` once.
    const keyRole = route.resolved?.role ?? await fetchKeyRole(route, cfg.ship.userAgent);
    const roleRoute: Route = route.resolved && keyRole ? { ...route, resolved: { ...route.resolved, role: keyRole } } : route;
    R.line(`api key role:     ${keyRole ?? 'unknown'}\n`);
    // CREW-2240: what the last `crew connect` found this key may not do.
    for (const m of route.resolved?.capabilityMisses ?? []) R.line(`capability:       MISSING ${m} (re-run \`crew connect\` once granted)\n`);
    const canMint = await canMintAgentKeys(roleRoute, { userAgent: cfg.ship.userAgent });
    R.line(`can mint agent keys: ${canMint === undefined ? 'unknown' : canMint ? 'yes' : 'no'}\n`);

    // CREW-1603: which principal each seat will write as.
    for (const role of SEAT_KEY_ROLES) {
      if (!route.resolved?.seats[role]) continue;
      const id = await resolveSeatKey(roleRoute, role);
      R.line(
        `seat identity:    ${role} writes as ${id.kind === 'agent' ? `its own agent (${id.agentId})` : `the ship (${id.reason})`}\n`,
      );
    }

    if (route.resolved?.releaseSeat) {
      const id = await resolveReleaseKey(roleRoute);
      R.line(
        `seat identity:    release writes as ${id.kind === 'agent' ? `its own agent (${id.agentId})` : `the ship (${id.reason})`}\n`,
      );
    }

    // CREW-2549: a stored key proves nothing about what it may read. A seat
    // minted into a project with no default agent role authenticates and then
    // 403s on Issues, which only the release phase used to find out.
    if (!flag('offline')) {
      for (const p of await probeSeatReads(roleRoute, { userAgent: cfg.ship.userAgent })) {
        if (p.state === 'forbidden') {
          R.line(`${describeSeatForbidden(p.role, p.tables)}\n`);
          process.exitCode = 1;
        } else {
          R.line(p.state === 'ok' ? `${describeSeatTables(p.role, p.tables)}\n` : `seat read:        ${p.role} could not be checked (${p.detail})\n`);
        }
      }
      for (const w of await probeSeatWrites(roleRoute, { userAgent: cfg.ship.userAgent })) {
        if (w.state === 'forbidden') {
          R.line(`seat write:       ERROR ${seatCannotWriteMessage(w.role, w.tables)} (READ only) — ${SEAT_NO_WRITE_REMEDY}\n`);
          process.exitCode = 1;
        } else if (w.state === 'ok') R.line(`seat write:       ${w.role}: ok\n`);
      }
    }

    const [ships, crewRows] = await Promise.all([tracker.shipRows(), tracker.crewRows()]);
    if (ships.length === 0) {
      R.line('ship record:       this workspace has no Ships table (fine)\n');
    } else {
      const matched = matchShipRows(ships, cfg.ship.name, doctorMachineId(cfg.ship.stateDir));
      const mine = matched.rows;
      R.line(
        matched.hasColumn
          ? `ship row:          ${mine.length === 1 ? `matched by ${matched.by === 'machine_id' ? 'machine id' : 'name'}` : 'not matched'}\n`
          : 'ship row:          matched by name only — the Ships table has no machine_id column (update the Issues template)\n',
      );
      if (mine.length === 0) {
        R.line(
          `ship record:       NO row named "${cfg.ship.name}" — ` +
            `have: ${ships.map((s2) => s2.name).join(', ')}\n`,
        );
      } else if (mine.length > 1) {
        // A name is only an identity while it is unique; say so rather than
        // silently picking one.
        R.line(`ship record:       ${mine.length} rows named "${cfg.ship.name}" — ambiguous\n`);
      } else {
        const row = mine[0]!;
        const seats = crewRows.filter((c) => (c as { ship_id?: string }).ship_id === row.id);
        const declared = row.platform;
        R.line(
          `ship record:       ${row.name} (${declared ?? 'no platform'})` +
            `${declared && declared !== host ? ` — MISMATCH, this host is ${host}` : ''}\n` +
            `crew manifest:     ${seats.length ? seats.map((c) => c.name).join(', ') : 'none'}\n`,
        );
        for (const w of managedRuntimeWarnings(row.kind, cfg.ship)) R.line(`managed runtime:  WARN ${w}\n`);
        for (const w of managedGitIdentityWarnings(row.kind, readGlobalGitIdentity())) R.line(`managed git:      WARN ${w}\n`);
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
        R.line('operator identity: no operator on this route — run `crew connect`\n');
      } else if (!row) {
        R.line(`operator identity: ERROR operator ${op} is not a row of the Crew table\n`);
        process.exitCode = 1;
      } else if (!row.user_id) {
        R.line(
          `operator identity: ERROR Crew row "${row.name ?? op}" has no user_id — their UI comments will read ` +
            '"(no identity)"; re-run `crew connect` to link it\n',
        );
        process.exitCode = 1;
      } else {
        const resolves = memberByIdentity(buildRoster(configuredMembers(route), crewRows), row.user_id);
        R.line(
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
        R.line(
          warnings.length === 0
            ? 'ship holds:       every in-flight ticket is held by a live ship\n'
            : warnings.map((w) => `ship holds:       WARNING ${w}\n`).join(''),
        );
      } catch (e) {
        R.line(`ship holds:       could not check — ${(e as Error).message}\n`);
      }
    }

    // The daemon runs under launchd/systemd with `pathFor(ship)`, not this
    // shell's PATH, so the agent binary and git are checked against that PATH.
    // A miss here is the CREW-1365 failure mode: every spawn ENOENTs.
    const schedulerPath = pathFor(cfg.ship);
    const gitPath = findOnPath('git', schedulerPath);
    // CREW-1511: every configured toolchain gets its binary checked, its
    // tracker-MCP registration inspected and its capability limits printed.
    // The first line keeps the pre-toolchain wording for the default one.
    const defaultToolchain = resolveToolchain(cfg.ship).name;
    let allBinsFound = true;
    for (const tc of shipToolchains(cfg.ship)) {
      const adapter = adapterFor(tc.harness);
      const runBin = launcherExecutable(tc) ?? tc.bin;
      const binPath = findOnPath(runBin, schedulerPath);
      if (!binPath) allBinsFound = false;
      const label = tc.name === defaultToolchain ? 'agent binary:     ' : `toolchain ${tc.name}:`.padEnd(18);
      R.line(
        `${label} ${runBin} — ${binPath ? `OK (${binPath})` : 'NOT FOUND on the scheduler PATH'}` +
          `${tc.name === defaultToolchain ? '' : ` [${adapter.displayName}]`}\n`,
      );
      for (const limit of adapter.limitations) R.line(`                   cannot enforce: ${limit}\n`);
      // CREW-1522: Ori authenticates with an interactive OAuth login; whether that
      // login is visible to a launchd/systemd job is unverified, so say so rather
      // than imply a PATH hit means a headless run will authenticate.
      if (isOmlxLauncher(tc)) {
        // CREW-1554: the oMLX server must be up and hold the model; its API key lives
        // in oMLX's own settings and is never read here.
        const s = readOmlxSettings();
        if (!s) {
          R.line(`                   omlx: ~/.omlx/settings.json not found or has no server.port — cannot check the server\n`);
        } else {
          let status: number | undefined;
          try {
            status = (await fetch(`http://${s.host}:${s.port}/v1/models`, { signal: AbortSignal.timeout(3000) })).status;
          } catch {
            status = undefined;
          }
          const probe = interpretOmlxProbe(status);
          R.line(`                   omlx server: ${s.host}:${s.port} — ${probe.detail}${probe.up ? '' : ' (start oMLX)'}\n`);
          R.line(
            `                   omlx model: ${tc.model} — ${omlxModelPresent(tc.model, s.modelDirs) ? 'present' : `NOT FOUND in ${s.modelDirs.join(', ') || 'any model dir'}`}\n`,
          );
        }
        R.line(`                   local model: tool-call reliability and prefill speed vary by model\n`);
      }
      if (isOriLauncher(tc)) {
        R.line(`                   ori: headless auth under the scheduler is unverified — run \`ori login\` as the scheduler user, then confirm a run records provider openrouter (see docs/toolchains.md)\n`);
      }
    }
    // CREW-1529: repos on this route that run a toolchain other than the route's.
    for (const [repoName, ov] of Object.entries(route.repoOverrides)) {
      if (ov.toolchain) R.line(`repo toolchain:    ${repoName} → ${ov.toolchain} (binary and MCP checked above, as for every ship toolchain)\n`);
    }
    // CREW-3005: with forges configured, git calls crew back as its credential helper; prove that command runs.
    if (cfg.ship.forges) R.line(formatPushAuth('credential helper', probeCredentialHelper(crewCommandLine())).replace('push auth credential helper:', 'credential helper:'.padEnd(19)));
    for (const p of pushAuth) R.line(formatPushAuth(`${p.repo}`, p.result), { repo: p.repo });
    for (const t of toolRows) R.line(formatToolCheck(t));
    R.line(`git:               ${gitPath ? `OK (${gitPath})` : 'NOT FOUND on the scheduler PATH'}\n`);
    if (!allBinsFound || !gitPath) {
      R.line(
        `                   scheduler PATH is ${schedulerPath} — ` +
          'add the directory holding the missing binary to ship.extraPath in crew.yaml, then re-run `crew doctor`.\n',
      );
    }

    // CREW-1378: is the Tablation MCP server registered with each toolchain for this route?
    if (route.apiKey) {
      const mcpUrl = mcpUrlFor(route.baseUrl);
      const seenMcp = new Set<string>();
      for (const tc of shipToolchains(cfg.ship)) {
        const id = `${tc.harness}\0${tc.bin}`;
        if (seenMcp.has(id)) continue;
        seenMcp.add(id);
        const adapter = adapterFor(tc.harness);
        const m = adapter.inspectMcp({ bin: tc.bin, url: mcpUrl, key: route.apiKey });
        R.line(
          m.state === 'registered' ? `mcp:               tablation registered (user scope) → ${m.url}\n`
            : m.state === 'no-binary' ? `mcp:               ${tc.bin} not found — ${adapter.displayName} was not checked\n`
            : m.state === 'different' ? `mcp:               tablation registered but not for this route — ${m.detail}\n`
            : `mcp:               not registered — run crew connect\n`,
        );
      }
    }

    // CREW-1517: is Pair installed for each non-Claude harness `ship.pair` lists?
    for (const h of shipPair(cfg.ship).filter((x) => x !== 'claude')) {
      const inst = pairInstallerFor(h);
      const v = inst.verifyPair({ url: mcpUrlFor(route.baseUrl) });
      R.line(`pair ${h}:`.padEnd(19) + (v.ok ? ` installed (${v.detail})\n` : ` NOT installed — ${v.detail}; run crew connect\n`));
      const envWarn = inst.envWarning?.({ url: mcpUrlFor(route.baseUrl) });
      if (envWarn) R.line(`pair ${h} env:`.padEnd(19) + ` WARN — ${envWarn}\n`);
    }

    // CREW-1515: a seat whose persona names a vendor no toolchain on this ship
    // serves runs the default toolchain with a warning; say so here, up front.
    const shipVendors = new Set(shipToolchains(cfg.ship).map(toolchainVendor));
    if (route.apiKey && route.resolved) {
      let flagged = 0;
      for (const role of ROLE_NAMES) {
        const persona = await fetchSeatPersona(route, role, { userAgent: cfg.ship.userAgent });
        if (persona?.vendor && !shipVendors.has(persona.vendor)) {
          flagged++;
          R.line(`seat vendor:       ${role} persona wants "${persona.vendor}" — no toolchain on this ship serves it (have: ${[...shipVendors].join(', ')}); it will run ${resolveSeat(cfg.ship, route, role).toolchain.name} with a warning\n`);
        }
      }
      if (flagged === 0) R.line('seat vendor:       OK (every persona vendor has a toolchain on this ship)\n');
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
        // CREW-3007: on a sandbox ship the hooks run in the repository's image, so ask the
        // image, not the host PATH. A binary found there (or an image not built yet) clears
        // any item an earlier host-PATH sweep raised.
        const gaps = cfg.ship.runner === 'sandbox' ? sandboxHookGaps({
          route: c.route, repo: r.name, hooks: r.config.hooks, declares: Boolean(r.config.sandbox),
          image: sandboxImageForRun(readSandboxState(cfg.ship.stateDir), r.name, Boolean(r.config.sandbox)),
          hasBinary: imageHasBinary(),
        }) : [];
        for (const name of ['setup', 'test', 'build', 'deploy'] as const) {
          const script = r.config.hooks[name];
          const cmd = script ? hookCommand(script) : null;
          if (!cmd) continue;
          const key = `hook_missing:${c.route}/${r.name}/${name}`;
          if (cfg.ship.runner === 'sandbox') {
            const gap = gaps.find((g) => g.hook === name);
            if (!gap) { clearShipAttention(state, key); continue; }
            R.line(`hook ${c.route}/${r.name} ${name}: \`${cmd}\` NOT FOUND in the sandbox image\n`, { repo: r.name });
            await raiseShipAttention({ state, emit, route: c, ship: cfg.ship }, { kind: 'hook_missing', key, message: gap.message, since: new Date().toISOString() });
            continue;
          }
          if (findOnPath(cmd, schedulerPath)) { clearShipAttention(state, key); continue; }
          R.line(`hook ${c.route}/${r.name} ${name}: \`${cmd}\` NOT FOUND on the scheduler PATH\n`, { repo: r.name });
          await raiseShipAttention({ state, emit, route: c, ship: cfg.ship }, {
            kind: 'hook_missing', key,
            message: `${c.route}/${r.name}: the ${name} hook runs \`${cmd}\`, which is not on the scheduler PATH — add its directory to ship.extraPath in crew.yaml`,
            since: new Date().toISOString(),
          });
        }
      }
    }
    for (const i of visibleAttention(openShipAttention(state), Boolean(dockerFinding))) {
      R.line(`attention:         ${i.kind} — ${i.message} (since ${i.since})\n`);
    }

    // Foreign launchd units (CREW-1376): another checkout's, or a stale one
    // from before this checkout moved. Listed with load state and last exit
    // so a unit firing into a dead path is visible here, not only in launchctl.
    if (host === 'macos') {
      const foreign = describeForeignLaunchdUnits(CREW_HOME);
      if (foreign.length > 0) {
        R.line(`foreign launchd units: not this checkout's — \`crew install\` or \`crew uninstall --all\` clears them\n${foreign.map((f) => `  ${f.trim()}`).join('\n')}\n`);
      }
    }

    // CREW-2793: the sandbox runner needs the OpenShell CLI and a live gateway.
    if (cfg.ship.runner === 'sandbox') {
      const sb = checkSandboxRunner(cfg.ship.sandbox);
      R.line(`sandbox runner:    ${sb.ok ? `OK (${sb.detail})` : `NOT READY — ${sb.detail}`}\n`);
    } else {
      R.line('sandbox runner:    off (ship.runner is host)\n');
    }

    // Host Passengers preflight (ISSUE-553): a route can declare
    // `hostPassengers: true` with no way for `crew connect`/`crew run` to
    // have warned about it yet, so `doctor` is where a missing prerequisite
    // has to surface — clearly, not as a container-lifecycle crash three
    // commands from now.
    const passengerRoutes = cfg.routes.filter((r) => r.enabled && r.hostPassengers);
    if (passengerRoutes.length === 0) {
      R.line('host passengers:   off (no enabled route sets hostPassengers: true)\n');
    } else {
      const dockerOk = dockerAvailable();
      const dockerPathIssue = dockerPathProblem(cfg.ship);
      const dockerKey = 'docker_missing';
      if (dockerPathIssue) {
        R.line(`docker on scheduler PATH: NOT FOUND — ${dockerPathIssue}\n`);
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
      R.line(
        `host passengers:   ON for ${passengerRoutes.map((r) => r.route).join(', ')}\n` +
          `                   docker:     ${dockerOk ? 'OK' : `NOT AVAILABLE${dockerNote}`}\n` +
          `                   ssh-keygen: ${keygenOk ? 'OK' : 'NOT AVAILABLE'}\n` +
          `                   image:      ${image} (${imageOk ? 'present' : 'missing'})\n` +
          `                   relay host: ${cfg.ship.relayHost ? `${cfg.ship.relayHost}:${cfg.ship.relayPort}` : 'not set (ship.relayHost) — containers will run with no tunnel'}\n`,
      );
      if (!dockerOk) {
        R.line(
          '                   Docker Desktop (or another Docker daemon) is required for Host Passengers — ' +
            'install/start it, then re-run `crew doctor`. The toggle stays armed in crew.yaml but nothing will ' +
            'start until Docker answers `docker info`.\n',
        );
      }
      if (!keygenOk) {
        R.line(
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
          R.line(
            `                   ${r.route} url: ${slug ? publicUrlFor(slug, cfg.ship.relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain) : 'not minted yet (first tunnel cycle creates it)'}\n`,
          );
          const controlUrl = slug && readPersistedTunnel(cfg.ship.stateDir, ws)?.controlSocket
            ? `${relayBaseUrlFor(slug, cfg.ship.relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain)}/control`
            : undefined;
          R.line(`                   ${r.route} control url: ${controlUrl ?? 'none (the tunnel carries passengers only)'}\n`);
          const api = endpointApiFor([r])(ws);
          if (!api) continue;
          const probe = await probeEndpointAccess(api, ws);
          R.line(
            `                   ${r.route} mcp endpoints: ` +
              (probe === 'ok' ? 'OK (key may register its endpoint)'
                : probe === 'forbidden' ? `403 — ${REGISTER_MCP_ENDPOINTS_HINT}`
                : `could not check (${probe.error})`) + '\n',
          );
        }
      }
      for (const r of passengerRoutes) {
        const included = passengerRepoTargets(r);
        R.line(
          `                   ${r.route}: ${included.length ? included.map((t) => t.name).join(', ') : '(no repos included)'}\n`,
        );
      }
    }
    // CREW-2794: a stale or missing sandbox image, per declaring repo.
    {
      const declaredS = withShipSandbox(await sandboxReposOf(cfg.routes.filter((r) => r.enabled)));
      const stateS = readSandboxState(cfg.ship.stateDir);
      for (const r of declaredS) {
        const st = sandboxImageStatus(stateS, planSandbox(r.name, r.decl, r.warm, r.bridge));
        R.line(`sandbox image:    ${r.name}: ${st.status.toUpperCase()} — ${st.detail}${st.status === 'ok' ? '' : dockerNote}\n`);
      }
    }
    // CREW-2862: the MCP endpoints live periscopes have registered in their workspaces.
    for (const e of listPeriscopeEndpoints(cfg.ship.stateDir)) {
      const secret = readPeriscopeSecret(cfg.ship.stateDir, e.ticketRecordId) ? 'live' : 'ended, awaiting removal';
      R.line(`periscope mcp:     ${e.ticket} ${e.route} ${e.url} (${secret}, attached only)\n`);
    }
    // CREW-2803: the control API over the relay, end to end, for this route's workspace.
    if (cfg.ship.relayHost && !flag('offline')) {
      const relayUrl = routeRelayUrl(route);
      if (!relayUrl) {
        R.line('relay control:     no tunnel URL yet (the first `crew passengers` cycle opens it)\n');
      } else {
        let key: string | undefined;
        try { key = resolveApiKey(route); } catch { key = undefined; }
        const relayLine = key
          ? describeRelayProbe(relayUrl, await probeRelayControl(relayUrl, key, cfg.ship.userAgent))
          : 'relay control:     could not check (no API key for this route)';
        R.line(`${relayLine}${/FAILED/.test(relayLine) ? dockerNote : ''}\n`);
      }
    }
    // CREW-2236: the last stored `crew selftest` result per toolchain; doctor
    // reports it and never launches a harness itself.
    for (const l of doctorSelftestLines(readSelftest(cfg.ship.stateDir), shipToolchains(cfg.ship).map((t) => t.name))) {
      R.line(`${l}\n`);
    }
    // CREW-2539: which billing path each Claude toolchain resolves to.
    for (const t of shipToolchains(cfg.ship).filter((t) => t.harness === 'claude')) {
      if (t.auth === 'workspace') {
        // CREW-2796: the endpoint host is per route, so one line each.
        for (const r of cfg.routes.filter((r) => r.enabled)) {
          const inference = r.resolved ? { baseUrl: inferenceBaseUrl(r.baseUrl, r.resolved.workspaceId), token: '' } : undefined;
          R.line(`auth:              ${t.name}: ${r.route}: ${describeClaudeAuth({ ...t, inference })}\n`);
        }
        continue;
      }
      R.line(`auth:              ${t.name}: ${describeClaudeAuth(t)}\n`);
    }
    // CREW-1288: the opt-in action phase. `--fix` is itself the consent (so it
    // also works unattended); a plain run only ever offers, and only on a real
    // terminal. A script or non-TTY run without `--fix` never prompts and
    // never changes anything.
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
    const counts = R.counts();
    process.stdout.write(renderDoctor(R, [
      `ship ${cfg.ship.name} (${host}) · route ${route.route} · crew ${sentVersion(cfg.ship) ?? 'unknown version'}${daemonLiveness ? ` · daemon ${daemonLineText(daemonLiveness)}` : ''}`,
    ], flag('verbose')));
    if (flag('fix') || interactive) {
      await doctorFix({ prompt: !flag('fix') || interactive, host, fixFlag: flag('fix'), blockers: counts.blocker, warnings: counts.warning });
    }
    break;
  }

  default:
    usage(`unknown command "${command}"`);
}

lock?.release();
}
