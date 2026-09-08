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

import { StaleWriteError } from '@tablation/client';
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
 * Which column and value a workspace uses to MARK a coordinating ticket
 * (ISSUE-354) — carried like every other column/value name, since a
 * workspace that renames `report_type` or spells the value differently
 * still has to work.
 */
export interface CoordinatingOptions {
  reportTypeColumn?: string;
  coordinatingValue?: string;
}

const COORDINATING_DEFAULTS: Required<CoordinatingOptions> = {
  reportTypeColumn: 'report_type',
  coordinatingValue: 'coordinating',
};

/**
 * A ticket is coordinating because it is MARKED so, not because a Repo is
 * absent (ISSUE-354) — the absence was ambiguous between "epic" and
 * "somebody forgot to set Repo", and the crew could not tell those apart.
 */
const isCoordinating = (t: Ticket, opts: Required<CoordinatingOptions>): boolean =>
  (t as Record<string, unknown>)[opts.reportTypeColumn] === opts.coordinatingValue;

/**
 * `filingErrors`' own marker set (ISSUE-387), separate from `coordinatingValue`.
 * A `question` or `investigation` ticket is legitimately repo-less by design —
 * a discussion or a spike has no code to touch — but it is a standalone
 * ticket, not a parent with children the way a `coordinating` ticket is
 * (Brad, 2026-09-07: investigation tickets are ordinary dev/design work, not
 * a distinct lane, and are referenced from an epic's description rather than
 * linked via `parent_id`). Keeping this list independent of `coordinatingValue`
 * means a workspace renaming the rollup marker doesn't also have to repeat
 * that rename here, and `rollUpParents` never mistakes a question/investigation
 * ticket for a parent to roll up.
 */
export interface FilingErrorOptions extends CoordinatingOptions {
  repoExemptValues?: string[];
}

const FILING_ERROR_DEFAULT_EXEMPT = ['coordinating', 'question', 'investigation'];

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
export function rollUpParents(
  tickets: Ticket[], done = RESOLVED_STATUSES, opts: CoordinatingOptions = {},
): ParentRollup[] {
  const resolved = { ...COORDINATING_DEFAULTS, ...opts };
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
    const children = byParent.get(t.id);
    if (!isCoordinating(t, resolved) || !children) continue;
    const outstanding = children.filter((c) => !done.has(c.status));
    rollups.push({ parent: t, children, outstanding, complete: outstanding.length === 0 });
  }
  return rollups;
}

/**
 * A ticket naming no repo and carrying no repo-exempt marker: not an epic, a
 * question, an investigation — a filing error. `rollUpParents` only ever
 * looks at tickets that turn out to have children — this is the sibling
 * check for the ISSUE-344 shape, a repo-less ticket that isn't rolling
 * anything up either: fetched every cycle, placeable in no checkout, and
 * silently never worked.
 *
 * Reported the way `strandedNeedsInfo` reports its case — every cycle, until
 * a human fixes the filing (adds a Repo, or marks it coordinating/question/
 * investigation).
 */
export function filingErrors(tickets: Ticket[], opts: FilingErrorOptions = {}): Ticket[] {
  const reportTypeColumn = opts.reportTypeColumn ?? COORDINATING_DEFAULTS.reportTypeColumn;
  // A workspace that renames `coordinatingValue` still has that renamed value
  // exempted here by default, without also having to repeat it in
  // `repoExemptValues` — only an explicit `repoExemptValues` overrides this.
  const coordinatingValue = opts.coordinatingValue ?? COORDINATING_DEFAULTS.coordinatingValue;
  const exempt = new Set(
    opts.repoExemptValues ?? [coordinatingValue, ...FILING_ERROR_DEFAULT_EXEMPT.filter((v) => v !== 'coordinating')],
  );
  return tickets.filter((t) => {
    if (t.repo_id) return false;
    return !exempt.has((t as Record<string, unknown>)[reportTypeColumn] as string);
  });
}

// ---------------------------------------------------------------------------
// Applying the sweep
// ---------------------------------------------------------------------------

/**
 * What the crew writes on a ticket when it parks or restores one.
 *
 * An `event` comment, not prose: it is the crew's audit trail, and `kind`
 * keeps it out of the "new comment from someone else" wake signal so the crew
 * does not wake itself.
 */
export function sweepComment(step: SweepStep): string {
  return step.action === 'park'
    ? `Parked as **Blocked** by the crew — waiting on: ${step.blockers}.

This is automatic and reversible: an approved ticket whose \`Blocked by\` entries are not all resolved is parked out of the queue, and restored on the first poll after the last one resolves. Nothing else about the ticket changes. A blocker counts as resolved at \`verified\`, \`closed_deployed\`, \`closed_wont_fix\` or \`closed_duplicate\` — not at \`fixed\`, which is still an unmerged branch awaiting QA.`
    : `Restored to **Approved** by the crew — every blocker has resolved${step.blockers && step.blockers !== '—' ? ` (${step.blockers})` : ''}.

This restores the status it was approved at before being parked; it is back in the queue and a role may pick it up. If a blocker resolved as \`closed_wont_fix\` or \`closed_duplicate\` this ticket may still not be buildable as written — that is a call for a human, not the crew.`;
}

export interface SweepWriter {
  updateTicket(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string): Promise<void>;
}

/**
 * Perform the plan.
 *
 * `expectedUpdatedAt` (ISSUE-495) makes each write conditional on the ticket
 * row not having moved since `decideCycle` read it. Three lanes each compute
 * and apply their own sweep independently, on their own cadence — without
 * this, a lane whose fetch predates a `needs_info` hand-off (a design reply,
 * an in-progress claim) blindly overwrites that fresher status with the plan
 * it computed from its own stale snapshot, and does it silently: the write
 * "succeeds", so there is nothing in the log to say a person's status change
 * was clobbered. This is the same conditional-write primitive claim.ts
 * already uses to arbitrate a contended claim between ships.
 *
 * A ticket whose write is rejected as stale is neither `parked`/`restored`
 * nor `failed` — it is `contended`: something else has already changed this
 * ticket more recently than the plan, so leaving it alone is correct, not an
 * error. The next poll recomputes blocked-ness from scratch against the
 * ticket's current state and will act on it then if it still applies.
 *
 * A ticket whose status write fails for any other reason is skipped and
 * reported — the next poll recomputes blocked-ness from scratch and will try
 * again, because nothing here is read back off the `blocked` status.
 *
 * A comment that fails to post does NOT undo the status change: the ticket
 * being in the right state matters more than the note explaining why.
 */
export async function applySweep(
  writer: SweepWriter, steps: SweepStep[], memberId: string,
  log: { emit(msg: string, extra?: Record<string, unknown>): unknown; warn(msg: string, extra?: Record<string, unknown>): unknown },
): Promise<{ parked: number; restored: number; failed: number; contended: number }> {
  let parked = 0;
  let restored = 0;
  let failed = 0;
  let contended = 0;
  for (const step of steps) {
    try {
      await writer.updateTicket(step.ticket.id, { status: step.to }, step.ticket.updated_at);
      if (step.action === 'park') parked++;
      else restored++;
      log.emit(
        step.action === 'park'
          ? `parked (waiting on ${step.blockers})`
          : `restored to ${step.to} (blockers resolved: ${step.blockers || 'none'})`,
        { ticket: step.ticket.issue_id, step: 'sweep' },
      );
      try {
        await writer.postEvent(step.ticket.id, sweepComment(step), memberId);
      } catch {
        log.warn('status changed but the note failed to post', { ticket: step.ticket.issue_id, step: 'sweep' });
      }
    } catch (e) {
      if (e instanceof StaleWriteError) {
        contended++;
        log.warn(`skipped ${step.action} — ticket changed since the sweep was planned`, {
          ticket: step.ticket.issue_id, step: 'sweep',
        });
        continue;
      }
      failed++;
      log.warn(`could not ${step.action}: ${(e as Error).message}`, { ticket: step.ticket.issue_id, step: 'sweep' });
    }
  }
  return { parked, restored, failed, contended };
}
