/**
 * Repository contracts on a ship with no primary checkouts (CREW-2938).
 *
 * A sandbox-runner ship provisioned by `crew pool-member` keeps its
 * repositories only as bare mirrors on the cache volume; the route directory
 * holds nothing. Every place that reads `<dir>/.crew.yaml` then reads nothing,
 * so the release phase saw every repository as having no hooks and
 * `release.mode: local`, and ran git in a directory that does not exist.
 *
 * This module reads the contract from the mirror's default branch instead, and
 * decides what the release phase does for a repository it has no checkout of.
 */

import { existsSync } from 'node:fs';
import { REPO_CONFIG_FILENAMES, parseRepoConfig, type RepoConfig } from './repo-config.ts';
import { mirrorRepoOf } from './passenger-mirror.ts';
import type { SandboxCache, CacheRepo } from './sandbox-cache.ts';
import type { RepoTarget } from './config.ts';

/** Whether this repository has to be served from its mirror: a sandbox-runner ship whose checkout directory is absent. */
export function lacksCheckout(ship: { runner?: string }, dir: string): boolean {
  return ship.runner === 'sandbox' && !existsSync(dir);
}

/** The mirror a target lives in, from its `remote` and forge host; null when the board gave no remote. */
export function mirrorRepoOfTarget(t: RepoTarget): CacheRepo | null {
  return mirrorRepoOf({ remote: t.remote, forgeHost: t.forgeHost } as Parameters<typeof mirrorRepoOf>[0]);
}

/**
 * The repository's contract as committed on `base` in its mirror, or null when
 * the mirror carries none. A malformed contract throws the `RepoConfigError`
 * `parseRepoConfig` raises, the same as a checkout would.
 */
export async function readMirrorContract(cache: Pick<SandboxCache, 'showFile'>, repo: CacheRepo, base: string): Promise<RepoConfig | null> {
  for (const name of REPO_CONFIG_FILENAMES) {
    const text = await cache.showFile(repo, base, name);
    if (text !== null) return parseRepoConfig(text, `${repo.host}/${repo.path}:${base}:${name}`);
  }
  return null;
}

/**
 * What the release phase does for a repository it has no checkout of. Release
 * modes that merge on the ship itself need the sandboxed release over a
 * mirror-fed clone, which this ship cannot do yet; `local` repositories deploy
 * through a hook on the host that owns them, so there is nothing for this ship
 * to release.
 */
export function noCheckoutReleaseNote(repo: string, mode: string | null): string {
  if (mode === 'local' || mode === null) {
    return `${repo}: no checkout on this ship; release.mode "local" repositories are released by the host that owns the deploy hook, which takes a ticket at verified`;
  }
  return `${repo}: no checkout on this ship; release.mode "${mode}" needs the sandboxed release over a mirror-fed clone, which is not built (CREW-2940)`;
}

/** Repositories already reported as having no checkout, so a daemon logs each once rather than once per pass. */
const reported = new Set<string>();

/** True the first time `key` is seen in this process. */
export function firstReport(key: string): boolean {
  if (reported.has(key)) return false;
  reported.add(key);
  return true;
}

/** Test seam. */
export function resetReported(): void {
  reported.clear();
}
