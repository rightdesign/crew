/**
 * The runner enforces the push at hand-off (CREW-1380).
 *
 * The persona asks a dev/design session to `git push --set-upstream` before it
 * sets a ticket to `fixed` (common.md Step 3.10), but a prompt is a request, not
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
 * CREW-2579: before bouncing, the runner completes the push itself when that
 * is a plain fast-forward — the local branch exists and the remote either has
 * no such branch or sits at an ancestor of the local tip. It already has the
 * worktree, the branch name, the remote and the push credentials, and a seat
 * that declines to push would otherwise cycle the ticket between `fixed` and
 * the bounce forever. A moved remote (not an ancestor) or a rejected push
 * still bounces, with git's error quoted. The push is never forced, and goes
 * to the same branch name the check reads (`existingBranchForTicket`), so
 * `branch.push` only matters to the seat's own first push. The `DISALLOWED_TOOLS`
 * deny on `git push --force*` is untouched.
 */

import { closedStatuses, type Contract } from './contract.ts';
import { existsSync } from 'node:fs';
import { gitOk, headSha, lsRemoteHeads, isAncestor, pushBranchUpstream, remoteConfigured, worktrees } from './git.ts';
import { existingBranchForTicket, branchCandidatesForTicket, type BranchLookupTicket } from './ticket-branch.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import { repoTargetFor, routeSlug, type Route, type Ship, type RoleName } from './config.ts';
import { replayPendingHandoffs } from './pending-handoff.ts';
import { ticketHolderShipId } from './ship-affinity.ts';
import { loadRepoConfig, resolveRepoConfig } from './repo-config.ts';
import { displayKey, type Comment, type RunnerEvent, type Ticket, type Tracker } from './tracker.ts';
import { finishRunWorktree, dropEmptyRunBranch } from './run-worktree.ts';
import { calloutHeader } from './callout.ts';
import { sandboxOriginFor } from './agent.ts';
import { branchWebUrl } from './forges.ts';

/** A marker so a bounce is recognisable in the comment history. */
export const HANDOFF_BOUNCED_MARKER = calloutHeader('WARNING', 'Hand-off Bounced');

/** The fixed shape QA reads: `pushed <full sha> to origin/<branch>`. */
export const pushedEventBody = (sha: string, remote: string, branch: string): string =>
  `pushed ${sha} to ${remote}/${branch}`;

/** The `## Acceptance` bullets of a ticket body, text only; empty when the ticket has no such section (CREW-2600). */
export function acceptanceLines(description: unknown): string[] {
  if (typeof description !== 'string') return [];
  const out: string[] = [];
  let inside = false;
  for (const raw of description.split('\n')) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(raw);
    if (heading) { inside = /^acceptance\b/i.test(heading[1]!); continue; }
    if (!inside) continue;
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(raw);
    if (bullet) out.push(bullet[1]!);
  }
  return out;
}

/**
 * CREW-2970: the Acceptance lines as the ready-to-fill block the hand-off comment must contain, rendered
 * verbatim (backticks and quotes included) so the seat copies and fills it rather than recalling it.
 * Empty when the ticket has no Acceptance section.
 */
export function acceptanceChecklistBlock(lines: string[]): string {
  if (lines.length === 0) return '';
  return `## Acceptance checklist (copy into your last comment and fill each result)\n${lines.map((l) => `- ${l}: <test, command or manual check, and its result>`).join('\n')}`;
}

const flat = (s: string): string => s.replace(/[`*_>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The acceptance lines `comment` does not quote, compared without markdown emphasis, case or line breaks. */
export function unquotedAcceptance(lines: string[], comment: string): string[] {
  const body = flat(comment);
  return lines.filter((l) => !body.includes(flat(l)));
}

export const ACCEPTANCE_BOUNCED_MARKER = calloutHeader('WARNING', 'Acceptance Checklist Missing');

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

/**
 * CREW-3033: the same verdict for a run whose clone lived in a sandbox that is
 * already deleted. There is no local HEAD to compare, so the branch being on
 * the remote at all is the hand-off; nothing can be pushed for the seat either.
 */
export function inspectRemoteHandoff(
  origin: string, cfg: EffectiveRepoConfig, ticket: BranchLookupTicket, role?: string,
): HandoffVerdict {
  const remote = cfg.branch.remote;
  const heads = lsRemoteHeads(origin);
  if (!heads) return { kind: 'unverified', why: `could not reach \`${remote}\` (${origin}) to check the pushed branch` };
  for (const c of branchCandidatesForTicket(cfg, ticket, role)) {
    const hit = c.endsWith('*') ? [...heads.keys()].find((b) => b.startsWith(c.slice(0, -1))) : heads.has(c) ? c : undefined;
    if (hit) return { kind: 'pushed', branch: hit, sha: heads.get(hit)!, remote };
  }
  return {
    kind: 'bounce', branch: null, remote, local: null, origin: null,
    reason: `no branch for this ticket is on \`${remote}\`; the run's clone was deleted with its sandbox, so nothing it did not push can be recovered`,
  };
}

/** A failed guard check in plain words: a missing working directory is not a missing git. */
export function describeGuardError(e: unknown, dir?: string): string {
  const msg = (e as Error).message;
  if (!/ENOENT/.test(msg)) return msg;
  return dir && !existsSync(dir) ? `the run's clone at ${dir} is gone` : 'git is not installed on this machine';
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

/**
 * Whether the runner may complete this bounce by pushing: the branch exists
 * locally and the remote lacks it or is strictly behind it. Anything else (the
 * remote moved, no local branch) is for the seat or a person.
 */
export function pushableBounce(dir: string, v: Extract<HandoffVerdict, { kind: 'bounce' }>): v is Extract<HandoffVerdict, { kind: 'bounce' }> & { branch: string; local: string } {
  if (!v.branch || !v.local) return false;
  return !v.origin || isAncestor(dir, v.origin, v.local);
}

/** What `crew run --dry-run` prints for a hand-off the runner would complete, or `null` when there is none. */
export function describeHandoffPush(dir: string, cfg: EffectiveRepoConfig, ticket: BranchLookupTicket, role?: string): string | null {
  const v = inspectHandoff(dir, cfg, ticket, role);
  return v.kind === 'bounce' && pushableBounce(dir, v) ? `would push ${v.branch} to ${v.remote}` : null;
}

export function bounceComment(v: Extract<HandoffVerdict, { kind: 'bounce' }>, shipName: string | undefined, pushError?: string): string {
  return `${HANDOFF_BOUNCED_MARKER}

**Hand-off bounced: the branch is not on \`${v.remote}\` at the tip this ticket was built to.**

${shipName ? `Ship: ${shipName}\n` : ''}Local HEAD: ${v.local ? `\`${v.local}\`` : '(no local branch)'}
\`${v.remote}\`: ${v.origin ? `\`${v.origin}\`` : v.branch ? '(branch missing)' : '(no branch to look for)'}

${v.reason[0]!.toUpperCase()}${v.reason.slice(1)}. ${pushError ? ` The runner tried a plain push and git refused it: \`${pushError}\`.` : ''} Set back to \`in_progress\`, still held by this ship; push with a plain \`git push --set-upstream ${v.remote} <branch>\` (never \`--force\`) and set \`fixed\` again. Your brief authorizes this push: it is the hand-off, not a release, so do it now rather than asking for permission.`;
}

/** The event log refuses a `message` over this many characters (CREW-3307). */
export const EVENT_MESSAGE_LIMIT = 5000;
/** A note is held under this, a margin below the limit. */
const NOTE_BUDGET = 4800;

/** `note` cut to the budget, with the cut said aloud, for notes that embed text we do not control (git output, ticket text). */
export function boundNote(note: string, budget = NOTE_BUDGET): string {
  if (note.length <= budget) return note;
  const tail = '\n\n(note cut: it was longer than the event log accepts)';
  return note.slice(0, budget - tail.length) + tail;
}

/**
 * CREW-3307: post a guard note to the event log; when that is refused, post it
 * as a comment from the seat instead. Returns whether either route landed. The
 * HTTP status and the tracker's reason go to the log either way, so a dropped
 * note is never a bare "failed to post".
 */
async function deliverNote(
  i: Pick<HandoffGuardInput, 'writer' | 'seatId' | 'log'>, ticketId: string, note: string, type: string, log: Record<string, unknown>,
): Promise<boolean> {
  const body = boundNote(note);
  try {
    await i.writer.postEvent(ticketId, body, i.seatId, type);
    return true;
  } catch (e) {
    const eventWhy = (e as Error).message;
    if (!i.writer.postComment) {
      i.log.warn(`the ${type} note could not be posted: ${eventWhy}`, log);
      return false;
    }
    try {
      await i.writer.postComment(ticketId, body, i.seatId);
      i.log.warn(`the ${type} note was refused by the event log (${eventWhy}); posted it as a comment instead`, log);
      return true;
    } catch (c) {
      i.log.warn(`the ${type} note could not be posted as an event (${eventWhy}) or as a comment (${(c as Error).message})`, log);
      return false;
    }
  }
}

export interface HandoffWriter {
  ticket(id: string): Promise<Ticket>;
  updateTicket(id: string, patch: Record<string, unknown>): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string, type?: string): Promise<void>;
  /** CREW-3307: where a bounce note goes when the event log refuses it; absent in a writer that cannot comment. */
  postComment?(ticketId: string, body: string, memberId: string): Promise<void>;
  /** Event-log reader (CREW-1973); absent in a writer that cannot read it, which then skips the takeover check. */
  events?(type: string): Promise<RunnerEvent[]>;
  /** Comment reader (CREW-2600); absent in a writer that cannot read it, which then skips the acceptance check. */
  comments?(limit?: number): Promise<Comment[]>;
}

export interface HandoffLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

export type HandoffOutcome =
  | { kind: 'not-handed-off' }
  | { kind: 'pushed'; sha: string }
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
  /** ISO time this run started: a `taken_over` event newer than it, naming another ship, means this run no longer owns the ticket. */
  since?: string;
  /** CREW-3033: the remote URL to ask instead of `dir`, for a run whose clone lived in a sandbox that is already deleted. */
  origin?: string;
  /** CREW-3255: where to record the pushed branch's web page; absent when the Issues table has no `branch_url` column. */
  branchLink?: BranchLink;
  log: HandoffLog;
}

/** The Issues column that takes the pushed branch's web page, and how to build it (null: leave the column empty). */
export interface BranchLink { column: string; url(branch: string): string | null }

/** Posts the `pushed` event and, where the table has the column, records the branch's web page beside it. */
async function postPushed(i: HandoffGuardInput, ticketId: string, sha: string, remote: string, branch: string, log: Record<string, unknown>): Promise<void> {
  await i.writer.postEvent(ticketId, pushedEventBody(sha, remote, branch), i.seatId, 'pushed');
  const url = i.branchLink?.url(branch);
  if (!i.branchLink || !url) return;
  try {
    await i.writer.updateTicket(ticketId, { [i.branchLink.column]: url });
  } catch {
    i.log.warn(`pushed, but the branch link could not be recorded`, log);
  }
}

/** Whether another ship took this ticket over after `since` (CREW-1973). */
async function takenOverSince(i: HandoffGuardInput, ticketRow: string): Promise<boolean> {
  if (!i.since || !i.writer.events) return false;
  const from = Date.parse(i.since);
  const evs = await i.writer.events('taken_over');
  return evs.some((e) => {
    if (e.record_id !== ticketRow) return false;
    if (Date.parse(e.occurred_at ?? e.created_at ?? '') < from) return false;
    const by = / by (.+?); /.exec(e.message ?? '')?.[1];
    return !!by && by !== i.shipName;
  });
}

/** The acceptance lines the hand-off check found unquoted, and the time of the comment it judged (`null`: the seat had none). */
export interface AcceptanceGap { missing: string[]; judged: string | null; all: string[] }

/**
 * CREW-2600: the acceptance lines the seat's hand-off comment does not quote, or
 * `null` when the check does not apply (no Acceptance section, or a writer that
 * cannot read comments) or the hand-off passes.
 *
 * CREW-2962: the hand-off may be followed by a short note in a later run ("the
 * hand-off above stands"), so judging only the newest comment bounced a complete
 * hand-off. The candidates are the seat's comments posted since the run began
 * (`since`), or the newest one when there are none; the check passes when any
 * one of them quotes every line. When none does, the gap reported is the
 * candidate's with the fewest lines missing (newest on a tie), and `judged`
 * names its time. A seat with no comment at all misses every line.
 */
async function missingAcceptance(i: HandoffGuardInput, t: Ticket): Promise<AcceptanceGap | null> {
  const lines = acceptanceLines(t.description);
  if (lines.length === 0 || !i.writer.comments) return null;
  const cc = i.contract.comments;
  const mine = (await i.writer.comments())
    .map((c) => c as unknown as Record<string, unknown>)
    .filter((r) => r[cc.parent] === t.id && r[cc.author] === i.seatId)
    .sort((a, b) => String(a[cc.createdAt] ?? '').localeCompare(String(b[cc.createdAt] ?? '')));
  const from = i.since ? Date.parse(i.since) : NaN;
  const recent = Number.isNaN(from) ? [] : mine.filter((r) => Date.parse(String(r[cc.createdAt] ?? '')) >= from);
  const candidates = recent.length > 0 ? recent : mine.slice(-1);
  if (candidates.length === 0) return { missing: lines, judged: null, all: lines };
  let best: AcceptanceGap | null = null;
  for (const c of candidates) {
    const missing = unquotedAcceptance(lines, String(c[cc.body] ?? ''));
    if (missing.length === 0) return null;
    if (!best || missing.length <= best.missing.length) best = { missing, judged: String(c[cc.createdAt] ?? '') || null, all: lines };
  }
  return best;
}

export function acceptanceBounceComment(missing: string[], shipName: string | undefined, judged?: string | null, all: string[] = []): string {
  // CREW-3307: the checklist block already names every line, so a hand-off that quoted none does not list them twice.
  const quotedNone = all.length > 0 && missing.length >= all.length;
  const build = (cut: number): string => {
    const shown = (ls: string[]): string[] => {
      const kept = cut > 0 ? ls.slice(0, Math.max(1, ls.length - cut)).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)) : ls;
      return kept.length < ls.length ? [...kept, `(… ${ls.length - kept.length} more in the ticket's Acceptance section)`] : kept;
    };
    const head = `${ACCEPTANCE_BOUNCED_MARKER}

**Hand-off bounced: the hand-off comment does not quote every line of the ticket's Acceptance section.**

${shipName ? `Ship: ${shipName}\n\n` : ''}${judged ? `Judged the comment posted at ${judged}; no comment this run quoted every line.\n\n` : 'This seat has no comment on the ticket.\n\n'}`;
    const list = quotedNone ? '' : `Not quoted verbatim:\n${shown(missing).map((l) => `- ${l}`).join('\n')}\n\n`;
    const act = `Set back to \`in_progress\`. Post a comment that lists every Acceptance line verbatim, each followed by the test, command or manual check that exercised it in this run and its result (a line you could not exercise is listed with the reason, never omitted), then set \`fixed\` again. The branch is already pushed.`;
    const block = all.length > 0
      ? `\n\n${quotedNone ? 'No line was quoted. ' : ''}Copy this block into the comment and fill in each result:\n\n\`\`\`\n${acceptanceChecklistBlock(shown(all))}\n\`\`\``
      : '';
    return `${head}${list}${act}${block}`;
  };
  // Shorten the lists (never the instruction) until the note fits the event log.
  const most = Math.max(all.length, missing.length);
  for (let cut = 0; cut < most; cut++) {
    const note = build(cut === 0 ? 0 : cut);
    if (note.length <= NOTE_BUDGET) return note;
  }
  return boundNote(build(most));
}

/**
 * Run after a dev/design session ends. A ticket not at `fixed` (or already
 * claimed past it) is none of this guard's business (the session is mid-work, parked at `needs_info`, ...).
 * Non-fatal throughout: a tracker blip here must not fail a run that already
 * finished its work.
 */
export async function enforceHandoff(i: HandoffGuardInput): Promise<HandoffOutcome> {
  try {
    const t = await i.writer.ticket(i.ticketId);
    const st = i.contract.statuses;
    const log = { ticket: t.issue_id, step: 'handoff' };
    // CREW-1729: QA may claim a `fixed` ticket in the seconds before this guard
    // reads it, so a status past the hand-off means the hand-off already happened.
    const claimed = [st.verifying, st.verified, st.deployed].some((s) => s && t.status === s);
    if (t.status !== st.handoff && !claimed) {
      i.log.emit(`${displayKey(t)} is at ${t.status}, not handed off — nothing to check`, log);
      return { kind: 'not-handed-off' };
    }

    const v = i.origin ? inspectRemoteHandoff(i.origin, i.cfg, t, i.role) : inspectHandoff(i.dir, i.cfg, t, i.role);
    if (v.kind === 'unverified') {
      i.log.warn(`${displayKey(t)} is at ${t.status} but the push was not checked: ${v.why}`, log);
      return { kind: 'unverified', why: v.why };
    }
    if (v.kind === 'pushed' && !claimed) {
      const gap = await missingAcceptance(i, t);
      if (gap) {
        const heldNow = i.hold ? t[i.hold.column] : undefined;
        if ((i.hold && heldNow && heldNow !== i.hold.shipId) || await takenOverSince(i, t.id)) {
          i.log.warn(`${displayKey(t)} is held by another ship now — the acceptance check is stale, left alone`, log);
          return { kind: 'unverified', why: 'ticket is held by another ship' };
        }
        // CREW-3307: the explanation lands first. A bounce nobody can read leaves the seat re-dispatched into
        // the same hand-off, so with no way to say why, the ticket stays at the hand-off for QA.
        if (!await deliverNote(i, t.id, acceptanceBounceComment(gap.missing, i.shipName, gap.judged, gap.all), 'bounced', log)) {
          i.log.warn(`${displayKey(t)} lacks the acceptance checklist but the bounce note could not be delivered — left at ${t.status}, guard outcome unverified`, log);
          return { kind: 'unverified', why: 'the acceptance bounce note could not be posted' };
        }
        await i.writer.updateTicket(t.id, {
          status: i.contract.statuses.building,
          // CREW-2962: the hand-off may have assigned QA's seat; a bounce is the building seat's again.
          assignee_id: i.seatId,
          ...(i.hold && !heldNow ? { [i.hold.column]: i.hold.shipId } : {}),
        });
        i.log.warn(`${displayKey(t)} bounced back to ${i.contract.statuses.building}: hand-off comment lacks the acceptance checklist`, log);
        return { kind: 'bounced' };
      }
    }
    if (v.kind === 'pushed') {
      await postPushed(i, t.id, v.sha, v.remote, v.branch, log);
      i.log.emit(`${displayKey(t)} pushed at ${v.sha.slice(0, 7)} — handed on to QA`, log);
      return { kind: 'pushed', sha: v.sha };
    }

    // QA owns a claimed ticket: never pull it back to the building lane.
    if (claimed) {
      i.log.warn(`${displayKey(t)} is at ${t.status} but its branch is not on the remote at HEAD: ${v.reason}`, log);
      return { kind: 'failed', why: v.reason };
    }

    // CREW-1973: a bounce is only this ship's to write while it is still the
    // holder. A stale run whose hold was taken over must not undo the new
    // holder's hand-off (TABL-1967), and a ship with no local branch has
    // nothing of its own to compare against origin; the shape the bounce text
    // was written for is a local tip that is missing from, or ahead of, origin.
    const heldBy = i.hold ? t[i.hold.column] : undefined;
    if (i.hold && heldBy && heldBy !== i.hold.shipId) {
      i.log.warn(`${displayKey(t)} is held by another ship now — this run's hand-off check is stale, left alone`, log);
      return { kind: 'unverified', why: 'ticket is held by another ship' };
    }
    if (await takenOverSince(i, t.id)) {
      i.log.warn(`${displayKey(t)} was taken over by another ship during this run — left alone`, log);
      return { kind: 'unverified', why: 'ticket was taken over during this run' };
    }
    if (!v.local && !i.origin) {
      i.log.warn(`${displayKey(t)} has no local branch on this ship, so it is not this ship's hand-off to bounce: ${v.reason}`, log);
      return { kind: 'unverified', why: 'no local branch on this ship' };
    }
    let pushError: string | undefined;
    if (pushableBounce(i.dir, v)) {
      const wt = worktrees(i.dir).find((w) => w.branch === v.branch);
      try {
        pushBranchUpstream(wt?.path ?? i.dir, v.remote, v.branch);
        const again = inspectHandoff(i.dir, i.cfg, t, i.role);
        if (again.kind === 'pushed') {
          await postPushed(i, t.id, again.sha, again.remote, again.branch, log);
          await i.writer.postEvent(t.id,
            `The runner pushed \`${again.branch}\` to \`${again.remote}\` on ${i.shipName ? `${i.shipName}'s` : 'this ship\'s'} behalf: the ${i.role} seat set \`${i.contract.statuses.handoff}\` without pushing. Plain fast-forward push.${i.cfg.hooks.ci_status ? ' The repo\'s `ci_status` hook was NOT run by the hand-off guard, so CI was not checked by the builder.' : ''}`,
            i.seatId, 'pushed_by_runner').catch((e: unknown) => i.log.warn(`pushed, but the note failed to post: ${(e as Error).message}`, log));
          i.log.emit(`${displayKey(t)}: pushed ${again.branch} to ${again.remote} on the seat's behalf at ${again.sha.slice(0, 7)} — handed on to QA`, log);
          return { kind: 'pushed', sha: again.sha };
        }
        pushError = `the push succeeded but ${again.kind === 'bounce' ? again.reason : again.why}`;
      } catch (e) {
        pushError = (e as Error).message;
      }
      i.log.warn(`${displayKey(t)}: the runner's own push failed: ${pushError}`, log);
    }
    if (!await deliverNote(i, t.id, bounceComment(v, i.shipName, pushError), 'bounced', log)) {
      i.log.warn(`${displayKey(t)}: ${v.reason}, but the bounce note could not be delivered — left at ${t.status}, guard outcome unverified`, log);
      return { kind: 'unverified', why: 'the bounce note could not be posted' };
    }
    await i.writer.updateTicket(t.id, {
      status: i.contract.statuses.building,
      assignee_id: i.seatId,
      ...(i.hold && !heldBy ? { [i.hold.column]: i.hold.shipId } : {}),
    });
    i.log.warn(`${displayKey(t)} bounced back to ${i.contract.statuses.building}: ${v.reason}`, log);
    return { kind: 'bounced' };
  } catch (e) {
    const why = describeGuardError(e, i.dir);
    i.log.warn(`could not check the hand-off: ${why}`, { step: 'handoff' });
    return { kind: 'failed', why };
  }
}

/**
 * CREW-3037: why a building run's ticket is no longer this ship's, or null.
 * Closed for good, or held by another ship while still in a building/approved
 * status. A hold by another ship at `fixed` onward is normal (QA's claim).
 */
export function lostTicketReason(t: Ticket, contract: Contract, myShipId?: string | null): string | null {
  if (closedStatuses(contract).includes(t.status)) return `the ticket is ${t.status}`;
  const holder = ticketHolderShipId(t, contract);
  const st = contract.statuses;
  if (holder && myShipId && holder !== myShipId && [st.building, st.approved].includes(t.status)) {
    return 'another ship holds the ticket now';
  }
  return null;
}

/**
 * The call every run site makes after `spawnAgent` returns. Only the building
 * seats hand work on, and only a run that actually claimed a ticket
 * (`workingId`) has one to check.
 */
export async function guardRunHandoff(
  route: Route, ship: Ship, tracker: Tracker, role: RoleName, workingId: string | null, log: HandoffLog,
  /** ISO time the run started; with it, hand-offs to tickets other than `workingId` are checked too (CREW-1759). */
  since?: string,
): Promise<HandoffOutcome | null> {
  // CREW-2363: any hand-off an earlier run could not write (tracker down) goes first.
  const replayed = await replayRoutePending(route, ship, tracker, log, role);
  if (!workingId || (role !== 'dev' && role !== 'design' && role !== 'qa')) return null;
  const seatId = route.resolved?.seats[role];
  if (!seatId) return null;
  let checkoutDir: string | undefined;
  try {
    const t = await tracker.ticket(workingId);
    const resolved = repoConfigFor(route, t);
    if (!resolved) return null;
    const { target, cfg } = resolved;
    checkoutDir = target.dir;
    // CREW-3037: a run whose ticket closed, or was re-claimed by another ship, while it ran has
    // nothing to hand on: say why once and touch neither the board nor the branch.
    const lost = lostTicketReason(t, tracker.contract, (await tracker.claimAffinity())?.shipId);
    if (lost && role !== 'qa') {
      log.warn(`${displayKey(t)}: run ended without a push — ${lost}`, { ticket: t.issue_id, step: 'handoff' });
      return { kind: 'unverified', why: lost };
    }
    // CREW-1405: QA hands nothing on (it verifies or bounces), and its hard
    // limits forbid `crew drop`, so the runner retires the worktree a QA run cut
    // with `crew worktree NNN` once the run ends. Same rules as a hand-off:
    // a `handoff` hook's worktree stays, a dirty or unpushed one is never removed.
    if (role === 'qa') {
      await retireRunWorktree(tracker, target.dir, cfg, t, role, seatId, ship.name, log);
      return null;
    }
    const affinity = await tracker.claimAffinity();
    // CREW-3033: a sandboxed run's clone went with the sandbox, so its push is asked of the remote.
    const origin = ship.runner === 'sandbox' ? sandboxOriginFor(route, target.name) : undefined;
    if (ship.runner === 'sandbox' && !origin) {
      log.warn(`${displayKey(t)}: the push was not checked: this ship cannot place the remote of ${target.name}`, { ticket: t.issue_id, step: 'handoff' });
      return null;
    }
    // The replay just handed this very ticket on and posted its `pushed` event.
    const outcome: HandoffOutcome = replayed.includes(workingId) ? { kind: 'pushed', sha: '' } : await enforceHandoff({
      writer: tracker, contract: tracker.contract, ticketId: workingId, role, dir: target.dir, cfg,
      seatId, shipName: ship.name, hold: affinity ? { column: affinity.column, shipId: affinity.shipId } : undefined, since, log,
      ...(await branchLinkFor(tracker, {
        remote: target.remote ?? (t.repo_id ? route.resolved?.repoRemotes?.[t.repo_id] : undefined),
        forgeHost: target.forgeHost ?? (t.repo_id ? route.resolved?.repoForgeHosts?.[t.repo_id] : undefined),
      })),
      ...(origin ? { origin } : {}),
    });
    if (origin) {
      // The run's worktree and branch were in the deleted sandbox: nothing here to retire or drop.
    } else if (outcome.kind === 'pushed') await retireRunWorktree(tracker, target.dir, cfg, t, role, seatId, ship.name, log);
    else {
      // CREW-2528: a run that cut a branch from the base and committed nothing leaves no branch behind.
      const branch = existingBranchForTicket(target.dir, cfg, t, role);
      if (branch && dropEmptyRunBranch(target.dir, cfg, branch)) {
        log.emit(`${displayKey(t)}: dropped ${branch} — the run made no commits beyond ${cfg.branch.base}`, { ticket: t.issue_id, step: 'handoff' });
      }
    }
    if (since && !origin) await guardRunStrays(route, ship, tracker, role, workingId, since, log);
    return outcome;
  } catch (e) {
    log.warn(`could not check the hand-off: ${describeGuardError(e, checkoutDir)}`, { step: 'handoff' });
    return null;
  }
}

/** CREW-3255: the `branchLink` input for a checkout, when the Issues table has the column and the Repos row names a remote. */
async function branchLinkFor(
  tracker: Pick<Tracker, 'linkColumns' | 'contract'>, target: { remote?: string; forgeHost?: string },
): Promise<{ branchLink?: BranchLink }> {
  try {
    if (!target.remote || !(await tracker.linkColumns()).branchUrl) return {};
  } catch { return {}; }
  return { branchLink: { column: tracker.contract.columns.branchUrl, url: (b) => branchWebUrl(target.forgeHost, target.remote, b) } };
}

/**
 * CREW-1385: the run's worktree has no reader once its branch is verifiably on
 * the remote, so it is removed — except where the repo's `handoff` hook keeps a
 * server up for QA, in which case it stays and the serving ship is recorded on
 * the ticket (as an event; the workspace has no `serving_ship_id` column to
 * write, and adding one is the operator's call). Non-fatal.
 */
async function retireRunWorktree(
  tracker: Tracker, dir: string, cfg: EffectiveRepoConfig, t: Ticket, role: string,
  seatId: string, shipName: string, log: HandoffLog,
): Promise<void> {
  try {
    const branch = existingBranchForTicket(dir, cfg, t, role);
    if (!branch) return;
    const o = await finishRunWorktree(dir, cfg, branch);
    const at = { ticket: t.issue_id, step: 'handoff' };
    if (o.kind === 'removed') log.emit(`${displayKey(t)}: removed the run's worktree ${o.path} — the branch is on ${cfg.branch.remote}`, at);
    else if (o.kind === 'kept-handoff') {
      log.emit(`${displayKey(t)}: kept worktree ${o.path} — this repo's handoff hook serves from it`, at);
      await tracker.postEvent(t.id, `worktree kept on ship ${shipName} at \`${o.path}\`: the repo's \`handoff\` hook serves from it. QA on another ship cuts its own from \`${cfg.branch.remote}/${branch}\` instead.`, seatId, 'worktree_kept');
    } else if (o.kind === 'kept-dirty') log.warn(`${displayKey(t)}: left worktree ${o.path} — it has uncommitted changes`, at);
    else if (o.kind === 'kept-unpushed') log.warn(`${displayKey(t)}: left worktree ${o.path} — its branch has commits that are not on ${cfg.branch.remote}`, at);
  } catch (e) {
    log.warn(`could not retire the run's worktree: ${(e as Error).message}`, { step: 'handoff' });
  }
}

export function repoConfigFor(route: Route, t: Ticket) {
  const target = repoTargetFor(route, t.repo_id);
  if (!target) return null;
  const o = route.repoOverrides[target.name];
  const cfg = resolveRepoConfig(loadRepoConfig(target.dir), {
    hooks: { ...route.hooks, ...o?.hooks },
    labels: { ...route.labels, ...o?.labels },
    branch: { ...route.branch, ...o?.branch },
    worktrees: { nameOverride: o?.worktreeName },
  }, target.dir);
  return { target, cfg };
}

/**
 * Replays this route's pending hand-offs (CREW-2363). Exported for the daemon's
 * own pass, which calls it even when no run just ended. Never throws.
 */
export async function replayRoutePending(route: Route, ship: Ship, tracker: Tracker, log: HandoffLog, role?: string): Promise<string[]> {
  try {
    return await replayPendingHandoffs({
      writer: tracker, contract: tracker.contract, stateDir: ship.stateDir, route: routeSlug(route.route), role,
      seats: route.resolved?.seats ?? {},
      checkout: (t) => { const r = repoConfigFor(route, t); return r ? { dir: r.target.dir, cfg: r.cfg } : null; },
      log,
    });
  } catch (e) {
    log.warn(`could not replay pending hand-offs: ${(e as Error).message}`, { step: 'handoff' });
    return [];
  }
}

export const STRAY_HANDOFF_MARKER = calloutHeader('WARNING', 'Stray Hand-off');

export interface StrayGuardInput {
  writer: HandoffWriter;
  contract: Contract;
  /** Tickets at the hand-off status that changed since the run began, excluding the claimed one. */
  candidates: Ticket[];
  seatId: string;
  role: string;
  /** This ship's Ships row id (`null`: no hold column, so holds cannot be compared). */
  myShipId: string | null;
  shipName?: string;
  /** Resolves the checkout for a candidate; `null` when this ship has no clone of its repo. */
  checkout(t: Ticket): { dir: string; cfg: EffectiveRepoConfig } | null;
  log: HandoffLog;
}

/**
 * CREW-1759: a run claims ONE ticket, but the session can move another to
 * `fixed` anyway (it did, on a bounce that appeared mid-run, while a second
 * ship held it). The claimed-ticket guard never looks at it, so no `pushed`
 * event was written and two ships built the same bounce.
 *
 * For each other ticket handed off during the run:
 *   - held by a DIFFERENT ship: that ship's own hand-off clears its hold, so
 *     this is a stray write. Return it to `in_progress` (assignee and hold are
 *     left as they were) with a note.
 *   - not held by another ship and a branch for it exists in this checkout:
 *     verify the push exactly like the claimed ticket's.
 *   - otherwise (nothing to inspect here — most likely another ship's honest
 *     hand-off): leave it alone.
 * Every one is logged as an error naming the ticket: it is outside the claim.
 */
export async function guardStrayHandoffs(i: StrayGuardInput): Promise<void> {
  const st = i.contract.statuses;
  // QA verifies or bounces; it never hands a ticket on, so a `fixed` ticket seen
  // during its run is some other seat's or ship's honest hand-off.
  if (i.role === 'qa') return;
  for (const t of i.candidates) {
    const at = { ticket: t.issue_id, step: 'handoff' };
    try {
      const holder = i.myShipId ? ticketHolderShipId(t, i.contract) : null;
      if (holder && holder !== i.myShipId) {
        const said = await deliverNote(i, t.id,
          `${STRAY_HANDOFF_MARKER}\n\n**Hand-off bounced: this ticket is held by another ship.**\n\n${i.shipName ? `${i.shipName}'s ` : 'A '}${i.role} run set it to \`${st.handoff}\` without having claimed it. Set back to \`${st.building}\`; the holding ship's own hand-off is the one that counts.`,
          'bounced', at);
        if (!said) { i.log.warn(`${displayKey(t)}: stray hand-off not bounced, its note could not be delivered`, at); continue; }
        await i.writer.updateTicket(t.id, { status: st.building });
        i.log.warn(`${displayKey(t)} was handed off by a run that did not claim it, while held by another ship — bounced to ${st.building}`, at);
        continue;
      }
      const co = i.checkout(t);
      if (!co || !existingBranchForTicket(co.dir, co.cfg, t, i.role)) {
        i.log.warn(`${displayKey(t)} moved to ${st.handoff} during a run that did not claim it; no local branch to verify, left alone`, at);
        continue;
      }
      const v = inspectHandoff(co.dir, co.cfg, t, i.role);
      i.log.warn(`${displayKey(t)} was handed off by a run that did not claim it`, at);
      if (v.kind === 'pushed') {
        await i.writer.postEvent(t.id, pushedEventBody(v.sha, v.remote, v.branch), i.seatId, 'pushed');
      } else if (v.kind === 'bounce') {
        // The remote tip is only "ours to bounce" when this checkout's branch is
        // missing from it or strictly ahead of it. A remote that is ahead of (or
        // has diverged from) a stale local branch was pushed by another ship's
        // honest hand-off, which clears its hold and so looks unheld here.
        if (v.origin && v.local && !isAncestor(co.dir, v.origin, v.local)) {
          i.log.warn(`${displayKey(t)}: \`${v.remote}/${v.branch}\` is at ${v.origin.slice(0, 7)}, not a tip this checkout built — left alone`, at);
          continue;
        }
        if (!await deliverNote(i, t.id, bounceComment(v, i.shipName), 'bounced', at)) {
          i.log.warn(`${displayKey(t)}: stray hand-off not bounced, its note could not be delivered`, at);
          continue;
        }
        await i.writer.updateTicket(t.id, { status: st.building, assignee_id: i.seatId });
      }
    } catch (e) {
      i.log.warn(`could not check the stray hand-off: ${(e as Error).message}`, at);
    }
  }
}

async function guardRunStrays(
  route: Route, ship: Ship, tracker: Tracker, role: RoleName, workingId: string, since: string, log: HandoffLog,
): Promise<void> {
  const seatId = route.resolved?.seats[role];
  if (!seatId) return;
  try {
    const affinity = await tracker.claimAffinity();
    const candidates = await tracker.handedOffSince(since, workingId);
    if (candidates.length === 0) return;
    await guardStrayHandoffs({
      writer: tracker, contract: tracker.contract, candidates, seatId, role,
      myShipId: affinity?.shipId ?? null, shipName: ship.name,
      checkout: (t) => { const r = repoConfigFor(route, t); return r ? { dir: r.target.dir, cfg: r.cfg } : null; },
      log,
    });
  } catch (e) {
    log.warn(`could not check for stray hand-offs: ${(e as Error).message}`, { step: 'handoff' });
  }
}
