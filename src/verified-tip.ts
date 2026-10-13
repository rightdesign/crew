/**
 * Has a verified ticket's branch moved past what QA verified (CREW-1637)?
 *
 * The release squashes whatever the ticket branch points at when it runs. QA
 * verified a particular commit; if the branch has since gained work (a dev
 * pushed after the hand-off, a reviewer's fixup), the squash would ship
 * something nobody tested. `review.ts` already guards this for
 * `release.mode: external`; this is the same guard for the internal merge.
 *
 * What QA verified, in order of authority:
 *   1. the ticket's `verified_sha` column, when the board has one and QA wrote it;
 *   2. otherwise the sha in the newest `pushed <sha> to <remote>/<branch>`
 *      event, which the runner posts when a building lane hands off — QA tests
 *      exactly that tip.
 * Neither known (an older ticket, a board with no event log) means "can't
 * tell", and the branch is released as before.
 *
 * Merge commits are not movement: the conflict-refresh merges the base into a
 * stale branch, and a branch that only gained merges adds no work of its own.
 * Judged on the first-parent line, so the base's commits a merge brings in
 * do not count as the branch's.
 */

import { gitOk, isAncestor } from './git.ts';
import type { Ticket, RunnerEvent } from './tracker.ts';

const PUSHED_RE = /^pushed ([0-9a-f]{40}) to \S+$/;

/** The sha a `pushed` event body names, or null for any other text. */
export function parsePushedSha(message: string | null | undefined): string | null {
  return PUSHED_RE.exec((message ?? '').trim())?.[1] ?? null;
}

/**
 * The commit QA verified for `ticket`: its `verified_sha` column if set, else
 * the sha of its newest `pushed` event (`events` may be in any order).
 */
export function verifiedShaFor(
  ticket: Ticket, verifiedShaColumn: string, pushedEvents: RunnerEvent[],
): string | null {
  const col = (ticket as Record<string, unknown>)[verifiedShaColumn];
  if (typeof col === 'string' && /^[0-9a-f]{7,40}$/i.test(col.trim())) return col.trim();
  const when = (e: RunnerEvent) => Date.parse(e.occurred_at ?? e.created_at ?? '') || 0;
  const newest = pushedEvents
    .filter((e) => e.record_id === ticket.id && parsePushedSha(e.message))
    .sort((a, b) => when(b) - when(a))[0];
  return newest ? parsePushedSha(newest.message) : null;
}

/**
 * The branch's current tip when it carries work beyond `verified`, else null.
 * `verified` not being in this checkout at all is "can't tell" (null): the
 * release must not hold a ticket back over a sha it cannot look at.
 */
export function movedPastVerified(cwd: string, branch: string, verified: string): { tip: string; verified: string } | null {
  const tip = gitOk(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`]);
  const ver = gitOk(cwd, ['rev-parse', '-q', '--verify', `${verified}^{commit}`]);
  if (!tip || !ver || tip === ver) return null;
  // Behind what was verified is not "moved past" it; the squash then merges
  // less than QA saw, which the next verification catches.
  if (isAncestor(cwd, tip, ver)) return null;
  // Descends from it: moved only if something beyond merges was added.
  if (isAncestor(cwd, ver, tip)) {
    const own = gitOk(cwd, ['rev-list', '--first-parent', '--no-merges', '--count', `${ver}..${tip}`]);
    if (own === '0') return null;
  }
  return { tip, verified: ver };
}
