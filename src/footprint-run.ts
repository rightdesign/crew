/**
 * The impure half of footprints (CREW-3387): reading the `footprint_declared`
 * and `pushed` events from the log and each served repo's changelog and version
 * files (which never count). `footprint.ts` decides; this only gathers.
 */

import type { Route } from './config.ts';
import { reposOf } from './config.ts';
import { gitOk } from './git.ts';
import { loadRepoConfigTolerant, resolveRepoConfig } from './repo-config.ts';
import type { Ticket, Tracker } from './tracker.ts';
import {
  FOOTPRINT_DECLARED_EVENT, declarations, normalizePath, pushedMetadata, planFootprints, pushes,
  type Declaration, type FootprintPlan, type PushInfo,
} from './footprint.ts';

export interface FootprintEvents { declared: Map<string, Declaration>; pushed: Map<string, PushInfo> }

export async function readFootprintEvents(tracker: Pick<Tracker, 'events'>): Promise<FootprintEvents> {
  return {
    declared: declarations(await tracker.events(FOOTPRINT_DECLARED_EVENT)),
    pushed: pushes(await tracker.events('pushed')),
  };
}

/** repo_id -> the paths the release phase rewrites in that repo (changelog, version files). */
export function ignoreByRepo(route: Route): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  const names = route.resolved?.repoNames ?? {};
  for (const target of reposOf(route)) {
    let ignored: Set<string>;
    try {
      const cfg = resolveRepoConfig(loadRepoConfigTolerant(target.dir), undefined, target.dir);
      ignored = new Set([...cfg.release.versionFiles, ...(cfg.release.changelog ? [cfg.release.changelog] : [])].map(normalizePath));
    } catch {
      continue; // an unreadable config only means the lockfile rule alone applies this cycle
    }
    // A route with one unnamed repo has no id map; its tickets carry no repo_id either.
    const ids = Object.entries(names).filter(([, n]) => n === target.name).map(([id]) => id);
    for (const id of ids.length ? ids : ['']) out.set(id, ignored);
  }
  return out;
}

export function planFootprintsFor(
  route: Route, tickets: Ticket[], ev: FootprintEvents, dependencyBlocked?: Set<string>,
): FootprintPlan {
  return planFootprints({ tickets, ...ev, ignoreByRepo: ignoreByRepo(route), dependencyBlocked });
}

/** The metadata for a `pushed` event: the paths `sha` changes against `<remote>/<base>` in `dir`. */
export function pushedEventExtra(dir: string, remote: string, base: string, sha: string): { paths: string[] } | undefined {
  return pushedMetadata(gitOk(dir, ['diff', '--no-renames', '--name-only', `${remote}/${base}...${sha}`]));
}
