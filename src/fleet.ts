/**
 * Many connections, one decision.
 *
 * A ship serves several workspaces at once and must pick the single most
 * urgent piece of work across all of them (ISSUE-338). This is the layer that
 * makes that possible; `poll.ts` still decides one connection at a time and
 * knows nothing about the others.
 *
 * Ranks are comparable across workspaces because each board's contract turns
 * its own priority values into an INDEX — `0` means "most urgent here"
 * whether a tracker says `p0`, `urgent` or `P1`. Two tickets from two
 * different trackers are therefore already comparable integers, which is the
 * hard half of this and came free.
 */

import type { Connection, RoleName, Ship } from './config.ts';
import type { State } from './state.ts';
import type { Emitter } from './events.ts';
import { decideCycle, type CycleDecision } from './poll.ts';
import { NOTHING_ACTIONABLE } from './priority.ts';

export interface FleetEntry {
  connection: Connection;
  decision?: CycleDecision;
  /** Best rank across this connection's pending roles, or NOTHING_ACTIONABLE. */
  rank: number;
  role?: RoleName;
  error?: string;
}

export interface FleetDecision {
  entries: FleetEntry[];
  /** The one connection and role that should run, or null. */
  winner?: { connection: Connection; role: RoleName; decision: CycleDecision };
  /** Connections that could not be reached this cycle. */
  unreachable: string[];
}

export interface FleetOptions {
  connections: Connection[];
  ship: Ship;
  state: State;
  emit: Emitter;
  /** Skip connections whose interlock is closed. Default true. */
  enabledOnly?: boolean;
}

/**
 * Poll every connection and decide which one runs.
 *
 * Connections are polled CONCURRENTLY and independently: one unreachable
 * tracker must not stop the others being served, which is the whole point of
 * a ship that holds several. A failure is reported and that connection simply
 * does not compete this cycle.
 */
export async function decideFleet(o: FleetOptions): Promise<FleetDecision> {
  const eligible = o.connections.filter((c) => (o.enabledOnly === false ? true : c.enabled));
  const entries: FleetEntry[] = await Promise.all(eligible.map(async (connection) => {
    try {
      const decision = await decideCycle({ conn: connection, ship: o.ship, state: o.state, emit: o.emit });
      const sel = decision.selection;
      if (!sel.selected) return { connection, decision, rank: NOTHING_ACTIONABLE };
      return {
        connection,
        decision,
        role: sel.selected,
        rank: sel.ranks[sel.selected] ?? NOTHING_ACTIONABLE,
      };
    } catch (e) {
      return { connection, rank: NOTHING_ACTIONABLE, error: (e as Error).message };
    }
  }));

  for (const e of entries) {
    if (e.error) o.emit.error(`${e.connection.name}: ${e.error}`, { step: 'poll' });
  }

  const contenders = entries.filter((e) => e.role && e.rank < NOTHING_ACTIONABLE);
  // Lowest rank wins. Ties fall to the connection listed first, which is
  // stable and lets an operator express preference by ordering crew.yaml.
  const best = contenders.reduce<FleetEntry | undefined>(
    (acc, e) => (!acc || e.rank < acc.rank ? e : acc), undefined,
  );

  return {
    entries,
    winner: best && best.role && best.decision
      ? { connection: best.connection, role: best.role, decision: best.decision }
      : undefined,
    unreachable: entries.filter((e) => e.error).map((e) => e.connection.name),
  };
}

/** A one-line-per-connection summary, for `crew poll` with no name. */
export function renderFleet(f: FleetDecision): string {
  const rows = f.entries.map((e) => {
    if (e.error) return `  ${e.connection.name.padEnd(16)} unreachable — ${e.error}`;
    if (!e.role) return `  ${e.connection.name.padEnd(16)} nothing pending`;
    const pending = e.decision?.selection.pending.join(' ') ?? '';
    const win = f.winner?.connection.name === e.connection.name ? '  <- runs this cycle' : '';
    return `  ${e.connection.name.padEnd(16)} ${e.role.padEnd(7)} rank ${String(e.rank).padStart(12)}  pending: ${pending}${win}`;
  });
  if (!rows.length) return 'no enabled connections\n';
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
