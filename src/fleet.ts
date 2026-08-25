/**
 * Many routes, one decision.
 *
 * A ship serves several workspaces at once and must pick the single most
 * urgent piece of work across all of them (ISSUE-338). This is the layer that
 * makes that possible; `poll.ts` still decides one route at a time and
 * knows nothing about the others.
 *
 * Ranks are comparable across workspaces because each board's contract turns
 * its own priority values into an INDEX — `0` means "most urgent here"
 * whether a tracker says `p0`, `urgent` or `P1`. Two tickets from two
 * different trackers are therefore already comparable integers, which is the
 * hard half of this and came free.
 */

import type { Route, RoleName, Ship } from './config.ts';
import type { State } from './state.ts';
import type { Emitter } from './events.ts';
import { decideCycle, type CycleDecision } from './poll.ts';
import { NOTHING_ACTIONABLE, agedRankScalar } from './priority.ts';

export interface FleetEntry {
  route: Route;
  decision?: CycleDecision;
  /**
   * Best rank across this route's pending roles, or NOTHING_ACTIONABLE —
   * AFTER aging (ISSUE-383) has eroded it toward 0 if this route's own
   * top ticket has been sitting unpicked. QA/triage are exempt: their
   * `FIXED_RANK` is already the most urgent rank there is, and aging (which
   * only ever moves a rank TOWARD 0) can only make a building rank approach,
   * never pass, that floor.
   */
  rank: number;
  role?: RoleName;
  error?: string;
}

/**
 * Aging (ISSUE-383) applied to one route's winning rank for fleet-wide
 * comparison. Only building roles (dev/design) age — QA/triage's negative
 * `FIXED_RANK` values are not on the same scale `agedRankScalar` erodes
 * toward 0, and eroding a negative number toward 0 would make it LESS
 * urgent, backwards.
 *
 * Reads the PRIOR cycle's fairness bookkeeping (`state.fairness(name)`,
 * ISSUE-382) — this cycle's own `record()` call happens after every
 * route has been ranked, further down in `decideFleet`. Only applies
 * when the ticket that has actually been waiting is still this cycle's top
 * one; if a new ticket just took the front of the queue it has no history
 * yet, so it ages from nothing rather than inheriting the old ticket's wait.
 */
function agedConnectionRank(
  rawRank: number, role: RoleName, route: Route, decision: CycleDecision, state: State, now: number,
): number {
  if (role !== 'dev' && role !== 'design') return rawRank;
  const waiting = state.fairness(route.route).waiting();
  if (!waiting || waiting.ticket !== decision.actionable.top?.issue_id) return rawRank;
  return agedRankScalar(rawRank, { since: waiting.since, weight: route.weight }, now);
}

export interface FleetDecision {
  entries: FleetEntry[];
  /** The one route and role that should run, or null. */
  winner?: { route: Route; role: RoleName; decision: CycleDecision };
  /** Routes that could not be reached this cycle. */
  unreachable: string[];
}

export interface FleetOptions {
  routes: Route[];
  ship: Ship;
  state: State;
  emit: Emitter;
  /** Skip routes whose interlock is closed. Default true. */
  enabledOnly?: boolean;
  /** For aging (ISSUE-383) and tests that need a fixed clock. Defaults to Date.now(). */
  now?: number;
}

/**
 * Poll every route and decide which one runs.
 *
 * Routes are polled CONCURRENTLY and independently: one unreachable
 * tracker must not stop the others being served, which is the whole point of
 * a ship that holds several. A failure is reported and that route simply
 * does not compete this cycle.
 */
export async function decideFleet(o: FleetOptions): Promise<FleetDecision> {
  const now = o.now ?? Date.now();
  const eligible = o.routes.filter((c) => (o.enabledOnly === false ? true : c.enabled));
  const entries: FleetEntry[] = await Promise.all(eligible.map(async (route) => {
    try {
      const decision = await decideCycle({ route: route, ship: o.ship, state: o.state, emit: o.emit });
      const sel = decision.selection;
      if (!sel.selected) return { route, decision, rank: NOTHING_ACTIONABLE };
      const rawRank = sel.ranks[sel.selected] ?? NOTHING_ACTIONABLE;
      return {
        route,
        decision,
        role: sel.selected,
        rank: agedConnectionRank(rawRank, sel.selected, route, decision, o.state, now),
      };
    } catch (e) {
      return { route, rank: NOTHING_ACTIONABLE, error: (e as Error).message };
    }
  }));

  for (const e of entries) {
    if (e.error) o.emit.error(`${e.route.route}: ${e.error}`, { step: 'poll' });
  }

  const contenders = entries.filter((e) => e.role && e.rank < NOTHING_ACTIONABLE);
  // Lowest rank wins. Ties fall to the route listed first, which is
  // stable and lets an operator express preference by ordering crew.yaml.
  const best = contenders.reduce<FleetEntry | undefined>(
    (acc, e) => (!acc || e.rank < acc.rank ? e : acc), undefined,
  );

  // Record what this cycle saw for every reachable route (ISSUE-382),
  // so a route that keeps having work and never winning shows up
  // without anyone going looking. An unreachable route has no data to
  // record, not zero — recording it as idle would erase a real streak.
  for (const e of entries) {
    if (e.error || !e.decision) continue;
    const won = best?.route.route === e.route.route;
    o.state.fairness(e.route.route).record(e.decision.actionable.count, e.decision.actionable.top?.issue_id, won);
  }

  return {
    entries,
    winner: best && best.role && best.decision
      ? { route: best.route, role: best.role, decision: best.decision }
      : undefined,
    unreachable: entries.filter((e) => e.error).map((e) => e.route.route),
  };
}

/**
 * A run passed over often enough that it is worth naming even in the
 * one-line summary, rather than only in `crew status`. Arbitrary but small:
 * a handful of cycles is normal traffic between two busy boards, a long run
 * is the thing ISSUE-382 exists to make visible.
 */
const LOUD_STREAK = 5;

/**
 * How long ago an ISO timestamp was, in the coarsest unit that reads
 * naturally — good enough for a status line, not a precise duration.
 */
export function since(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A one-line-per-route summary, for `crew poll` with no name. */
export function renderFleet(f: FleetDecision, state?: State): string {
  const rows = f.entries.map((e) => {
    if (e.error) return `  ${e.route.route.padEnd(16)} unreachable — ${e.error}`;
    if (!e.role) return `  ${e.route.route.padEnd(16)} nothing pending`;
    const pending = e.decision?.selection.pending.join(' ') ?? '';
    const win = f.winner?.route.route === e.route.route ? '  <- runs this cycle' : '';
    const streak = state?.fairness(e.route.route).streak() ?? 0;
    const passedOver = !win && streak >= LOUD_STREAK ? `  ! passed over ${streak} cycles running` : '';
    return `  ${e.route.route.padEnd(16)} ${e.role.padEnd(7)} rank ${String(e.rank).padStart(12)}  pending: ${pending}${win}${passedOver}`;
  });
  if (!rows.length) return 'no enabled routes\n';
  return `${rows.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Falling through to the next role
// ---------------------------------------------------------------------------

/**
 * A role can be selected honestly and still produce nothing.
 *
 * The poll sees status and assignee; it cannot know that a seat will read a
 * ticket and judge it unbuildable. That happened on the first real run: the
 * design role was picked because ISSUE-319 was genuinely `accepted` and
 * startable, and the agent then moved it to `needs_info` for want of five
 * architectural decisions. The cycle was spent, and the next cycle would have
 * picked design again had that ticket still qualified.
 *
 * So after a run that changed nothing, the remaining pending roles are worth
 * trying — a cycle has real fixed cost, and the runner-up is right there.
 */
export interface Snapshot {
  /** ticket id -> the fields a run would move. */
  state: Map<string, string>;
}

export function snapshot(tickets: Array<{ id: string; status: string; updated_at: string; assignee_id?: string | null }>): Snapshot {
  return {
    state: new Map(tickets.map((t) => [t.id, `${t.status}|${t.assignee_id ?? ''}|${t.updated_at}`])),
  };
}

/**
 * Did anything a role could have touched actually move?
 *
 * Deliberately generous: ANY status, assignee or timestamp change counts, as
 * does a ticket appearing or disappearing. A false "it did something" only
 * costs a cycle; a false "it did nothing" would run another role on top of
 * work in progress, which is worse.
 */
export function changed(before: Snapshot, after: Snapshot): boolean {
  if (before.state.size !== after.state.size) return true;
  for (const [id, v] of after.state) if (before.state.get(id) !== v) return true;
  return false;
}

/** Pending roles other than the one that just ran, most urgent first. */
export function nextRoles(decision: CycleDecision, ran: RoleName[]): RoleName[] {
  return decision.selection.pending
    .filter((r) => !ran.includes(r))
    .sort((a, b) => (decision.selection.ranks[a] ?? 0) - (decision.selection.ranks[b] ?? 0));
}
