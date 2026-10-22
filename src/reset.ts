/**
 * `crew disconnect --reset` (CREW-2243): removes everything `connect` and
 * `install` wrote on this machine, in one step, so the app's "Start over"
 * (and a person) can return to a first-run state.
 *
 * Order matters and is fixed: scheduler units first (nothing may wake mid-reset),
 * then the Pair/MCP entries, then the seat keys (revoked server-side with the
 * workspace credential, so that credential must still exist), then the
 * workspace credential itself, then — only with `--remove-checkouts` — the
 * checkouts crew cloned, then the resolved state, and `crew.yaml` last, so an
 * interrupted reset leaves a config that still points at what remains and can
 * simply be run again.
 *
 * Server rows (Ships, Crew, Repos) are never touched. Every effect is injected
 * (`ResetEffects`) so a test never reaches a real keychain, launchd or git.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Route } from './config.ts';

export type ResetAction = 'removed' | 'would-remove' | 'absent' | 'kept' | 'failed';

export interface ResetStep {
  /** Which part of the order this belongs to. */
  step: 'scheduler' | 'pair' | 'seat-keys' | 'credential' | 'checkout' | 'state' | 'config';
  target: string;
  action: ResetAction;
  detail?: string;
}

/** Where the directories crew itself cloned are recorded, so `--remove-checkouts` never guesses. */
export function clonedCheckoutsFile(stateDir: string): string {
  return join(stateDir, 'cloned-checkouts.json');
}

export function readClonedCheckouts(stateDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(clonedCheckoutsFile(stateDir), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** Called from `ensureRepoCheckout` when it actually clones; a checkout attached from elsewhere never lands here. */
export function recordClonedCheckout(stateDir: string, dir: string): void {
  const known = readClonedCheckouts(stateDir);
  if (known.includes(dir)) return;
  const file = clonedCheckoutsFile(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify([...known, dir], null, 2)}\n`);
}

export interface ResetEffects {
  /** Unload and remove every scheduler unit for this checkout; returns the lines it printed. */
  uninstallUnits(dryRun: boolean): Promise<string[]> | string[];
  /** Remove the MCP entry and Pair block for one server URL, for every harness; returns the lines it printed. */
  removePair(baseUrl: string, dryRun: boolean): string[];
  /** Revoke one route's seat keys server-side and from the keychain; `ok` is false when any key is left behind. */
  revokeSeatKeys(route: Route, dryRun: boolean): Promise<Array<{ line: string; ok: boolean }>>;
  /** The workspace credential for a route: whether one is stored, and how to delete it. */
  credential(route: Pick<Route, 'route' | 'baseUrl'>): Promise<{ stored: boolean; clear(): Promise<void> }>;
  /** `git status --porcelain` for a checkout, plus its linked worktrees (other than the checkout itself). */
  inspectCheckout(dir: string): { dirty: string[]; linkedWorktrees: string[] };
}

export interface ResetOptions {
  routes: Route[];
  /**
   * Routes crew.yaml declares that did not load (an interrupted first run never
   * resolved their ids). They have no seat keys, but sign-in may already have
   * stored a workspace credential for them.
   */
  droppedRoutes?: Array<Pick<Route, 'route' | 'baseUrl'>>;
  stateDir: string;
  configFile: string;
  dryRun: boolean;
  removeCheckouts: boolean;
}

const mark = (dryRun: boolean): ResetAction => (dryRun ? 'would-remove' : 'removed');

export async function runReset(o: ResetOptions, fx: ResetEffects): Promise<ResetStep[]> {
  const steps: ResetStep[] = [];

  for (const line of await fx.uninstallUnits(o.dryRun)) steps.push({ step: 'scheduler', target: line, action: mark(o.dryRun) });

  const urls = [...new Set(o.routes.map((r) => r.baseUrl))];
  for (const url of urls) {
    for (const line of fx.removePair(url, o.dryRun)) steps.push({ step: 'pair', target: line, action: mark(o.dryRun) });
  }

  for (const route of o.routes) {
    for (const r of await fx.revokeSeatKeys(route, o.dryRun)) {
      steps.push({ step: 'seat-keys', target: `${route.route}: ${r.line}`, action: r.ok ? mark(o.dryRun) : 'failed' });
    }
  }

  for (const route of [...o.routes, ...(o.droppedRoutes ?? [])]) {
    try {
      const cred = await fx.credential(route);
      if (!cred.stored) { steps.push({ step: 'credential', target: route.route, action: 'absent', detail: 'no workspace credential in the keychain' }); continue; }
      if (!o.dryRun) await cred.clear();
      steps.push({ step: 'credential', target: route.route, action: mark(o.dryRun), detail: 'workspace credential in the keychain' });
    } catch (e) {
      steps.push({ step: 'credential', target: route.route, action: 'failed', detail: (e as Error).message });
    }
  }

  // Read the record before the state directory goes: it lives there.
  if (o.removeCheckouts) {
    for (const dir of readClonedCheckouts(o.stateDir)) steps.push(removeCheckout(dir, o.dryRun, fx));
  }

  steps.push(...removeState(o.stateDir, o.dryRun));

  if (existsSync(o.configFile)) {
    if (!o.dryRun) rmSync(o.configFile, { force: true });
    steps.push({ step: 'config', target: o.configFile, action: mark(o.dryRun) });
  } else {
    steps.push({ step: 'config', target: o.configFile, action: 'absent' });
  }
  return steps;
}

function removeCheckout(dir: string, dryRun: boolean, fx: ResetEffects): ResetStep {
  if (!existsSync(dir)) return { step: 'checkout', target: dir, action: 'absent', detail: 'already gone' };
  const { dirty, linkedWorktrees } = fx.inspectCheckout(dir);
  if (dirty.length) {
    return { step: 'checkout', target: dir, action: 'kept', detail: `has uncommitted changes (${dirty.length} path${dirty.length === 1 ? '' : 's'}: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''})` };
  }
  if (linkedWorktrees.length) {
    return { step: 'checkout', target: dir, action: 'kept', detail: `has linked worktrees (${linkedWorktrees.join(', ')}); remove them first` };
  }
  if (!dryRun) rmSync(dir, { recursive: true, force: true });
  return { step: 'checkout', target: dir, action: mark(dryRun) };
}

/**
 * The resolved ids, the connect-written key files, the clone record and the
 * sentinels and locks (every dot-file at the top of the state directory).
 * Logs, events and stream artifacts stay: they are history, not configuration.
 */
function removeState(stateDir: string, dryRun: boolean): ResetStep[] {
  const out: ResetStep[] = [];
  const targets = [join(stateDir, 'resolved'), join(stateDir, 'keys'), clonedCheckoutsFile(stateDir), join(stateDir, 'connect-session.json'), join(stateDir, 'reload-requested'), join(stateDir, 'daemon.started')];
  try {
    for (const name of readdirSync(stateDir)) {
      if (name.startsWith('.') && statSync(join(stateDir, name)).isFile()) targets.push(join(stateDir, name));
    }
  } catch { /* no state directory: nothing to remove */ }
  for (const t of targets) {
    if (!existsSync(t)) continue;
    if (!dryRun) rmSync(t, { recursive: true, force: true });
    out.push({ step: 'state', target: t, action: mark(dryRun) });
  }
  if (!out.length) out.push({ step: 'state', target: stateDir, action: 'absent', detail: 'nothing to remove' });
  return out;
}

export function describeResetStep(s: ResetStep): string {
  const verb = { removed: 'removed', 'would-remove': 'would remove', absent: 'nothing to remove', kept: 'KEPT', failed: 'FAILED' }[s.action];
  return `${s.step}: ${verb}: ${s.target}${s.detail ? ` (${s.detail})` : ''}`;
}

/** Exit status: nonzero when anything was kept or failed, so a caller (the app) knows the machine is not clean. */
export function resetIncomplete(steps: ResetStep[]): boolean {
  return steps.some((s) => s.action === 'failed' || s.action === 'kept');
}
