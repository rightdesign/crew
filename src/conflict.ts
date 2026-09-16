/**
 * What happens when a verified branch will not squash-merge.
 *
 * Before this, a conflicting branch was reset and skipped, and that was all:
 * the ticket stayed `verified`, nothing was written to the board, and the
 * next cycle re-ran the identical merge and failed identically. ISSUE-346
 * failed six times in an hour that way, visible only as an error count in a
 * log line. The release was never blocked — every other branch still shipped
 * — so nothing ever escalated. That is the bug this module closes.
 *
 * The crew does NOT resolve the conflict itself. Resolving a merge is
 * judgement about intent, and doing it inside the release phase would put an
 * agent in the ship path, holding the release lock, writing code that nothing
 * afterwards reviews. Instead the conflict is MOVED to where the crew already
 * has a seat for it: the ticket goes back to the dev lane, which resolves it
 * with the ticket's context in hand and hands it to QA like any other change.
 *
 * One resolution IS attempted first, and it is free: merging the base branch
 * into the ticket's own branch. Where that applies cleanly — the branch was
 * merely stale, or an earlier hand-back already resolved it — the squash on
 * the next cycle applies cleanly too, and nobody is woken at all.
 *
 * ## Why the hand-back clears the assignee
 *
 * `in_progress` with no assignee already means "back up for grabs" to
 * `buildingRoleHasWork`, which wakes a dev lane for exactly that. So the
 * hand-back needs no new selection logic — and, more to the point, it works
 * with SEVERAL SHIPS in the water. The board is the only state ships share:
 * one ship's lock file, worktrees and branches are invisible to another. A
 * hand-back written to the board is therefore picked up by whichever ship
 * crews dev, including the ship that built the branch in the first place,
 * which is the one whose worktree still holds it.
 *
 * That also decides what happens when the branch has no worktree HERE: the
 * ticket is handed back regardless, without touching git. The conflict is
 * real wherever the branch lives, and the ship that owns it will find it.
 */

import { git, gitOk, worktrees, GitError } from './git.ts';
import { StaleWriteError } from '@tablation/client';
import type { Contract } from './contract.ts';
import type { Ticket, Comment } from './tracker.ts';

/** A marker in the hand-back note, so a repeat is recognisable. */
export const BOUNCE_MARKER = '<!-- crew:merge-conflict -->';

export interface ConflictBounce {
  ticket: Ticket;
  branch: string;
  /** The branch this failed to merge into. */
  base: string;
  /** The branch's worktree ON THIS SHIP, or null when it was built elsewhere. */
  worktree: string | null;
  /** Paths git could not merge, captured before the base checkout was rewound. */
  paths: string[];
  /** How many times the crew has already handed this ticket back for a conflict. */
  priorBounces: number;
}

export type ConflictOutcome =
  /** Merging the base in applied cleanly — the next cycle's squash will too. */
  | { kind: 'refreshed' }
  /** The conflict is real; the ticket is back with the dev lane. */
  | { kind: 'handed-back' }
  /** Handed back before and conflicting again — a person owes an answer. */
  | { kind: 'escalated' }
  /**
   * The ticket moved on the board since this run read it, so the write was
   * refused rather than applied (ISSUE-821): a stamp landing between this
   * cycle's board fetch and this bounce — this ticket's own release, or
   * another cycle's — must never be overwritten back to `building` by a
   * conflict this run detected against now-stale state.
   */
  | { kind: 'stale' }
  | { kind: 'failed'; why: string };

/**
 * Where this branch is checked out on this ship, if anywhere.
 *
 * By branch, not by worktree name: a worktree's directory is named after the
 * ticket, but the branch is what actually failed to merge, and the two can
 * disagree once a repo names its worktrees itself.
 */
export function worktreeForBranch(cwd: string, branch: string): string | null {
  for (const w of worktrees(cwd)) {
    if (w.branch === branch && !w.prunable) return w.path;
  }
  return null;
}

/** How many times the crew has already handed this ticket back. */
export const priorBounces = (ticket: Ticket, comments: Comment[]): number =>
  comments.filter((c) => c.ticket_id === ticket.id && (c.body ?? '').includes(BOUNCE_MARKER)).length;

export function planConflictBounce(
  cwd: string,
  ticket: Ticket,
  branch: string,
  base: string,
  paths: string[],
  comments: Comment[],
): ConflictBounce {
  return {
    ticket, branch, base, paths,
    worktree: worktreeForBranch(cwd, branch),
    priorBounces: priorBounces(ticket, comments),
  };
}

/**
 * Merge the base branch into the ticket's branch, in its own worktree.
 *
 * A real merge, not a squash: it writes MERGE_HEAD, so `git merge --abort`
 * works and whoever picks this up has a way back. A conflict is LEFT IN
 * PLACE deliberately — the worktree then shows the whole thing to the next
 * agent that opens it, which no note on the board can do.
 */
export function refreshBranch(
  worktree: string, base: string,
): { clean: boolean; paths: string[]; why?: string } {
  // A worktree with uncommitted work of its own is not ours to merge into:
  // git would refuse anyway, and forcing it would destroy work nobody has
  // seen. Treat it as a conflict to hand back — a person or agent looking at
  // that worktree is the right resolver.
  const dirty = gitOk(worktree, ['status', '--porcelain']);
  if (dirty) return { clean: false, paths: [], why: 'the worktree has uncommitted changes' };
  try {
    git(worktree, ['merge', '--no-edit', base]);
    return { clean: true, paths: [] };
  } catch (e) {
    const paths = (gitOk(worktree, ['diff', '--name-only', '--diff-filter=U']) ?? '')
      .split('\n').filter(Boolean);
    // Not a conflict but some other failure (no such base, a broken index):
    // leave nothing half-done behind.
    if (!paths.length) {
      gitOk(worktree, ['merge', '--abort']);
      return { clean: false, paths: [], why: (e as GitError).message };
    }
    return { clean: false, paths };
  }
}

export function handBackComment(b: ConflictBounce, merged: boolean): string {
  const list = b.paths.length ? b.paths.map((p) => `\`${p}\``).join(', ') : 'files this branch and the base both changed';
  return `${BOUNCE_MARKER}
**Back with the dev lane — this branch no longer merges.**

\`${b.branch}\` was verified, but squash-merging it into \`${b.base}\` conflicts in ${list}. Work that landed on \`${b.base}\` after this branch was cut has changed the same lines.

${merged
    ? `\`${b.base}\` has been merged into \`${b.branch}\` in its worktree and the conflict is left in place, so \`git status\` there shows exactly what disagrees. Resolve it, commit, and hand back to QA as usual — \`git merge --abort\` backs the merge out if you would rather start differently.`
    : `This ship has no worktree for \`${b.branch}\`, so nothing has been merged for you. Merge \`${b.base}\` into the branch wherever it lives, resolve the conflict, and commit.`}

Nothing was written to \`${b.base}\`: the failed merge was rewound, and the rest of the release shipped without this ticket. Re-verifying is what puts it back in the merge queue.`;
}

export function escalateComment(b: ConflictBounce): string {
  return `${BOUNCE_MARKER}
**Conflicting again after a hand-back — stopping rather than looping.**

\`${b.branch}\` was handed back once for a merge conflict, verified again, and conflicts against \`${b.base}\` a second time${b.paths.length ? ` (${b.paths.map((p) => `\`${p}\``).join(', ')})` : ''}.

Either \`${b.base}\` is moving faster than this branch can be rebased onto it, or this ticket overlaps work that has already shipped and needs rethinking rather than merging. That is a call for a person, not another lap through the lanes.`;
}

export interface ConflictWriter {
  updateTicket(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string): Promise<void>;
}

export interface ConflictLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

/**
 * Perform the hand-back.
 *
 * Non-fatal throughout, for the same reason stamping is: this runs after the
 * release has already shipped everything that could ship, and a tracker blip
 * must not turn a good release into a failed one. A ticket left at `verified`
 * because this failed is simply retried next cycle, which is exactly the
 * behaviour that existed before this module — no worse than the old floor.
 */
export async function applyConflictBounce(
  writer: ConflictWriter,
  b: ConflictBounce,
  contract: Contract,
  memberId: string,
  log: ConflictLog,
  dryRun: boolean,
): Promise<ConflictOutcome> {
  const t = { ticket: b.ticket.issue_id, step: 'merge' };

  if (b.priorBounces > 0) {
    if (dryRun) {
      log.emit(`would escalate to ${contract.statuses.needsHuman} — handed back before`, t);
      return { kind: 'escalated' };
    }
    try {
      await writer.updateTicket(b.ticket.id, { status: contract.statuses.needsHuman }, b.ticket.updated_at);
      await writer.postEvent(b.ticket.id, escalateComment(b), memberId).catch(() => {
        log.warn('escalated, but the note failed to post', t);
      });
      log.warn(`conflicts again after a hand-back — escalated to ${contract.statuses.needsHuman}`, t);
      return { kind: 'escalated' };
    } catch (e) {
      if (e instanceof StaleWriteError) {
        log.emit(`${b.ticket.issue_id} changed on the board since this run read it — not escalating over it`, t);
        return { kind: 'stale' };
      }
      return { kind: 'failed', why: (e as Error).message };
    }
  }

  if (dryRun) {
    log.emit(
      `would merge ${b.base} into ${b.branch}` +
        `${b.worktree ? ` in ${b.worktree}` : ' — no worktree on this ship'}` +
        `, and hand back to ${contract.statuses.building} if it conflicts`,
      t,
    );
    return { kind: 'handed-back' };
  }

  let merged = false;
  if (b.worktree) {
    const r = refreshBranch(b.worktree, b.base);
    if (r.clean) {
      // Stale, not conflicting. The branch now contains the base, so the next
      // cycle's squash applies cleanly and the ticket stays verified — nobody
      // is woken and nothing is written to the board.
      log.emit(`merged ${b.base} into ${b.branch} cleanly — it was stale, not conflicting`, t);
      return { kind: 'refreshed' };
    }
    merged = r.paths.length > 0;
    if (r.why) log.warn(`could not merge ${b.base} into ${b.branch}: ${r.why}`, t);
    if (r.paths.length) b.paths = r.paths;   // the branch's own view, more precise than the squash's
  }

  try {
    // Assignee cleared, not set to a seat: `in_progress` with no assignee is
    // what `buildingRoleHasWork` reads as "back up for grabs", and it is the
    // only claim signal every ship in the water can see.
    //
    // Conditioned on the `updated_at` this run read the ticket at — never on
    // a bare guess that it's still `verified` (ISSUE-821): a stamp landing on
    // this ticket between this cycle's board fetch and this write (its own
    // successful release just moments before, since a squash-merge conflict
    // can surface from a stale re-attempt of a branch already carried by an
    // earlier squash) must never be clobbered back to `building`.
    await writer.updateTicket(
      b.ticket.id, { status: contract.statuses.building, assignee_id: null }, b.ticket.updated_at,
    );
    await writer.postEvent(b.ticket.id, handBackComment(b, merged), memberId).catch(() => {
      log.warn('handed back, but the note failed to post', t);
    });
    log.emit(
      `handed back to ${contract.statuses.building} — conflicts with ${b.base}` +
        `${b.paths.length ? ` in ${b.paths.join(', ')}` : ''}`,
      t,
    );
    return { kind: 'handed-back' };
  } catch (e) {
    if (e instanceof StaleWriteError) {
      log.emit(`${b.ticket.issue_id} changed on the board since this run read it — not handing it back over it`, t);
      return { kind: 'stale' };
    }
    return { kind: 'failed', why: (e as Error).message };
  }
}
