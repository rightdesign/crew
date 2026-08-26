/**
 * Claim a building role's next ticket at selection time, not inside its
 * session (ISSUE-395).
 *
 * `select.ts` decides WHICH ticket a role would open next, but two ships
 * whose polls land in the same window can both decide on the same `accepted`
 * ticket — the actual claim (`status` -> `in_progress`, `assignee_id` -> the
 * seat) used to happen minutes later, inside the launched session, which is
 * far too late to arbitrate anything. This reuses ISSUE-394's board-lock
 * primitive — `RecordsResource.update` with `expectedUpdatedAt`, throwing
 * `StaleWriteError` on a stale write — against the ticket row itself: the
 * first ship's conditional write lands, a second ship's identical attempt
 * loses because the row already moved, and it walks down to the next
 * candidate instead.
 *
 * Only a ticket actually AT the approved status is contended this way — a
 * resumption (already `in_progress`, ours or unassigned) has nothing to
 * race, so it is handed back unclaimed rather than rewritten.
 */

import { StaleWriteError } from '@tablation/client';
import type { Ticket } from './tracker.ts';

export interface ClaimableTracker {
  updateTicket(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<Ticket>;
}

export interface ClaimResult {
  /**
   * The ticket this role should work this cycle — already claimed (moved to
   * `buildingStatus` with `assignee_id` set) when `claimed` is true. `null`
   * when every `approvedStatus` candidate was contended and nothing else in
   * the ranked list was viable either: this role has nothing this cycle.
   */
  ticket: Ticket | null;
  /** Whether `ticket` required (and won) a conditional write. */
  claimed: boolean;
  /** `issue_id`s tried and lost, in the order they were tried. */
  contended: string[];
  /**
   * `issue_id`s skipped because `isServable` rejected them — this ship has
   * no local checkout for the ticket's repo (ISSUE-445). Distinct from
   * `contended`: nobody else claimed these, this ship just cannot work them.
   */
  unservable: string[];
}

/**
 * Walk `candidates` (already ranked most-urgent-first, see
 * `select.ts#rankedCandidates`) and either claim the first `approvedStatus`
 * one or hand back the first candidate that needs no claim at all.
 *
 * `isServable`, when given, gates every candidate regardless of status
 * BEFORE any write or hand-back — a ticket whose repo this ship has no
 * local checkout for is walked past rather than claimed (setting it
 * `in_progress` with nowhere to work it) or handed back for resumption
 * (same trap for a ticket some earlier, differently-configured run already
 * claimed). ISSUE-445: a missing `crew.yaml` repo entry let the runner claim
 * ISSUE-402 and ISSUE-420 and then have no worktree to open, leaving both
 * stuck `in_progress` indefinitely with no error surfaced.
 */
export async function resolveTopCandidate(
  tracker: ClaimableTracker,
  candidates: Ticket[],
  seat: string,
  approvedStatus: string,
  buildingStatus: string,
  isServable?: (t: Ticket) => boolean,
): Promise<ClaimResult> {
  const contended: string[] = [];
  const unservable: string[] = [];
  for (const t of candidates) {
    if (isServable && !isServable(t)) {
      unservable.push(t.issue_id);
      continue;
    }
    if (t.status !== approvedStatus) return { ticket: t, claimed: false, contended, unservable };
    try {
      const claimed = await tracker.updateTicket(
        t.id,
        { status: buildingStatus, assignee_id: seat },
        t.updated_at,
      );
      return { ticket: { ...t, ...claimed }, claimed: true, contended, unservable };
    } catch (e) {
      if (e instanceof StaleWriteError) {
        contended.push(t.issue_id);
        continue;
      }
      throw e;
    }
  }
  return { ticket: null, claimed: false, contended, unservable };
}
