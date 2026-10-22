import type { Route } from './config.ts';
import { credentialSource, resolveApiKey } from './config.ts';

/** What `crew whoami` reports for one route. */
export type WhoamiEntry =
  | {
    route: string;
    ok: true;
    identity: { id: string | null; email: string | null; name: string | null };
    /** The key's role in the route's workspace (`/auth/me?workspaceId=`). */
    role: string | null;
    /** The Crew row `connect` linked as this ship's operator; `name` is null when the Crew table could not be read. */
    operator: { id: string | null; name: string | null };
    credential: ReturnType<typeof credentialSource>;
  }
  | { route: string; ok: false; error: string; credential: ReturnType<typeof credentialSource> };

export interface WhoamiDeps {
  fetch?: typeof fetch;
  userAgent?: string;
  /** Name of a Crew row, best effort; a failure leaves the operator unnamed. */
  operatorName?: (route: Route, id: string) => Promise<string | null | undefined>;
}

/**
 * CREW-2350: one `/auth/me` call per route with the route's own key. Writes
 * nothing and never prints the key; a failure is reported for that route
 * alone (a 401/403 as a one-line reason) so one dead key hides no other.
 */
export async function buildWhoami(routes: Route[], deps: WhoamiDeps = {}): Promise<WhoamiEntry[]> {
  const doFetch = deps.fetch ?? fetch;
  return Promise.all(routes.map(async (route): Promise<WhoamiEntry> => {
    const credential = credentialSource(route);
    try {
      const key = resolveApiKey(route);
      const q = route.resolved ? `?workspaceId=${encodeURIComponent(route.resolved.workspaceId)}` : '';
      const res = await doFetch(`${route.baseUrl.replace(/\/+$/, '')}/api/auth/me${q}`, {
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': deps.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
      });
      if (res.status === 401 || res.status === 403) {
        return { route: route.route, ok: false, credential, error: `key rejected by ${route.baseUrl} (HTTP ${res.status}): expired or revoked, re-run crew connect` };
      }
      if (!res.ok) return { route: route.route, ok: false, credential, error: `/auth/me answered HTTP ${res.status}` };
      const me = (await res.json()) as { id?: string; email?: string; name?: string; role?: string };
      const operatorId = route.resolved?.operator ?? null;
      let operatorName: string | null = null;
      if (operatorId && deps.operatorName) {
        try { operatorName = (await deps.operatorName(route, operatorId)) ?? null; } catch { /* unnamed */ }
      }
      return {
        route: route.route, ok: true, credential,
        identity: { id: me.id ?? null, email: me.email ?? null, name: me.name ?? null },
        role: typeof me.role === 'string' ? me.role : null,
        operator: { id: operatorId, name: operatorName },
      };
    } catch (e) {
      return { route: route.route, ok: false, credential, error: (e as Error).message };
    }
  }));
}

export function formatWhoami(report: WhoamiEntry[]): string {
  const lines: string[] = [];
  for (const r of report) {
    lines.push(`route ${r.route}`);
    if (!r.ok) { lines.push(`  error: ${r.error}`, `  credential: ${r.credential}`); continue; }
    const who = [r.identity.name, r.identity.email ? `<${r.identity.email}>` : null].filter(Boolean).join(' ');
    lines.push(`  signed in as: ${who || r.identity.id || '(unknown)'}${r.identity.id ? ` (${r.identity.id})` : ''}`);
    lines.push(`  role: ${r.role ?? '(unknown)'}`);
    lines.push(`  operator: ${r.operator.id ? `${r.operator.name ?? '(unnamed)'} (${r.operator.id})` : '(not linked)'}`);
    lines.push(`  credential: ${r.credential}`);
  }
  return `${lines.join('\n')}\n`;
}
