/**
 * A verified ticket the release cannot place at all: no branch on this
 * ship, and its key names no commit on the base either (`planMerge`'s
 * `never-built` skip reason — see release.ts).
 *
 * Before this, that state was reported once per cycle, forever:
 *
 *   merge: ISSUE-345 verified but has no branch and nothing on the base
 *          names it — nothing to merge
 *
 * and nothing escalated it, routed it to a person, or changed its status.
 * `already-merged` (the sibling skip reason) resolves itself once a
 * successful release stamps the ticket; this one never does, because
 * nothing is coming to stamp.
 *
 * Three states hide behind that one shape:
 *
 *   1. Landed under a commit that never named the key — the work shipped,
 *      only the bookkeeping is missing.
 *   2. The branch was deleted before it merged — the work is gone.
 *   3. Verified in error, with nothing ever built.
 *
 * The crew cannot tell these apart, and closing (1) automatically would
 * also silently close (2) — data loss reported as success. So: stop
 * repeating, ask a person, and say exactly what was searched.
 *
 * Same two-pass shape as conflict.ts's hand-back/escalate, for the same
 * reason: the first cycle that finds a ticket in this state only leaves a
 * marker note, in case this is a race with a branch or commit that has not
 * reached this ship's checkout yet. The second cycle that still cannot
 * place it — a marker from a prior cycle already on the ticket — escalates
 * to a person.
 */

import type { Contract } from './contract.ts';
import type { Ticket, Comment } from './tracker.ts';
import type { MergeCandidate } from './release.ts';

/** A marker in the note, so a repeat is recognisable. */
export const STRANDED_MARKER = '<!-- crew:stranded-verified -->';

export interface StrandedVerified {
  candidate: MergeCandidate;
  /** The base branch searched, e.g. "main". */
  base: string;
  /** The remote searched, e.g. "origin". */
  remote: string;
  /** How many times this ticket has already been flagged for this. */
  priorFlags: number;
}

export type StrandedOutcome =
  /** First sighting — a note was left, status and assignee untouched. */
  | { kind: 'flagged' }
  /** Flagged before and still unplaceable — handed to a person. */
  | { kind: 'escalated' }
  | { kind: 'failed'; why: string };

/** How many times this ticket has already been flagged as stranded. */
export const priorStrandedFlags = (ticket: Ticket, comments: Comment[]): number =>
  comments.filter((c) => c.ticket_id === ticket.id && (c.body ?? '').includes(STRANDED_MARKER)).length;

export function planStrandedVerified(
  candidate: MergeCandidate, base: string, remote: string, comments: Comment[],
): StrandedVerified {
  return { candidate, base, remote, priorFlags: priorStrandedFlags(candidate.ticket, comments) };
}

export function flagComment(s: StrandedVerified): string {
  const key = s.candidate.ticket.issue_id;
  return `${STRANDED_MARKER}
**Verified, but nothing to merge — flagging before this repeats forever.**

\`${key}\` is \`verified\` with no branch on this ship, and its key names no commit on \`${s.base}\` (searched \`${s.remote}/${s.base}\`'s history for a bounded \`${key}\` in a commit subject or body). One of three things is true: it landed under a commit that never named the key, the branch was deleted before it merged, or it was verified in error — the crew cannot tell these apart and will not guess.

If it is still unplaceable next cycle, this ticket is escalated to a person. If the work already landed, closing this ticket by hand now avoids that.`;
}

export function escalateComment(s: StrandedVerified): string {
  const key = s.candidate.ticket.issue_id;
  return `${STRANDED_MARKER}
**Still nothing to merge — stopping rather than repeating.**

\`${key}\` was flagged as stranded at \`verified\` on an earlier cycle and still has no branch on this ship and no commit on \`${s.base}\` naming its key (searched \`${s.remote}/${s.base}\`). This needs a person: either the work landed under a commit that doesn't name the key and this ticket can simply close, or the branch is gone and the work needs redoing.

The crew will not close this on its own.`;
}

export interface StrandedWriter {
  updateTicket(id: string, patch: Record<string, unknown>): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string): Promise<void>;
}

export interface StrandedLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

/**
 * Perform the flag or escalation.
 *
 * Non-fatal throughout, the same reasoning as conflict.ts's apply: this runs
 * after the release has already shipped everything it could, and a tracker
 * blip here must not turn a good release into a failed one. A ticket left
 * unflagged because this failed is simply retried next cycle — no worse than
 * the old floor of repeating the log line forever.
 */
export async function applyStrandedVerified(
  writer: StrandedWriter,
  s: StrandedVerified,
  contract: Contract,
  operatorId: string | undefined,
  memberId: string,
  log: StrandedLog,
  dryRun: boolean,
): Promise<StrandedOutcome> {
  const t = { ticket: s.candidate.ticket.issue_id, step: 'merge' };

  if (s.priorFlags > 0) {
    if (dryRun) {
      log.emit(`would escalate to ${contract.statuses.needsHuman} — flagged before`, t);
      return { kind: 'escalated' };
    }
    try {
      await writer.updateTicket(s.candidate.ticket.id, {
        status: contract.statuses.needsHuman,
        ...(operatorId ? { assignee_id: operatorId } : {}),
      });
      await writer.postEvent(s.candidate.ticket.id, escalateComment(s), memberId).catch(() => {
        log.warn('escalated, but the note failed to post', t);
      });
      log.warn(`still nothing to merge after a flag — escalated to ${contract.statuses.needsHuman}`, t);
      return { kind: 'escalated' };
    } catch (e) {
      return { kind: 'failed', why: (e as Error).message };
    }
  }

  if (dryRun) {
    log.emit('would flag as stranded at verified — nothing to merge, no prior flag', t);
    return { kind: 'flagged' };
  }

  try {
    await writer.postEvent(s.candidate.ticket.id, flagComment(s), memberId).catch(() => {
      log.warn('flagged, but the note failed to post', t);
    });
    log.emit('flagged as stranded at verified — will escalate if still unplaceable next cycle', t);
    return { kind: 'flagged' };
  } catch (e) {
    return { kind: 'failed', why: (e as Error).message };
  }
}
