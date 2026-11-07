/**
 * The release phase's platform eligibility gate, evaluated against the contract
 * as it would be AFTER the merge (CREW-3104).
 *
 * Reading `platform` from the base alone is self-sealing: when a repository's
 * base says `linux` and a macOS ship is the only one serving the route, the one
 * change that can make the repository releasable (a verified branch editing
 * `platform` to `unix`) sits on the branch the gate refuses to look at. Hooks
 * still run from the merged tree, so only the eligibility decision looks ahead.
 */
import { join } from 'node:path';
import { REPO_CONFIG_FILENAMES, RepoConfigError, parseRepoConfig } from './repo-config.ts';
import { satisfies, eligibleShips, type ShipPlatform, type PlatformRequirement } from './platform.ts';
import { gitOk } from './git.ts';

export interface PlatformAdmitter {
  issueId: string;
  branch: string;
  platform: PlatformRequirement;
}

/**
 * The verified tickets whose branch carries a repo contract (changed relative to
 * `baseRef`) that parses and whose `platform` this ship satisfies. `locate` names
 * a ticket's branch (null when it has none). A branch that does not change the
 * contract, or whose contract is refused, never admits a ship the base refused.
 */
export function platformAdmitters(
  dir: string, baseRef: string, ship: ShipPlatform,
  tickets: ReadonlyArray<{ issue_id: string }>,
  locate: (t: { issue_id: string }) => string | null,
): PlatformAdmitter[] {
  const out: PlatformAdmitter[] = [];
  for (const t of tickets) {
    const branch = locate(t);
    if (!branch) continue;
    const changed = gitOk(dir, ['diff', '--name-only', `${baseRef}...${branch}`, '--', ...REPO_CONFIG_FILENAMES]);
    const file = changed?.split('\n').find((f) => f.trim() !== '');
    if (!file) continue;
    const text = gitOk(dir, ['show', `${branch}:${file}`]);
    if (text === null) continue;
    try {
      const { platform } = parseRepoConfig(text, join(dir, file));
      if (satisfies(ship, platform)) out.push({ issueId: t.issue_id, branch, platform });
    } catch (e) {
      if (e instanceof RepoConfigError) continue;
      throw e;
    }
  }
  return out;
}

/** The note for a repository no verified branch makes releasable here: names the ticket(s) and who could release it. */
export function platformStuckNote(repo: string, required: PlatformRequirement, ship: ShipPlatform, issueIds: readonly string[]): string {
  const who = eligibleShips(required).join(', ');
  const stuck = issueIds.length ? `${issueIds.join(', ')} verified but cannot be released by this ${ship} ship` : `this ${ship} ship cannot release it`;
  return `${repo}: its contract requires ${required}, so ${stuck}; only a ${who} ship can (and no verified branch changes platform to admit this one)`;
}
