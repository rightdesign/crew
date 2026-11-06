/**
 * The local record of each live periscope on this ship (EPIC-077, CREW-2857).
 *
 * `crew periscope up` writes one JSON sidecar per periscope under
 * `<stateDir>/periscopes` and `down` removes it, so `crew status --json` can
 * list them without a tracker round trip (the tracker's Periscopes row stays
 * the source of truth for `periscope list`). `serving` is never stored: it is
 * probed at read time, because the point of the field is to notice a preview
 * server that died while its row still says `live`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { readPointedAt, type PointedAt } from './periscope-pointed.ts';

export interface PeriscopeSidecar {
  ticket: string;
  ticketRecordId: string;
  periscopeRecordId: string;
  repo: string;
  /** The route that serves it; absent on a record written before CREW-2862. */
  route?: string;
  worktree: string;
  branch: string;
  url: string;
  host: string;
  state: string;
  isolated: boolean;
  /** The repository's symbol service (`hooks.intel`) and the tools it advertised; absent when none came up. */
  intelUrl?: string;
  intelTools?: string[];
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  /**
   * Relayed preview (CREW-3059), all absent when the periscope is not relayed. `slug` is the
   * periscope's own opaque public label; `url` is then the public address and `localUrl` the
   * proxy address the tunnel forwards to (what the serving probe checks).
   */
  slug?: string;
  localUrl?: string;
  /** Pid of the detached ssh process carrying the preview forward; absent while it is stopped. */
  tunnelPid?: number;
  tunnelStartedAt?: string;
  /** A pass found the tunnel alive after it started (it was not refused). */
  tunnelSettled?: boolean;
  /** Consecutive passes that found a never-settled tunnel dead; `tunnel_rejected` is raised at the threshold. */
  tunnelQuickExits?: number;
  /** The tunnel was stopped on purpose (idle stop, failed resume): the respawn step leaves it alone until `up --resume`. */
  tunnelStopped?: boolean;
}

export interface PeriscopeStatus extends PeriscopeSidecar {
  /** Whether something is listening on the preview URL's port right now. */
  serving: boolean;
  /** The newest line of the worktree's drop file (CREW-2874), read at report time; null when nothing was pointed at. */
  pointedAt: PointedAt | null;
}

const dirOf = (stateDir: string) => join(stateDir, 'periscopes');
const fileOf = (stateDir: string, ticketRecordId: string) => join(dirOf(stateDir), `${ticketRecordId}.json`);

export function writePeriscopeSidecar(stateDir: string, sc: PeriscopeSidecar): void {
  mkdirSync(dirOf(stateDir), { recursive: true });
  writeFileSync(fileOf(stateDir, sc.ticketRecordId), `${JSON.stringify(sc, null, 2)}\n`);
}

/** Merges `patch` into a periscope's sidecar; a no-op when there is none. Returns the result. */
export function updatePeriscopeSidecar(stateDir: string, ticketRecordId: string, patch: Partial<PeriscopeSidecar>): PeriscopeSidecar | undefined {
  const sc = readPeriscopeSidecars(stateDir).find((x) => x.ticketRecordId === ticketRecordId);
  if (!sc) return undefined;
  const next = { ...sc, ...patch };
  for (const k of Object.keys(patch) as Array<keyof PeriscopeSidecar>) if (patch[k] === undefined) delete next[k];
  writePeriscopeSidecar(stateDir, next);
  return next;
}

export function removePeriscopeSidecar(stateDir: string, ticketRecordId: string): void {
  rmSync(fileOf(stateDir, ticketRecordId), { force: true });
}

/** Every sidecar on this ship, oldest first; an unreadable file is skipped. */
export function readPeriscopeSidecars(stateDir: string): PeriscopeSidecar[] {
  const dir = dirOf(stateDir);
  if (!existsSync(dir)) return [];
  const out: PeriscopeSidecar[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const sc = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PeriscopeSidecar;
      if (sc && typeof sc.ticketRecordId === 'string' && typeof sc.url === 'string') out.push(sc);
    } catch { /* half-written or hand-edited: not a periscope we can report */ }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The port a preview URL is served on (the scheme's default when none is named); undefined for a non-URL. */
export function urlPort(url: string): number | undefined {
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    return undefined;
  }
}

/** True when something accepts a TCP connection on `host` at `port`. */
function hostListening(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * True when something accepts a TCP connection on `port` of this machine, on
 * either loopback family. A dev server or proxy bound to `localhost` may
 * resolve to `::1` only, so IPv4 alone reports a live periscope as down.
 * This is the single probe behind both `crew status` and `crew periscope list`.
 */
export async function portListening(port: number, timeoutMs = 500): Promise<boolean> {
  if (await hostListening(port, '127.0.0.1', timeoutMs)) return true;
  return hostListening(port, '::1', timeoutMs);
}

/** Live periscopes with `serving` probed now. `probe` is injectable for tests. */
export async function periscopesForStatus(
  stateDir: string,
  probe: (port: number) => Promise<boolean> = portListening,
): Promise<PeriscopeStatus[]> {
  return Promise.all(readPeriscopeSidecars(stateDir).map(async (sc) => {
    const port = urlPort(sc.localUrl ?? sc.url);
    return { ...sc, serving: port === undefined ? false : await probe(port), pointedAt: readPointedAt(sc.worktree) };
  }));
}
