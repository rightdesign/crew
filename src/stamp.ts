/**
 * Closing out a release on the board.
 *
 * After a release ships, the tickets it carried move from `verified` to
 * `deployed` and record which version carried them. That is the only place
 * `released_version` is written, and it is what turns "this shipped" from a
 * commit message into something the board can be filtered by.
 *
 * Deliberately NOT fatal: this runs *after* a successful deploy, and a
 * tracker that is briefly unreachable must not turn a good release into a
 * failed one. The stamp is retried next cycle, because the tickets are still
 * at `verified` and still named in commits past the last release.
 */

import { referenceKeys, type Tracker, type Ticket } from './tracker.ts';
import type { Contract } from './contract.ts';
import type { Emitter } from './events.ts';
import { commitBodies, findKeyInRange, type ClosureCheck } from './git.ts';

export interface StampPlan {
  ticket: Ticket;
  /** Why it is being stamped: named in the released range. */
  reason: string;
  /**
   * The merge commit sha on the base branch, when it is known — either this
   * run's own squash-merge, or resolved from the released range for a
   * ticket this run did not merge itself (a prior cycle's deploy failed and
   * this one carries it, or a forge/person merged it outside the crew).
   */
  sha?: string;
}

/**
 * Which verified tickets this release actually carried.
 *
 * Read from the commits in the released range rather than from whatever the
 * merge phase happened to merge this cycle: a ticket merged on an earlier
 * cycle whose deploy failed is carried by THIS release, and would otherwise
 * sit at `verified` forever with its work already live.
 */
export function planStamp(
  cwd: string, tickets: Ticket[], contract: Contract,
  fromSha: string | null, toSha: string,
  /**
   * Tickets this run merged itself, by issue id, to the sha of the squash
   * commit it wrote (unset for a no-op merge — nothing was committed).
   *
   * The commit scan below cannot see all of them. A branch already contained
   * in the integration branch merges as a no-op and writes NO commit, so it is
   * named nowhere in the released range — ISSUE-292 shipped inside v0.58.4 and
   * sat at `verified` afterwards for exactly this reason. What the run merged
   * is first-hand knowledge; the scan is for everything else, including work a
   * forge or a person merged outside the crew.
   */
  merged: ReadonlyMap<string, string | undefined> = new Map(),
): StampPlan[] {
  const range = fromSha ? `${fromSha.slice(0, 8)}..${toSha.slice(0, 8)}` : null;
  const bodies = fromSha ? commitBodies(cwd, `${fromSha}..${toSha}`) : '';
  return tickets
    .filter((t) => t.status === contract.statuses.verified)
    .map((t): StampPlan | null => {
      if (merged.has(t.issue_id)) {
        return { ticket: t, reason: 'merged by this release', sha: merged.get(t.issue_id) };
      }
      // Matches either the ticket's issue_id or its issue_tag (ISSUE-969) —
      // a commit naming only `CREW-969` must still be found, or a ticket
      // whose work shipped under its tag sits at `verified` forever.
      const keys = referenceKeys(t);
      const pattern = keys.map((k) => k.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&')).join('|');
      if (range && new RegExp(`(^|[^0-9A-Za-z_-])(${pattern})([^0-9]|$)`).test(bodies)) {
        // Not merged by this run — a prior cycle's deploy failed and this one
        // carries it, or a forge/person merged it outside the crew. Its sha
        // is resolved from the same range, same reasoning as `findKeyOnBase`
        // (git.ts) uses for the external-closure path.
        const sha = findKeyInRange(cwd, keys, range) ?? undefined;
        return { ticket: t, reason: `named in ${range}`, sha };
      }
      return null;
    })
    .filter((p): p is StampPlan => p !== null);
}

export async function applyStamp(
  tracker: Tracker, plan: StampPlan[], version: string | undefined,
  contract: Contract, emit: Emitter, dryRun: boolean,
): Promise<number> {
  let stamped = 0;
  const at = new Date().toISOString();
  for (const { ticket, sha } of plan) {
    const shaNote = sha ? `, commit_sha ${sha.slice(0, 8)}` : '';
    if (dryRun) {
      emit.emit(`would stamp -> ${contract.statuses.deployed}${version ? ` (${version})` : ''}${shaNote}`, {
        ticket: ticket.issue_id,
      });
      stamped++;
      continue;
    }
    try {
      await tracker.updateTicket(ticket.id, {
        status: contract.statuses.deployed,
        // `released_at` is always a real release moment here; only the version is optional (versioning: none).
        released_at: at,
        ...(version ? { released_version: version } : {}),
        // Written here rather than only on the external path (below): a
        // ticket's record should mean the same thing regardless of which
        // release mode closed it (ISSUE-218). `merged_at` is stamped
        // alongside — not read off the commit itself — since that is the
        // moment the tracker learns of it, same as the external path.
        ...(sha ? { commit_sha: sha, merged_at: at } : {}),
      });
      emit.emit(`stamped ${contract.statuses.deployed}${version ? ` (${version})` : ''}${shaNote}`, {
        ticket: ticket.issue_id,
      });
      stamped++;
    } catch (e) {
      // One ticket failing must not abandon the rest, and none of it fails
      // the release — the work is already live.
      emit.warn(`could not stamp: ${(e as Error).message}`, { ticket: ticket.issue_id });
    }
  }
  return stamped;
}

/**
 * `release.mode: external` only: write `commit_sha`/`merged_at` onto a
 * ticket once `detectClosure` confirms it landed on the other side of the
 * hand-off — the same two fields dev-loop.sh's `stamp_merge_commit` writes
 * for the automated-merge path (ISSUE-218), so a ticket's record means the
 * same thing regardless of which path closed it.
 *
 * Only `state === 'merged'` writes anything: `open`/`unknown` mean nothing
 * has happened yet, and a `mergedAt` that stays `undefined` (merge subject
 * was rewritten, no key found on the base) is not stamped either — a
 * missing sha next cycle, once the base has more history to search, beats a
 * wrong one now.
 *
 * When the repo also defines `hooks.released`, `confirmExternalReleased`
 * (release-run.ts) has already checked whether a real release carried that
 * landing — `confirmed: true` closes the ticket the rest of the way, to
 * `contract.statuses.deployed`, with `released_version`/`released_at` set
 * the same as `applyStamp` above does for a release the crew ran itself
 * (ISSUE-811). `confirmed` left `undefined` (no `hooks.released` defined, or
 * the poll hasn't yet found a live commit to check against) or `false` (a
 * live commit exists but doesn't yet carry this merge) both mean: stamp what
 * landed, same as always, but leave status alone — the work merged, not
 * necessarily shipped.
 */
export async function applyExternalClosures(
  tracker: Tracker,
  closures: { ticket: Ticket; closure: ClosureCheck; confirmed?: boolean; version?: string }[] | undefined,
  contract: Contract,
  emit: Emitter,
  dryRun: boolean,
): Promise<number> {
  if (!closures?.length) return 0;
  let stamped = 0;
  const at = new Date().toISOString();
  for (const { ticket, closure, confirmed, version } of closures) {
    if (closure.state !== 'merged' || !closure.mergedAt) continue;
    const shippedNote = confirmed ? ` and ${contract.statuses.deployed}${version ? ` (${version})` : ''}` : '';
    if (dryRun) {
      emit.emit(`would stamp commit_sha (${closure.mergedAt.slice(0, 8)})${shippedNote}`, { ticket: ticket.issue_id });
      stamped++;
      continue;
    }
    try {
      await tracker.updateTicket(ticket.id, {
        commit_sha: closure.mergedAt,
        merged_at: at,
        ...(confirmed ? { status: contract.statuses.deployed, released_at: at, ...(version ? { released_version: version } : {}) } : {}),
      });
      emit.emit(`stamped commit_sha (${closure.mergedAt.slice(0, 8)})${shippedNote}`, { ticket: ticket.issue_id });
      stamped++;
    } catch (e) {
      // Same reasoning as applyStamp above: the merge already happened on
      // the other side, a tracker blip here must not be treated as a
      // release failure.
      emit.warn(`could not stamp commit_sha: ${(e as Error).message}`, { ticket: ticket.issue_id });
    }
  }
  return stamped;
}
