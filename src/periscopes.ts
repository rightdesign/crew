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
