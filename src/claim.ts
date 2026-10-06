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
  /**
   * Re-read one ticket. Used only when the resumption stamp loses a race
   * (CREW-1386): without it the loser cannot tell who won, so it must not
   * build the ticket at all.
   */
  ticket?(id: string): Promise<Ticket>;
}

/**
 * Ship affinity for a claim (CREW-1386). `column` is the Issues
 * `held_by_ship_id` column; the claim stamps it in the SAME conditional write
 * as `status`/`assignee_id`, so there is no window where a ticket is claimed
 * but unowned. Omit it entirely on a workspace whose Issues table has no such
 * column (the authorship probe's `issueHeld`).
 */
export interface ClaimAffinity {
  column: string;
  shipId: string;
  /**
   * True for a ticket another LIVE ship holds. The claim refuses it itself,
   * not only selection upstream: an operator's re-`accepted` of a held ticket
   * is the exact case that used to hand it to the wrong ship.
   */
  isHeldElsewhere?: (t: Ticket) => boolean;
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
  /**
   * `issue_id`s skipped because another live ship holds them (CREW-1386).
   */
  held: string[];
  /**
   * True when the claimed ticket was already held by THIS ship — an operator
   * set it back to `accepted` while we held it. It is a resume, not a fresh
   * claim; the caller posts the event comment saying the flip was unnecessary.
   */
  reaccepted: boolean;
}

type Stamp =
  | { outcome: 'stamped'; ticket: Ticket }
  | { outcome: 'held' }
  | { outcome: 'unknown' };

/**
 * Stamp this ship's hold on an in-progress ticket that has none. Conditional,
 * so a lost race throws `StaleWriteError`; the loser re-reads the row and
 * decides from what it finds instead of assuming the ticket is still its to
 * build: another live ship's hold means walk on (`held`); this ship's own
 * means it is already ours; no hold yet means the row moved for an unrelated
 * reason, so retry once against the fresh `updated_at`. Anything it cannot
 * establish (no `ticket()` to re-read with, a failed re-read, a second lost
 * race) is `unknown`, which the caller treats as contended, never as claimable.
 */
async function stampResumption(tracker: ClaimableTracker, t: Ticket, affinity: ClaimAffinity): Promise<Stamp> {
  let current = t;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stamped = await tracker.updateTicket(current.id, { [affinity.column]: affinity.shipId }, current.updated_at);
      return { outcome: 'stamped', ticket: { ...current, ...stamped } };
    } catch (e) {
      if (!(e instanceof StaleWriteError)) throw e;
    }
    if (!tracker.ticket) return { outcome: 'unknown' };
    try {
      current = await tracker.ticket(t.id);
    } catch {
      return { outcome: 'unknown' };
    }
    if (affinity.isHeldElsewhere?.(current)) return { outcome: 'held' };
    if (current[affinity.column] === affinity.shipId) return { outcome: 'stamped', ticket: current };
    // Any other hold that `isHeldElsewhere` did not flag belongs to a dead or
    // unknown ship, which is takeover-able here exactly as it is on the
    // first attempt: go round again and stamp against the fresh row.
  }
  return { outcome: 'unknown' };
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
  affinity?: ClaimAffinity,
): Promise<ClaimResult> {
  const contended: string[] = [];
  const unservable: string[] = [];
  const held: string[] = [];
  for (const t of candidates) {
    if (affinity?.isHeldElsewhere?.(t)) {
      held.push(t.issue_id);
      continue;
    }
    if (isServable && !isServable(t)) {
      unservable.push(t.issue_id);
      continue;
    }
    if (t.status !== approvedStatus) {
      // A resumption needs no claim, but one with no `ship_id` yet (started
      // before ship affinity existed), or whose hold names a dead ship
      // (`isHeldElsewhere` above already walked past live ones), takes the
      // hold now, or the dead ship's return would resume it a second time. Conditional: a lost race re-reads the row
      // and walks past the ticket unless the stamp is ours (`stampResumption`).
      if (affinity && t[affinity.column] !== affinity.shipId) {
        const stamp = await stampResumption(tracker, t, affinity);
        if (stamp.outcome === 'stamped') {
          return { ticket: stamp.ticket, claimed: false, contended, unservable, held, reaccepted: false };
        }
        // Lost the race and someone else now holds it (or we could not tell
        // who): returning it here is how two ships built CREW-1386's own
        // ticket. Walk past it instead.
        (stamp.outcome === 'held' ? held : contended).push(t.issue_id);
        continue;
      }
      return { ticket: t, claimed: false, contended, unservable, held, reaccepted: false };
    }
    try {
      const claimed = await tracker.updateTicket(
        t.id,
        {
          status: buildingStatus,
          assignee_id: seat,
          ...(affinity ? { [affinity.column]: affinity.shipId } : {}),
        },
        t.updated_at,
      );
      const reaccepted = !!affinity && t[affinity.column] === affinity.shipId;
      return { ticket: { ...t, ...claimed }, claimed: true, contended, unservable, held, reaccepted };
    } catch (e) {
      if (e instanceof StaleWriteError) {
        contended.push(t.issue_id);
        continue;
      }
      throw e;
    }
  }
  return { ticket: null, claimed: false, contended, unservable, held, reaccepted: false };
}
