/**
 * `crew doctor --fix` (CREW-1288): the opt-in action phase after doctor's
 * read-only report. Carries a new operator from "wizard done" to "ship
 * installed and idle" without hand-editing YAML.
 *
 * Pure planning only — a report in, a list of actions out, and text in/text
 * out for the one yaml edit — so it is tested without a disk, a terminal or a
 * scheduler. `cli.ts` gathers the facts, asks the operator, and applies.
 */

import { parseDocument } from 'yaml';
import { routeMapOf } from './repos-cmd.ts';
import type { InstallPlan } from './install.ts';

/** What doctor learned about one loaded route. */
export interface RouteHealth {
  route: string;
  enabled: boolean;
  /** At least one checkout (`dir`/`repos`) is configured. */
  hasRepos: boolean;
  /** Every failed check, as the line doctor prints for it. Empty = clean. */
  problems: string[];
}

export type FixAction =
  | { kind: 'enable'; route: string }
  | { kind: 'install' };

export interface FixPlan {
  actions: FixAction[];
  /** Lines to print when there is something to say but nothing to offer (Windows). */
  notes: string[];
}

export interface FixFacts {
  routes: RouteHealth[];
  /** No scheduler unit for this ship's `run` job is installed/loaded. */
  schedulerAbsent: boolean;
  host: 'macos' | 'linux' | 'windows';
}

const sound = (r: RouteHealth) => r.hasRepos && r.problems.length === 0;

/**
 * A route is only offered for enabling when it passes every check, has a
 * checkout, and is currently off. A route that fails a check is never
 * enabled — doctor reports it as it always has. `install` is recommended
 * once at least one route is (or is about to be) enabled and sound.
 */
export function planFix(f: FixFacts): FixPlan {
  const actions: FixAction[] = [];
  const notes: string[] = [];
  for (const r of f.routes) {
    if (!r.enabled && sound(r)) actions.push({ kind: 'enable', route: r.route });
  }
  if (f.schedulerAbsent && f.routes.some(sound)) {
    // Every sound route is either enabled already or offered for enabling above.
    if (f.host === 'windows') notes.push('scheduler support is not built for Windows yet — nothing to install; run `crew run` by hand');
    else actions.push({ kind: 'install' });
  }
  return { actions, notes };
}

/**
 * Gather one route's health. A check that cannot even run (a route not yet
 * connected, so its tracker cannot be built) is a failed check for THAT route
 * — reported and never enabled — not a reason to abort the fix for the rest.
 */
export async function gatherHealth(
  c: { route: string; enabled: boolean; hasRepos: boolean },
  check: () => Promise<string[]>,
): Promise<RouteHealth> {
  let problems: string[];
  try {
    problems = await check();
  } catch (e) {
    problems = [`checks could not run: ${e instanceof Error ? e.message : String(e)}`];
  }
  return { route: c.route, enabled: c.enabled, hasRepos: c.hasRepos, problems };
}

/** `crew doctor <route> --fix` considers only the named route; with none named, every route. */
export function routesInScope<T extends { route: string }>(routes: T[], named: string | undefined): T[] {
  return named ? routes.filter((r) => r.route === named) : routes;
}

/** Set `enabled: true` on one route, leaving every other key, comment and route as written. */
export function planEnable(text: string, route: string): string {
  const doc = parseDocument(text);
  routeMapOf(doc, route).set('enabled', true);
  return String(doc);
}

/**
 * Whether the `run` job is already scheduled. Unit-file hosts (launchd,
 * systemd) are judged by their unit paths; cron by its marker in the
 * user's crontab. `crontab` is passed in so this stays pure.
 */
export function schedulerInstalled(plan: InstallPlan, exists: (p: string) => boolean, crontab: string): boolean {
  if (plan.mechanism === 'cron') return plan.cronMarker !== null && crontab.includes(plan.cronMarker);
  return plan.unitPaths.length > 0 && plan.unitPaths.every(exists);
}
