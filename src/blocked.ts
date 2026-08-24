/**
 * Dependency-blocked tickets, and the coordinating-parent rollup.
 *
 * Ported from blocker_info_map / compute_blocked_ids / sweep_blocked_tickets
 * in bin/crew (ISSUE-187), plus the parent rollup from ISSUE-331.
 *
 * The invariant that makes writing a status safe: `blocked` is strictly a
 * sub-state of *approved*. The loop parks only `accepted -> blocked` and
 * restores only `blocked -> accepted`, and writes no other transition. The
 * operator's approval therefore happens exactly once, up front, and every
 * restore hands back a status they already set.
 *
 * A one-way park is deliberately not an option: parking without restoring is
 * what left ISSUE-138 and ISSUE-134 invisible for weeks after their blocker
 * shipped.
 *
 * Blocked-ness is COMPUTED on every poll and never read back off the `blocked`
 * status. The status is how the board renders it — swimlanes are
 * status-defined — but nothing here branches on it to decide startability, so
 * a ticket whose park or unpark write failed is still treated by its real
 * dependency state rather than by a stale label.
 *
 * Everything in this file is PURE. Deciding what to change is separated from
 * changing it so the decision can be tested against real data without writing
 * to anyone's tracker.
 */

import type { Ticket } from './tracker.ts';
import { RESOLVED_STATUSES } from './tracker.ts';

/** {ticketId: {issue_id, status}} — closed blockers included. */
export type BlockerInfo = Record<string, { issue_id?: string; status?: string }>;

/** Ids named in `blocked_by` that are not in the open set, and so need fetching. */
export function missingBlockerIds(tickets: Ticket[]): string[] {
  const known = new Set(tickets.map((t) => t.id));
  const missing = new Set<string>();
  for (const t of tickets) for (const id of t.blocked_by ?? []) if (!known.has(id)) missing.add(id);
  return [...missing];
}

export function blockerInfoMap(tickets: Ticket[], extra: Ticket[] = []): BlockerInfo {
  const info: BlockerInfo = {};
  for (const t of [...tickets, ...extra]) info[t.id] = { issue_id: t.issue_id, status: t.status };
  return info;
}

/**
 * Depth-1 only. Transitivity comes free through iteration: a ticket blocked by
 * a blocked ticket stays parked because its own blocker never reaches a
 * resolved status until the chain clears.
 *
 * An id in neither the open set nor the bounded extra fetch is a genuinely
 * dangling reference (the record was hard-deleted). It is treated as NOT
 * blocking — parking a ticket forever on a row nobody can resolve is the worse
 * failure — and reported by `sweepDiagnostics`.
 */
export function computeBlockedIds(tickets: Ticket[], info: BlockerInfo): Set<string> {
  const blocked = new Set<string>();
  for (const t of tickets) {
    const unresolved = (t.blocked_by ?? []).some((id) => {
      const status = info[id]?.status;
      return status !== undefined && !RESOLVED_STATUSES.has(status);
    });
    if (unresolved) blocked.add(t.id);
  }
  return blocked;
}

export interface SweepDiagnostics {
  /** "ISSUE-1 -> <uuid>" for each reference nothing resolves. */
  dangling: string[];
  /** Tickets naming themselves — parked forever, and almost always a slip. */
  selfBlocked: string[];
}

export function sweepDiagnostics(tickets: Ticket[], info: BlockerInfo): SweepDiagnostics {
  const dangling: string[] = [];
  const selfBlocked: string[] = [];
  for (const t of tickets) {
    for (const id of t.blocked_by ?? []) {
      if (info[id] === undefined) dangling.push(`${t.issue_id} -> ${id}`);
      if (id === t.id) selfBlocked.push(t.issue_id);
    }
  }
  return { dangling, selfBlocked: [...new Set(selfBlocked)] };
}

export type SweepAction = 'park' | 'restore';

export interface SweepStep {
  action: SweepAction;
  ticket: Ticket;
  /** "ISSUE-241 (accepted), ISSUE-9 (unknown)" — every blocker, with status. */
  blockers: string;
  to: 'blocked' | 'accepted';
}

const describeBlockers = (t: Ticket, info: BlockerInfo): string =>
  (t.blocked_by ?? [])
    .map((id) => `${info[id]?.issue_id ?? '?'} (${info[id]?.status ?? 'unknown'})`)
    .join(', ');

/**
 * What the sweep would change, and nothing more. Only `accepted -> blocked`
 * and `blocked -> accepted` are ever produced; every other status is left
 * alone, including `in_progress` (someone is working it) and `new` (never
 * approved, so parking it would buy nothing and break the sub-state
 * invariant — it waits at `new` for triage).
 */
export function planSweep(tickets: Ticket[], info: BlockerInfo, blocked: Set<string>): SweepStep[] {
  const steps: SweepStep[] = [];
  for (const t of tickets) {
    if (t.status === 'accepted' && blocked.has(t.id)) {
      steps.push({ action: 'park', ticket: t, blockers: describeBlockers(t, info), to: 'blocked' });
    } else if (t.status === 'blocked' && !blocked.has(t.id)) {
      steps.push({ action: 'restore', ticket: t, blockers: describeBlockers(t, info), to: 'accepted' });
    }
  }
  return steps;
}

/**
 * The other half of ISSUE-187's problem, in its second form: a ticket parked
 * in `needs_info` whose blockers have all resolved. The crew does not move
 * these — `needs_info` means a human owes an answer, and that is not the
 * crew's to decide — but it surfaces them, because otherwise nothing but a
 * human comment ever wakes them. This is what stranded ISSUE-138 and 134.
 *
 * **A ticket assigned to a hold row is excluded**: the ball is in that
 * person's court, and repeating it every cycle is noise, not a reminder. That
 * is the same rule the rest of the crew already applies to a hold, and it is
 * what distinguishes "someone is sitting on this" from the case this check
 * exists for — nobody owns it and nothing will ever wake it.
 */
export function strandedNeedsInfo(
  tickets: Ticket[], blocked: Set<string>, holds: Set<string> = new Set(),
): Ticket[] {
  return tickets.filter(
    (t) =>
      t.status === 'needs_info' &&
      (t.blocked_by ?? []).length > 0 &&
      !blocked.has(t.id) &&
      !(t.assignee_id && holds.has(t.assignee_id)),
  );
}

// ---------------------------------------------------------------------------
// Coordinating parents (ISSUE-331)
// ---------------------------------------------------------------------------

/** A parent has no Repo: not actionable by any seat, done when its children are. */
export interface ParentRollup {
  parent: Ticket;
  children: Ticket[];
  /** Children not yet at a terminal, shipped state. */
  outstanding: Ticket[];
  /** Every child is done, so the parent is too — but only if it has children. */
  complete: boolean;
}

/**
 * Roll a coordinating parent up from its children.
 *
 * Computed each cycle, never stored — the same discipline as blocked-ness, and
 * for the same reason: a derived state that is written down goes stale exactly
 * when someone changes the thing it was derived from.
 *
 * A parent with no children is NOT complete. Vacuous truth here would close a
 * coordinating ticket the moment it was filed, before anything was split out
 * of it.
 */
export function rollUpParents(tickets: Ticket[], done = RESOLVED_STATUSES): ParentRollup[] {
  const byParent = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const p = (t as { parent_id?: string | null }).parent_id;
    if (!p) continue;
    const list = byParent.get(p);
    if (list) list.push(t);
    else byParent.set(p, [t]);
  }
  const rollups: ParentRollup[] = [];
  for (const t of tickets) {
    const isCoordinating = !(t as { repo_id?: string | null }).repo_id;
    const children = byParent.get(t.id);
    if (!isCoordinating || !children) continue;
    const outstanding = children.filter((c) => !done.has(c.status));
    rollups.push({ parent: t, children, outstanding, complete: outstanding.length === 0 });
  }
  return rollups;
}
