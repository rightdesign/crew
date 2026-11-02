/**
 * Running one agent session.
 *
 * Ported from run_agent in bin/crew. Assembling the prompt and deciding the
 * invocation are separated from performing it, so the whole decision can be
 * inspected — `crew run --dry-run` prints exactly what would be launched
 * without launching it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, createWriteStream, openSync, closeSync, readSync, type WriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { finished } from 'node:stream/promises';
import type { StreamKindEvent } from './stream.ts';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { State } from './state.ts';
import { forgeRunEnv, crewCommandLine } from './forges.ts';
import { raiseShipAttention, clearShipAttention, agentLogRefusedItem, agentLogRefusedKey } from './ship-attention.ts';
import type { Route, RoleName, Ship } from './config.ts';
import { routeSlug, SELF_CONTAINED_ROLES, reposOf } from './config.ts';
import { loadRepoConfig } from './repo-config.ts';
import { ensureLspPlugin, lspFlavor } from './intel.ts';
import type { SandboxPolicyInput } from './sandbox-policy.ts';
import { API_KEY_VAR } from './environment.ts';
import type { Emitter } from './events.ts';
import { inferenceBaseUrl } from './adapters/claude.ts';
import { adapterFor, resolveSeat, toolchainProvider, type CodeBridge, type PersonaChoice, type ToolchainSpec } from './toolchain.ts';
import { INTEL_SERVER_NAME, wantsCodeBridge } from './intel.ts';
import { intelDir } from './intel-bridge.ts';
import { resolveContract } from './contract.ts';
import { BeforeFirstEditTracker } from './tool-classify.ts';
import { reportAgentRun, queueAgentRun, queueTicketCounters, AgentLogUnreachableError, AgentLogHttpError, type AgentLogTarget, type AgentCycle } from './agent-log.ts';
import { HandoffTranscriptTracker } from './handoff-transcript.ts';
import { writePendingHandoff, stateDirOfStream } from './pending-handoff.ts';
import { swapSandboxSkills } from './sandbox-brief.ts';
import { expandSkillMarkers, SkillIncludeError, type ExpandResult } from './skill-include.ts';
import { listLocalSkills } from './skills.ts';
import { runnerFor, runnerOfSidecar, type Runner, type StartedRun, type RunnerKind } from './runner.ts';
import { deadlineFor, msUntilDeadline, resolveMaxRunMinutes, WALL_CLOCK_REASON } from './run-limit.ts';
import { appendAdditions } from './prompt-additions.ts';
import { TicketAttributionTracker, isClaimWrite } from './ticket-attribution.ts';

/**
 * A digest older than this is treated as absent. Acting on a stale queue is
 * worse than rebuilding it: the ticket it names may already have moved.
 */
export const DIGEST_MAX_AGE_SECONDS = 600;

const LEGACY_TOOLCHAIN_HARNESS = 'claude';
const LEGACY_TOOLCHAIN_PROVIDER = 'anthropic';

// The tool grant, deny list and billing scrub are the Claude adapter's now
// (CREW-1511); re-exported so existing importers keep working.
export { allowedTools, DISALLOWED_TOOLS, BILLING_VARS_TO_UNSET } from './adapters/claude.ts';

/** The environment a session inherits: the process's own, minus the harness's billing-sensitive vars. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env, harness = LEGACY_TOOLCHAIN_HARNESS): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const v of adapterFor(harness).unsetEnv) delete out[v];
  return out;
}

/**
 * Set in every headless agent session's environment (below), to whichever
 * role planned the run. Two independent things key off it: the operator's
 * `pair-context-hook.sh` (see the comment on `setEnv.CREW_LANE_ROLE` below),
 * and `cli.ts`'s own refusal of state-writing subcommands run from inside a
 * session (ISSUE-980) — the same value, read for a second, unrelated reason.
 */
export const CREW_LANE_ROLE_VAR = 'CREW_LANE_ROLE';

export interface PromptParts {
  roster: string;
  /**
   * Everything specific to this route and repository — ids, hooks, the
   * worktree convention. The briefs name none of it (ISSUE-293), so without
   * this section they refer to things the session has no way to resolve.
   */
  environment: string;
  common: string;
  brief: string;
  digest?: string;
  digestAgeSeconds?: number;
  digestBytes?: number;
}

/**
 * Roster first, then the environment, then the shared policy, then this
 * role's brief, then the queue.
 *
 * The roster leads because everything below refers to seats and to the
 * operator generically, and it is what binds those words to real names. The
 * environment comes next for the same reason: the briefs name no id, path or
 * command, so it is what binds THOSE words to real ones.
 */
export function assemblePrompt(p: PromptParts): string {
  const sections = [p.roster, p.environment, `${p.common}${p.brief}`];
  if (p.digest) sections.push(p.digest);
  return sections.join('\n\n');
}

export interface AgentPlan {
  role: RoleName;
  route: string;
  cwd: string;
  bin: string;
  args: string[];
  /**
   * Which toolchain (`toolchains:` entry) and harness adapter planned this
   * run. `harness` is optional so a hand-built plan means Claude, as before.
   */
  toolchain?: string;
  harness?: string;
  /** CREW-2796: the run authenticates through the workspace inference endpoint. */
  workspaceAuth?: boolean;
  /** Who serves/bills the model (`adapter.provider`); a hand-built plan means Anthropic. */
  provider?: string;
  /** Why that toolchain and model (`--dry-run`'s resolution chain). */
  resolution?: { toolchain: string; model: string };
  /** Seat-resolution fallbacks, emitted as `warn` events when the run starts. */
  warnings?: string[];
  /** Wall-clock limit in minutes (CREW-2786); absent or 0 means none. `planAgentRun` always sets it. */
  maxRunMinutes?: number;
  /**
   * Where the run executes (CREW-2793). Absent means the host runner, as before.
   * Set by `planAgentRun` from `ship.runner`; `sandboxConfig` is `ship.sandbox`.
   */
  runner?: RunnerKind;
  sandboxConfig?: Partial<import('./runner.ts').SandboxConfig>;
  /** CREW-2801: what the generated sandbox policy is derived from. Set with `runner: sandbox`. */
  sandboxPolicy?: SandboxPolicyInput;
  /** Passed on stdin, never as argv — see `spawnAgent`. */
  prompt: string;
  promptBytes: number;
  unsetEnv: string[];
  /**
   * Added to the session's environment. Carries the tracker key, so that a
   * brief never has to tell an agent where someone else's secrets are kept.
   */
  setEnv: Record<string, string>;
  digestAttached: boolean;
  digestAgeSeconds?: number;
  model: string;
  /**
   * Where the raw `stream-json` NDJSON for this run is saved, unmodified,
   * as it is parsed (ISSUE-401) — the post-mortem artifact and what
   * crew-macos will browse.
   */
  streamPath: string;
  /**
   * Fine-grained per-block (thought/text/tool) events, mapped from the
   * stream but kept OUT of the shared `events.jsonl` that `crew status`
   * scans — a long session is thousands of tool calls, and that file is
   * not the place for them. A view opts in by tailing this file directly.
   */
  eventsPath: string;
  /** Best-effort — the ticket this run is expected to work, if known yet. */
  ticket?: string;
  /**
   * The tracker record id of the ticket the runner claimed for this run, when
   * it claimed one. Recorded in the run's `.pid` sidecar so that a run found
   * dead after a daemon restart can say which ticket it was holding.
   */
  ticketRecordId?: string | null;
  /** The repo name of the ticket this run was selected for (CREW-2822), for `crew status`. */
  repo?: string | null;
  /** The route's own name (`ws/proj`); `route` above is its filename-safe slug and cannot be turned back. */
  routeName?: string;
  /**
   * Where to report this run's Agent Log / Agent Log Cycles rows
   * (ISSUE-416/ISSUE-457), when the route has a resolved workspace to
   * report into and a key to report with. Undefined skips reporting
   * entirely — same as a route `crew connect` hasn't run on yet.
   */
  agentLog?: AgentLogTarget;
  /**
   * ISSUE-377/529 — carried straight through to `reportAgentRun`, see
   * `AgentRunReport.promptVersion`/`promptSha` (agent-log.ts) for what each
   * one means and how `crew logbook show --prompt` uses it.
   */
  promptVersion?: string;
  promptSha: string;
}

export interface PlanOptions {
  role: RoleName;
  route: Route;
  ship: Ship;
  stateDir: string;
  roster: string;
  environment: string;
  /** The tracker key, handed to the session in the environment. */
  apiKey?: string;
  /** Whose key `apiKey` is (`resolveSeatKey`). Only `auth: workspace` cares: it refuses `ship`. */
  seatKind?: 'agent' | 'ship';
  /**
   * Groups this run with the rest of its poll cycle in the streams
   * directory — same id as the `Emitter` driving the run (`emit.cycle`).
   */
  cycle: string;
  /**
   * CREW-2821: tells apart two runs of one role started in one cycle. Added to
   * the stream names and used to find the run's own digest
   * (`poll.ts#digestPath`), so concurrent runs no longer write or read the
   * same files. Omitted, names are exactly as before.
   */
  runId?: string;
  /** Best-effort — the top actionable ticket the poll saw, if any. */
  ticket?: string;
  /** The claimed ticket's tracker record id; lands in `AgentPlan.ticketRecordId`. */
  ticketRecordId?: string | null;
  /** Injected for testing; defaults to the real clock. */
  now?: () => number;
  /**
   * A workspace admin's live edit to this role's Agent-table prompt
   * (`agents.ts` `fetchDivergedPrompt`, ISSUE-526), replacing
   * `common.md`+`lane-<role>.md` wholesale when present — that row's
   * `prompt` field IS what those two files' concatenation seeds it with, so
   * a diverged row already carries the full replacement text, not just the
   * lane-specific part. Undefined (the common case) keeps today's
   * local-files behavior; fetching it is the caller's job, not
   * `planAgentRun`'s — this function stays local-I/O only.
   */
  divergedPrompt?: string;
  /**
   * The Agent row's non-blank `prompt_additions` (`agents.ts`
   * `fetchPersonaPrompt`, TABL-1716): appended after the effective brief —
   * local or diverged — before `{{skill:}}` markers expand, so additions may
   * include markers and `promptSha` covers them.
   */
  personaAdditions?: string;
  /**
   * Workspace Agent Skills rows an admin has edited, by skill name
   * (`skills.ts` `fetchSkillOverrides`, CREW-1534): consulted before the
   * local `skills/*.md` file when expanding `{{skill: Name}}` includes in the
   * brief. Fetching is the caller's job, as with `divergedPrompt`.
   */
  skillOverrides?: Record<string, string>;
  /**
   * The linked Agent row's own `model` field (`agents.ts`
   * `fetchSeatAgentModel`, ISSUE-611), overriding `ship.agent.model` for
   * this run when the workspace has set one. Undefined (no seat, no linked
   * Agent, or the row has no `model`) keeps today's ship-wide default.
   * Fetching it is the caller's job, same as `divergedPrompt` above.
   */
  agentModel?: string;
  /**
   * The linked Agent row's `model`, `tier` and `vendor` together
   * (`agents.ts` `fetchSeatPersona`, CREW-1515), resolved against the ship's
   * toolchains by `resolveSeat`. Supersedes `agentModel`, which stays for
   * callers that only know a model. Undefined keeps the route/ship default.
   */
  agentPersona?: PersonaChoice;
  /**
   * The repo name (`repoTargetFor(...).name`) of the ticket this run was
   * selected for, when one was: feeds `repos.<name>.toolchain` (CREW-1529).
   * Undefined for a run with no ticket (triage, no candidate).
   */
  repo?: string;
  /**
   * `role`'s linked Agent row id, straight from `agents.ts`'s
   * `resolveAgentId` (ISSUE-670) — the same cache-then-seat-fallback
   * resolution `fetchDivergedPrompt`/`fetchSeatAgentModel` already use, so
   * Agent Log attribution stops depending on `crew agents sync` ever having
   * run. Before this field existed, `agentLog.agentId` below read the sync
   * cache directly and stayed empty for any route provisioned solely
   * through `crew connect` (ISSUE-609/610/611) — every one of that route's
   * runs then logged as "Unknown persona" in the Activity Log, since the
   * seat-linked Agent row was resolvable but nothing was resolving it for
   * logging. Undefined (no seat, no linked Agent, unreachable tracker) keeps
   * today's no-Agent-reference report.
   */
  resolvedAgentId?: string;
}

export class AgentError extends Error {}

/**
 * The agent binary could not be started at all: `spawn` emitted `error`,
 * typically ENOENT because `ship.agent.bin` is not on this machine's PATH.
 * Nothing ran, so there is no run to log, and the daemon treats it as a
 * failed start rather than a started role (ISSUE-1365).
 */
/**
 * What a sandboxed run's policy is derived from (CREW-2801): the forge hosts
 * of the route's repositories, the route's Tablation host, the auth mode and
 * provider of the run's toolchain, and the hosts and toolchains the ticket's
 * repository declares in its `.crew.yaml` `sandbox:` section.
 */
export function sandboxPolicyInputFor(
  route: Route,
  toolchain: ToolchainSpec,
  o: { harnessBin: string; repo?: string | null; sandbox?: { agentBin?: string; mirrorDir?: string; workDir?: string } },
): SandboxPolicyInput {
  const repos = reposOf(route);
  const forgeHosts = [...new Set(repos.map((r) => r.forgeHost ?? 'github.com'))];
  const dir = repos.find((r) => r.name === o.repo)?.dir ?? route.dir;
  let declared: ReturnType<typeof loadRepoConfig> = null;
  try { declared = loadRepoConfig(dir); } catch { /* a malformed .crew.yaml is reported where it is read; the policy then carries no extras */ }
  return {
    forgeHosts,
    tablationUrl: route.baseUrl,
    authMode: toolchain.auth ?? 'inherit',
    provider: toolchainProvider(toolchain),
    harnessBin: o.sandbox?.agentBin ?? o.harnessBin,
    ...(declared?.sandboxNetwork ? { extraHosts: declared.sandboxNetwork.hosts, toolchains: declared.sandboxNetwork.toolchains } : {}),
    ...(o.sandbox?.mirrorDir ? { mirrorDir: o.sandbox.mirrorDir } : {}),
    ...(o.sandbox?.workDir ? { workDir: o.sandbox.workDir } : {}),
  };
}

/**
 * CREW-2916: the language-server plugin directory a run loads when the ticket's
 * repository declares an `*-lsp` `hooks.intel` flavor. Best-effort like
 * `sandboxPolicyInputFor`: a missing or malformed `.crew.yaml` means no plugin.
 */
export function lspPluginDirsFor(route: Route, repo: string | null | undefined, stateDir: string): string[] | undefined {
  try {
    const dir = reposOf(route).find((r) => r.name === repo)?.dir ?? route.dir;
    const flavor = lspFlavor(loadRepoConfig(dir)?.hooks.intel);
    return flavor ? [ensureLspPlugin(stateDir, flavor, dir)] : undefined;
  } catch { return undefined; }
}

export class AgentSpawnError extends AgentError {}

/**
 * `auth: workspace` cannot run this seat (CREW-2796): the endpoint accepts seat keys only, so a
 * seat that would fall back to the ship key, or a route `crew connect` has not resolved, is
 * refused rather than sent to the endpoint to fail. The daemon turns it into an attention item.
 */
export class WorkspaceAuthRefused extends AgentSpawnError {}

/**
 * The endpoint refused a call because the workspace is past its AI allowance (CREW-2796). The
 * role pauses on this route until a later pass finds the allowance open again.
 */
export class WorkspaceAllowanceExhausted extends AgentError {}

/** What the endpoint's allowance refusal carries (`AI_ALLOWANCE_EXCEEDED: ...`); the CLI echoes it into the stream. */
export const ALLOWANCE_REFUSAL_MARKER = 'AI_ALLOWANCE_EXCEEDED';

/**
 * Whether a finished run's stream shows the endpoint's allowance refusal. Only the CLI's own error
 * reporting counts: the final `result` event with `is_error: true`, or an assistant message the CLI
 * flagged as an API error. The marker anywhere else (a tool result that read a file or ticket
 * mentioning it, a user turn) is run content, not a refusal, and must not pause a healthy role.
 */
export function streamShowsAllowanceRefusal(streamPath: string): boolean {
  let raw: string;
  try { raw = readFileSync(streamPath, 'utf8'); } catch { return false; }
  if (!raw.includes(ALLOWANCE_REFUSAL_MARKER)) return false;
  for (const line of raw.split('\n')) {
    if (!line.includes(ALLOWANCE_REFUSAL_MARKER)) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as { type?: unknown; is_error?: unknown; isApiErrorMessage?: unknown; error?: unknown; result?: unknown; message?: unknown };
    if (e.type === 'result' && e.is_error === true) {
      if (typeof e.result === 'string' && e.result.includes(ALLOWANCE_REFUSAL_MARKER)) return true;
    } else if (e.type === 'assistant' && (e.isApiErrorMessage === true || e.error !== undefined)) {
      if (JSON.stringify(e.message ?? '').includes(ALLOWANCE_REFUSAL_MARKER)) return true;
    }
  }
  return false;
}

/** `poll.ts#digestPath`, restated here because `poll.ts` imports this module. */
const digestPathFor = (stateDir: string, routeLabel: string, role: string, runId?: string): string =>
  join(stateDir, `digest-${routeLabel}-${role}${runId ? `-${runId}` : ''}.md`);

/** Everything the run WOULD do, decided without doing any of it. */
/**
 * CREW-2912: the stdio bridge registered as `code` at launch, for a host lane run on a
 * repository whose `.crew.yaml` declares `intel`. The session cannot add a server after it
 * starts and the worktree (so the service's URL) does not exist yet, so crew registers a
 * server it owns now and `crew worktree` hands it the URL later. Nothing is registered for a
 * repository without `intel` or a run without a ticket; a sandbox run has no `crew` binary or
 * state directory of ours inside it.
 */
export function codeBridgeFor(o: PlanOptions, harness: string): CodeBridge | undefined {
  if (o.ship.runner === 'sandbox' || !o.ticket) return undefined;
  const number = /(\d+)$/.exec(o.ticket)?.[1];
  if (!number) return undefined;
  let intel: string | undefined;
  try {
    const repos = reposOf(o.route);
    const target = repos.find((r) => r.name === o.repo) ?? (repos.length === 1 ? repos[0] : undefined);
    intel = target ? loadRepoConfig(target.dir)?.hooks?.intel : undefined;
  } catch { /* a malformed .crew.yaml is reported where it is read; a route with no checkout has nothing to bridge */ }
  if (!wantsCodeBridge(intel)) return undefined;
  const args = [...process.execArgv, process.argv[1] ?? 'crew', 'intel', 'bridge', o.route.route, number, '--state-dir', o.stateDir];
  const bridge: CodeBridge = { command: process.execPath, args };
  if (harness === 'gemini') {
    // Gemini has no per-run server list; a system settings file named by env var is the per-run scope.
    const file = join(intelDir(o.stateDir, o.route.route, number), 'gemini-settings.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ mcpServers: { [INTEL_SERVER_NAME]: { command: bridge.command, args } } }, null, 2)}\n`);
    bridge.settingsFile = file;
  }
  return bridge;
}

export function planAgentRun(o: PlanOptions): AgentPlan {
  const briefPath = join(o.route.promptsDir, 'personas', `lane-${o.role}.md`);
  if (!existsSync(briefPath)) {
    throw new AgentError(`no brief at ${briefPath} — refusing to run an unscoped session`);
  }
  // A self-contained role (`config.ts`'s SELF_CONTAINED_ROLES — today triage
  // and pair) gets its brief alone. For the others, a preset that still ships
  // `personas/common.md` gets it in front of the brief; the shipped presets
  // instead include their policy by `{{skill: ...}}` marker (CREW-1534).
  const commonPath = join(o.route.promptsDir, 'personas', 'common.md');
  const usesCommon = !SELF_CONTAINED_ROLES.has(o.role) && existsSync(commonPath);

  const now = o.now ?? (() => Date.now());
  const routeLabel = routeSlug(o.route.route);
  // see poll.ts digestPath(): the run's own digest when it has one, else the role's
  const ownDigest = o.runId ? digestPathFor(o.stateDir, routeLabel, o.role, o.runId) : undefined;
  const digestPath = ownDigest && existsSync(ownDigest) ? ownDigest : digestPathFor(o.stateDir, routeLabel, o.role);
  let digest: string | undefined;
  let ageSeconds: number | undefined;
  if (existsSync(digestPath)) {
    ageSeconds = Math.floor((now() - statSync(digestPath).mtimeMs) / 1000);
    if (ageSeconds <= DIGEST_MAX_AGE_SECONDS) digest = readFileSync(digestPath, 'utf8');
  }

  const common = usesCommon ? readFileSync(commonPath, 'utf8') : '';
  const brief = readFileSync(briefPath, 'utf8');
  // A diverged row's prompt is the full common+brief replacement (see
  // `divergedPrompt`'s own doc on `PlanOptions`), so it goes entirely into
  // `brief` with `common` left empty rather than splitting it back apart.
  const effectiveCommon = o.divergedPrompt ? '' : common;
  const effectiveBrief = appendAdditions(o.divergedPrompt ?? brief, o.personaAdditions);
  // CREW-1534: includes expand over the effective brief — the admin's edit
  // when diverged, else the local file — so the hash below covers what ran.
  const localSkills = new Map(listLocalSkills(o.route.promptsDir).map((s) => [s.name, s.prompt]));
  let expanded: ExpandResult;
  try {
    expanded = expandSkillMarkers(
      `${effectiveCommon}${effectiveBrief}`,
      (name) => o.skillOverrides?.[name] ?? localSkills.get(name),
    );
  } catch (e) {
    if (e instanceof SkillIncludeError) throw new AgentError(`${e.message} — refusing to run an unscoped session`);
    throw e;
  }
  // CREW-2800: a sandboxed run reads the sandbox setup skill where the policy names the worktree one.
  if (o.ship.runner === 'sandbox') expanded = { ...expanded, text: swapSandboxSkills(expanded.text) };
  const prompt = assemblePrompt({
    roster: o.roster,
    environment: o.environment,
    common: '',
    brief: expanded.text,
    digest,
  });
  // ISSUE-377/529: hashed at composition time, over whatever content was
  // actually assembled above (the diverged replacement when present, else
  // the local common+brief) — exactly the string `crew agents sync`
  // (agents.ts's `personaDefaultPrompt`) pushes into this role's Agents row
  // when not diverged, so a later `crew logbook show --prompt` can tell
  // whether the local file has moved on from what `prompt_version` points at.
  const promptSha = createHash('sha256').update(expanded.text).digest('hex');

  const streamsDir = join(o.stateDir, 'streams');
  const base = `${routeLabel}-${o.role}-${o.cycle}${o.runId ? `-${o.runId}` : ''}`;
  const seat = resolveSeat(o.ship, o.route, o.role, o.agentPersona ?? (o.agentModel ? { model: o.agentModel } : {}), o.repo);
  const { model } = seat;
  let toolchain = seat.toolchain;
  if (toolchain.auth === 'workspace') {
    if (!o.apiKey || o.seatKind === 'ship') {
      throw new WorkspaceAuthRefused(`${o.role}: toolchain ${toolchain.name} has auth: workspace, which needs the seat's own agent key — this seat would fall back to the ship key (run \`crew agents sync\`)`);
    }
    if (!o.route.resolved) {
      throw new WorkspaceAuthRefused(`${o.role}: toolchain ${toolchain.name} has auth: workspace, but route ${o.route.route} is not connected (run \`crew connect\`)`);
    }
    toolchain = { ...toolchain, inference: { baseUrl: inferenceBaseUrl(o.route.baseUrl, o.route.resolved.workspaceId), token: o.apiKey } };
  }
  const adapter = adapterFor(toolchain.harness);
  const code = codeBridgeFor(o, adapter.harness);
  const invocation = adapter.invocation(toolchain, {
    code,
    role: o.role,
    model,
    pluginDirs: adapter.harness === 'claude' ? lspPluginDirsFor(o.route, o.repo, o.stateDir) : undefined,
    // Skipped when there's no key to send: a route `crew connect` hasn't
    // resolved yet has nothing to authenticate the MCP connection with either.
    mcp: o.apiKey ? { url: `${o.route.baseUrl}/api/mcp`, keyVar: API_KEY_VAR } : undefined,
  });

  // Reporting needs a resolved workspace (`crew connect`) and a key to call
  // it with — either is missing for a route that hasn't been connected, or
  // in tests that build a bare Route by hand. `agentId` is best-effort on
  // top of that: `o.resolvedAgentId` (ISSUE-670) already fell back to the
  // seat's own linked Agent row when `crew agents sync` has never run, and
  // the endpoint accepts a run with no Agent reference for the cases even
  // that can't resolve (no seat, no linked Agent, unreachable tracker).
  const columns = resolveContract(o.route.contract).columns;
  const agentLog: AgentPlan['agentLog'] = o.route.resolved && o.apiKey
    ? {
        baseUrl: o.route.baseUrl,
        workspaceId: o.route.resolved.workspaceId,
        apiKey: o.apiKey,
        userAgent: o.ship.userAgent,
        agentId: o.resolvedAgentId,
        ...(o.route.resolved.models?.issues ? { tickets: {
          issuesModelId: o.route.resolved.models.issues,
          keyColumn: columns.key,
          tagColumn: columns.tag,
          counters: {
            agentRuns: columns.agentRuns, tokensIn: columns.tokensIn, tokensOut: columns.tokensOut,
            cacheReadTokens: columns.cacheReadTokens, cacheWriteTokens: columns.cacheWriteTokens, costUsd: columns.costUsd,
          },
        } } : {}),
      }
    : undefined;

  return {
    role: o.role,
    route: routeLabel,
    // The route's directory, which is a STARTING POINT and not the
    // ticket's repo: the session picks its own working directory even when
    // the runner already selected a ticket (`o.repo` is known then, and
    // only feeds the per-repo toolchain choice). Where an area spans
    // several repos this is whichever one `repos` happened to list first
    // (config.ts), and the digest's `repo` column is what actually places
    // the work. Kept deliberately rather than guessed at (ISSUE-349).
    cwd: o.route.dir,
    bin: invocation.bin,
    args: invocation.args,
    toolchain: toolchain.name,
    harness: toolchain.harness,
    workspaceAuth: toolchain.auth === 'workspace',
    provider: toolchainProvider(toolchain),
    maxRunMinutes: resolveMaxRunMinutes(o.route.maxRunMinutes, toolchain.maxRunMinutes),
    ...(o.ship.runner === 'sandbox'
      ? {
          runner: 'sandbox' as const,
          ...(o.ship.sandbox ? { sandboxConfig: o.ship.sandbox } : {}),
          sandboxPolicy: sandboxPolicyInputFor(o.route, toolchain, { harnessBin: invocation.bin, repo: o.repo, sandbox: o.ship.sandbox }),
        }
      : {}),
    resolution: { toolchain: seat.toolchainWhy, model: seat.modelWhy },
    warnings: [...(seat.warnings ?? []), ...expanded.warnings],
    prompt,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    unsetEnv: adapter.unsetEnv,
    setEnv: {
      ...(o.apiKey ? { [API_KEY_VAR]: o.apiKey } : {}),
      ...adapter.runEnv(toolchain, { code }),
      // The operator's global SessionStart hook (pair-context-hook.sh) injects
      // the interactive Pair persona's prompt for any session it can't tell
      // apart from a person's own terminal. Every headless lane run this
      // planner produces carries a real ticket brief already (`prompt`
      // above) — it must never be replaced by the Pair persona with no
      // ticket attached, which silently no-ops and strands the ticket
      // in_progress (ISSUE-490, ISSUE-591). Setting this is what lets that
      // hook tell the two apart; it has nothing to do with the run itself.
      [CREW_LANE_ROLE_VAR]: o.role,
      // CREW-2783: the ship's forge credential — git helper config plus the
      // token as an env var for `gh` and friends. Empty without `forges:`.
      ...forgeRunEnv(o.ship.forges, { crewCommand: crewCommandLine(), configFile: process.env.CREW_CONFIG, stateDir: o.stateDir }),
    },
    digestAttached: digest !== undefined,
    digestAgeSeconds: ageSeconds,
    model,
    streamPath: join(streamsDir, `${base}.jsonl`),
    eventsPath: join(streamsDir, `${base}.events.jsonl`),
    ticket: o.ticket,
    ticketRecordId: o.ticketRecordId ?? null,
    repo: o.repo ?? null,
    routeName: o.route.route,
    agentLog,
    promptVersion: o.route.resolved?.agentPersonas?.[o.role]?.historyId,
    promptSha,
  };
}

/** A human-readable account of a plan, for `--dry-run`. */
export function describePlan(p: AgentPlan): string {
  return [
    `role:    ${p.role}`,
    ...(p.resolution ? [`resolved: toolchain ${p.toolchain} ← ${p.resolution.toolchain}; model ${p.model} ← ${p.resolution.model}${p.provider ? `; provider ${p.provider}` : ''}`] : []),
    ...(p.warnings ?? []).map((w) => `warning: ${w}`),
    // Only for a non-default toolchain, so a plain Claude run's output is unchanged.
    ...(p.toolchain && p.toolchain !== 'claude' ? [`toolchain: ${p.toolchain} (${p.harness ?? 'claude'})`] : []),
    `cwd:     ${p.cwd}`,
    `command: ${p.bin} ${p.args.join(' ')}`,
    `prompt:  ${p.promptBytes} bytes on stdin (never argv)`,
    `digest:  ${p.digestAttached ? `attached, ${p.digestAgeSeconds}s old` : 'absent — the agent will fetch the tracker itself'}`,
    `unset:   ${p.unsetEnv.join(' ')}`,
    // The VALUE is deliberately absent: --dry-run output is pasted into
    // tickets and chat.
    `set:     ${Object.keys(p.setEnv).join(' ') || '(nothing)'}`,
    `stream:  ${p.streamPath}`,
  ].join('\n');
}

export interface RunResult {
  code: number;
  ms: number;
  /** The run's hand-off write failed against an unreachable tracker; a pending record was left for replay (CREW-2363). */
  handoffPending?: boolean;
  /** The daemon ended the run at its wall-clock limit (CREW-2786); the worktree is left for the hand-back. */
  killed?: { limitMinutes: number; elapsedMs: number };
}

/**
 * What survives of a run that outlived the process that spawned it
 * (CREW-1775): `<stream>.pid`, written at spawn. Everything the finish path
 * needs to report the run from a different process — and nothing secret: the
 * Agent Log key is re-resolved by whoever reattaches, never stored.
 */
export interface RunSidecar {
  pid: number;
  /**
   * The crew process that spawned it. While that process lives it is the one
   * finishing the run, so nobody else may adopt it; once it is gone the run
   * is an orphan (CREW-1775).
   */
  ownerPid: number;
  /** ISO time of the spawn; with `pid` it tells a live run from a recycled pid. */
  spawnedAt: string;
  /**
   * ISO time the run's wall-clock limit expires (CREW-2786); absent when it has none. Kept here so a
   * daemon that restarts mid-run still enforces the original deadline.
   */
  deadline?: string;
  /** The limit `deadline` came from, in minutes. */
  maxRunMinutes?: number;
  role: RoleName;
  route: string;
  ticket: string | null;
  /** The tracker record id of the ticket the runner claimed for this run, if any. */
  ticketRecordId: string | null;
  /** Which runner started it (CREW-2793); absent on sidecars written before, which are host runs. */
  runner?: RunnerKind;
  /** The OpenShell sandbox the run executes in; `pid` is then the `sandbox exec` client on the host. */
  sandbox?: string;
  sandboxBin?: string;
  /** The repo name of the ticket the run was selected for (CREW-2822), when known. */
  repo?: string | null;
  /** The route's own name (`ws/proj`), where `route` is the slug; absent on sidecars written before CREW-2822. */
  routeName?: string;
  model: string;
  toolchain: string;
  harness: string;
  provider: string;
  eventsPath: string;
  agentLog?: Omit<AgentLogTarget, 'apiKey'>;
  promptVersion?: string;
  promptSha: string;
}

/** The sidecar path for a stream. */
export const pidPathFor = (streamPath: string): string => `${streamPath}.pid`;

export function readRunSidecar(streamPath: string): RunSidecar | null {
  try {
    const sc = JSON.parse(readFileSync(pidPathFor(streamPath), 'utf8')) as Partial<RunSidecar>;
    return typeof sc.pid === 'number' && typeof sc.spawnedAt === 'string' && typeof sc.role === 'string'
      ? (sc as RunSidecar)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is still the process spawned at `spawnedAt`. A bare
 * `kill(pid, 0)` would adopt any unrelated process that inherited a recycled
 * pid, so the process's own start time (`ps -o lstart=`, second resolution)
 * has to agree with the spawn time too.
 */
export function runIsAlive(sc: Pick<RunSidecar, 'pid' | 'spawnedAt'>): boolean {
  try {
    process.kill(sc.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(sc.pid)], { encoding: 'utf8' });
  const started = Date.parse(ps.stdout.trim());
  // No readable start time (a platform without this `ps`): the pid check stands.
  if (ps.status !== 0 || Number.isNaN(started)) return ps.status === 0;
  return Math.abs(started - Date.parse(sc.spawnedAt)) < 15_000;
}

/** Everything the finish path needs from a plan, so a reattached run can be reported without one. */
type RunIdentity = Pick<RunSidecar, 'role' | 'route' | 'ticket' | 'model' | 'toolchain' | 'harness' | 'provider' | 'eventsPath' | 'agentLog' | 'promptVersion' | 'promptSha'> & {
  streamPath: string;
};

function identityOf(plan: AgentPlan, adapterHarness: string): RunIdentity {
  return {
    role: plan.role, route: plan.route, ticket: plan.ticket ?? null, model: plan.model,
    toolchain: plan.toolchain ?? LEGACY_TOOLCHAIN_HARNESS, harness: adapterHarness,
    provider: plan.provider ?? LEGACY_TOOLCHAIN_PROVIDER,
    eventsPath: plan.eventsPath, streamPath: plan.streamPath,
    agentLog: plan.agentLog ? withoutKey(plan.agentLog) : undefined,
    promptVersion: plan.promptVersion, promptSha: plan.promptSha,
  };
}

/**
 * Ends a run that has outlived its wall-clock limit and records `run_killed`
 * on the event stream with the reason and the elapsed time (CREW-2786). Shared
 * by the process that spawned the run and by one that adopted it.
 */
async function killForDeadline(
  kill: () => Promise<void>, pid: number | undefined, emit: Emitter, role: RoleName, ticket: string | null,
  spawnedAt: string, limitMinutes: number | undefined,
): Promise<{ limitMinutes: number; elapsedMs: number }> {
  const elapsedMs = Date.now() - Date.parse(spawnedAt);
  const limit = limitMinutes ?? Math.round(elapsedMs / 60_000);
  emit.emit(`run_killed: ${role} run exceeded its wall-clock limit of ${limit} min (ran ${Math.round(elapsedMs / 60_000)} min)`, {
    role, ...(ticket ? { ticket } : {}),
    data: { event: 'run_killed', reason: WALL_CLOCK_REASON, limitMinutes: limit, elapsedMs, pid },
  });
  await kill();
  return { limitMinutes: limit, elapsedMs };
}

const withoutKey = ({ apiKey: _apiKey, ...rest }: AgentLogTarget): Omit<AgentLogTarget, 'apiKey'> => rest;

/**
 * Opens a sink for writing, or gives up quietly.
 *
 * Same rule as `Emitter.emit`'s own sinks: a stream that cannot be prepared
 * degrades observability, it must never prevent the agent run itself.
 */
function openSink(path: string): WriteStream | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return createWriteStream(path, { flags: 'a' });
  } catch {
    return undefined;
  }
}

/**
 * Ends a sink and waits for its buffered writes to actually land on disk.
 *
 * `WriteStream#end()` is asynchronous — a caller reading the file right after
 * `spawnAgent`'s promise resolves (as tests and any post-mortem tooling do)
 * can otherwise see a short or empty file. Same degrade-quietly contract as
 * `openSink`: a sink that errors on flush must not fail the run it was only
 * ever a side-channel for.
 */
function endSink(sink: WriteStream | undefined): Promise<void> {
  if (!sink) return Promise.resolve();
  sink.end();
  return finished(sink).catch(() => undefined);
}

/**
 * Reads whatever has been appended to a file since the last `poll`.
 *
 * The agent's stdout is the stream file itself (see `spawnAgent`), not a pipe
 * to this process, so this is how the runner sees it — and how a different
 * process, after a restart, replays a run from the top (`offset` 0).
 */
class FileTail {
  private offset = 0;
  private readonly decoder = new StringDecoder('utf8');
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  poll(): string {
    let fd: number;
    try { fd = openSync(this.path, 'r'); } catch { return ''; }
    try {
      let text = '';
      const chunk = Buffer.alloc(64 * 1024);
      for (;;) {
        const n = readSync(fd, chunk, 0, chunk.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        text += this.decoder.write(chunk.subarray(0, n));
      }
      return text;
    } finally {
      closeSync(fd);
    }
  }
}

const TAIL_POLL_MS = 200;

/**
 * Turns a run's stream into the crew's own view of it — mapped events, Agent
 * Log cycles, the final result and ticket attribution — one line at a time.
 * Shared by the process that spawned the run and by a restarted daemon that
 * reattaches to it, which replays the stream from the top with `muted` set so
 * events the first process already wrote are not written twice.
 */
class RunObserver {
  readonly cycles: AgentCycle[] = [];
  readonly attribution = new TicketAttributionTracker();
  /** Hand-off writes and their outcomes, to tell a run whose hand-off never landed (CREW-2363). */
  readonly handoff = new HandoffTranscriptTracker();
  result: ReturnType<ReturnType<typeof adapterFor>['extractResult']>;
  /** Prefix tokens of the first assistant call that carried usage; kept once. */
  prefixTokens: number | undefined;
  /** Tool calls before the run's first edit (CREW-2879). */
  readonly beforeFirstEdit = new BeforeFirstEditTracker();
  /** Set once the stream carries the harness's final result (turn count or cost). */
  sawResult = false;
  muted = false;
  /**
   * The label stamped on events. Starts as the poll hint and switches to the
   * ticket the run actually claims (CREW-1776); `id.ticket` stays the hint.
   */
  liveTicket: string | undefined;
  /** Called after `liveTicket` changes, so the sidecar can be rewritten. */
  onClaim?: () => void;
  private buf = '';
  private readonly startMs = Date.now();
  private readonly mapper: { map(p: unknown): StreamKindEvent[]; flush(): StreamKindEvent[] };
  private readonly id: RunIdentity;
  private readonly adapter: ReturnType<typeof adapterFor>;
  private readonly eventsSink: WriteStream | undefined;
  private readonly emitCycle: string;

  constructor(id: RunIdentity, adapter: ReturnType<typeof adapterFor>, eventsSink: WriteStream | undefined, emitCycle: string) {
    this.id = id;
    this.adapter = adapter;
    this.eventsSink = eventsSink;
    this.emitCycle = emitCycle;
    this.liveTicket = id.ticket ?? undefined;
    this.mapper = adapter.createStreamMapper?.() ?? { map: (p: unknown) => adapter.mapStreamLine(p), flush: () => [] };
  }

  feed(text: string): void {
    this.buf += text;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  end(): void {
    if (this.buf) this.handleLine(this.buf);
    this.buf = '';
    try { this.consume(undefined, this.mapper.flush()); } catch { /* ditto */ }
  }

  private handleLine(line: string): void {
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;   // not our schema's stability guarantee — drop and move on
    }
    try {
      // Field by field: Codex reports the session id and a turn's usage on
      // different lines, and a later line must not erase an earlier field.
      const got = this.adapter.extractResult(parsed);
      if (got) {
        this.result = { ...this.result, ...Object.fromEntries(Object.entries(got).filter(([, v]) => v !== undefined)) };
        if (got.numTurns !== undefined || got.costUsd !== undefined) this.sawResult = true;
      }
      this.handoff.feed(parsed);
      this.consume(parsed, this.mapper.map(parsed));
    } catch {
      /* a shape this run's mapping does not expect must not kill the cycle */
    }
  }

  // Turns mapped events (and, when there is a source line, its token usage)
  // into sink writes and buffered cycles. `parsed` is undefined for events
  // the mapper flushes at end of stream, which have no line of their own.
  private consume(parsed: unknown, events: StreamKindEvent[]): void {
    const plan = this.id;
    let turnText = '';
    // Names in this message's text come before its tool calls, so a claim in
    // the same message as "claiming TABL-1763" resolves to that key.
    for (const ev of events) if ((ev.kind === 'thought' || ev.kind === 'text') && ev.text) this.attribution.note(ev.text);
    for (const ev of events) {
      if (ev.kind === 'tool') this.attribution.noteWrite(ev.tool, ev.input);
      // A replayed (muted) stream has lost the real timing, so it counts without a time.
      if (ev.kind === 'tool') this.beforeFirstEdit.note(ev.tool, ev.target, this.muted ? undefined : Date.now() - this.startMs);
      if (ev.kind === 'tool' && isClaimWrite(ev.tool, ev.input)) {
        const claimed = this.attribution.current;
        if (claimed && claimed !== this.liveTicket) {
          if (!this.muted) {
            this.eventsSink?.write(`${JSON.stringify({
              at: new Date().toISOString(), cycle: this.emitCycle, route: plan.route, step: 'agent', level: 'info',
              message: `ticket: ${this.liveTicket ?? 'none'} → ${claimed}`, role: plan.role, ticket: claimed,
              data: { kind: 'ticket', from: this.liveTicket ?? null, to: claimed },
            })}\n`);
          }
          this.liveTicket = claimed;
          if (!this.muted) this.onClaim?.();
        }
      }
      const e = {
        at: new Date().toISOString(),
        cycle: this.emitCycle,
        route: plan.route,
        step: 'agent' as const,
        level: 'info' as const,
        message: ev.kind === 'tool' ? `${ev.tool ?? 'tool'}${ev.target ? ` ${ev.target}` : ''}` : ev.kind,
        role: plan.role,
        ...(this.liveTicket ? { ticket: this.liveTicket } : {}),
        data: { kind: ev.kind, ...(ev.text ? { text: ev.text } : {}), ...(ev.tool ? { tool: ev.tool } : {}), ...(ev.target ? { target: ev.target } : {}) },
      };
      if (!this.muted) this.eventsSink?.write(`${JSON.stringify(e)}\n`);
      if ((ev.kind === 'thought' || ev.kind === 'text') && ev.text) {
        turnText += `${ev.text}\n`;
        const cycleIndex = this.cycles.length;
        this.cycles.push({
          cycleIndex,
          occurredAt: e.at,
          thinking: ev.text,
          // A conversational `text` turn is tagged 'assistant' so it's
          // distinguishable from a thinking block once both share this
          // buffer (ISSUE-594) — matching the precedent
          // `agent-chat.service.ts`'s logChatRun (ISSUE-504) already set
          // for the same column. A `thought` cycle stays untagged, same
          // as before this change.
          ...(ev.kind === 'text' ? { role: 'assistant' as const } : {}),
        });
        // A second event alongside the raw `thought`/`text` one above
        // (ISSUE-481) — a live consumer (crew-macos's log window) wants
        // the same text correlated with the Agent Log Cycle it will end
        // up as (`cycleIndex`, matching `AgentCycle` above) plus which
        // seat/persona produced it, not just the bare text the source
        // event carries. `cycleIndex` only exists here, in the buffer
        // this function already owns, not in `mapStreamLine` — that
        // mapper is deliberately a pure, per-line function with no run
        // state, so it stays the one place deciding "is this a thinking
        // block or a text turn", and this is the one place that knows which
        // numbered cycle it became.
        if (!this.muted) {
          this.eventsSink?.write(`${JSON.stringify({
            ...e,
            message: 'cycle',
            data: { kind: 'cycle', cycleIndex, text: ev.text },
          })}\n`);
        }
      }
    }
    // Only an `assistant` line carries `message.usage` (one real API
    // call), so this is a no-op for every other line type — including
    // the tool-only assistant lines already folded into `turnText`
    // above as an empty string, which `TicketAttributionTracker.add`
    // treats as "no new mention, keep crediting whatever ticket was
    // last named."
    if (this.prefixTokens === undefined && parsed !== undefined) this.prefixTokens = this.adapter.extractPrefixTokens?.(parsed);
    const turnTokens = parsed === undefined ? undefined : this.adapter.extractTurnTokens(parsed);
    if (turnTokens !== undefined) this.attribution.add(turnText, turnTokens);
  }
}

/**
 * Writes `<stream>.meta.json`. Called at spawn (`exitCode: null`), on a claim
 * and on close, so a run killed before `close` still names the ticket it was
 * on (CREW-1776). `hint` is the poll's pre-run guess, `ticket` the live label.
 */
function writeRunMeta(
  id: RunIdentity, startedAt: string, liveTicket: string | undefined, extra: Record<string, unknown>,
): void {
  try {
    writeFileSync(`${id.streamPath}.meta.json`, JSON.stringify({
      route: id.route, role: id.role, hint: id.ticket, ticket: liveTicket ?? id.ticket,
      startedAt, model: id.model,
      toolchain: id.toolchain, harness: id.harness, provider: id.provider,
      exitCode: null,
      running: true,
      ...extra,
    }));
  } catch { /* the sidecar is a convenience, not load-bearing */ }
}

/**
 * Reads the run's dispatch ticket back after the run and says whether its
 * status or assignee changed since dispatch: the hand-off signal for a run
 * that wrote through MCP tools crew never saw as tracker writes (CREW-2598).
 */
export type HintMoved = () => Promise<boolean>;

/** How a run ended, as far as the finishing process can tell. */
interface RunEnd {
  /** The agent's exit code; null when this process never saw it exit (a reattached run). */
  code: number | null;
  /** Why the run stopped short of finishing, when it did (`daemon-exit`: it was found dead after a restart). */
  interrupted?: string;
}

/**
 * Writes the sidecar, the finish (or interrupted) event and the Agent Log row
 * for a run — the one finish path both `spawnAgent` and a reattach go through.
 */
async function finishRun(
  id: RunIdentity, obs: RunObserver, emit: Emitter, startedAt: string, end: RunEnd, agentLogKey?: string,
  hintMoved?: HintMoved,
): Promise<{ ms: number; ticket: string | undefined; handoffPending: boolean }> {
  // The ticket this run's tracker writes targeted (hand-off, then claim, then
  // comment); only a run with no such write falls back to the ticket it spent
  // the most tokens on, then the pre-run poll hint (CREW-2364).
  // The read-back only matters when no write was observed; a failed GET is
  // simply "no signal" (CREW-2598).
  let moved = false;
  if (hintMoved) { try { moved = await hintMoved(); } catch { /* no signal */ } }
  const { ticket: attributedTicket, by: attributedBy } = obs.attribution.decide(obs.liveTicket, { hintMoved: moved });
  // Which toolchain, harness and provider produced this run (CREW-1516),
  // beside `model`. `toolchain` is the crew.yaml entry name, so it lives in
  // the sidecar and the event only — the Agent Log carries harness+provider.
  const identity = { toolchain: id.toolchain, harness: id.harness, provider: id.provider };
  const { result } = obs;
  // A hand-off write that hit an unreachable tracker, with no later success.
  // The branch may well be pushed; only the board does not know (CREW-2363).
  const pending = end.interrupted ? null : obs.handoff.pending();
  if (pending) {
    try {
      const now = new Date();
      writePendingHandoff(stateDirOfStream(id.streamPath), {
        ...pending, version: 1, route: id.route, role: id.role,
        ...(attributedTicket ? { ticket: attributedTicket } : {}),
        streamPath: id.streamPath, createdAt: now.toISOString(), attempts: 0, nextAttemptAt: now.toISOString(),
      });
    } catch (e) {
      emit.warn(`could not save the pending hand-off: ${(e as Error).message}`, { step: 'agent' });
    }
  }
  const before = obs.beforeFirstEdit.result();
  try {
    writeRunMeta(id, startedAt, obs.liveTicket, {
      attributedTicket: attributedTicket ?? null,
      attributedBy,
      running: undefined,
      exitCode: end.code,
      ...(end.interrupted ? { interrupted: end.interrupted } : {}),
      ...(pending ? { handoff: 'pending' } : {}),
      sessionId: result?.sessionId ?? null, numTurns: result?.numTurns ?? null, prefixTokens: obs.prefixTokens ?? null,
      beforeFirstEdit: before,
      totalCostUsd: result?.costUsd ?? null,
    });
  } catch { /* ditto — the sidecar is a convenience, not load-bearing */ }
  const ms = Date.now() - Date.parse(startedAt);
  emit.emit(end.interrupted ? 'agent run interrupted' : `agent run finished (${pending ? 'hand-off pending' : `exit ${end.code ?? 'unknown'}`})`, {
    data: {
      ms, code: end.code,
      ...(pending ? { handoff: 'pending' } : {}),
      ...(end.interrupted ? { interrupted: end.interrupted } : {}),
      ...identity,
      attributedTicket: attributedTicket ?? null, attributedBy,
      ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
      callsBeforeFirstEdit: before.calls, edited: before.edited,
      ...(before.secondsToFirstEdit !== undefined ? { secondsToFirstEdit: before.secondsToFirstEdit } : {}),
      ...(result?.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
      ...(result?.costUsd !== undefined ? { totalCostUsd: result.costUsd } : {}),
    },
  });
  if (id.agentLog && agentLogKey) {
    const report = {
        ticketReference: attributedTicket,
        outcome: end.interrupted ? 'interrupted' : end.code === 0 || (end.code === null && obs.sawResult) ? 'success' : 'error',
        startedAt,
        finishedAt: new Date().toISOString(),
        cycles: obs.cycles,
        model: id.model,
        tokensIn: result?.inputTokens,
        tokensOut: result?.outputTokens,
        cacheReadTokens: result?.cacheReadTokens,
        cacheWriteTokens: result?.cacheWriteTokens,
        costUsd: result?.costUsd,
        // Both come from a finished run: without the result line (interrupted) neither is trustworthy.
        ...(result?.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
        ...(result?.numTurns !== undefined && obs.prefixTokens !== undefined ? { prefixTokens: obs.prefixTokens } : {}),
        beforeFirstEdit: before,
        harness: identity.harness,
        provider: identity.provider,
        promptVersion: id.promptVersion,
        promptSha: id.promptSha,
    };
    try {
      const sent = await reportAgentRun({ ...id.agentLog, apiKey: agentLogKey }, report);
      // The tracker took this seat's report, so a standing refusal for the route is over (CREW-2832).
      try { clearShipAttention(new State(stateDirOfStream(id.streamPath)), agentLogRefusedKey(id.route)); } catch { /* attention is a convenience */ }
      if (sent.counterWarning) emit.warn(sent.counterWarning, { step: 'agent' });
      // The row exists but the tracker would not take the increment: queue just
      // that write, so the spend is not lost and the row is not posted twice.
      if (sent.counterRetry) {
        try {
          queueTicketCounters(stateDirOfStream(id.streamPath), basename(id.streamPath, '.jsonl'), {
            version: 1, route: id.route, role: id.role, target: id.agentLog, write: sent.counterRetry,
            attempts: 0, nextAttemptAt: new Date().toISOString(),
          });
        } catch { /* the warning above already says the spend was not added */ }
      }
    } catch (e) {
      // The tracker did not answer, so no row exists: keep the report and send
      // it on a later pass rather than losing the run's record (CREW-2363).
      if (e instanceof AgentLogUnreachableError) {
        try {
          queueAgentRun(stateDirOfStream(id.streamPath), basename(id.streamPath, '.jsonl'), {
            version: 1, route: id.route, role: id.role, target: id.agentLog, report,
            attempts: 0, nextAttemptAt: new Date().toISOString(),
          });
          emit.warn(`could not report agent log (${e.message}); queued to retry`, { step: 'agent' });
          return { ms, ticket: attributedTicket, handoffPending: !!pending };
        } catch { /* fall through to the plain warning */ }
      }
      // A refusal is not retried, so surface it on the ship instead of leaving
      // only the warn line below: once per route, updated if the status moves (CREW-2832).
      if (e instanceof AgentLogHttpError && e.row && e.status >= 400 && e.status < 500) {
        try {
          await raiseShipAttention({ state: new State(stateDirOfStream(id.streamPath)), emit },
            agentLogRefusedItem(id.route, id.role, e.status));
        } catch { /* the warn line below still says it */ }
      }
      // A workspace that has never been provisioned/backfilled (ISSUE-465),
      // or a plain network hiccup, must not fail the run it is reporting
      // on — same reasoning as `openSink`'s degrade-quietly contract above.
      emit.warn(`could not report agent log: ${(e as Error).message}`, { step: 'agent' });
    }
  }
  return { ms, ticket: attributedTicket, handoffPending: !!pending };
}

/**
 * Launch it.
 *
 * The prompt goes in on STDIN, never as an argv string. `claude -p` reads it
 * either way, but an argument is world-readable in `ps` output for the whole
 * run — a full policy document, including credentials it tells the agent to
 * provision, once sat in every process listing on the machine. Stdin also
 * keeps the runner clear of ARG_MAX.
 *
 * Stdout is `--output-format stream-json`: NDJSON, one object per assistant
 * turn/tool-call/tool-result plus a final `{type:"result"}`. It is the stream
 * file itself (`plan.streamPath` — the post-mortem artifact), opened for
 * append and handed to the child as its stdout, and this process tails that
 * file to map it onto the crew's own event model (`plan.eventsPath` — see the
 * module doc on `AgentPlan` for why that is a separate file from the shared
 * `events.jsonl`). A pipe here would tie the run to this process: once the
 * reader is gone the agent's next write fails with EPIPE, so a daemon restart
 * would kill the run no matter what process group it was in (CREW-1775).
 *
 * The child also gets a process group of its own (`detached`), so launchd or
 * systemd taking down the daemon's group does not take the run with it, and a
 * `<stream>.pid` sidecar so the next daemon can find it (`reattachRun`).
 */
export function spawnAgent(plan: AgentPlan, emit: Emitter, hintMoved?: HintMoved): Promise<RunResult> {
  const adapter = adapterFor(plan.harness ?? LEGACY_TOOLCHAIN_HARNESS);
  const runner: Runner = runnerFor(plan.runner, plan.sandboxConfig);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  for (const w of plan.warnings ?? []) emit.warn(w, { step: 'agent', role: plan.role });
  const eventsSink = openSink(plan.eventsPath);
  const id = identityOf(plan, adapter.harness);

  let streamFd: number;
  try {
    mkdirSync(dirname(plan.streamPath), { recursive: true });
    streamFd = openSync(plan.streamPath, 'a');
  } catch (e) {
    void endSink(eventsSink);
    return Promise.reject(new AgentSpawnError(`cannot open the stream file ${plan.streamPath}: ${(e as Error).message}`));
  }
  const failed = (e: unknown): Promise<never> => {
    void endSink(eventsSink);
    return Promise.reject(new AgentSpawnError(`cannot run ${plan.bin}: ${(e as Error).message}`));
  };
  // The host runner spawns synchronously, so the child (and its sidecar) exist when this returns.
  let begun: StartedRun | Promise<StartedRun>;
  try {
    begun = runner.start(plan, { env: { ...scrubbedEnv(process.env, adapter.harness), ...plan.setEnv }, streamFd, emit });
  } catch (e) {
    closeSync(streamFd);
    return failed(e);
  }
  if (begun instanceof Promise) {
    return begun.then(
      (run) => { closeSync(streamFd); return supervise(run); },
      (e) => { closeSync(streamFd); return failed(e); },
    );
  }
  closeSync(streamFd);   // the child holds its own copy
  return supervise(begun);

  function supervise({ child, handle, promptDelivered }: StartedRun): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnedAt = new Date().toISOString();
    const deadline = deadlineFor(spawnedAt, plan.maxRunMinutes);
    if (child.pid !== undefined) {
      const sidecar: RunSidecar = {
        pid: child.pid, ownerPid: process.pid, spawnedAt, role: plan.role, route: plan.route,
        ...(deadline ? { deadline, maxRunMinutes: plan.maxRunMinutes } : {}),
        ...(handle.runner === 'sandbox' ? { runner: 'sandbox' as const, sandbox: handle.sandbox, sandboxBin: handle.sandboxBin } : {}),
        ticket: plan.ticket ?? null, ticketRecordId: plan.ticketRecordId ?? null, repo: plan.repo ?? null, routeName: plan.routeName, model: plan.model,
        toolchain: id.toolchain, harness: id.harness, provider: id.provider, eventsPath: plan.eventsPath,
        agentLog: id.agentLog, promptVersion: plan.promptVersion, promptSha: plan.promptSha,
      };
      try { writeFileSync(pidPathFor(plan.streamPath), JSON.stringify(sidecar)); } catch { /* a run nobody can find again is no worse than before */ }
    }

    const obs = new RunObserver(id, adapter, eventsSink, emit.cycle);
    // Written at spawn and rewritten on claim and on close, so an interrupted
    // run (no `close`) still leaves a sidecar naming the ticket it was on (CREW-1776).
    const meta = { pid: child.pid ?? null, ...(deadline ? { deadline } : {}) };
    obs.onClaim = () => writeRunMeta(id, startedAt, obs.liveTicket, meta);
    if (child.pid !== undefined) writeRunMeta(id, startedAt, obs.liveTicket, meta);
    const tail = new FileTail(plan.streamPath);
    const timer = setInterval(() => obs.feed(tail.poll()), TAIL_POLL_MS);

    // The wall-clock limit (CREW-2786): end the run at its deadline. The
    // `close` handler below then finishes it as interrupted, exactly as for any killed run.
    let killed: RunResult['killed'];
    const limitTimer = child.pid !== undefined && deadline
      ? setTimeout(() => {
          void killForDeadline(() => runner.kill(handle, WALL_CLOCK_REASON), child.pid, emit, plan.role, obs.liveTicket ?? plan.ticket ?? null, spawnedAt, plan.maxRunMinutes)
            .then((k) => { killed = k; });
        }, Math.max(0, msUntilDeadline(deadline) ?? 0))
      : undefined;

    // Set when `spawn` itself failed. Node still emits `close` after `error`
    // in that case, and the close handler below must not then report a run
    // that never happened: no "agent run finished" event, no Agent Log row.
    let spawnFailed = false;
    child.on('error', (err) => {
      spawnFailed = true;
      clearInterval(timer);
      clearTimeout(limitTimer);
      void runner.release(handle, emit);
      reject(new AgentSpawnError(`cannot run ${plan.bin}: ${err.message}`));
    });
    child.on('close', async (code) => {
      clearInterval(timer);
      clearTimeout(limitTimer);
      obs.feed(tail.poll());
      obs.end();
      await endSink(eventsSink);
      if (spawnFailed) return;
      await runner.release(handle, emit);
      // `killed` is set once the kill returns, which can trail `close` by a tick.
      if (limitTimer && !killed && !obs.sawResult && msUntilDeadline(deadline)! <= 0) {
        killed = { limitMinutes: plan.maxRunMinutes ?? 0, elapsedMs: Date.now() - Date.parse(spawnedAt) };
      }
      const { ms, handoffPending } = await finishRun(
        id, obs, emit, startedAt, { code: code ?? 1, ...(killed ? { interrupted: WALL_CLOCK_REASON } : {}) },
        plan.agentLog?.apiKey, hintMoved,
      );
      resolve({ code: code ?? 1, ms, ...(handoffPending ? { handoffPending } : {}), ...(killed ? { killed } : {}) });
    });
    // An agent that exits (or closes stdin) before the prompt is fully written
    // breaks the pipe under this write. Without a listener that EPIPE is an
    // unhandled 'error' event and takes the whole `crew run` down with a stack
    // trace (CREW-983) — instead of the run being reported, as it should be,
    // by the `close` handler above, which sees the child's real exit code
    // either way. So the write failing is noted, never fatal.
    child.stdin?.on('error', (err) => {
      emit.warn(`agent closed stdin before the prompt was delivered: ${err.message}`, { step: 'agent' });
    });
    // An uploaded prompt (over the sandbox stdin limit) is already in place; writing it again would push
    // the same multi-MiB payload through the exec client's stdin, which is what the upload avoids.
    if (promptDelivered) child.stdin?.end(); else child.stdin?.end(plan.prompt);
  });
  }
}

export interface ReattachOptions {
  /** The key to report the Agent Log row with; without one the row is skipped. */
  agentLogKey?: string;
  /** Injected for tests; defaults to `runIsAlive`. */
  isAlive?: (sc: RunSidecar) => boolean;
  pollMs?: number;
  /** Called once the run is known to be live, before waiting on it. */
  onAdopted?: () => void;
}

export interface ReattachResult {
  /** Which way it went: still running when found, or already dead. */
  adopted: boolean;
  interrupted?: string;
  /** Set when this process ended the run at its wall-clock limit (CREW-2786). */
  killed?: { limitMinutes: number; elapsedMs: number };
  ms: number;
  /** The ticket the transcript most credited, falling back to the run's hint. */
  ticket: string | undefined;
}

/**
 * Picks up a run whose spawning process is gone (CREW-1775).
 *
 * The stream file is the transcript, so the run is rebuilt by replaying it
 * (muted: the events file already holds what the first process mapped). A
 * live process is waited for and then finished exactly as `spawnAgent` would
 * have; one that is already dead is finished at once as `interrupted` — unless
 * its stream shows the harness's final result, in which case it did complete
 * and only the bookkeeping was lost.
 */
export async function reattachRun(
  streamPath: string, sc: RunSidecar, emit: Emitter, o: ReattachOptions = {},
): Promise<ReattachResult> {
  const adapter = adapterFor(sc.harness);
  const isAlive = o.isAlive ?? runIsAlive;
  const id: RunIdentity = { ...sc, streamPath };
  const eventsSink = openSink(sc.eventsPath);
  const obs = new RunObserver(id, adapter, eventsSink, emit.cycle);
  const tail = new FileTail(streamPath);

  obs.muted = true;
  obs.feed(tail.poll());
  obs.muted = false;

  const runner = runnerOfSidecar(sc);
  const adopted = isAlive(sc);
  let killed: ReattachResult['killed'];
  if (adopted) {
    o.onAdopted?.();
    const pollMs = o.pollMs ?? TAIL_POLL_MS;
    while (isAlive(sc)) {
      obs.feed(tail.poll());
      // The deadline in the sidecar is the ORIGINAL one, so a restarted daemon
      // does not hand a run a fresh clock (CREW-2786).
      if (!killed && (msUntilDeadline(sc.deadline) ?? 1) <= 0) {
        killed = await killForDeadline(() => runner.kill(runner.reattach(sc), WALL_CLOCK_REASON), sc.pid, emit, sc.role, obs.liveTicket ?? sc.ticket, sc.spawnedAt, sc.maxRunMinutes);
        continue;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  obs.feed(tail.poll());
  obs.end();
  await endSink(eventsSink);
  // A sandbox outlives a dead client: delete it whichever way the run ended.
  await runner.release(runner.reattach(sc), emit);

  const interrupted = killed ? WALL_CLOCK_REASON : obs.sawResult ? undefined : adopted ? 'no-result' : 'daemon-exit';
  const { ms, ticket } = await finishRun(
    id, obs, emit, sc.spawnedAt, { code: null, ...(interrupted ? { interrupted } : {}) }, o.agentLogKey,
  );
  return { adopted, ...(interrupted ? { interrupted } : {}), ...(killed ? { killed } : {}), ms, ticket };
}
