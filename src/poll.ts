/**
 * One cycle: fetch, sweep, select, and decide what to run.
 *
 * Ported from poll_for_work in bin/crew. Returns a decision; performing it is
 * the caller's job, which is what makes `--dry-run` a real dry run rather
 * than an approximation of one.
 */

import type { Connection, RoleName, Ship } from './config.ts';
import { configuredMembers } from './config.ts';
import { Tracker, type Ticket, type Comment } from './tracker.ts';
import { buildRoster, holdIds, rosterMarkdown, type Roster } from './roster.ts';
import {
  blockerInfoMap, missingBlockerIds, computeBlockedIds, planSweep,
  sweepDiagnostics, strandedNeedsInfo, rollUpParents,
  type BlockerInfo, type SweepStep,
} from './blocked.ts';
import { selectRole, type Selection } from './select.ts';
import type { State } from './state.ts';
import type { Emitter } from './events.ts';

export interface CycleDecision {
  tickets: Ticket[];
  comments: Comment[];
  roster: Roster;
  blocked: Set<string>;
  info: BlockerInfo;
  sweep: SweepStep[];
  stranded: Ticket[];
  selection: Selection;
  watermark: string;
}

export interface CycleOptions {
  conn: Connection;
  ship: Ship;
  state: State;
  emit: Emitter;
  roles?: RoleName[];
}

/**
 * Everything a cycle decides, with no writes at all.
 *
 * Blocked-ness is computed once from the WHOLE payload before any role
 * slicing: a blocker can belong to another role's slice, so a per-role
 * computation would read a cross-role dependency as resolved.
 */
export async function decideCycle(o: CycleOptions): Promise<CycleDecision> {
  const { conn, ship, state, emit } = o;
  const tracker = new Tracker(conn, ship);
  emit.enter('poll');

  const [tickets, comments, crewRows] = await Promise.all([
    tracker.openTickets(),
    tracker.comments(200),
    tracker.crewRows(),
  ]);
  emit.emit(`${tickets.length} open ticket(s), ${comments.length} comment(s)`, {
    data: { tickets: tickets.length, comments: comments.length },
  });

  const extra = await tracker.ticketsByIds(missingBlockerIds(tickets));
  const info = blockerInfoMap(tickets, extra);
  const blocked = computeBlockedIds(tickets, info);

  emit.enter('sweep');
  const roster = buildRoster(configuredMembers(conn), crewRows);
  const holds = new Set(holdIds(roster));
  const diag = sweepDiagnostics(tickets, info);
  for (const d of diag.dangling) emit.warn(`dangling blocked_by reference, ignored: ${d}`);
  if (diag.selfBlocked.length) {
    emit.warn(`ticket(s) blocking themselves, parked permanently: ${diag.selfBlocked.join(', ')}`);
  }
  const sweep = planSweep(tickets, info, blocked);
  const stranded = strandedNeedsInfo(tickets, blocked, holds);
  for (const t of stranded) {
    emit.emit('needs_info with all blockers resolved — the operator\'s call, not the crew\'s', {
      ticket: t.issue_id,
    });
  }
  for (const r of rollUpParents(tickets)) {
    if (r.complete) {
      emit.emit(`every child is done — this coordinating ticket is too`, { ticket: r.parent.issue_id });
    }
  }

  emit.enter('select');
  const watermark = state.watermark();
  const selection = selectRole({
    tickets, comments, watermark, blocked,
    holds,
    seats: conn.resolved!.seats,
    paused: state.pausedRoles(['dev', 'design', 'qa']),
    contract: tracker.contract,
  });
  if (selection.selected) {
    emit.emit(
      `roles with work: ${selection.pending.join(' ')} -> '${selection.selected}' wins this cycle` +
        `; the rest stay pending for the next`,
      { role: selection.selected, data: { rank: selection.ranks[selection.selected], pending: selection.pending } },
    );
  } else {
    emit.enter('idle');
    emit.emit('nothing pending');
  }
  return { tickets, comments, roster, blocked, info, sweep, stranded, selection, watermark };
}

/** The roster block the winning seat is handed. */
export function rosterFor(d: CycleDecision, conn: Connection, role: RoleName): string {
  return rosterMarkdown(d.roster, conn.resolved!.seats[role] ?? null);
}
