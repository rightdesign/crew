/**
 * Mirror-fed Host Passengers checkouts (CREW-2807, EPIC-075 Map v1 §10).
 *
 * A ship on the sandbox runner has no primary checkouts, only the sandbox
 * cache volume's bare mirrors. For such a ship `passengerCheckoutSyncSpecs`
 * marks each spec `mirror` and points `dir` into `passengerMirrorArea`; this
 * module writes the base-branch tip of the repository's mirror into that
 * directory, read-only to the passenger container (which bind-mounts it with
 * `:ro`). It runs right after every mirror refresh (the daemon's cache pass),
 * on each passengers pass, and on a passenger's `/sync` callback, so a
 * passenger sees the same tip the next sandbox run will clone.
 *
 * The directory is updated in place rather than swapped, so a running
 * container's bind mount never ends up on a deleted directory. Switching the
 * runner between host and sandbox changes the mounted path, which changes the
 * container's `mountsHash`, so the container is recreated on the next sync
 * with no manual step.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SandboxCache, parseRemote, type CacheRepo } from './sandbox-cache.ts';
import { DEFAULT_FORGE_HOST, normalizeForgeHost } from './forges.ts';
import type { PassengerCheckoutSyncSpec } from './passenger-containers.ts';
import type { PassengerCheckoutOutcome } from './git.ts';

export interface MirrorCheckoutOutcome {
  name: string;
  workspaceId: string;
  action: 'updated' | 'unchanged' | 'failed';
  detail: string;
}

/** The mirror a spec's repository lives in: its origin URL when it has one, else `remote` on the Repos row's forge host. */
export function mirrorRepoOf(spec: PassengerCheckoutSyncSpec): CacheRepo | null {
  const fromOrigin = spec.originUrl ? parseRemote(spec.originUrl) : null;
  if (fromOrigin) return fromOrigin;
  if (!spec.remote) return null;
  return { host: normalizeForgeHost(spec.forgeHost) || DEFAULT_FORGE_HOST, path: spec.remote };
}

/**
 * Brings each mirror-fed spec's checkout level with its mirror. One
 * repository failing does not stop the others; a failure is returned, not
 * thrown, and the previous contents stay in place.
 */
export async function materializeMirrorCheckouts(
  specs: PassengerCheckoutSyncSpec[], cacheFor: (s: PassengerCheckoutSyncSpec) => SandboxCache = (s) => new SandboxCache(s.mirror!.cache),
): Promise<MirrorCheckoutOutcome[]> {
  const out: MirrorCheckoutOutcome[] = [];
  for (const spec of specs) {
    if (!spec.mirror) continue;
    const base = { name: spec.name, workspaceId: spec.workspaceId };
    const repo = mirrorRepoOf(spec);
    if (!repo) {
      out.push({ ...base, action: 'failed', detail: `no remote known for ${spec.name}, so its mirror cannot be found` });
      continue;
    }
    try {
      const parent = dirname(spec.dir);
      mkdirSync(parent, { recursive: true });
      // Made by the host user, before a container's bind mount can create it as root.
      mkdirSync(spec.dir, { recursive: true });
      const r = await cacheFor(spec).materialize(repo, spec.base, parent, spec.name);
      out.push({ ...base, action: r.changed ? 'updated' : 'unchanged', detail: r.tip });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      out.push({ ...base, action: 'failed', detail: (err.stderr?.trim() || err.message || String(e)).split('\n').slice(-3).join(' / ') });
    }
  }
  return out;
}

/** A mirror outcome in the shape the `/sync` route reports for a forge clone. */
export function mirrorOutcome(m: MirrorCheckoutOutcome): PassengerCheckoutOutcome {
  if (m.action === 'failed') return { action: 'clone-failed', detail: m.detail, repeat: false };
  return { action: 'cloned', detail: `${m.action} ${m.detail}` };
}
