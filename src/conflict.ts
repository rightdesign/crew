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

import { git, gitOk, worktrees, isAncestor, GitError } from './git.ts';
import { StaleWriteError } from '@tablation/client';
import type { Contract } from './contract.ts';
import type { Ticket, RunnerEvent } from './tracker.ts';
import { calloutHeader } from './callout.ts';

/** A marker in the hand-back note, so a repeat is recognisable. */
export const BOUNCE_MARKER = calloutHeader('WARNING', 'Merge Conflict');

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
  /** The checkout the squash ran in; it has both the base and the branch refs. */
  cwd: string;
  /** The base tip this conflict was detected against (recorded on the hand-back so a later one can compare). */
  baseSha: string | null;
  /** The base tip the most recent acted-on hand-back was written against; null for events that predate it. */
  priorBaseSha: string | null;
  /** Branches already squash-merged earlier in this same release that changed one of `paths`. */
  siblings?: { key: string; branch: string }[];
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

const stampOf = (e: RunnerEvent): string => e.occurred_at ?? e.created_at ?? '';

/**
 * How many hand-backs of this ticket a lane has already acted on: a
 * `conflict_handed_back` counts only once a later `pushed` event exists, so a
 * hand-back nobody saw (or answered) does not make the next conflict look like
 * a lane that failed to fix it (CREW-1761). `events` carries both types.
 */
export const priorBounces = (ticket: Ticket, events: RunnerEvent[]): number => {
  const mine = events.filter((e) => e.record_id === ticket.id);
  const pushes = mine.filter((e) => e.event_type === 'pushed').map(stampOf);
  return mine.filter(
    (e) => e.event_type === 'conflict_handed_back' && pushes.some((p) => p > stampOf(e)),
  ).length;
};

/** The base tip a hand-back event was written against: its metadata, else the `Base tip:` line of its note. */
export const baseShaOf = (e: RunnerEvent): string | null => {
  const m = e.metadata?.base_sha;
  if (typeof m === 'string' && m) return m;
  return /Base tip: `([0-9a-f]{7,40})`/.exec(e.message ?? '')?.[1] ?? null;
};

/** The newest hand-back of this ticket that a lane acted on (same test as `priorBounces`). */
const lastActedHandBack = (ticket: Ticket, events: RunnerEvent[]): RunnerEvent | undefined => {
  const mine = events.filter((e) => e.record_id === ticket.id);
  const pushes = mine.filter((e) => e.event_type === 'pushed').map(stampOf);
  return mine
    .filter((e) => e.event_type === 'conflict_handed_back' && pushes.some((p) => p > stampOf(e)))
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)))[0];
};

/** A third conflict in a row escalates however the base moved: a hot file must not loop forever. */
export const MAX_ABSORBED_HANDBACKS = 2;

export function planConflictBounce(
  cwd: string,
  ticket: Ticket,
  branch: string,
  base: string,
  paths: string[],
  events: RunnerEvent[],
  merged: { key: string; branch: string }[] = [],
): ConflictBounce {
  // A path touched by a branch merged earlier in this release conflicts with
  // that branch, not with a base that has not moved.
  const siblings = merged.filter((m) => m.branch !== branch && paths.some((p) =>
    (gitOk(cwd, ['diff', '--name-only', `${base}...${m.branch}`, '--', p]) ?? '').trim() !== ''));
  return {
    ticket, branch, base, paths,
    worktree: worktreeForBranch(cwd, branch),
    priorBounces: priorBounces(ticket, events),
    cwd,
    baseSha: gitOk(cwd, ['rev-parse', '--verify', '-q', base]) || null,
    priorBaseSha: baseShaOf(lastActedHandBack(ticket, events) ?? { record_id: '', event_type: '' }),
    siblings,
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
): { clean: boolean; paths: string[]; why?: string; behind?: boolean } {
  // A worktree with uncommitted work of its own is not ours to merge into:
  // git would refuse anyway, and forcing it would destroy work nobody has
  // seen. Treat it as a conflict to hand back — a person or agent looking at
  // that worktree is the right resolver.
  const dirty = gitOk(worktree, ['status', '--porcelain']);
  if (dirty) return { clean: false, paths: [], why: 'the worktree has uncommitted changes' };
  // CREW-1636: merging base into a branch that is behind its own remote
  // produces a "conflict" the pushed tip may already have resolved. Behind
  // the remote is the finding, not a conflict to hand back.
  const upstream = gitOk(worktree, ['rev-parse', '-q', '--verify', '@{upstream}']);
  const head = gitOk(worktree, ['rev-parse', 'HEAD']);
  if (upstream && head && upstream !== head && isAncestor(worktree, head, upstream)) {
    return { clean: false, paths: [], behind: true, why: 'the branch is behind its remote; fast-forward it before merging the base in' };
  }
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

\`${b.branch}\` was verified, but squash-merging it into \`${b.base}\` conflicts in ${list}. ${b.siblings?.length
    ? `This conflicts with ${b.siblings.map((x) => `${x.key} (\`${x.branch}\`)`).join(', ')}, merged earlier in the same release, not with a \`${b.base}\` that moved: merging \`${b.base}\` in will change nothing. Merge ${b.siblings.length === 1 ? 'that branch' : 'those branches'} into this one (or move this change onto ${b.siblings.length === 1 ? 'it' : 'one of them'}), resolve, and push.`
    : `Work that landed on \`${b.base}\` after this branch was cut has changed the same lines.`}

${merged
    ? `\`${b.base}\` has been merged into \`${b.branch}\` in its worktree and the conflict is left in place, so \`git status\` there shows exactly what disagrees. Resolve it, commit, push as a plain fast-forward (the branch is pushed, so rebasing it is not an option) and hand back to QA as usual — \`git merge --abort\` backs the merge out if you would rather start differently.`
    : `This ship has no worktree for \`${b.branch}\`, so nothing has been merged for you. Merge \`${b.base}\` into the branch wherever it lives, resolve the conflict, and commit.`}

${b.baseSha ? `Base tip: \`${b.baseSha}\`\n\n` : ''}Nothing was written to \`${b.base}\`: the failed merge was rewound, and the rest of the release shipped without this ticket. Re-verifying is what puts it back in the merge queue.`;
}

export function escalateComment(b: ConflictBounce): string {
  const where = b.paths.length ? ` (${b.paths.map((p) => `\`${p}\``).join(', ')})` : '';
  const absorbed = b.priorBounces >= MAX_ABSORBED_HANDBACKS;
  return `${BOUNCE_MARKER}

**Conflicting again after a hand-back — stopping rather than looping.**

\`${b.branch}\` was handed back ${b.priorBounces === 1 ? 'once' : `${b.priorBounces} times`} for a merge conflict, verified again, and conflicts against \`${b.base}\` ${b.priorBounces === 1 ? 'a second time' : `again (conflict ${b.priorBounces + 1})`}${where}.

${absorbed
    ? `Each earlier hand-back was answered by merging \`${b.base}\` in, and \`${b.base}\` moved underneath the branch every time. This file is changing faster than the lanes can absorb it, so it needs a person to sequence this ticket against the others touching it.`
    : `The branch ${b.priorBaseSha ? `does not contain \`${b.priorBaseSha}\`, the \`${b.base}\` tip it was last handed back for` : 'was pushed'} — the hand-back was answered without merging \`${b.base}\` in, or this ticket overlaps work that has already shipped and needs rethinking rather than merging.`}
That is a call for a person, not another lap through the lanes.`;
}

export interface ConflictWriter {
  updateTicket(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown>;
  postEvent(
    ticketId: string, body: string, memberId: string, type?: string, extra?: Record<string, unknown>,
  ): Promise<void>;
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

  // A hand-back that was answered by merging the base it named is not a failed
  // resolution when the base has moved again since (CREW-2379): treat it as a
  // fresh conflict, up to MAX_ABSORBED_HANDBACKS. Anything we cannot prove
  // (no recorded sha, branch ref unreadable) keeps the old escalation.
  const absorbed = b.priorBounces > 0 && b.priorBounces < MAX_ABSORBED_HANDBACKS && !!b.priorBaseSha
    && isAncestor(b.worktree ?? b.cwd, b.priorBaseSha, b.branch);
  if (absorbed) {
    log.emit(`${b.ticket.issue_id} conflicts again, but ${b.base} moved since the hand-back was answered — handing back again`, t);
  }

  if (b.priorBounces > 0 && !absorbed) {
    if (dryRun) {
      log.emit(`would escalate to ${contract.statuses.needsHuman} — handed back before`, t);
      return { kind: 'escalated' };
    }
    try {
      await writer.updateTicket(b.ticket.id, { status: contract.statuses.needsHuman }, b.ticket.updated_at);
      await writer.postEvent(b.ticket.id, escalateComment(b), memberId, 'conflict_escalated').catch(() => {
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
    if (r.behind) {
      // Not a real conflict: the local copy is stale. Leave the ticket at
      // `verified` untouched; the release levels the branch next cycle.
      log.warn(`not handing ${b.ticket.issue_id} back: ${r.why}`, t);
      return { kind: 'failed', why: r.why ?? 'branch behind its remote' };
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
    await writer.postEvent(b.ticket.id, handBackComment(b, merged), memberId, 'conflict_handed_back',
      b.baseSha ? { base_sha: b.baseSha } : undefined).catch(() => {
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
