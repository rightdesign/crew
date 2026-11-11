/**
 * Relayed periscope previews (CREW-3059).
 *
 * With `ship.relayPreviews` on, `crew periscope up` opens one detached `ssh -R` process per
 * periscope that forwards the periscope proxy to the relay under the periscope's own opaque slug
 * (`-path-preview`, the other half of crew-relay's `parseBindAddr`). The link is the credential:
 * nothing sits in front of it. The ship's passenger/control tunnel is a different ssh process
 * and is never touched here.
 *
 * Lifecycle, by who owns it:
 *   up      mints the slug, starts the tunnel, waits for it to settle, records the public URL
 *   down    kills the tunnel before the proxy and server
 *   idle    the idle pass stops it with the server; `up --resume` brings it back under the same slug
 *   daemon  `runPeriscopeTunnelPass` restarts a tunnel that died later, and raises `tunnel_rejected`
 *           for one that keeps dying before it settles
 *
 * Nothing in here may log an ssh argv: it carries the route's API key.
 * Everything is injected so it is tested without ssh or a relay.
 */
import { execFileSync } from 'node:child_process';
import type { PeriscopeSidecar } from './periscope-state.ts';
import type { ShipAttentionItem } from './ship-attention.ts';
import { TUNNEL_REJECTED_AFTER, TUNNEL_REJECTED_KEY } from './tunnel.ts';

/** How long a fresh tunnel must stay up before `up` believes the relay accepted it. */
export const PREVIEW_TUNNEL_SETTLE_MS = 3000;

export type TunnelOutcome = { ok: true; pid: number } | { ok: false; reason: string };

/** What `periscope up` and `--resume` need to relay one periscope; built by `cli.ts` from the ship's settings. */
export interface PreviewRelay {
  newSlug(): string;
  /** `https://<slug>.<relay domain>` */
  publicUrl(slug: string): string;
  /** Starts the tunnel to the periscope proxy at `localUrl` and reports whether it settled. */
  open(slug: string, localUrl: string): Promise<TunnelOutcome>;
  /** Stops a tunnel this relay started. */
  stop(pid: number, slug: string): void;
}

/** `host:port` of a proxy URL, for the forward's target. */
export function forwardTarget(localUrl: string): { host: string; port: number } {
  const u = new URL(localUrl);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  // `new URL` brackets an IPv6 literal; ssh's -R wants it bare.
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

/** The reason shown when the tunnel died before settling. */
export const NOT_RELAYED_REASON =
  'the relay closed the preview tunnel right away (a relay without the `preview` tunnel kind, or a rejected key)';

export interface OpenTunnelDeps {
  /** Spawns the ssh forward to `target`; `exited()` is true once the child has exited. */
  start(target: { host: string; port: number }): { pid: number | undefined; exited(): boolean };
  sleep(ms: number): Promise<void>;
  kill(pid: number): void;
}

/** Starts a preview tunnel and decides, after `PREVIEW_TUNNEL_SETTLE_MS`, whether the relay accepted it. */
export async function openPreviewTunnel(d: OpenTunnelDeps, localUrl: string): Promise<TunnelOutcome> {
  let child: ReturnType<OpenTunnelDeps['start']>;
  try {
    child = d.start(forwardTarget(localUrl));
  } catch (e) {
    return { ok: false, reason: `could not start ssh: ${(e as Error).message}` };
  }
  if (child.pid === undefined) return { ok: false, reason: 'could not start ssh' };
  await d.sleep(PREVIEW_TUNNEL_SETTLE_MS);
  if (child.exited()) return { ok: false, reason: NOT_RELAYED_REASON };
  return { ok: true, pid: child.pid };
}

/**
 * Whether `pid` is still this periscope's preview ssh: a pid recorded days ago may belong to an
 * unrelated process by now, and must never be signalled. `commandOf` is the process's command
 * line (undefined when it is gone). Only the slug marker is compared; the line is never logged.
 */
export function isPreviewTunnel(pid: number, slug: string, commandOf: (pid: number) => string | undefined = psCommand): boolean {
  const cmd = commandOf(pid);
  return cmd !== undefined && cmd.includes(`-slug-${slug}-path-preview-`);
}

function psCommand(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || undefined;
  } catch { return undefined; }
}

/** SIGTERMs the preview tunnel recorded in a sidecar, if it is still that process. Returns whether one was stopped. */
export function stopRecordedTunnel(
  sc: Pick<PeriscopeSidecar, 'slug' | 'tunnelPid'>,
  deps: { commandOf?: (pid: number) => string | undefined; kill?: (pid: number) => void } = {},
): boolean {
  if (!sc.slug || sc.tunnelPid === undefined) return false;
  if (!isPreviewTunnel(sc.tunnelPid, sc.slug, deps.commandOf)) return false;
  try { (deps.kill ?? ((p) => process.kill(p, 'SIGTERM')))(sc.tunnelPid); } catch { return false; }
  return true;
}

export const periscopeTunnelKey = (ticket: string): string => `${TUNNEL_REJECTED_KEY}:periscope:${ticket}`;

export function periscopeTunnelRejectedItem(ticket: string, quickExits: number, nowIso: string): ShipAttentionItem {
  return {
    kind: 'tunnel_rejected',
    key: periscopeTunnelKey(ticket),
    since: nowIso,
    message:
      `the relay preview tunnel for periscope ${ticket} exited before settling on ${quickExits} consecutive passes; its link does not work. ` +
      'Check that the relay supports the `preview` tunnel kind (crew-relay) and that the route key is accepted, or end the periscope.',
  };
}

/**
 * CREW-3239: the open periscope `tunnel_rejected` keys whose periscope no longer has a tunnel the pass
 * watches (the sidecar is gone, has no slug, or its tunnel was stopped on purpose). Nothing else clears
 * them: the pass skips such a periscope, so an item raised before it ended would stay open.
 */
export function staleTunnelKeys(openKeys: string[], sidecars: PeriscopeSidecar[]): string[] {
  const watched = new Set(sidecars.filter((sc) => sc.slug && !sc.tunnelStopped).map((sc) => periscopeTunnelKey(sc.ticket)));
  const prefix = `${TUNNEL_REJECTED_KEY}:periscope:`;
  return openKeys.filter((key) => key.startsWith(prefix) && !watched.has(key));
}

export interface TunnelPassDeps {
  sidecars(): PeriscopeSidecar[];
  isAlive(sc: PeriscopeSidecar): boolean;
  /** Starts a new tunnel for the sidecar's slug without waiting for it; returns its pid. */
  respawn(sc: PeriscopeSidecar): number | undefined;
  patch(ticketRecordId: string, patch: Partial<PeriscopeSidecar>): void;
  raise(item: ShipAttentionItem): Promise<void>;
  clear(key: string): void;
  now(): Date;
  warn(message: string): void;
}

/**
 * One pass over this ship's relayed periscopes: a tunnel found alive is marked settled; a dead one
 * is restarted, and one that never settled counts toward `tunnel_rejected`. Periscopes whose tunnel
 * was stopped on purpose (idle, failed resume) and unrelayed ones are left alone.
 */
export async function runPeriscopeTunnelPass(d: TunnelPassDeps): Promise<{ respawned: number }> {
  let respawned = 0;
  for (const sc of d.sidecars()) {
    if (!sc.slug || sc.tunnelStopped) continue;
    const key = periscopeTunnelKey(sc.ticket);
    try {
      if (sc.tunnelPid !== undefined && d.isAlive(sc)) {
        if (!sc.tunnelSettled) d.patch(sc.ticketRecordId, { tunnelSettled: true, tunnelQuickExits: 0 });
        d.clear(key);
        continue;
      }
      const quickExits = sc.tunnelSettled ? 0 : (sc.tunnelQuickExits ?? 0) + 1;
      const pid = d.respawn(sc);
      d.patch(sc.ticketRecordId, {
        tunnelPid: pid, tunnelStartedAt: d.now().toISOString(), tunnelSettled: false, tunnelQuickExits: quickExits,
      });
      respawned++;
      if (quickExits >= TUNNEL_REJECTED_AFTER) await d.raise(periscopeTunnelRejectedItem(sc.ticket, quickExits, d.now().toISOString()));
    } catch (e) {
      d.warn(`periscope tunnel check failed for ${sc.ticket}: ${(e as Error).message}`);
    }
  }
  return { respawned };
}
