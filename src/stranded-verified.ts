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
import type { Ticket, RunnerEvent } from './tracker.ts';
import type { MergeCandidate } from './release.ts';
import { calloutHeader } from './callout.ts';
import { gitOk } from './git.ts';
import { branchCandidatesForTicket } from './ticket-branch.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';

/** A marker in the note, so a repeat is recognisable. */
export const STRANDED_MARKER = calloutHeader('WARNING', 'Stranded Verified');

/**
 * CREW-3384: a remote branch under another name whose commits name the ticket's key — most likely the ticket's
 * work, built on a branch the contract name does not match.
 */
export interface NearMissBranch { branch: string; commits: number }

/**
 * Remote branches whose name contains the ticket number and whose commits ahead of the base name the key.
 * Bounded to branches containing the number so the search stays cheap; reads the remote-tracking refs as this
 * ship last fetched them. Never throws: no refs or a failed git call is an empty list.
 */
export function findNearMissBranches(dir: string, cfg: EffectiveRepoConfig, ticket: Pick<Ticket, 'issue_id' | 'issue_tag' | 'project_issue_prefix'>): NearMissBranch[] {
  const number = ticket.issue_id.replace(/^\D+/, '');
  if (!number) return [];
  const remote = cfg.branch.remote;
  const prefix = `refs/remotes/${remote}/`;
  const refs = (gitOk(dir, ['for-each-ref', '--format=%(refname)', prefix]) ?? '').split('\n')
    .filter((r) => r.startsWith(prefix) && r !== `${prefix}HEAD`)
    .map((r) => r.slice(prefix.length))
    .filter((b) => b !== cfg.branch.base && new RegExp(`(^|\\D)${number}(\\D|$)`).test(b));
  const keys = [...new Set([ticket.issue_id, ticket.issue_tag].filter((k): k is string => !!k))];
  const keyRe = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const out: NearMissBranch[] = [];
  for (const b of refs) {
    const log = gitOk(dir, ['log', '--format=%H', '-E', '-i', `--grep=(^|[^0-9A-Za-z])(${keyRe})([^0-9]|$)`, `${remote}/${cfg.branch.base}..${prefix}${b}`]);
    const commits = log ? log.split('\n').filter(Boolean).length : 0;
    if (commits > 0) out.push({ branch: b, commits });
  }
  return out;
}

/** The sentence the stranded notes add when a near-miss branch exists; empty when none. */
export function nearMissText(s: Pick<StrandedVerified, 'remote' | 'nearMisses' | 'expectedBranch'>): string {
  if (!s.nearMisses?.length) return '';
  const list = s.nearMisses.map((n) => `\`${s.remote}/${n.branch}\` (${n.commits} commit${n.commits === 1 ? '' : 's'} naming the key)`).join(', ');
  return `\n\n**A branch under another name looks like this ticket's work:** ${list}. The crew expected \`${s.expectedBranch ?? 'the contract branch name'}\`. It was most likely built on a misnamed branch; pushing it under the expected name, or renaming it, lets the release merge it.`;
}

export interface StrandedVerified {
  /** CREW-3384: remote branches under other names whose commits name the key. */
  nearMisses?: NearMissBranch[];
  /** CREW-3384: the contract branch name the crew looked for. */
  expectedBranch?: string;
  candidate: MergeCandidate;
  /** The base branch searched, e.g. "main". */
  base: string;
  /** The remote searched, e.g. "origin". */
  remote: string;
  /** How many times this ticket has already been flagged for this. */
  priorFlags: number;
  /** When the most recent flag was posted, if any carries a timestamp. */
  lastFlaggedAt?: number;
}

/**
 * The shortest time between the flag and the escalation (CREW-1364).
 *
 * "One cycle later" was ~2.5 minutes — shorter than it takes another ship to
 * push a branch, or this ship to next fetch. A ticket built elsewhere was
 * flagged and escalated to a person before its branch could possibly have
 * arrived. The lookup now fetches before it concludes anything, and this
 * gap is the second guard: a flag only ripens into an escalation after the
 * race it was meant to allow for has had time to resolve.
 */
export const STRANDED_ESCALATE_AFTER_MS = 30 * 60 * 1000;

export type StrandedOutcome =
  /** First sighting — a note was left, status and assignee untouched. */
  | { kind: 'flagged' }
  /** Flagged recently — too soon to escalate, nothing written. */
  | { kind: 'waiting' }
  /** Flagged before and still unplaceable — handed to a person. */
  | { kind: 'escalated' }
  | { kind: 'failed'; why: string };

/** How many times this ticket has already been flagged as stranded. */
export const priorStrandedFlags = (ticket: Ticket, events: RunnerEvent[]): number =>
  events.filter((e) => e.record_id === ticket.id && e.event_type === 'stranded_flagged').length;

export function planStrandedVerified(
  candidate: MergeCandidate, base: string, remote: string, events: RunnerEvent[],
  /** CREW-3384: where to look for a differently named branch; omitted, none is searched for. */
  look?: { dir: string; cfg: EffectiveRepoConfig },
): StrandedVerified {
  const stamps = events
    .filter((e) => e.record_id === candidate.ticket.id && e.event_type === 'stranded_flagged')
    .map((e) => Date.parse(e.occurred_at ?? e.created_at ?? ''))
    .filter((n) => !Number.isNaN(n));
  const nearMisses = look ? findNearMissBranches(look.dir, look.cfg, candidate.ticket) : [];
  return {
    candidate, base, remote,
    ...(nearMisses.length && look ? { nearMisses, expectedBranch: branchCandidatesForTicket(look.cfg, candidate.ticket).find((c) => !c.endsWith('*')) } : {}),
    priorFlags: priorStrandedFlags(candidate.ticket, events),
    lastFlaggedAt: stamps.length ? Math.max(...stamps) : undefined,
  };
}

export function flagComment(s: StrandedVerified): string {
  const key = s.candidate.ticket.issue_id;
  return `${STRANDED_MARKER}

**Verified, but nothing to merge — flagging before this repeats forever.**

\`${key}\` is \`verified\` with no branch on this ship, and its key names no commit anywhere in this ship's \`${s.base}\` history (searched all of it, local commits included, for a bounded \`${key}\` in a commit subject or body). One of three things is true: it landed under a commit that never named the key, the branch was deleted before it merged, or it was verified in error — the crew cannot tell these apart and will not guess.

If it is still unplaceable next cycle, this ticket is escalated to a person. If the work already landed, closing this ticket by hand now avoids that.${nearMissText(s)}`;
}

export function escalateComment(s: StrandedVerified): string {
  const key = s.candidate.ticket.issue_id;
  return `${STRANDED_MARKER}

**Still nothing to merge — stopping rather than repeating.**

\`${key}\` was flagged as stranded at \`verified\` on an earlier cycle and still has no branch on this ship or on \`${s.remote}\` and no commit in this ship's \`${s.base}\` history naming its key (searched all of it, local commits included). This needs a person: either the work landed under a commit that doesn't name the key and this ticket can simply close, or the branch is gone and the work needs redoing.

The crew will not close this on its own.${nearMissText(s)}`;
}

export interface StrandedWriter {
  updateTicket(id: string, patch: Record<string, unknown>): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string, type?: string): Promise<void>;
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
  now: number = Date.now(),
): Promise<StrandedOutcome> {
  const t = { ticket: s.candidate.ticket.issue_id, step: 'merge' };

  if (s.priorFlags > 0 && s.lastFlaggedAt !== undefined && now - s.lastFlaggedAt < STRANDED_ESCALATE_AFTER_MS) {
    log.emit('flagged as stranded recently — not escalating yet', t);
    return { kind: 'waiting' };
  }

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
      await writer.postEvent(s.candidate.ticket.id, escalateComment(s), memberId, 'stranded_escalated').catch(() => {
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
    await writer.postEvent(s.candidate.ticket.id, flagComment(s), memberId, 'stranded_flagged').catch(() => {
      log.warn('flagged, but the note failed to post', t);
    });
    log.emit('flagged as stranded at verified — will escalate if still unplaceable next cycle', t);
    return { kind: 'flagged' };
  } catch (e) {
    return { kind: 'failed', why: (e as Error).message };
  }
}
