/**
 * The daemon's core supervisor loop (ISSUE-762).
 *
 * Today, the `run` route is a series of OS-timer-fired one-shot `crew run`
 * invocations roughly every ~120s (`install.ts`'s `INTERVAL_SECONDS`) — each
 * one polls (`poll.ts#decideCycle`), picks a role (`select.ts`), takes a
 * run-lock/slot (`state.ts#State.acquireRun`) and spawns one agent session,
 * then exits. There is always an idle gap even when there is obviously more
 * work, and concurrency across agent slots only ever happened by two timer
 * fires accidentally overlapping.
 *
 * This file wraps that same per-cycle logic in a persistent loop instead of
 * redesigning it, in two deliberately separate layers:
 *
 *  - `runDaemonLoop` is the scheduler ONLY: zero-idle chaining when a pass
 *    found work, exponential idle backoff up to the ceiling when it didn't,
 *    reset to the floor the moment work is found again. It knows nothing
 *    about tickets, roles or agents — it just calls the `runPass` it is
 *    handed and reacts to whether that pass started anything. This is what
 *    makes it fully unit-testable with a fake `runPass` and an injected
 *    `sleep` (see `daemon.test.ts`).
 *
 *  - `runOnePass` is the real per-pass work: calls `decideCycle` (unchanged),
 *    then walks its `selection.pending` roles most-urgent-first, trying to
 *    fill every open `maxConcurrentAgents` slot with a DIFFERENT eligible
 *    role via `state.acquireRun` (unchanged) — deliberate concurrent-slot
 *    filling, replacing the old accidental-overlap-only concurrency. Never
 *    reimplements `decideCycle`, `selectRole` or `acquireRun`; it only
 *    orchestrates calls to them, plus the same claim/checkout/spawn
 *    sequence `cli.ts`'s one-shot `run` command already performs for a
 *    winning role (`claim.ts#resolveTopCandidate`, `git.ts#ensureRepoCheckout`,
 *    `agent.ts#planAgentRun`/`spawnAgent`).
 *
 * `release` and `passengers` stay on their existing fixed timers, untouched —
 * only the `run` route's cadence changes here.
 *
 * ISSUE-763 (install/lifecycle) is done: `install.ts#planLaunchd`/
 * `planSystemd` now write a real persistent unit for the `run` job whose
 * `ProgramArguments`/`ExecStart` run `crew daemon` — this file's loop —
 * instead of one-shot `crew run`, and `cli.ts`'s `case 'daemon':` handles
 * `start`/`stop`/`status`/`restart` via `install.ts#planDaemonControl` before
 * falling through to the bare foreground-loop form (still used to run/test
 * this file end-to-end without going through a real OS service).
 *
 * ISSUE-764 (self-update) is also done: `computeTreeSignature`/
 * `makeStaleChecker` below give `runDaemonLoop` an optional `checkStale`
 * hook, consulted only on an idle pass (never while chaining on found
 * work — a busy daemon is never interrupted mid-cycle). Once the installed
 * tree's signature moves, the loop returns the `'stale'` stop reason instead
 * of sleeping again; `cli.ts` turns that into a clean `process.exit(0)` so
 * the SAME OS-level auto-restart ISSUE-763 already wired (`KeepAlive`/
 * `Restart=on-failure`) relaunches the daemon against whatever is now on
 * disk. One mechanism covers both crash recovery and staleness, exactly as
 * this file originally proposed. `crew daemon restart` (`cli.ts`) is the
 * explicit, deterministic sibling for a manual `git pull` — it does not go
 * through this signature check at all, it just re-runs the same
 * stop-then-start commands `start`/`stop` already use.
 *
 * Known, deliberately flagged simplification: `buildEnvironment` below
 * (used to build the "Your environment" section of a spawned agent's
 * prompt) skips the ship/area worktree-prefix lookup that `cli.ts`'s
 * `resolvedRepos`/`areaWorktreePrefix` perform (a network round-trip to
 * resolve an area's shared `worktrees.prefix` default). A route with no
 * EXPLICIT `worktrees.prefix` in its own or its ship's config renders
 * `repo-config.ts`'s bare default instead of that resolved one. This is
 * cosmetic — which folder name a brief SUGGESTS a worktree live at — not a
 * scheduling or correctness gap in the loop itself. Worth revisiting
 * whenever this file's production wiring is next touched (plausibly
 * ISSUE-763).
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleName, Route, Ship } from './config.ts';
import { dirForRepo, hydrateApiKeys, repoIdForName, repoTargetFor, reposOf, resolveApiKey } from './config.ts';
import { State } from './state.ts';
import { Emitter } from './events.ts';
import { decideCycle, rosterFor, writeDigest, type CycleDecision } from './poll.ts';
import { rankedCandidates, withHoldCheck } from './select.ts';
import { applyHoldReleases, noteReaccepted } from './ship-affinity.ts';
import { resolveTopCandidate } from './claim.ts';
import { applySweep } from './blocked.ts';
import { AgentSpawnError, planAgentRun, spawnAgent } from './agent.ts';
import { loadRepoConfig, resolveRepoConfig } from './repo-config.ts';
import { renderEnvironment, type EnvironmentRepo } from './environment.ts';
import { DEFAULT_CONTRACT } from './contract.ts';
import { Tracker } from './tracker.ts';
import { ensureRepoCheckout, type GitError } from './git.ts';
import { fetchDivergedPrompt, fetchSeatAgentModel, resolveAgentId } from './agents.ts';
import { raiseShipAttention, clearShipAttention, openShipAttention } from './ship-attention.ts';
import { INTERVAL_SECONDS } from './install.ts';

/** The idle backoff floor: short, so a just-missed cycle doesn't wait long. */
export const DEFAULT_FLOOR_MS = 5_000;

/**
 * The idle backoff ceiling: today's fixed poll cadence
 * (`install.ts#INTERVAL_SECONDS`, the launchd/systemd `StartInterval` every
 * other one-shot invocation already fires on), reused rather than a second
 * hardcoded copy of the same number.
 */
export const DEFAULT_CEILING_MS = INTERVAL_SECONDS * 1000;

// ---------------------------------------------------------------------------
// Layer 1: the scheduler. Pure — no tracker, no filesystem beyond whatever
// `runPass` itself does, no real timers unless the caller wants them.
// ---------------------------------------------------------------------------

export interface PassResult {
  /** Every role `decideCycle` found pending this pass, most-urgent-first. */
  pending: RoleName[];
  /** Roles this pass actually acquired a run slot for and launched. */
  started: RoleName[];
  /** Roles that had work this pass but could not run, and why. */
  skipped: Array<{ role: RoleName; reason: string }>;
}

export type PassRunner = () => Promise<PassResult>;

export interface DaemonLoopOptions {
  runPass: PassRunner;
  /** Idle backoff floor, ms. Defaults to `DEFAULT_FLOOR_MS` (~5s). */
  floorMs?: number;
  /** Idle backoff ceiling, ms. Defaults to today's ~120s poll cadence. */
  ceilingMs?: number;
  /** Injected so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Stops the loop once the in-flight pass returns. */
  signal?: AbortSignal;
  /** Test-only escape hatch: stop after this many passes regardless of `signal`. */
  maxPasses?: number;
  /**
   * Observability hook, called once after every pass with the backoff the
   * loop is about to sleep for (0 when it is about to chain immediately).
   */
  onPass?: (result: PassResult, nextBackoffMs: number) => void;
  /**
   * Self-update detection (ISSUE-764). Consulted only on an IDLE pass, right
   * before the loop would otherwise sleep — never while chaining on found
   * work, so an actively-busy daemon is never interrupted mid-cycle to pick
   * up an update. Returning `true` stops the loop with the `'stale'` reason
   * instead of sleeping again. Typically `makeStaleChecker(...)` below.
   */
  checkStale?: () => boolean;
}

/** Why `runDaemonLoop` returned. `'maxPasses'` only ever fires in a test. */
export type DaemonStopReason = 'aborted' | 'stale' | 'maxPasses';

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The persistent loop itself.
 *
 * Replaces the old model — a fresh OS-timer-fired process does exactly one
 * pass and exits, always waiting out the full interval even right after
 * finishing real work — with one long-running process that:
 *
 * - Chains immediately (no sleep at all) whenever `runPass` started
 *   anything: there may be more work worth starting right away, whether
 *   that's a different pending role this same pass didn't have a slot for,
 *   or the same role's queue moving again the moment its lock frees up.
 * - Backs off when a pass starts nothing: waits `backoff` ms, then doubles
 *   `backoff` up to `ceilingMs` for the next idle pass.
 * - Resets `backoff` to `floorMs` the instant a pass finds work again — a
 *   quiet patch must not leave the next burst of real work waiting out a
 *   ceiling-sized backoff it earned while idle.
 */
export async function runDaemonLoop(o: DaemonLoopOptions): Promise<DaemonStopReason> {
  const floor = o.floorMs ?? DEFAULT_FLOOR_MS;
  const ceiling = o.ceilingMs ?? DEFAULT_CEILING_MS;
  const sleep = o.sleep ?? defaultSleep;
  let backoff = floor;
  let passes = 0;

  for (;;) {
    if (o.signal?.aborted) return 'aborted';
    const result = await o.runPass();
    passes++;

    if (result.started.length > 0) {
      backoff = floor;
      o.onPass?.(result, 0);
      if (o.maxPasses !== undefined && passes >= o.maxPasses) return 'maxPasses';
      continue;   // zero-idle chaining: no sleep at all
    }

    o.onPass?.(result, backoff);
    if (o.maxPasses !== undefined && passes >= o.maxPasses) return 'maxPasses';
    if (o.signal?.aborted) return 'aborted';
    // Checked only here, on an idle pass — never on the chain-immediately
    // branch above, so real work in flight is never interrupted for this.
    if (o.checkStale?.()) return 'stale';
    await sleep(backoff);
    backoff = Math.min(backoff * 2, ceiling);
  }
}

// ---------------------------------------------------------------------------
// Self-update detection (ISSUE-764). A cheap mtime-based signature over
// whichever paths the caller names — deliberately not a content hash: every
// real update (a `git pull`, a redeploy overwriting `dist/`, a new compiled
// binary replacing the old one) touches mtimes for what it changes, and
// stat-ing every file in `src`/`dist`/`bin` once per idle tick is negligible
// next to `INTERVAL_SECONDS`-scale backoff.
// ---------------------------------------------------------------------------

/**
 * The latest mtime (ms since epoch) under `path`, recursing into
 * directories. `0` for a path that doesn't exist (a compiled-binary install
 * has no `src`, a fresh checkout with no build step has no `dist`) so a
 * caller can watch several candidate paths without checking existence
 * itself; a missing path just never moves the combined signature.
 */
function latestMtime(path: string): number {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;
  let latest = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    latest = Math.max(latest, latestMtime(join(path, entry.name)));
  }
  return latest;
}

/**
 * A signature for the given paths, stable as long as nothing under them
 * changes. `cli.ts` passes the paths that actually matter for how THIS
 * process was launched (compiled binary vs. `src`/`dist`/`bin` checkout) —
 * this function itself doesn't know or care which.
 */
export function computeTreeSignature(paths: string[]): string {
  return paths.map((p) => String(latestMtime(p))).join(':');
}

/**
 * Captures the current signature over `paths` and returns a closure that
 * reports whether it has since moved — the `checkStale` hook
 * `DaemonLoopOptions` expects.
 */
export function makeStaleChecker(paths: string[]): () => boolean {
  const initial = computeTreeSignature(paths);
  return () => computeTreeSignature(paths) !== initial;
}

// ---------------------------------------------------------------------------
// Layer 2: one real pass — decideCycle, sweep, and deliberate concurrent-slot
// filling across every pending role via the existing acquireRun lock.
// ---------------------------------------------------------------------------

export interface RoleAgentContext {
  route: Route;
  ship: Ship;
  state: State;
  emit: Emitter;
}

/** The real claim+checkout+spawn sequence for one role, or an injectable fake in tests. */
export type SpawnRoleAgent = (role: RoleName, decision: CycleDecision, ctx: RoleAgentContext) => Promise<void>;

/** The real per-cycle decision, or an injectable fake in tests (`decideCycle` needs a live tracker). */
export type Decide = (ctx: RoleAgentContext) => Promise<CycleDecision>;

// ---------------------------------------------------------------------------
// Spawn-failure backoff (ISSUE-1365). A role whose agent binary cannot be
// started (ENOENT on `ship.agent.bin`) used to count as started, so the loop
// chained straight into another pass and retried as fast as the tracker poll
// allowed: 38 passes in two minutes, one Agent Log error row each.
// ---------------------------------------------------------------------------

/** Consecutive failed starts for one role before it is parked for a ceiling interval. */
export const SPAWN_PARK_AFTER = 3;

export interface SpawnFailureReport {
  /** This failure reached `SPAWN_PARK_AFTER`: the role is parked. */
  parked: boolean;
  /** The message differs from this role's previous failure, so it is worth a fresh log line. */
  firstOfMessage: boolean;
  /** Consecutive failed starts for this role, including this one. */
  failures: number;
  /** How long the role must wait before it may be started again. */
  retryInMs: number;
}

interface SpawnFailureState {
  failures: number;
  retryAt: number;
  lastMessage: string;
}

/**
 * Per-role memory of failed starts. A failed start waits `floor * 2^(n-1)`
 * (5s, then 10s, ...) before the role may start again. At `SPAWN_PARK_AFTER`
 * consecutive failures the role is parked for the ceiling interval instead.
 * Any run that spawns successfully clears the role's history.
 *
 * Held by the caller across passes (`cli.ts` keeps one per daemon process).
 * `now` is injectable so tests never wait.
 */
export class SpawnBreaker {
  private readonly states = new Map<RoleName, SpawnFailureState>();
  private readonly now: () => number;
  private readonly floorMs: number;
  private readonly ceilingMs: number;

  constructor(opts: { now?: () => number; floorMs?: number; ceilingMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.floorMs = opts.floorMs ?? DEFAULT_FLOOR_MS;
    this.ceilingMs = opts.ceilingMs ?? DEFAULT_CEILING_MS;
  }

  /** Whether `role` may be started right now. */
  allows(role: RoleName): boolean {
    const s = this.states.get(role);
    return !s || this.now() >= s.retryAt;
  }

  /** Records a failed start of `role` and says what to report about it. */
  recordFailure(role: RoleName, message: string): SpawnFailureReport {
    const prev = this.states.get(role);
    const failures = (prev?.failures ?? 0) + 1;
    const parked = failures >= SPAWN_PARK_AFTER;
    const retryInMs = parked ? this.ceilingMs : Math.min(this.floorMs * 2 ** (failures - 1), this.ceilingMs);
    this.states.set(role, { failures, retryAt: this.now() + retryInMs, lastMessage: message });
    return { parked, firstOfMessage: prev?.lastMessage !== message, failures, retryInMs };
  }

  /** A run for `role` spawned: forget its earlier failed starts. */
  recordSuccess(role: RoleName): void {
    this.states.delete(role);
  }
}

export interface RunOnePassOptions {
  route: Route;
  ship: Ship;
  state: State;
  /** This machine's overall agent concurrency capacity — `ship.maxConcurrentAgents`. */
  maxConcurrentAgents: number;
  /**
   * A fresh `Emitter` per pass: every `decideCycle`/digest/stream artifact
   * downstream is keyed by `emit.cycle`, the same way one-shot `crew run`
   * treats one process invocation as one cycle.
   */
  newEmitter: () => Emitter;
  /**
   * Bookkeeping only, for a caller that wants to await every agent this pass
   * launched before it exits (e.g. a future graceful `crew daemon stop` —
   * ISSUE-763's concern, not built here). Correctness never depends on
   * this: `state.acquireRun`'s lock files are what actually prevent
   * double-running a role or exceeding capacity, in this process or any
   * other `crew` invocation on the machine.
   */
  inFlight?: Set<Promise<void>>;
  /** Injected for testing. Defaults to the real `decideCycle`. */
  decide?: Decide;
  /** Injected for testing. Defaults to the real claim+checkout+spawn (`runRoleAgent`). */
  spawnRoleAgent?: SpawnRoleAgent;
  /**
   * Injected for testing (ISSUE-966) — forwarded to `hydrateApiKeys`'s own
   * `getStore` parameter so a test never touches a real OS keychain.
   * Defaults to `hydrateApiKeys`'s own default (the real
   * `@tablation/client` backend) when left undefined.
   */
  getSessionStore?: () => import('@tablation/client').SessionStore;
  /**
   * Spawn-failure memory (ISSUE-1365). Must be the same instance across every
   * pass of one daemon run — a fresh one per pass forgets its failures and
   * re-enables the retry storm. Left unset, a per-call one is used, which is
   * only correct for a single pass (tests).
   */
  spawnBreaker?: SpawnBreaker;
}

/**
 * One pass: decide, sweep, then try to fill every open slot with a different
 * eligible pending role.
 *
 * Every attempt goes through `state.acquireRun`, exactly as `cli.ts`'s
 * one-shot `run` command does — its role-exclusive lock is what stops this
 * pass (or a future one, or any other `crew` process on the machine) from
 * double-running a role already in flight, and its N-slot capacity lock is
 * what stops the fleet exceeding `maxConcurrentAgents` overall. Walking
 * every PENDING role (not just the single highest-ranked `selection.selected`
 * `decideCycle` already computes) is what makes the filling deliberate
 * rather than one-role-per-pass: dev, design and qa can all be mid-agent at
 * once, bounded only by capacity.
 *
 * Never awaits the agents it starts — it returns as soon as it has tried
 * every pending role, so `runDaemonLoop` can chain into the next pass
 * immediately (zero-idle chaining) while those agents are still running.
 */
export async function runOnePass(o: RunOnePassOptions): Promise<PassResult> {
  // CREW-1372: `crew pause` is honored here too, the same refusal the one-shot
  // `run` makes before `decideCycle` (cli.ts). A paused pass does no keychain
  // read, no poll, no sweep and no spawn, so the loop backs off like any idle
  // pass. A run already in flight when the marker appears is not touched.
  // Per-role pauses need no check here: `decideCycle` already drops paused
  // roles from selection (poll.ts `pausedRoles`), so they never reach the loop.
  if (o.state.isPaused()) return { pending: [], started: [], skipped: [] };

  // Re-check the OS keychain for this route on every cycle (ISSUE-966) —
  // cheap for a route that isn't keychain-backed at all (see
  // `hydrateApiKeys`'s own doc comment), and what lets a re-`crew connect`
  // (a new device-login session) take effect on the very next pass instead
  // of requiring a daemon restart.
  await hydrateApiKeys([o.route], o.getSessionStore);
  const emit = o.newEmitter();
  const decide = o.decide ?? decideCycle;
  const spawn = o.spawnRoleAgent ?? runRoleAgent;
  const breaker = o.spawnBreaker ?? new SpawnBreaker();
  const ctx: RoleAgentContext = { route: o.route, ship: o.ship, state: o.state, emit };

  const decision = await decide(ctx);

  if (decision.sweep.length) {
    const tracker = new Tracker(o.route, o.ship);
    const seat = o.route.resolved?.seats.qa ?? o.route.resolved?.seats.dev ?? '';
    try {
      const r = await applySweep(tracker, decision.sweep, seat, emit);
      emit.emit(
        `swept ${r.parked} parked, ${r.restored} restored` +
          `${r.failed ? `, ${r.failed} failed` : ''}${r.contended ? `, ${r.contended} contended` : ''}`,
        { step: 'sweep', data: r },
      );
    } catch (e) {
      emit.warn(`could not sweep: ${(e as Error).message}`, { step: 'sweep' });
    }
  }
  if (decision.holdReleases?.length) {
    const tracker = new Tracker(o.route, o.ship);
    await applyHoldReleases(tracker, decision.holdReleases, tracker.contract, emit);
  }

  // Most urgent first, same comparator `decideCycle`/`selectRole` already
  // ranked with — a role with no rank (shouldn't happen for a pending role,
  // but `ranks` is a Partial) sorts last rather than crashing the pass.
  const order = [...decision.selection.pending].sort(
    (a, b) => (decision.selection.ranks[a] ?? Number.POSITIVE_INFINITY) -
      (decision.selection.ranks[b] ?? Number.POSITIVE_INFINITY),
  );

  const started: RoleName[] = [];
  const skipped: Array<{ role: RoleName; reason: string }> = [];

  for (const role of order) {
    if (!breaker.allows(role)) {
      skipped.push({ role, reason: 'agent recently failed to start — waiting before retry' });
      continue;
    }
    const lock = o.state.acquireRun(role, o.maxConcurrentAgents);
    if (!lock.ok) {
      skipped.push({ role, reason: lock.reason });
      continue;
    }
    started.push(role);
    const run = spawn(role, decision, ctx)
      .then(() => {
        breaker.recordSuccess(role);
        clearShipAttention(o.state, `role_parked:${role}`);
      })
      .catch(async (e) => {
        const message = (e as Error).message;
        if (!(e instanceof AgentSpawnError)) {
          emit.warn(`${role} agent run failed: ${message}`, { step: 'agent', role });
          return;
        }
        // Nothing ran, so this is not an agent run failure: warn once per
        // distinct message, and say so when the role is parked.
        const report = breaker.recordFailure(role, message);
        if (report.firstOfMessage || report.parked) {
          emit.warn(`${role} agent could not start: ${message}`, { step: 'agent', role });
        }
        if (report.parked) {
          emit.error(
            `${role} parked for ${Math.round(report.retryInMs / 1000)}s after ${report.failures} ` +
              'consecutive failed starts — check that ship.agent.bin is installed and on PATH',
          );
          // CREW-1373: visible from the board and `crew status`, not only this ship's log.
          await raiseShipAttention({ state: o.state, emit, route: o.route, ship: o.ship }, {
            kind: 'role_parked',
            key: `role_parked:${role}`,
            message: `${role} agent is parked after ${report.failures} failed starts: ${message}`,
            since: new Date().toISOString(),
          });
        }
      })
      .finally(() => lock.release());
    if (o.inFlight) {
      const set = o.inFlight;
      set.add(run);
      void run.finally(() => set.delete(run));
    }
  }

  // Show a change to the open ship-attention set on the board without
  // waiting for the next engaged/idle beat (CREW-1373). Best effort, and only
  // when the set differs from what this process last published.
  await publishShipAttention(o);

  return { pending: decision.selection.pending, started, skipped };
}

let lastPublishedAttention: string | undefined;

async function publishShipAttention(o: RunOnePassOptions): Promise<void> {
  const key = JSON.stringify(openShipAttention(o.state).map((i) => i.key));
  if (key === lastPublishedAttention) return;
  try {
    await new Tracker(o.route, o.ship).publishShipAttention(o.ship.name);
    lastPublishedAttention = key;
  } catch { /* the board being unreachable must not fail a pass; the next change retries */ }
}

// ---------------------------------------------------------------------------
// The real per-role work: claim (dev/design only), check out the ticket's
// repo, plan the session and spawn it. Mirrors `cli.ts`'s one-shot `run`
// command's own claim/spawn sequence for a winning role — see this file's
// module doc for why that sequence lives here too rather than being
// imported from `cli.ts` (a script, not a library: importing it would
// re-run its own argv-driven top-level dispatch).
// ---------------------------------------------------------------------------

async function runRoleAgent(role: RoleName, decision: CycleDecision, ctx: RoleAgentContext): Promise<void> {
  const { route, ship, emit } = ctx;
  const tracker = new Tracker(route, ship);
  let ticketHint = decision.actionable.top?.issue_id;
  let workingId = decision.actionable.top?.id ?? null;

  if (role === 'dev' || role === 'design') {
    const seat = route.resolved?.seats[role];
    if (seat) {
      const candidates = rankedCandidates(role, decision.selectionInput);
      const contract = decision.selectionInput.contract ?? DEFAULT_CONTRACT;
      const result = await resolveTopCandidate(
        tracker, candidates, seat, contract.statuses.approved, contract.statuses.building,
        (t) => dirForRepo(route, t.repo_id) !== null,
        withHoldCheck(await tracker.claimAffinity(), decision.selectionInput),
      );
      if (result.contended.length) {
        emit.emit(`claim contended for ${result.contended.join(', ')} — moved to the next candidate`, {
          step: 'select', role,
        });
      }
      if (result.unservable.length) {
        emit.emit(`skipped ${result.unservable.join(', ')} — no local checkout for their repo`, {
          step: 'select', role,
        });
      }
      if (result.held.length) {
        emit.emit(`skipped ${result.held.join(', ')} — held by another live ship`, { step: 'select', role: role });
      }
      await noteReaccepted(tracker, result, seat, ship.name);
      if (!result.ticket) {
        emit.emit(`${role} skipped this cycle — every candidate was already claimed elsewhere`);
        return;
      }
      if (result.claimed) {
        const idx = decision.tickets.findIndex((t) => t.id === result.ticket!.id);
        if (idx >= 0) decision.tickets[idx] = result.ticket;
        writeDigest({ route, ship, state: ctx.state, emit }, decision, role, ship.stateDir);
      }
      ticketHint = result.ticket.issue_id;
      workingId = result.ticket.id;

      const target = repoTargetFor(route, result.ticket.repo_id);
      try {
        if (target && ensureRepoCheckout(target.dir, target.remote)) {
          emit.emit(`cloned ${target.name} into ${target.dir}`, { step: 'select', role });
        }
      } catch (e) {
        emit.error(
          `could not check out ${target?.name ?? '(unknown repo)'} for ${result.ticket.issue_id}: ` +
            `${(e as GitError).message}`,
        );
        return;
      }
    }
  }

  const plan = planAgentRun({
    role, route, ship, stateDir: ship.stateDir, roster: rosterFor(decision, route, role),
    environment: await buildEnvironment(route, ship, ticketHint),
    apiKey: resolveApiKey(route),
    cycle: emit.cycle, ticket: ticketHint,
    divergedPrompt: await fetchDivergedPrompt(route, role, { userAgent: ship.userAgent }),
    agentModel: await fetchSeatAgentModel(route, role, { userAgent: ship.userAgent }),
    resolvedAgentId: await resolveAgentId(route, role, { userAgent: ship.userAgent }),
  });

  emit.enter('agent', role);
  emit.emit(`starting agent run for ${route.route}`);
  const memberId = route.resolved?.seats[role];
  if (memberId) {
    try {
      await tracker.setCrewStatus(memberId, 'working', workingId);
    } catch (e) {
      emit.warn(`could not set crew status: ${(e as Error).message}`, { step: 'agent' });
    }
  }
  try {
    await tracker.beatEngaged(ship.name, route.route, workingId);
  } catch (e) {
    emit.warn(`could not beat ship engaged: ${(e as Error).message}`, { step: 'agent' });
  }
  try {
    await spawnAgent(plan, emit);
  } finally {
    if (memberId) {
      try {
        await tracker.setCrewStatus(memberId, 'idle');
      } catch (e) {
        emit.warn(`could not clear crew status: ${(e as Error).message}`, { step: 'agent' });
      }
    }
    try {
      await tracker.beatIdle(ship.name);
    } catch (e) {
      emit.warn(`could not beat ship idle: ${(e as Error).message}`, { step: 'agent' });
    }
  }
}

/**
 * The "Your environment" section of a spawned agent's prompt.
 *
 * See this file's module doc for the one deliberate simplification versus
 * `cli.ts`'s `resolvedRepos`: no ship/area worktree-prefix network lookup.
 */
async function buildEnvironment(route: Route, ship: Ship, ticket?: string | null): Promise<string> {
  const tracker = new Tracker(route, ship);
  const contract = tracker.contract;
  const repos: EnvironmentRepo[] = reposOf(route).map((t) => {
    const id = repoIdForName(route, t.name);
    const o = route.repoOverrides[t.name];
    return {
      name: t.name,
      dir: t.dir,
      id,
      config: resolveRepoConfig(loadRepoConfig(t.dir), {
        hooks: { ...route.hooks, ...o?.hooks },
        labels: { ...route.labels, ...o?.labels },
        branch: { ...route.branch, ...o?.branch },
      }, t.dir),
    };
  });
  // The authorship probe is best-effort guidance for the brief: a failed read
  // leaves the filing block without authorship lines, never a failed cycle.
  const authorship = await tracker.authorshipProbe().catch(() => null);
  return renderEnvironment({ route, userAgent: ship.userAgent, repos, contract, sourceTicket: ticket, authorship });
}
