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
}

/**
 * Walk `candidates` (already ranked most-urgent-first, see
 * `select.ts#rankedCandidates`) and either claim the first `approvedStatus`
 * one or hand back the first candidate that needs no claim at all.
 */
export async function resolveTopCandidate(
  tracker: ClaimableTracker,
  candidates: Ticket[],
  seat: string,
  approvedStatus: string,
  buildingStatus: string,
): Promise<ClaimResult> {
  const contended: string[] = [];
  for (const t of candidates) {
    if (t.status !== approvedStatus) return { ticket: t, claimed: false, contended };
    try {
      const claimed = await tracker.updateTicket(
        t.id,
        { status: buildingStatus, assignee_id: seat },
        t.updated_at,
      );
      return { ticket: { ...t, ...claimed }, claimed: true, contended };
    } catch (e) {
      if (e instanceof StaleWriteError) {
        contended.push(t.issue_id);
        continue;
      }
      throw e;
    }
  }
  return { ticket: null, claimed: false, contended };
}
