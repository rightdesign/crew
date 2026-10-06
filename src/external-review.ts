/**
 * The review leg of `release.mode: external` (CREW-1387).
 *
 * An `external` repo is reviewed on its forge before the work counts as done.
 * The path a ticket takes there is
 *
 *   accepted -> in_progress -> (in review) -> fixed -> verified -> closed_deployed
 *
 * and the point of the middle step is that QA never tests a branch a reviewer
 * may still change or reject. "In review" is `in_progress` carrying
 * `needs_review`, with no assignee: the same state the design seat parks a
 * built-and-waiting ticket in, which `select.ts` already refuses to resume. No
 * new status is needed, so no workspace's choice list has to change.
 *
 * Three pieces:
 *
 *   openReview       at hand-off, after the push is verified: run `hooks.pr`,
 *                    record the URL it printed, park the ticket in review.
 *   settleReviews    each release phase, for every ticket in review: ask
 *                    `hooks.merged` (landed -> `fixed`), else `hooks.review`
 *                    (`changes_requested` -> back to the dev seat).
 *   reviewUrlFrom    read the URL back off the ticket's comments.
 *
 * The URL lives in a machine-written comment rather than a `review_url`
 * column: the crew may not add columns to a workspace, and a comment needs
 * none. `reviewUrlFrom` is the one place that knows the format, so a column
 * can replace it later without touching a caller.
 */

import { referenceKeys, type Comment, type Ticket, type Tracker } from './tracker.ts';
import type { Contract } from './contract.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import { resolveShell, runScript } from './shell.ts';
import { detectClosure } from './git.ts';

/** Marks the comment that carries a ticket's pull request URL. */
export const REVIEW_OPENED_MARKER = '<!-- crew:review-opened -->';
/** Marks the comment that sent a ticket back to the dev seat for review feedback. */
export const REVIEW_CHANGES_MARKER = '<!-- crew:review-changes-requested -->';

export type ReviewState = 'approved' | 'changes_requested' | 'open';

export const reviewOpenedBody = (url: string, branch: string): string =>
  `${REVIEW_OPENED_MARKER}\n**In review:** ${url}\n\nBranch \`${branch}\` is pushed and its pull request is open. ` +
  'The ticket waits here (`in_progress`, `needs_review`) and moves to `fixed` for QA once the branch has landed.';

export const reviewFailedBody = (branch: string, output: string): string =>
  `**The pull request could not be opened** for \`${branch}\` — the \`pr\` hook ${output ? `said:\n\n\`\`\`\n${output}\n\`\`\`` : 'printed nothing'}\n\n` +
  'The branch is pushed. Parked in review rather than handed to QA, because QA must not test an unmerged branch. ' +
  'Needs a person to open the pull request (or fix the hook) and comment its URL; ' +
  'the crew still promotes the ticket to `fixed` on its own once the branch lands.';

/** The last line of a hook's output that looks like a URL, or null. */
export function parseReviewUrl(output: string): string | null {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean).reverse();
  for (const l of lines) {
    const m = /https?:\/\/\S+/.exec(l);
    if (m) return m[0];
  }
  return null;
}

/** `open` unless the hook's last line is one of the other two words. */
export function parseReviewState(output: string): ReviewState {
  const last = output.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean).pop() ?? '';
  return last === 'approved' || last === 'changes_requested' ? last : 'open';
}

/** The pull request URL recorded on a ticket, newest first; null when none was. */
export function reviewUrlFrom(comments: { body?: string | null }[]): string | null {
  for (const c of [...comments].reverse()) {
    const b = c.body ?? '';
    if (!b.includes(REVIEW_OPENED_MARKER)) continue;
    const m = /\*\*In review:\*\* (https?:\/\/\S+)/.exec(b);
    if (m) return m[1]!;
  }
  return null;
}

export interface OpenReviewInput {
  cfg: EffectiveRepoConfig;
  ticket: Ticket;
  branch: string;
  /** Where the hook runs: the ticket's own worktree. */
  cwd: string;
}

export type OpenReviewResult = { ok: true; url: string } | { ok: false; output: string };

/** Runs `hooks.pr`. The URL it prints is the review's identity from then on. */
export async function openReview(i: OpenReviewInput): Promise<OpenReviewResult> {
  const script = i.cfg.hooks.pr;
  if (!script) return { ok: false, output: 'no `pr` hook is configured for this repo' };
  const r = await runScript(script, {
    cwd: i.cwd,
    shell: resolveShell(i.cfg.shell),
    env: {
      CREW_TICKET: i.ticket.issue_id,
      CREW_BRANCH: i.branch,
      CREW_BASE: i.cfg.branch.base,
      CREW_TITLE: `${i.ticket.issue_tag ?? i.ticket.issue_id}: ${i.ticket.title ?? ''}`.trim(),
    },
  });
  const url = r.code === 0 ? parseReviewUrl(r.output) : null;
  if (url) return { ok: true, url };
  const tail = r.output.trim().split('\n').slice(-6).join('\n');
  return { ok: false, output: r.code === 0 ? tail || 'exited 0 without printing a URL' : `exited ${r.code}: ${tail}` };
}

export interface SettleLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

export interface SettleInput {
  tracker: Pick<Tracker, 'updateTicket' | 'postEvent' | 'comments'>;
  contract: Contract;
  cfg: EffectiveRepoConfig;
  /** This repo's open tickets. Anything not in review is ignored. */
  tickets: Ticket[];
  /** The primary checkout: the closure heuristic and the hooks run here. */
  cwd: string;
  /** Comment author and the seat a bounced ticket returns to. */
  devSeatId: string;
  /** Resolves a ticket's branch name, or null when it has none here. */
  branchFor: (t: Ticket) => string | null;
  log: SettleLog;
  dryRun?: boolean;
}

export interface SettleOutcome { promoted: string[]; bounced: string[] }

const inReview = (t: Ticket, c: Contract): boolean =>
  t.status === c.statuses.building && t.needs_review === true;

/**
 * One pass over every ticket in review. Order matters: `merged` is asked
 * first, because a branch that landed is done whatever its review thread
 * last said. Only then is `review` consulted.
 *
 * Non-fatal per ticket — a forge hiccup on one must not stop the others, and
 * nothing is written on a hook that could not answer.
 */
export async function settleReviews(i: SettleInput): Promise<SettleOutcome> {
  const out: SettleOutcome = { promoted: [], bounced: [] };
  const shell = resolveShell(i.cfg.shell);
  const reviewing = i.tickets.filter((t) => inReview(t, i.contract));
  // One read for the whole pass, and only when there is something in review.
  const allComments: Comment[] = reviewing.length && i.cfg.hooks.review ? await i.tracker.comments() : [];
  for (const t of reviewing) {
    const branch = i.branchFor(t);
    if (!branch) continue;
    const log = { ticket: t.issue_id, step: 'review' };
    try {
      const env = { CREW_TICKET: t.issue_id, CREW_BRANCH: branch, CREW_BASE: i.cfg.branch.base };
      const mergedScript = i.cfg.hooks.merged;
      const closure = await detectClosure({
        cwd: i.cwd, key: t.issue_id, aliases: referenceKeys(t).slice(1), pushedBranch: branch,
        remote: i.cfg.branch.remote, base: i.cfg.branch.base,
        mergedHook: mergedScript
          ? async (e: Record<string, string>) => (await runScript(mergedScript, { cwd: i.cwd, env: e, shell })).code
          : undefined,
      });
      if (closure.state === 'merged') {
        if (i.dryRun) { i.log.emit('would promote to fixed — its branch has landed', log); continue; }
        await i.tracker.updateTicket(t.id, { status: i.contract.statuses.handoff, needs_review: false, assignee_id: null });
        await i.tracker.postEvent(t.id,
          `**Landed.** ${closure.detail}. Moved to \`${i.contract.statuses.handoff}\` for QA, which verifies the merged base branch rather than the ticket branch.`,
          i.devSeatId);
        i.log.emit(`${t.issue_id} landed — handed on to QA`, log);
        out.promoted.push(t.issue_id);
        continue;
      }
      const reviewScript = i.cfg.hooks.review;
      if (!reviewScript) continue;
      const url = reviewUrlFrom(allComments.filter((c) => c.ticket_id === t.id));
      const r = await runScript(reviewScript, {
        cwd: i.cwd, shell, env: { ...env, CREW_REVIEW_URL: url ?? '' },
      });
      if (r.code !== 0 || parseReviewState(r.output) !== 'changes_requested') continue;
      // Already bounced for this very review thread? The marker is only ever
      // written together with the status change, so a ticket still in review
      // here has not been bounced since it last pushed.
      if (i.dryRun) { i.log.emit('would return to the dev seat — changes were requested', log); continue; }
      await i.tracker.updateTicket(t.id, { status: i.contract.statuses.building, needs_review: false, assignee_id: i.devSeatId });
      await i.tracker.postEvent(t.id,
        `${REVIEW_CHANGES_MARKER}\n**Changes requested** on the pull request${url ? `: ${url}` : ''}. ` +
        'Address them on the same branch and push (a plain `git push`, never `--force`); ' +
        'handing off again re-requests review on the same pull request.',
        i.devSeatId);
      i.log.emit(`${t.issue_id} has review changes requested — back to the dev seat`, log);
      out.bounced.push(t.issue_id);
    } catch (e) {
      i.log.warn(`could not settle the review: ${(e as Error).message}`, log);
    }
  }
  return out;
}
