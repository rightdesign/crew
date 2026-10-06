/**
 * The review hand-off: pushing verified work for a person to review.
 *
 * For a repo that is `release.mode: external` and whose contract names
 * `statuses.reviewing`, a ticket reaching `verified` is not merged by the
 * crew — it is pushed under `branch.push`, a pull request is opened through
 * the repo's own `hooks.pr`, and the ticket moves to `reviewing`. The branch
 * a reviewer sees is what QA verified, so two columns keep that honest:
 *
 *   verified_sha  written by QA with the move to `verified`; the branch head
 *                 that was actually tested.
 *   pr_ref        what `hooks.pr` printed — the PR this ticket was handed off
 *                 under. Carried to `hooks.merged` as `CREW_PR`.
 *
 * Every cycle, a `verified` or `reviewing` ticket whose branch (here, or as
 * the reviewer left it on the remote) is no longer what `verified_sha` names
 * returns to QA's queue: a reviewer's extra commit changed what was verified.
 *
 * `reviewing` is deliberately NOT a hold — QA keeps watching it, which is what
 * makes the re-verification above work at all.
 *
 * Git and hooks happen in `runReview` (inside the release run); the tracker
 * writes happen in `applyReview`, after it, so a tracker blip cannot undo a
 * push that already landed.
 */

import { isAncestor, pushBranch, resolve } from './git.ts';
import type { Emitter } from './events.ts';
import type { Contract } from './contract.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import { pushedBranchForTicket } from './ticket-branch.ts';
import { displayKey, type Ticket, type Tracker } from './tracker.ts';
import { lastLines } from './gate-red.ts';

/** Which optional review columns the Issues table carries (`Tracker#reviewColumns`). */
export interface ReviewColumns { verifiedSha: boolean; prRef: boolean }

export interface ReviewItem {
  ticket: Ticket;
  /** The local branch holding the ticket's work. */
  branch: string;
}

/** A ticket whose branch was pushed (and whose PR hook ran), ready to move to `reviewing`. */
export interface ReviewHandoff {
  ticket: Ticket;
  pushedAs: string;
  head: string;
  /** What `hooks.pr` printed that looks like a PR reference — a URL or number. */
  prRef?: string;
  /** Set when `hooks.pr` ran and failed: the branch is pushed, the PR is not. */
  prFailure?: { code: number; tail: string };
}

/** A ticket whose branch no longer matches what QA verified. */
export interface ReviewRequeue {
  ticket: Ticket;
  /** `verified_sha`. */
  verified: string;
  /** Where the branch is now (local head, or the remote's if a reviewer pushed past it). */
  head: string;
}

export interface ReviewOutcome {
  handoffs: ReviewHandoff[];
  requeues: ReviewRequeue[];
}

/**
 * Whether the review hand-off applies to this repo at all: it needs both a
 * repo that hands work off (`external`) and a workspace with somewhere to put
 * it (`statuses.reviewing`). Either missing is simply today's behaviour.
 */
export function reviewApplies(repo: EffectiveRepoConfig, contract: Contract): boolean {
  return repo.release.mode === 'external' && !!contract.statuses.reviewing;
}

/**
 * Reasons a repo that hands off for review cannot do it safely.
 *
 * The pushed branch name is the only durable link between a ticket and
 * whatever the forge decides: a squash or rebase merge destroys SHA ancestry,
 * and a PR title derives from the branch. A push template carrying none of the
 * ticket's key, number or tag would name every ticket's branch alike (or
 * something `hooks.merged` cannot map back), so it is refused up front.
 */
export function reviewProblems(repo: EffectiveRepoConfig, contract: Contract): string[] {
  if (!reviewApplies(repo, contract)) return [];
  const problems: string[] = [];
  const template = repo.branch.push ?? repo.branch.name;
  if (!/\{(key|number|tag)\}/.test(template)) {
    problems.push(
      `branch.push "${template}" names none of {key}, {number} or {tag} — with release.mode "external" and a ` +
      'reviewing status, the pushed branch is the only link back to its ticket',
    );
  }
  return problems;
}

/** The first line of `output` that looks like a PR reference, or the only line if there is just one. */
export function parsePrRef(output: string): string | undefined {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1) return lines[0]!.slice(0, 500);
  for (const l of [...lines].reverse()) {
    if (/^https?:\/\/\S+$/.test(l) || /^#?\d+$/.test(l)) return l;
  }
  return undefined;
}

export interface ReviewRun {
  cwd: string;
  repo: EffectiveRepoConfig;
  contract: Contract;
  emit: Emitter;
  columns: ReviewColumns;
  dryRun?: boolean;
  /** Runs `hooks.pr` with the given environment; null when the repo defines none. */
  runPrHook(env: Record<string, string>): Promise<{ code: number; output: string } | null>;
}

/** The value of a ticket column, as a trimmed string ('' when unset). */
function columnValue(t: Ticket, column: string): string {
  const v = (t as Record<string, unknown>)[column];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Has this ticket's branch moved off what QA verified? Compares the local
 * head, and the remote's too: a reviewer's commit lands there first, and
 * waits for `crew sync` to fast-forward it here. The remote only counts when
 * it is ahead of (or off) what was verified — a remote still BEHIND it is
 * just a push that has not happened yet.
 */
function movedPast(r: ReviewRun, t: Ticket, branch: string, pushedAs: string): ReviewRequeue | null {
  if (!r.columns.verifiedSha) return null;
  const verified = columnValue(t, r.contract.columns.verifiedSha);
  if (!verified) return null;
  const head = resolve(r.cwd, branch);
  const remoteHead = resolve(r.cwd, `${r.repo.branch.remote}/${pushedAs}`);
  if (remoteHead && !isAncestor(r.cwd, remoteHead, verified) && remoteHead !== head) {
    return { ticket: t, verified, head: remoteHead };
  }
  if (head && head !== verified && !isAncestor(r.cwd, head, verified)) {
    return { ticket: t, verified, head };
  }
  return null;
}

/**
 * One cycle of the hand-off, for tickets that have NOT landed (the caller
 * filters landed ones out): re-verification for both statuses, and the push
 * for the ones still at `verified`.
 *
 * A push is a plain fast-forward — never forced, because a rejection means a
 * reviewer's commits are on the remote and overwriting them is the one thing
 * this must not do. A rejected push leaves the ticket at `verified` and says
 * why; it retries next cycle.
 */
export async function runReview(r: ReviewRun, verified: ReviewItem[], reviewing: ReviewItem[]): Promise<ReviewOutcome> {
  const out: ReviewOutcome = { handoffs: [], requeues: [] };
  const remote = r.repo.branch.remote;

  for (const { ticket, branch } of reviewing) {
    const moved = movedPast(r, ticket, branch, pushedBranchForTicket(r.repo, ticket));
    if (moved) out.requeues.push(moved);
  }

  for (const { ticket, branch } of verified) {
    const pushedAs = pushedBranchForTicket(r.repo, ticket);
    const moved = movedPast(r, ticket, branch, pushedAs);
    if (moved) { out.requeues.push(moved); continue; }

    const head = resolve(r.cwd, branch);
    if (!head) continue;
    if (r.dryRun) {
      r.emit.emit(`would push ${branch} to ${remote}/${pushedAs} for review`, { ticket: ticket.issue_id });
      continue;
    }
    try {
      pushBranch(r.cwd, remote, branch, pushedAs);
    } catch (e) {
      r.emit.error(
        `could not push ${branch} to ${remote}/${pushedAs} for review — ${(e as Error).message.split('\n')[0]}; ` +
        'left at verified, retried next cycle',
        { ticket: ticket.issue_id },
      );
      continue;
    }
    r.emit.emit(`pushed ${branch} to ${remote}/${pushedAs} for review`, { ticket: ticket.issue_id });

    const handoff: ReviewHandoff = { ticket, pushedAs, head };
    // A ticket that already carries a PR reference was handed off before (the
    // tracker write after the push failed): do not open a second one.
    const existing = r.columns.prRef ? columnValue(ticket, r.contract.columns.prRef) : '';
    if (existing) {
      handoff.prRef = existing;
    } else {
      const res = await r.runPrHook({
        CREW_TICKET: ticket.issue_id, CREW_BRANCH: pushedAs, CREW_BASE: r.repo.branch.base,
        CREW_TITLE: `${displayKey(ticket)}: ${ticket.title ?? ''}`.trim(),
      });
      if (res && res.code !== 0) handoff.prFailure = { code: res.code, tail: lastLines(res.output, 5).trim() };
      else if (res) handoff.prRef = parsePrRef(res.output);
    }
    out.handoffs.push(handoff);
  }
  return out;
}

/**
 * The tracker half: move handed-off tickets to `reviewing` and requeued ones
 * back to QA, each with an audit comment. Conditional on the `updated_at` read
 * with the ticket, so a ticket someone moved meanwhile is left alone. Non-fatal
 * per ticket — the push has happened either way.
 */
export async function applyReview(
  tracker: Pick<Tracker, 'updateTicket' | 'postEvent'>, contract: Contract, outcome: ReviewOutcome, remote: string,
  emit: Emitter, seat: string, columns: ReviewColumns, dryRun: boolean,
): Promise<void> {
  const reviewing = contract.statuses.reviewing;
  for (const h of outcome.handoffs) {
    if (!reviewing) break;
    const t = h.ticket;
    const lines = [`Pushed \`${h.pushedAs}\` (${h.head.slice(0, 8)}) to \`${remote}\` for review; moved to ${reviewing}.`];
    if (h.prRef) lines.push(`Pull request: ${h.prRef}`);
    if (h.prFailure) {
      lines.push(
        `\`hooks.pr\` exited ${h.prFailure.code}, so no pull request was recorded — the branch is pushed, ` +
        `open one by hand.\n\n\`\`\`\n${h.prFailure.tail}\n\`\`\``,
      );
    }
    try {
      await tracker.updateTicket(t.id, {
        [contract.columns.status]: reviewing,
        ...(h.prRef && columns.prRef ? { [contract.columns.prRef]: h.prRef } : {}),
      }, t.updated_at);
      await tracker.postEvent(t.id, lines.join('\n\n'), seat);
      emit.emit(`moved to ${reviewing}`, { ticket: t.issue_id });
    } catch (e) {
      emit.warn(`could not move to ${reviewing}: ${(e as Error).message}`, { ticket: t.issue_id });
    }
  }
  for (const q of outcome.requeues) {
    const t = q.ticket;
    const body =
      `The branch is no longer what was verified: \`verified_sha\` is ${q.verified.slice(0, 8)}, the branch is now at ` +
      `${q.head.slice(0, 8)}. Returned to ${contract.statuses.handoff} for QA to check what changed.`;
    if (dryRun) {
      emit.emit(`would return to ${contract.statuses.handoff} — branch moved past ${q.verified.slice(0, 8)}`, { ticket: t.issue_id });
      continue;
    }
    try {
      await tracker.updateTicket(t.id, { [contract.columns.status]: contract.statuses.handoff }, t.updated_at);
      await tracker.postEvent(t.id, body, seat);
      emit.emit(`returned to ${contract.statuses.handoff} — branch moved past ${q.verified.slice(0, 8)}`, { ticket: t.issue_id });
    } catch (e) {
      emit.warn(`could not return to ${contract.statuses.handoff}: ${(e as Error).message}`, { ticket: t.issue_id });
    }
  }
}
