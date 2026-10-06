/**
 * Which ship releases a repo (CREW-1384).
 *
 * Every ship runs the release phase for every repo it serves. For a repo
 * released locally (`local`/`integrate`, no CI) that is N laptops racing to
 * merge, version and tag, held apart only by the board lock. A repo can name
 * its releaser in `.crew.yaml` (`release.ship: <Ships row name>`); every other
 * ship skips the phase for that repo and says so. CI-mode repos are left
 * alone: they keep multi-ship merging behind the board lock and the
 * fast-forward-only push.
 */

import type { RepoConfig } from './repo-config.ts';
import type { ShipRow } from './tracker.ts';

export interface Releaser { releases: boolean; releaser: string | null }

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `shipName` runs the release phase for a repo with this release config. */
export function releaserFor(release: Pick<RepoConfig['release'], 'ship' | 'mode'>, shipName: string): Releaser {
  const named = release.ship;
  if (!named || (release.mode !== 'local' && release.mode !== 'integrate')) return { releases: true, releaser: named ?? null };
  return { releases: named.trim() === shipName.trim(), releaser: named };
}

/** The one line a non-releasing ship reports, once per cycle, in place of a release. */
export function nonReleaserNote(repo: string, releaser: string): string {
  return `release for ${repo} runs on ${releaser}`;
}

/**
 * `crew doctor`'s warning for a locally-released repo that names no releaser
 * while more than one ship has been seen in the last day. With exactly one
 * ship there is nothing to race, so it stays silent (that ship releases).
 */
export function missingReleaserWarning(
  repo: string, release: Pick<RepoConfig['release'], 'ship' | 'mode'>, ships: ShipRow[], now = Date.now(),
): string | null {
  if (release.ship || (release.mode !== 'local' && release.mode !== 'integrate')) return null;
  const live = ships.filter((s) => s.last_seen && now - Date.parse(s.last_seen) <= DAY_MS);
  if (live.length < 2) return null;
  const names = live.map((s) => s.name ?? '?').join(', ');
  return `${repo}: release.mode "${release.mode}" with no release.ship, and ${live.length} ships seen in the last day ` +
    `(${names}) — every one of them will try to release it. Set release.ship in .crew.yaml.`;
}
