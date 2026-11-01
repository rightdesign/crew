/**
 * Periscope settings as `crew status` and `crew doctor` report them
 * (EPIC-077). The config shapes live in config.ts; this is only the
 * read-side: which routes host periscopes, and whether the host a Passenger
 * would be sent to is set and resolves.
 */
import { lookup } from 'node:dns/promises';
import type { CrewConfig } from './config.ts';

export function periscopeRoutes(cfg: Pick<CrewConfig, 'routes'>): string[] {
  return cfg.routes.filter((r) => r.enabled && r.hostPeriscopes).map((r) => r.route);
}

/** The one-line summary `crew status` prints in the ship block. */
export function periscopeSummary(cfg: Pick<CrewConfig, 'routes' | 'ship'>): string {
  const routes = periscopeRoutes(cfg);
  const limits = `max ${cfg.ship.maxPeriscopes}, idle ${cfg.ship.periscopeIdleMinutes} min`;
  if (routes.length === 0) return `off (no enabled route sets hostPeriscopes: true; ${limits})`;
  return `ON for ${routes.join(', ')} (host ${cfg.ship.previewHost ?? 'NOT SET (ship.previewHost)'}, ${limits})`;
}

/** What doctor finds wrong with the preview host; undefined when fine or periscopes are off. */
export async function previewHostProblem(
  cfg: Pick<CrewConfig, 'routes' | 'ship'>,
  resolve: (host: string) => Promise<unknown> = (h) => lookup(h),
): Promise<string | undefined> {
  if (periscopeRoutes(cfg).length === 0) return undefined;
  const host = cfg.ship.previewHost;
  if (!host) return 'ship.previewHost is not set — a route hosts periscopes, so Passengers have no host to be sent to';
  try {
    await resolve(host);
  } catch {
    return `ship.previewHost "${host}" does not resolve from this machine`;
  }
  return undefined;
}

export interface PeriscopeProblem {
  severity: 'blocker' | 'attention' | 'note';
  kind: 'preview_hook_missing' | 'periscopes_table_missing' | 'preview_host_unresolvable' | 'preview_host';
  route?: string;
  repo?: string;
  message: string;
}

/**
 * What doctor reports about hosting on one route (CREW-2857). A repository with
 * no `preview` hook is only a note (it just cannot be opened); a missing
 * Periscopes table is a blocker for hosting only, never for the rest of the crew.
 */
export function routePeriscopeProblems(o: {
  route: string;
  hosts: boolean;
  repos: { name: string; hasPreviewHook: boolean }[];
  /** undefined when the table was not checked (offline). */
  tablePresent?: boolean;
}): PeriscopeProblem[] {
  if (!o.hosts) return [];
  const out: PeriscopeProblem[] = [];
  for (const r of o.repos) {
    if (!r.hasPreviewHook) {
      out.push({ severity: 'note', kind: 'preview_hook_missing', route: o.route, repo: r.name,
        message: `${o.route}/${r.name}: hostPeriscopes is on but ${r.name} declares no \`preview\` hook, so it cannot be opened as a periscope` });
    }
  }
  if (o.tablePresent === false) {
    out.push({ severity: 'blocker', kind: 'periscopes_table_missing', route: o.route,
      message: `${o.route}: hostPeriscopes is on but this workspace has no Periscopes table — update the Issues template and run \`crew connect\`` });
  }
  return out;
}

/** A preview host problem as a doctor finding: an unset host blocks hosting, one that does not resolve is attention. */
export function previewHostFinding(message: string): PeriscopeProblem {
  return /does not resolve/.test(message)
    ? { severity: 'attention', kind: 'preview_host_unresolvable', message }
    : { severity: 'blocker', kind: 'preview_host', message };
}
