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
 * What this file deliberately does NOT do — owed to sibling tickets, not
 * forgotten:
 *
 *  - ISSUE-763 (install/lifecycle): no launchd/systemd unit, no `crew
 *    daemon start/stop/status`. `cli.ts`'s `case 'daemon':` calls
 *    `runDaemonLoop` directly, in the foreground, only so this loop is
 *    invocable and testable end-to-end — it is not the real service
 *    wrapper.
 *  - ISSUE-764 (self-update): no mtime/hash staleness detection, no `crew
 *    daemon restart`.
 *  - `release` and `passengers` stay on their existing fixed timers,
 *    untouched — only the `run` route's cadence changes here.
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

import type { RoleName, Route, Ship } from './config.ts';
import { dirForRepo, repoIdForName, repoTargetFor, reposOf, resolveApiKey } from './config.ts';
import { State } from './state.ts';
import { Emitter } from './events.ts';
import { decideCycle, rosterFor, writeDigest, type CycleDecision } from './poll.ts';
import { rankedCandidates } from './select.ts';
import { resolveTopCandidate } from './claim.ts';
import { applySweep } from './blocked.ts';
import { planAgentRun, spawnAgent } from './agent.ts';
import { loadRepoConfig, resolveRepoConfig } from './repo-config.ts';
import { renderEnvironment, type EnvironmentRepo } from './environment.ts';
import { DEFAULT_CONTRACT } from './contract.ts';
import { Tracker } from './tracker.ts';
import { ensureRepoCheckout, type GitError } from './git.ts';
import { fetchDivergedPrompt, fetchSeatAgentModel, resolveAgentId } from './agents.ts';
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
}

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
export async function runDaemonLoop(o: DaemonLoopOptions): Promise<void> {
  const floor = o.floorMs ?? DEFAULT_FLOOR_MS;
  const ceiling = o.ceilingMs ?? DEFAULT_CEILING_MS;
  const sleep = o.sleep ?? defaultSleep;
  let backoff = floor;
  let passes = 0;

  for (;;) {
    if (o.signal?.aborted) return;
    const result = await o.runPass();
    passes++;

    if (result.started.length > 0) {
      backoff = floor;
      o.onPass?.(result, 0);
      if (o.maxPasses !== undefined && passes >= o.maxPasses) return;
      continue;   // zero-idle chaining: no sleep at all
    }

    o.onPass?.(result, backoff);
    if (o.maxPasses !== undefined && passes >= o.maxPasses) return;
    if (o.signal?.aborted) return;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, ceiling);
  }
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
  const emit = o.newEmitter();
  const decide = o.decide ?? decideCycle;
  const spawn = o.spawnRoleAgent ?? runRoleAgent;
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
    const lock = o.state.acquireRun(role, o.maxConcurrentAgents);
    if (!lock.ok) {
      skipped.push({ role, reason: lock.reason });
      continue;
    }
    started.push(role);
    const run = spawn(role, decision, ctx)
      .catch((e) => {
        emit.warn(`${role} agent run failed: ${(e as Error).message}`, { step: 'agent', role });
      })
      .finally(() => lock.release());
    if (o.inFlight) {
      const set = o.inFlight;
      set.add(run);
      void run.finally(() => set.delete(run));
    }
  }

  return { pending: decision.selection.pending, started, skipped };
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
  const contract = new Tracker(route, ship).contract;
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
  return renderEnvironment({ route, userAgent: ship.userAgent, repos, contract, sourceTicket: ticket });
}
