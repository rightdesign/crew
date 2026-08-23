/**
 * Which role runs this cycle, and whether any role should run at all.
 *
 * Ported from lane_has_work / qa_lane_has_work / lane_top_rank / poll_for_work
 * in bin/crew. Pure: it decides, and the caller acts.
 *
 * The roles no longer each get a session per cycle. With 26 accepted dev
 * tickets against 3 design, design was drawing roughly half the agent cycles
 * for a tenth of the queue (ISSUE-177). They share one ordered queue now, and
 * `needs_design` decides which brief the winning session runs under rather
 * than whether a second session happens at all.
 */

import { rankScalar, NOTHING_ACTIONABLE } from './priority.ts';
import { DEFAULT_CONTRACT, type Contract } from './contract.ts';
import type { Ticket, Comment } from './tracker.ts';
import type { RoleName } from './config.ts';

export interface SelectionInput {
  tickets: Ticket[];
  comments: Comment[];
  /** ISO timestamp of the previous poll. */
  watermark: string;
  /** Ticket ids the sweep computed as dependency-blocked. */
  blocked: Set<string>;
  /** Crew rows that mean HANDS OFF — a person is driving that ticket. */
  holds: Set<string>;
  /** Seat id per role, for the roles this ship crews. */
  seats: Partial<Record<RoleName, string>>;
  /** Roles the operator has paused. */
  paused?: Set<RoleName>;
  /** This workspace's rules. Defaults to the documented default contract. */
  contract?: Contract;
}

/** QA owns every ticket at `fixed` or `qa`, whichever role built it. */
export const qaSlice = (tickets: Ticket[]): Ticket[] =>
  tickets.filter((t) => t.status === 'fixed' || t.status === 'qa');

/**
 * The building roles split everything else by `needs_design`. Tickets
 * predating that field have it null, which reads as false — the same way the
 * prompt tells the agents to read it.
 *
 * Deliberately NOT status-filtered: their own counts already ignore fixed/qa,
 * so a digest still shows a role its whole world minus QA's part of it.
 */
export const buildingSlice = (tickets: Ticket[], role: 'dev' | 'design'): Ticket[] =>
  tickets.filter((t) => (role === 'design' ? t.needs_design === true : t.needs_design !== true));

export function sliceFor(tickets: Ticket[], role: RoleName): Ticket[] {
  if (role === 'qa') return qaSlice(tickets);
  if (role === 'triage') return tickets.filter((t) => t.status === 'new');
  return buildingSlice(tickets, role);
}

const isHeld = (t: Ticket, holds: Set<string>) => !!t.assignee_id && holds.has(t.assignee_id);

/**
 * Everything the poll would wake a BUILDING role for.
 *
 * A held ticket is excluded here rather than only in the prompt, so a ticket
 * a person is driving cannot be the sole reason a whole agent cycle wakes and
 * then finds nothing it is allowed to touch. A dependency-blocked ticket is
 * excluded for the same reason — and membership of `blocked` is what decides
 * that, never the `blocked` status, which is presentation.
 */
export function buildingRoleHasWork(
  role: 'dev' | 'design',
  i: SelectionInput,
): { hasWork: boolean; reason: string } {
  const me = i.seats[role];
  if (!me) return { hasWork: false, reason: 'this ship does not crew that role' };
  const mine = sliceFor(i.tickets, role);

  const startable = mine.filter(
    (t) =>
      (t.status === 'accepted' || t.status === 'blocked') &&
      !i.blocked.has(t.id) &&
      !isHeld(t, i.holds),
  );

  // Tickets we are actively watching for a reply: our own in_progress work,
  // an unassigned in_progress one (clearing assignee_id is the "back up for
  // grabs" signal), plus any needs_info ticket regardless of assignee — older
  // ones predate consistent assignee-setting.
  //
  // `fixed` is deliberately absent everywhere here: it is QA's, and counting
  // it would wake a building role for work it may no longer touch.
  const watched = mine.filter(
    (t) =>
      ((t.status === 'in_progress' && (t.assignee_id === me || !t.assignee_id)) ||
        t.status === 'needs_info') &&
      !isHeld(t, i.holds),
  );
  const watchedIds = new Set(watched.map((t) => t.id));
  const newComments = i.comments.filter(
    (c) =>
      c.created_at > i.watermark &&
      c.team_member_id !== me &&
      (c.kind ?? 'comment') !== 'event' &&
      watchedIds.has(c.ticket_id),
  ).length;

  // An in_progress ticket with no assignee is "back up for grabs" — worth a
  // run even with no new comment.
  const unassigned = mine.filter(
    (t) => t.status === 'in_progress' && !t.assignee_id && !i.blocked.has(t.id),
  ).length;

  if (startable.length > 0 || newComments > 0 || unassigned > 0) {
    const parts: string[] = [];
    if (startable.length) parts.push(`${startable.length} startable`);
    if (newComments) parts.push(`${newComments} new comment(s)`);
    if (unassigned) parts.push(`${unassigned} unassigned in_progress`);
    return { hasWork: true, reason: parts.join(', ') };
  }
  return { hasWork: false, reason: 'nothing startable and no new comments' };
}

/**
 * QA's version, and deliberately much simpler: every ticket in QA's slice IS
 * work by definition — `fixed` means nobody has checked it, `qa` means a check
 * is half-done — so there is no watermark or assignee dance to evaluate.
 */
export function qaRoleHasWork(i: SelectionInput): { hasWork: boolean; reason: string } {
  if (!i.seats.qa) return { hasWork: false, reason: 'this ship does not crew that role' };
  const n = qaSlice(i.tickets).filter((t) => !isHeld(t, i.holds)).length;
  return n > 0
    ? { hasWork: true, reason: `${n} ticket(s) awaiting or in verification` }
    : { hasWork: false, reason: 'nothing awaiting verification' };
}

export function roleHasWork(role: RoleName, i: SelectionInput): { hasWork: boolean; reason: string } {
  if (i.paused?.has(role)) return { hasWork: false, reason: 'paused' };
  if (role === 'qa') return qaRoleHasWork(i);
  if (role === 'triage') return { hasWork: false, reason: 'triage runs on its own timer' };
  return buildingRoleHasWork(role, i);
}

/**
 * How urgent is this role's most urgent ACTIONABLE ticket, as a single integer
 * (lower = more urgent)? Narrower than the set that WAKES a role: only what it
 * could actually start or resume.
 *
 * Ordering comes from priority.ts — the same module the digest sorts with — so
 * the role that wins is always the one holding the ticket that would have
 * sorted first.
 */
export function roleTopRank(role: RoleName, i: SelectionInput): number {
  const me = i.seats[role];
  if (!me) return NOTHING_ACTIONABLE;
  const candidates = sliceFor(i.tickets, role).filter(
    (t) =>
      (((t.status === 'accepted' || t.status === 'blocked') && !i.blocked.has(t.id)) ||
        (t.status === 'in_progress' && (t.assignee_id === me || !t.assignee_id))) &&
      !isHeld(t, i.holds),
  );
  if (candidates.length === 0) return NOTHING_ACTIONABLE;
  // NB the arrow: passing `rankScalar` bare would hand .map's INDEX to its
  // second parameter, which is now the contract.
  const c = i.contract ?? DEFAULT_CONTRACT;
  return Math.min(...candidates.map((t) => rankScalar(t, c)));
}

export interface Selection {
  /** Roles with work this cycle. All of them stay pending for the next. */
  pending: RoleName[];
  /** The one role that runs, or null when nothing does. */
  selected: RoleName | null;
  ranks: Partial<Record<RoleName, number>>;
  reasons: Partial<Record<RoleName, string>>;
}

/**
 * One role runs per cycle. QA is evaluated first so that a tie falls to it:
 * verifying finished work outranks starting more of it.
 */
export function selectRole(i: SelectionInput): Selection {
  const order: RoleName[] = ['qa', 'dev', 'design'];
  const pending: RoleName[] = [];
  const ranks: Partial<Record<RoleName, number>> = {};
  const reasons: Partial<Record<RoleName, string>> = {};

  for (const role of order) {
    const { hasWork, reason } = roleHasWork(role, i);
    reasons[role] = reason;
    if (hasWork) pending.push(role);
  }
  if (pending.length === 0) return { pending, selected: null, ranks, reasons };

  let selected: RoleName | null = null;
  let best = Infinity;
  for (const role of pending) {
    // QA has no ordered queue of its own to rank; it wins any cycle it has
    // work, which is why it sorts ahead of every building rank.
    const rank = role === 'qa' ? -1 : roleTopRank(role, i);
    ranks[role] = rank;
    if (rank < best) {
      best = rank;
      selected = role;
    }
  }
  return { pending, selected, ranks, reasons };
}
