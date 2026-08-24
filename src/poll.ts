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
import { selectRole, sliceFor, type Selection } from './select.ts';
import { buildingDigest, qaDigest } from './digest.ts';
import { branches } from './git.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const decision: CycleDecision = {
    tickets, comments, roster, blocked, info, sweep, stranded, selection, watermark,
  };
  if (selection.selected) {
    writeDigest(o, decision, selection.selected, state.dir);
    emit.emit(
      `roles with work: ${selection.pending.join(' ')} -> '${selection.selected}' wins this cycle` +
        `; the rest stay pending for the next`,
      { role: selection.selected, data: { rank: selection.ranks[selection.selected], pending: selection.pending } },
    );
  } else {
    emit.enter('idle');
    emit.emit('nothing pending');
  }
  return decision;
}

/**
 * Where a role's queue digest lives. Per connection AND per role: a ship
 * serves several projects, and each seat gets its own slice.
 */
export const digestPath = (stateDir: string, connection: string, role: RoleName): string =>
  join(stateDir, `digest-${connection}-${role}.md`);

/**
 * Write the digest the winning seat will be handed.
 *
 * Without this the agent fetches the whole tracker itself at the top of every
 * run — ~691 KB of JSON, ~275 KB of it case history for tickets it will never
 * touch, paid again every cycle. The digest is the same data the poll has
 * already fetched, filtered to one role and already in pick order.
 *
 * Never fatal: a digest that cannot be rendered or written just means the
 * agent falls back to fetching, which is slower rather than wrong.
 */
export function writeDigest(
  o: CycleOptions, d: CycleDecision, role: RoleName, stateDir: string,
): boolean {
  const me = o.conn.resolved?.seats[role];
  if (!me) return false;
  try {
    const input = {
      tickets: role === 'triage'
        ? d.tickets.filter((t) => t.assignee_id === o.conn.resolved?.seats.triage)
        : sliceFor(d.tickets, role),
      comments: d.comments,
      me,
      roster: d.roster,
      watermark: d.watermark,
      branches: branches(o.conn.dir, `${o.conn.worktreePrefix.replace(/-$/, '')}*`).concat(
        branches(o.conn.dir, 'issue-*'),
      ),
      blocked: d.blocked,
      blockerInfo: d.info,
    };
    const text = role === 'qa' ? qaDigest(input) : buildingDigest(input);
    const path = digestPath(stateDir, o.conn.name, role);
    writeFileSync(path, text);
    o.emit.emit(`queue digest written for ${role} (${Buffer.byteLength(text)} bytes)`, {
      data: { role, bytes: Buffer.byteLength(text) },
    });
    return true;
  } catch (e) {
    o.emit.warn(`could not write the ${role} digest — the agent will fetch the tracker itself: ${(e as Error).message}`);
    return false;
  }
}

/** The roster block the winning seat is handed. */
export function rosterFor(d: CycleDecision, conn: Connection, role: RoleName): string {
  return rosterMarkdown(d.roster, conn.resolved!.seats[role] ?? null);
}
