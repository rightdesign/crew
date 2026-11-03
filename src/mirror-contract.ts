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
import { remoteOf } from './remote-dir.ts';
import { REPO_CONFIG_FILENAMES, parseRepoConfig, loadRepoConfigTolerant, type RepoConfig } from './repo-config.ts';
import { mirrorRepoOf } from './passenger-mirror.ts';
import { parseRemote, SandboxCache, cacheSettingsOf, type CacheRepo } from './sandbox-cache.ts';
import { globToRegExp, WARM_MAX_BYTES, type WarmFiles } from './sandbox-image.ts';
import type { RepoTarget, Route, Ship } from './config.ts';

/** Whether this repository has to be served from its mirror: a sandbox-runner ship whose checkout directory is absent. */
export function lacksCheckout(ship: { runner?: string }, dir: string): boolean {
  return ship.runner === 'sandbox' && !existsSync(dir) && !remoteOf(dir);
}

/**
 * Whether the select step leaves the ticket's repository to the runner (CREW-3006). A sandbox-runner
 * ship clones inside the sandbox from the mirror, so a host clone serves nothing and, worse, makes
 * the release phase believe the ship has a toolchain on the host.
 */
export function skipsHostCheckout(ship: { runner?: string }): boolean {
  return ship.runner === 'sandbox';
}

/** The mirror a target lives in, from its `remote` and forge host; null when the board gave no remote. */
export function mirrorRepoOfTarget(t: RepoTarget): CacheRepo | null {
  return mirrorRepoOf({ remote: t.remote, forgeHost: t.forgeHost } as Parameters<typeof mirrorRepoOf>[0]);
}

/**
 * The mirror the cache pass keeps fresh for a target: its checkout's origin when it has one, else, on
 * a ship with no checkout of it, the Repos row's remote and forge host (CREW-2940).
 */
export function cacheRepoOfTarget(ship: { runner?: string }, t: RepoTarget, origin: string | null): CacheRepo | null {
  if (origin) return parseRemote(origin);
  return lacksCheckout(ship, t.dir) ? mirrorRepoOfTarget(t) : null;
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
 * CREW-3032: the one resolver for a ticket repository's contract at run time. A host-runner ship
 * reads the checkout's `.crew.yaml`; a sandbox-runner ship reads the one committed on the base
 * branch in its mirror, because it has no checkout (and one it happens to have is not what runs).
 * The planner, the policy generator, the image lookup and the daemon's image guard all use it, so
 * none of them can decide "declares no `sandbox:`" from a directory that is not there. A sandbox
 * ship with no mirror settings or no mirror for the repository falls back to the checkout, and an
 * unreadable or malformed contract reads as none, as it did for every caller before.
 */
export async function repoContractFor(ship: Pick<Ship, 'runner' | 'sandbox'>, route: Pick<Route, 'branch'>, t: RepoTarget): Promise<RepoConfig | null> {
  if (ship.runner === 'sandbox') {
    const settings = cacheSettingsOf(ship.sandbox);
    const mirror = mirrorRepoOfTarget(t);
    if (settings && mirror) {
      try { return await readMirrorContract(new SandboxCache(settings), mirror, route.branch?.base ?? 'main'); } catch { return null; }
    }
  }
  try { return loadRepoConfigTolerant(t.dir); } catch { return null; }
}

/**
 * The `sandbox.warm` files as committed on `base` in the mirror, for a ship with no checkout to
 * run `git show` in (CREW-3010). Same semantics as `readWarmFiles`: a pattern matching nothing is
 * skipped, and an unreadable mirror or oversized set throws.
 */
export async function readMirrorWarmFiles(cache: Pick<SandboxCache, 'showFile' | 'listFiles'>, repo: CacheRepo, base: string, patterns: string[]): Promise<WarmFiles> {
  if (patterns.length === 0) return {};
  const res = patterns.map(globToRegExp);
  const out: WarmFiles = {};
  let total = 0;
  for (const path of (await cache.listFiles(repo, base)).filter((f) => res.some((re) => re.test(f))).sort()) {
    const content = await cache.showFile(repo, base, path);
    if (content === null) continue;
    total += content.length;
    if (total > WARM_MAX_BYTES) throw new Error(`sandbox.warm files exceed ${WARM_MAX_BYTES} bytes`);
    out[path] = content;
  }
  return out;
}

/**
 * What the release phase does for a repository it has no checkout of. Release
 * modes that merge on the ship itself need the sandboxed release over a
 * mirror-fed clone, which this ship cannot do yet; `local` repositories deploy
 * through a hook on the host that owns them, so there is nothing for this ship
 * to release.
 */
export function noCheckoutReleaseNote(repo: string, mode: string | null): string {
  if (mode === 'external') {
    return `${repo}: no checkout on this ship; release.mode "external" repositories are handed off by a ship with a checkout`;
  }
  return `${repo}: no checkout on this ship; release.mode "local" repositories are released by the host that owns the deploy hook, which takes a ticket at verified`;
}

/** Release modes a managed ship releases itself, from a release sandbox (CREW-2940). */
export function releasesFromSandbox(mode: string | null): boolean {
  return mode === 'integrate' || mode === 'ci_auto' || mode === 'ci_manual';
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

/**
 * Whether a route is servable on this ship (CREW-2993). `platforms` are the platform requirements of the
 * repositories whose contract could be read; `unreadable` names the ones that could not. With
 * `tolerateUnmirrored`, an unreadable repository that merely has no mirror yet counts as servable: its
 * contract cannot be read until the cache pass creates the mirror, and it says nothing about its platform.
 */
export function judgeServable<P>(o: {
  platforms: P[]; satisfied: (platform: P) => boolean;
  unreadable: string[]; unmirrored: ReadonlySet<string>; tolerateUnmirrored: boolean;
}): boolean {
  if (o.platforms.some(o.satisfied)) return true;
  return o.tolerateUnmirrored && o.unreadable.some((n) => o.unmirrored.has(n));
}

/** Why a route was refused: each readable repository's requirement, then each unreadable one, never an empty clause. */
export function explainRefusal(readable: Array<{ name: string; platform: string }>, unreadable: Array<{ repo: string; detail: string }>): string {
  const parts = [
    ...readable.map((r) => `${r.name} requires ${r.platform}`),
    ...unreadable.map((e) => `${e.repo}'s contract could not be read (${e.detail.split('\n')[0]})`),
  ];
  if (readable.length === 0) parts.unshift('no repository contract could be read');
  return parts.join(', ');
}
