/**
 * The runner enforces the push at hand-off (CREW-1380).
 *
 * The persona asks a dev/design session to `git push --set-upstream` before it
 * sets a ticket to `fixed` (common.md Step 3.9), but a prompt is a request, not
 * a guarantee: CREW-1376 sat at `fixed` with its branch only on the ship that
 * built it, and every other ship's QA and release phase then reported the
 * branch missing. So when a building run ENDS with its ticket at `fixed`, the
 * runner — not the session — checks that `<remote>/<branch>` exists and equals
 * the worktree's HEAD:
 *
 *   - It does: post `pushed <full sha> to <remote>/<branch>` as an event. That
 *     comment is machine-written, and is what QA compares the tip it fetched
 *     against. (No Issues column: `commit_sha` is the release phase's
 *     merge-time stamp.)
 *   - It does not (never pushed, push rejected, remote at a different sha):
 *     the ticket goes back to `in_progress` with its assignee and ship hold
 *     restored — the session cleared both when it handed off — and an event
 *     says what was found. It never reaches QA.
 *   - The repo has no remote, or the remote could not be reached: nothing is
 *     written. A network blip must not bounce good work, and a repo with no
 *     remote has nothing to be on.
 *
 * The `DISALLOWED_TOOLS` deny on `git push --force*` is untouched: this never
 * pushes, it only looks.
 */

import type { Contract } from './contract.ts';
import { gitOk, headSha, remoteConfigured, worktrees } from './git.ts';
import { existingBranchForTicket, type BranchLookupTicket } from './ticket-branch.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import { repoTargetFor, type Route, type Ship, type RoleName } from './config.ts';
import { loadRepoConfig, resolveRepoConfig } from './repo-config.ts';
import type { Comment, Ticket, Tracker } from './tracker.ts';
import { openReview, reviewFailedBody, reviewOpenedBody, reviewUrlFrom } from './external-review.ts';

/** A marker so a bounce is recognisable in the comment history. */
export const HANDOFF_BOUNCED_MARKER = '<!-- crew:handoff-bounced -->';

/** The fixed shape QA reads: `pushed <full sha> to origin/<branch>`. */
export const pushedEventBody = (sha: string, remote: string, branch: string): string =>
  `pushed ${sha} to ${remote}/${branch}`;

export type HandoffVerdict =
  /** `<remote>/<branch>` is at the worktree's HEAD. */
  | { kind: 'pushed'; branch: string; sha: string; remote: string }
  /** Nothing to check — no remote, or the remote could not be asked. */
  | { kind: 'unverified'; why: string }
  | { kind: 'bounce'; branch: string | null; remote: string; local: string | null; origin: string | null; reason: string };

/**
 * `<remote>`'s own tip for `branch`, asked of the remote itself rather than
 * read from a remote-tracking ref that might be stale: `null` is "could not
 * ask", `''` is "asked, and it has no such branch".
 */
function remoteTip(dir: string, remote: string, branch: string): string | null {
  const out = gitOk(dir, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  if (out === null) return null;
  return out.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`))?.split('\t')[0] ?? '';
}

export function inspectHandoff(
  dir: string, cfg: EffectiveRepoConfig, ticket: BranchLookupTicket, role?: string,
): HandoffVerdict {
  const remote = cfg.branch.remote;
  if (!remoteConfigured(dir, remote)) return { kind: 'unverified', why: `no remote \`${remote}\` configured` };

  const branch = existingBranchForTicket(dir, cfg, ticket, role);
  if (!branch) {
    return {
      kind: 'bounce', branch: null, remote, local: null, origin: null,
      reason: `no branch for this ticket exists in this checkout, so there is nothing on \`${remote}\` to hand to QA`,
    };
  }
  const wt = worktrees(dir).find((w) => w.branch === branch);
  const local = wt ? headSha(wt.path) : gitOk(dir, ['rev-parse', `refs/heads/${branch}`]);

  const origin = remoteTip(dir, remote, branch);
  if (origin === null) return { kind: 'unverified', why: `could not reach \`${remote}\` to check \`${branch}\`` };
  if (!origin) {
    return {
      kind: 'bounce', branch, remote, local, origin: null,
      reason: `\`${branch}\` does not exist on \`${remote}\` — it was never pushed (or the push failed)`,
    };
  }
  if (origin !== local) {
    return {
      kind: 'bounce', branch, remote, local, origin,
      reason: `\`${remote}/${branch}\` is at \`${origin}\`, not at this worktree's HEAD — the latest commits were not pushed, or the remote moved`,
    };
  }
  return { kind: 'pushed', branch, sha: origin, remote };
}

export function bounceComment(v: Extract<HandoffVerdict, { kind: 'bounce' }>, shipName: string | undefined): string {
  return `${HANDOFF_BOUNCED_MARKER}
**Hand-off bounced: the branch is not on \`${v.remote}\` at the tip this ticket was built to.**

${shipName ? `Ship: ${shipName}\n` : ''}Local HEAD: ${v.local ? `\`${v.local}\`` : '(no local branch)'}
\`${v.remote}\`: ${v.origin ? `\`${v.origin}\`` : v.branch ? '(branch missing)' : '(no branch to look for)'}

${v.reason[0]!.toUpperCase()}${v.reason.slice(1)}. Set back to \`in_progress\`, still held by this ship; push with a plain \`git push --set-upstream ${v.remote} <branch>\` (never \`--force\`) and set \`fixed\` again.`;
}

export interface HandoffWriter {
  ticket(id: string): Promise<Ticket>;
  updateTicket(id: string, patch: Record<string, unknown>): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string): Promise<void>;
  /** Needed only to find a pull request already opened for this ticket (`external` repos). */
  comments?(): Promise<Comment[]>;
}

export interface HandoffLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

export type HandoffOutcome =
  | { kind: 'not-handed-off' }
  | { kind: 'pushed'; sha: string }
  /** `external` repo: pushed, pull request open, ticket parked in review instead of handed to QA. */
  | { kind: 'in-review'; sha: string; url: string | null }
  | { kind: 'unverified'; why: string }
  | { kind: 'bounced' }
  | { kind: 'failed'; why: string };

export interface HandoffGuardInput {
  writer: HandoffWriter;
  contract: Contract;
  /** The ticket row the run worked. */
  ticketId: string;
  role: string;
  dir: string;
  cfg: EffectiveRepoConfig;
  /** The seat that ran: restored as assignee when the session cleared it. */
  seatId: string;
  /** This ship's name and Ships row (`undefined` when the workspace has no hold column). */
  shipName?: string;
  hold?: { column: string; shipId: string };
  log: HandoffLog;
}

/**
 * `release.mode: external` (CREW-1387): the branch is pushed, but QA must not
 * test work a reviewer may still change or reject, so the ticket does not go
 * to `fixed`. It gets a pull request and waits in review — `in_progress` with
 * `needs_review` and no assignee, the ship hold left alone because the branch
 * lives here. `settleReviews` (external-review.ts) is what moves it on.
 *
 * A pull request recorded by an earlier hand-off is reused, not reopened: a
 * ticket bounced for changes pushes to the same branch, which updates the PR.
 */
async function parkInReview(
  i: HandoffGuardInput, t: Ticket, v: Extract<HandoffVerdict, { kind: 'pushed' }>, log: Record<string, string>,
): Promise<HandoffOutcome> {
  let url = reviewUrlFrom((await i.writer.comments?.() ?? []).filter((c) => c.ticket_id === t.id));
  if (!url) {
    const wt = worktrees(i.dir).find((w) => w.branch === v.branch);
    const r = await openReview({ cfg: i.cfg, ticket: t, branch: v.branch, cwd: wt?.path ?? i.dir });
    if (r.ok) {
      url = r.url;
      await i.writer.postEvent(t.id, reviewOpenedBody(url, v.branch), i.seatId);
    } else {
      await i.writer.postEvent(t.id, reviewFailedBody(v.branch, r.output), i.seatId);
      i.log.warn(`${t.issue_id}: could not open a pull request: ${r.output}`, log);
    }
  }
  await i.writer.updateTicket(t.id, { status: i.contract.statuses.building, needs_review: true, assignee_id: null });
  i.log.emit(`${t.issue_id} pushed at ${v.sha.slice(0, 7)} — waiting in review${url ? ` (${url})` : ''}`, log);
  return { kind: 'in-review', sha: v.sha, url };
}

/**
 * Run after a dev/design session ends. A ticket not at `fixed` is none of this
 * guard's business (the session is mid-work, parked at `needs_info`, ...).
 * Non-fatal throughout: a tracker blip here must not fail a run that already
 * finished its work.
 */
export async function enforceHandoff(i: HandoffGuardInput): Promise<HandoffOutcome> {
  try {
    const t = await i.writer.ticket(i.ticketId);
    if (t.status !== i.contract.statuses.handoff) return { kind: 'not-handed-off' };
    const log = { ticket: t.issue_id, step: 'handoff' };

    const v = inspectHandoff(i.dir, i.cfg, t, i.role);
    if (v.kind === 'unverified') {
      i.log.warn(`${t.issue_id} is at ${t.status} but the push was not checked: ${v.why}`, log);
      return { kind: 'unverified', why: v.why };
    }
    if (v.kind === 'pushed') {
      await i.writer.postEvent(t.id, pushedEventBody(v.sha, v.remote, v.branch), i.seatId);
      if (i.cfg.release.mode === 'external') return await parkInReview(i, t, v, log);
      i.log.emit(`${t.issue_id} pushed at ${v.sha.slice(0, 7)} — handed on to QA`, log);
      return { kind: 'pushed', sha: v.sha };
    }

    const heldBy = i.hold ? t[i.hold.column] : undefined;
    await i.writer.updateTicket(t.id, {
      status: i.contract.statuses.building,
      ...(t.assignee_id ? {} : { assignee_id: i.seatId }),
      ...(i.hold && !heldBy ? { [i.hold.column]: i.hold.shipId } : {}),
    });
    await i.writer.postEvent(t.id, bounceComment(v, i.shipName), i.seatId).catch(() => {
      i.log.warn('bounced, but the note failed to post', log);
    });
    i.log.warn(`${t.issue_id} bounced back to ${i.contract.statuses.building}: ${v.reason}`, log);
    return { kind: 'bounced' };
  } catch (e) {
    i.log.warn(`could not check the hand-off: ${(e as Error).message}`, { step: 'handoff' });
    return { kind: 'failed', why: (e as Error).message };
  }
}

/**
 * The call every run site makes after `spawnAgent` returns. Only the building
 * seats hand work on, and only a run that actually claimed a ticket
 * (`workingId`) has one to check.
 */
export async function guardRunHandoff(
  route: Route, ship: Ship, tracker: Tracker, role: RoleName, workingId: string | null, log: HandoffLog,
): Promise<HandoffOutcome | null> {
  if ((role !== 'dev' && role !== 'design') || !workingId) return null;
  const seatId = route.resolved?.seats[role];
  if (!seatId) return null;
  try {
    const t = await tracker.ticket(workingId);
    const target = repoTargetFor(route, t.repo_id);
    if (!target) return null;
    const o = route.repoOverrides[target.name];
    const cfg = resolveRepoConfig(loadRepoConfig(target.dir), {
      hooks: { ...route.hooks, ...o?.hooks },
      labels: { ...route.labels, ...o?.labels },
      branch: { ...route.branch, ...o?.branch },
    }, target.dir);
    const affinity = await tracker.claimAffinity();
    return await enforceHandoff({
      writer: tracker, contract: tracker.contract, ticketId: workingId, role, dir: target.dir, cfg,
      seatId, shipName: ship.name, hold: affinity ? { column: affinity.column, shipId: affinity.shipId } : undefined, log,
    });
  } catch (e) {
    log.warn(`could not check the hand-off: ${(e as Error).message}`, { step: 'handoff' });
    return null;
  }
}
