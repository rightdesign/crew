/**
 * When the combined release build (or test gate) fails, find the verified
 * branch that broke it and hand THAT branch back, instead of holding every
 * verified ticket on the route until a person reads a failure alert.
 *
 * The case that motivated it (CREW-1581, 2026-10-12): three verified branches
 * squash-merged without a textual conflict, then the build failed with a
 * duplicate-identifier error. Only one branch was at fault — it added a type
 * member a branch already on the base had added a minute earlier. Git merged
 * both hunks; TypeScript refused the result; QA had verified the branch at its
 * own tip, where it builds. `conflict.ts` only covers TEXTUAL conflicts.
 *
 * Two ways to name the culprit, cheapest first:
 *  1. The failing output names files. If exactly one merged branch changed a
 *     named file, that branch is the culprit and nothing is rebuilt.
 *  2. Otherwise build each branch alone on the pre-merge base. A branch whose
 *     solo run fails is a culprit. Capped (`release.isolateFailures`), since
 *     each solo run is a full build.
 *
 * This module holds the pure parts and the board hand-back. The git/hook
 * driving lives in `release-run.ts`, next to the hooks it runs.
 */

import { StaleWriteError } from '@tablation/client';
import { worktreeForBranch } from './conflict.ts';
import type { ConflictWriter, ConflictLog } from './conflict.ts';
import type { Contract } from './contract.ts';
import type { Ticket } from './tracker.ts';
import { calloutHeader } from './callout.ts';

/** A marker in the hand-back note, so a repeat is recognisable. */
export const BUILD_FAILURE_MARKER = calloutHeader('CAUTION', 'Build Failure');

/**
 * Repo-relative file paths named in a failing hook's output: tsc
 * (`path(line,col): error TS…`), tsc pretty / vite / eslint (`path:line:col`),
 * and jest/vitest/node:test (`FAIL path`, `✖ path`). Absolute paths under
 * `cwd` are made relative; anything else (a path outside the checkout, a
 * `node_modules` frame) is dropped.
 */
export function failingPaths(output: string, cwd: string): string[] {
  const found = new Set<string>();
  const ext = String.raw`[\w.-]+\.[A-Za-z]{1,6}`;
  const dir = String.raw`(?:[\w@.~-]+/)*`;
  const patterns = [
    new RegExp(String.raw`^\s*(${dir}${ext})\(\d+,\d+\)\s*:`, 'gm'),
    new RegExp(String.raw`(?:^|\s)(/?${dir}${ext}):\d+(?::\d+)?`, 'gm'),
    new RegExp(String.raw`(?:FAIL|✖|✕|not ok \d+ -)\s+(/?${dir}${ext})`, 'gm'),
  ];
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  for (const re of patterns) {
    for (const m of output.matchAll(re)) {
      let p = m[1]!;
      if (p.startsWith('/')) {
        if (!p.startsWith(root)) continue;
        p = p.slice(root.length);
      }
      p = p.replace(/^\.\//, '');
      if (p.includes('node_modules/')) continue;
      found.add(p);
    }
  }
  return [...found];
}

/**
 * The single candidate whose changed files include a file the failure names,
 * or null when none or several do (then the caller builds them one by one).
 */
export function culpritByFiles<T extends { changed: ReadonlySet<string> }>(
  candidates: readonly T[], paths: readonly string[],
): T | null {
  if (paths.length === 0) return null;
  const hits = candidates.filter((c) => paths.some((p) => c.changed.has(p)));
  return hits.length === 1 ? hits[0]! : null;
}

/** A merged branch the build failure was pinned on. */
export interface BuildCulprit {
  ticket: Ticket;
  branch: string;
  /** Which hook failed: `build` or `test`. */
  hook: string;
  /** The tail of that hook's output. */
  tail: string;
  /** How the culprit was found: named by the output, by building it alone, or as half of a failing pair. */
  how: 'files' | 'solo' | 'pair';
  /** For `pair`: the earlier-verified branch it fails together with. */
  sibling?: { key: string; branch: string };
}

export interface BuildFailureBounce extends BuildCulprit {
  base: string;
  remote: string;
  /** The branch's worktree ON THIS SHIP, or null when it was built elsewhere. */
  worktree: string | null;
}

export type BuildFailureOutcome = { kind: 'handed-back' } | { kind: 'escalated' } | { kind: 'stale' } | { kind: 'failed'; why: string };

export function planBuildFailureBounce(cwd: string, c: BuildCulprit, base: string, remote: string): BuildFailureBounce {
  return { ...c, base, remote, worktree: worktreeForBranch(cwd, c.branch) };
}

export function buildFailureComment(b: BuildFailureBounce): string {
  const how = b.how === 'pair' && b.sibling
    ? `Each branch passes the hook alone; \`${b.branch}\` together with ${b.sibling.key} (\`${b.sibling.branch}\`) fails it. ${b.sibling.key} was verified first, so the fix belongs on this branch: \`git merge ${b.remote}/${b.sibling.branch}\` first, then fix what disagrees. Fix it on this branch, never a fresh one.`
    : b.how === 'files'
    ? `The failing output names files that only \`${b.branch}\` changed among the branches in that release.`
    : `Built alone on the previous \`${b.base}\`, \`${b.branch}\` fails the same hook.`;
  return `${BUILD_FAILURE_MARKER}

**Back with the dev lane — this branch builds on its own but not on current \`${b.base}\`.**

\`${b.branch}\` was verified, but the release's \`${b.hook}\` hook failed once it was merged with the other branches in the same release. ${how}

First step: \`git merge ${b.remote}/${b.base}\` in ${b.worktree ? `\`${b.worktree}\`` : 'the branch\'s worktree'}, rebuild, and fix what disagrees — the merge is clean at the text level, so this is a semantic conflict (a duplicate identifier, a changed signature) with work that landed on \`${b.base}\` after this branch was cut. Push as a plain fast-forward and hand back to QA as usual.

\`\`\`
${b.tail.trimEnd()}
\`\`\`

Nothing was written to \`${b.base}\` for this ticket; the rest of the release shipped without it.`;
}

interface BuildFailureEvent { record_id?: string | null; event_type?: string | null; occurred_at?: string | null; created_at?: string | null }

/**
 * Hand-backs of this ticket for a failed hook that a lane has answered with a
 * push since (loop guard, CREW-2777): a second one means the fix did not hold.
 */
export function priorBuildFailures(ticket: Ticket, events: readonly BuildFailureEvent[]): number {
  const stamp = (e: BuildFailureEvent): string => e.occurred_at ?? e.created_at ?? '';
  const mine = events.filter((e) => e.record_id === ticket.id);
  const pushes = mine.filter((e) => e.event_type === 'pushed').map(stamp);
  return mine.filter((e) => e.event_type === 'build_failed' && pushes.some((p) => p > stamp(e))).length;
}

export function buildFailureEscalation(b: BuildFailureBounce): string {
  return `${BUILD_FAILURE_MARKER}

**Failed the release gate again after a hand-back — stopping rather than looping.**

\`${b.branch}\` was handed back for breaking the \`${b.hook}\` hook, pushed, verified again, and breaks it once more. That is a call for a person, not another lap through the lanes.

\`\`\`
${b.tail.trimEnd()}
\`\`\``;
}

/**
 * Hand a culprit back to the dev lane. Non-fatal and stale-write-safe for the
 * same reasons as `applyConflictBounce`; the assignee is cleared so
 * `in_progress` + unassigned reads as "up for grabs" on every ship.
 */
export async function applyBuildFailureBounce(
  writer: ConflictWriter, b: BuildFailureBounce, contract: Contract, memberId: string,
  log: ConflictLog, dryRun: boolean, prior: { count: number; operatorId?: string } = { count: 0 },
): Promise<BuildFailureOutcome> {
  const t = { ticket: b.ticket.issue_id, step: 'release' };
  if (prior.count > 0) {
    if (dryRun) {
      log.emit(`would escalate to ${contract.statuses.needsHuman} — handed back for the ${b.hook} hook before`, t);
      return { kind: 'escalated' };
    }
    try {
      await writer.updateTicket(
        b.ticket.id,
        { status: contract.statuses.needsHuman, ...(prior.operatorId ? { assignee_id: prior.operatorId } : {}) },
        b.ticket.updated_at,
      );
      await writer.postEvent(b.ticket.id, buildFailureEscalation(b), memberId, 'build_failed_escalated').catch(() => {
        log.warn('escalated, but the note failed to post', t);
      });
      log.warn(`breaks the ${b.hook} hook again after a hand-back — escalated to ${contract.statuses.needsHuman}`, t);
      return { kind: 'escalated' };
    } catch (e) {
      if (e instanceof StaleWriteError) return { kind: 'stale' };
      return { kind: 'failed', why: (e as Error).message };
    }
  }
  if (dryRun) {
    log.emit(`would hand ${b.ticket.issue_id} back to ${contract.statuses.building} — its branch breaks the ${b.hook} hook`, t);
    return { kind: 'handed-back' };
  }
  try {
    await writer.updateTicket(
      b.ticket.id, { status: contract.statuses.building, assignee_id: null }, b.ticket.updated_at,
    );
    await writer.postEvent(b.ticket.id, buildFailureComment(b), memberId, 'build_failed').catch(() => {
      log.warn('handed back, but the note failed to post', t);
    });
    // One compact record of who was blamed and how (CREW-2777), apart from the
    // comment the lane reads, for anything that wants to count or list them.
    await writer.postEvent(
      b.ticket.id,
      `${b.ticket.issue_tag ?? b.ticket.issue_id} left out of the release: ${b.hook} hook, found by ${b.how}${b.sibling ? `, together with ${b.sibling.key} (${b.sibling.branch})` : ''}`,
      memberId, 'release_culprit',
    ).catch(() => { /* the build_failed note above is the one that matters */ });
    log.emit(`handed back to ${contract.statuses.building} — breaks the ${b.hook} hook once merged with the rest`, t);
    return { kind: 'handed-back' };
  } catch (e) {
    if (e instanceof StaleWriteError) {
      log.emit(`${b.ticket.issue_id} changed on the board since this run read it — not handing it back over it`, t);
      return { kind: 'stale' };
    }
    return { kind: 'failed', why: (e as Error).message };
  }
}
