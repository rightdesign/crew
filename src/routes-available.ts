import { resolveApiKey, siblingRouteKey, splitRoute, type Route } from './config.ts';
import { versionAccepted, acceptedLabel } from './tracker-interface.ts';

/** One tracker app as `GET /auth/my-tracker-apps` reports it (the platform leaves version judgment to us). */
interface PlatformApp {
  workspace: { path: string; slug: string; name: string; role: string };
  project: { slug: string; name: string };
  interfaceVersion: { major: number; minor: number } | null;
}

export interface AvailableRoute {
  route: string;
  workspace: { address: string; name: string; role: string };
  project: { slug: string; name: string };
  /** Whether this crew accepts the declared work tracker interface version; an app that declares nothing is accepted. */
  accepted: boolean;
  /** True when connecting would start a device approval: no held credential and no configured route in that workspace to borrow a key from. */
  needsSignIn: boolean;
}

export type HostAvailable =
  | { host: string; identity: { email: string | null }; routes: AvailableRoute[] }
  | { host: string; error: string; reason: 'unsupported' | 'rejected' | 'no_key' | 'failed' };

export interface RoutesAvailableDeps {
  fetch?: typeof fetch;
  userAgent?: string;
  hostOf: (baseUrl: string) => string;
  /** Whether this machine holds a credential for the host and workspace address (the keychain read connect makes). */
  holdsCredential: (host: string, workspaceAddress: string) => Promise<boolean>;
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * `crew routes available` (CREW-3915, EPIC-104 Map §6). Read-only: only GETs, no device approval,
 * nothing written. One platform read per distinct host, made with the key of a route on that host;
 * a rejected key falls through to the next route on the host.
 */
export async function buildRoutesAvailable(routes: Route[], deps: RoutesAvailableDeps): Promise<HostAvailable[]> {
  const doFetch = deps.fetch ?? fetch;
  const hosts = new Map<string, Route[]>();
  for (const r of routes) {
    const h = deps.hostOf(r.baseUrl);
    hosts.set(h, [...(hosts.get(h) ?? []), r]);
  }
  const existing = new Set(routes.map((r) => {
    const [ws, proj] = splitRoute(r.route);
    return `${deps.hostOf(r.baseUrl)}|${lower(ws)}|${lower(proj)}`;
  }));
  const get = (r: Route, key: string, path: string) => doFetch(`${r.baseUrl.replace(/\/+$/, '')}/api${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': deps.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  });

  return Promise.all([...hosts].map(async ([host, hostRoutes]): Promise<HostAvailable> => {
    let keyed = 0;
    for (const r of hostRoutes) {
      let key: string;
      try { key = resolveApiKey(r); } catch { continue; }
      keyed++;
      let res: Response;
      try { res = await get(r, key, '/auth/my-tracker-apps'); } catch (e) {
        return { host, error: (e as Error).message, reason: 'failed' };
      }
      if (res.status === 401 || res.status === 403) continue;
      if (res.status === 404) return { host, error: 'this Tablation host does not offer the tracker app list yet', reason: 'unsupported' };
      if (!res.ok) return { host, error: `/auth/my-tracker-apps answered HTTP ${res.status}`, reason: 'failed' };
      const apps = ((await res.json()) as { apps?: PlatformApp[] } | PlatformApp[]);
      const list = Array.isArray(apps) ? apps : apps.apps ?? [];
      let email: string | null = null;
      try {
        const me = await get(r, key, '/auth/me');
        if (me.ok) email = ((await me.json()) as { email?: string }).email ?? null;
      } catch { /* the identity is a nicety */ }
      const signIn = new Map<string, boolean>();
      const out: AvailableRoute[] = [];
      for (const a of list) {
        const address = a.workspace.path || a.workspace.slug;
        if (existing.has(`${host}|${lower(address)}|${lower(a.project.slug)}`)) continue;
        if (!signIn.has(address)) {
          const sibling = siblingRouteKey(hostRoutes, host, (w) => lower(w) === lower(address), deps.hostOf);
          signIn.set(address, !sibling && !(await deps.holdsCredential(host, address).catch(() => false)));
        }
        out.push({
          route: `${address}/${a.project.slug}`,
          workspace: { address, name: a.workspace.name, role: a.workspace.role },
          project: { slug: a.project.slug, name: a.project.name },
          accepted: a.interfaceVersion === null || versionAccepted(a.interfaceVersion),
          needsSignIn: signIn.get(address)!,
        });
      }
      return { host, identity: { email }, routes: out };
    }
    return keyed === 0
      ? { host, error: 'no route on this host has a usable key', reason: 'no_key' }
      : { host, error: 'every key on this host was rejected', reason: 'rejected' };
  }));
}

export function formatRoutesAvailable(report: HostAvailable[], hadRoutes: boolean): string {
  if (!hadRoutes) return 'No routes are configured, so there is nothing to list from. `crew connect` is the first-run path.\n';
  const lines: string[] = [];
  let any = false;
  for (const h of report) {
    if ('error' in h) { lines.push(`${h.host}: ${h.error}`); continue; }
    if (report.length > 1) lines.push(`${h.host}${h.identity.email ? ` (${h.identity.email})` : ''}`);
    const byWs = new Map<string, AvailableRoute[]>();
    for (const r of h.routes) byWs.set(r.workspace.address, [...(byWs.get(r.workspace.address) ?? []), r]);
    for (const [, rs] of [...byWs].sort((a, b) => a[1][0]!.workspace.name.localeCompare(b[1][0]!.workspace.name))) {
      any = true;
      lines.push(rs[0]!.workspace.name);
      for (const r of rs.sort((a, b) => a.project.name.localeCompare(b.project.name))) {
        const marks = [!r.accepted ? `needs a newer crew (accepts ${acceptedLabel()})` : '', r.needsSignIn ? 'sign-in needed' : ''].filter(Boolean);
        lines.push(`  ${r.project.name}  ${r.route}${marks.length ? `  [${marks.join('; ')}]` : ''}`);
      }
    }
  }
  if (!any && report.some((h) => !('error' in h))) lines.push('Every tracker app you can reach is already routed on this machine.');
  if (any) lines.push('', 'Add one with `crew connect <route>`.');
  return `${lines.join('\n')}\n`;
}
