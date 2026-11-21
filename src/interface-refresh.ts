/**
 * Re-resolve the interface-derived part of a route's snapshot (CREW-3922).
 *
 * `crew connect` resolves the ids of the app's optional tables (Maps, Questions,
 * Answers, ...), the `contract` and `trackerInterface` once. A route connected
 * before the app declared its interface, or before crew knew a part, kept
 * reading by default names: `crew ask` found no questions ids and wrote nothing.
 * This brings those fields up to the app's current declaration without a full
 * connect. It touches nothing else in the file (seats, holds, release seat,
 * keys, personas, skills, repos) and writes nothing to the tracker.
 *
 * The decision is pure (`planRefresh`); `applyRefresh` is the one file write.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ResolvedIds, Route, Ship } from './config.ts';
import { resolvedPathFor } from './config.ts';
import { DEFAULT_CONTRACT, type Contract } from './contract.ts';
import { contractFromMapping, mappedTableName, questionsPartMapped, versionLabel } from './tracker-interface.ts';
import { getterFor, mappingKey, readForRoute, type InterfaceState } from './tracker-interface-read.ts';

type Declared = Extract<InterfaceState, { kind: 'declared' }>;

/** Optional tables resolved through the mapping, and the snapshot key each lands in. */
const OPTIONAL_TABLES = [
  ['ships', 'shipsModelId'], ['epics', 'epicsModelId'], ['maps', 'mapsModelId'],
  ['periscopes', 'periscopesModelId'], ['locks', 'locksModelId'],
] as const;

export interface RefreshPatch {
  trackerInterface: { declared: true; version: string; mappingKey: string };
  contract: Partial<Contract>;
  models?: Partial<Record<'issues' | 'comments' | 'crew', string>>;
  mapsModelId?: string; shipsModelId?: string; epicsModelId?: string; periscopesModelId?: string; locksModelId?: string;
  questionsModelId?: string; answersModelId?: string;
}

/** True when the app's declaration is one crew reads and the snapshot may be re-resolved from it. */
export function refreshable(state: InterfaceState): state is Declared {
  return state.kind === 'declared' && state.accepted && state.conforms !== false;
}

/** Cheap check, no tracker read: does the stored snapshot already match this declaration? */
export function snapshotCurrent(resolved: ResolvedIds | undefined, state: Declared): boolean {
  if (!resolved?.trackerInterface || resolved.trackerInterface.mappingKey !== mappingKey(state.mapping)) return false;
  // A snapshot written by a crew that did not know the questions part carries the same mapping key.
  return !questionsPartMapped(state.mapping) || (!!resolved.questionsModelId && !!resolved.answersModelId);
}

/**
 * What a fresh connect would store for the interface-derived fields, given the
 * project's tables as listed now. A mapped table that is not found leaves the
 * stored id alone rather than blanking it.
 */
export function planRefresh(
  resolved: ResolvedIds, state: Declared, models: Array<{ id: string; name: string }>,
): RefreshPatch {
  const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const idOf = (role: string): string | undefined => {
    const name = mappedTableName(state.mapping, role);
    return name ? models.find((m) => eq(m.name, name))?.id : undefined;
  };
  const declaredContract = contractFromMapping(DEFAULT_CONTRACT, state.mapping);
  // Keep every status the operator classified as resolved at connect: the app's list plus what is stored.
  const resolvedStatuses = [...new Set([...declaredContract.statuses.resolved, ...(resolved.contract?.statuses?.resolved ?? [])])];
  const patch: RefreshPatch = {
    trackerInterface: { declared: true, version: versionLabel(state.version), mappingKey: mappingKey(state.mapping) },
    contract: { ...declaredContract, statuses: { ...declaredContract.statuses, resolved: resolvedStatuses } },
  };
  const required: NonNullable<RefreshPatch['models']> = {};
  for (const role of ['issues', 'comments', 'crew'] as const) {
    const id = idOf(role);
    if (id) required[role] = id;
  }
  if (Object.keys(required).length > 0) patch.models = required;
  for (const [role, key] of OPTIONAL_TABLES) {
    const id = idOf(role);
    if (id) patch[key] = id;
  }
  if (questionsPartMapped(state.mapping)) {
    const q = idOf('questions');
    const a = idOf('answers');
    if (q && a) { patch.questionsModelId = q; patch.answersModelId = a; }
  }
  return patch;
}

/** The file's contents with the patch laid over it. Only the patched keys change. */
export function mergePatch(raw: Record<string, unknown>, patch: RefreshPatch): Record<string, unknown> {
  const { models, ...rest } = patch;
  const out: Record<string, unknown> = { ...raw, ...rest };
  if (models) out['models'] = { ...(raw['models'] as Record<string, unknown> | undefined), ...models };
  return out;
}

/** The same patch laid over a parsed route, for the process that is still running. */
export function applyToRoute(route: Route, patch: RefreshPatch): void {
  const { models, contract, trackerInterface, ...ids } = patch;
  route.resolved = {
    ...route.resolved!, ...ids, trackerInterface,
    contract: contract as ResolvedIds['contract'],
    ...(models ? { models: { ...route.resolved!.models, ...models } } : {}),
  };
  route.contract = contract;
}

/**
 * Declarations this process already tried to resolve, by route and mapping key.
 * A mapped table that is not in the project can never be found by listing again,
 * so a snapshot that stays incomplete is retried once per process, not per cycle.
 */
const attempted = new Set<string>();

/**
 * Re-resolve and, unless `write` is false, rewrite the route's resolved file
 * (atomic rename, `.bak` kept like connect does). Updates `route` in memory
 * either way. Returns the patch, or null when nothing needed doing or the
 * tables could not be listed.
 */
export async function refreshInterfaceSnapshot(
  o: { route: Route; stateDir: string; write?: boolean },
  state: InterfaceState,
  listModels: () => Promise<Array<{ id: string; name: string }>>,
): Promise<RefreshPatch | null> {
  const r = o.route.resolved;
  if (!r || !refreshable(state) || snapshotCurrent(r, state)) return null;
  const attemptKey = `${o.stateDir}|${o.route.route}|${mappingKey(state.mapping)}`;
  if (attempted.has(attemptKey)) return null;
  let models: Array<{ id: string; name: string }>;
  try { models = await listModels(); } catch { return null; }
  attempted.add(attemptKey);
  const patch = planRefresh(r, state, models);
  if (o.write !== false) {
    const path = resolvedPathFor(o.stateDir, o.route.route);
    if (!existsSync(path)) return null;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
    const next = `${JSON.stringify(mergePatch(raw, patch), null, 2)}\n`;
    // Nothing new to store: no rewrite (it would restart the daemon) and no .bak.
    if (next === readFileSync(path, 'utf8')) return null;
    copyFileSync(path, `${path}.bak`);
    const tmp = `${path}.tmp${process.pid}`;
    writeFileSync(tmp, next);
    renameSync(tmp, path);
  }
  applyToRoute(o.route, patch);
  return patch;
}

/**
 * The route's live declaration, re-resolved into its snapshot. `state` is the
 * read the caller already made (the poll's); `crew ask` passes none and reads
 * once. Returns true when the snapshot changed.
 */
export async function refreshForRoute(
  route: Route, ship: Ship, write: boolean, state?: InterfaceState,
): Promise<boolean> {
  const live = state ?? await readForRoute(route, ship);
  const projectId = route.resolved?.projectId;
  if (!projectId) return false;
  const get = getterFor(route, ship);
  const patch = await refreshInterfaceSnapshot(
    { route, stateDir: ship.stateDir, write }, live,
    () => get<Array<{ id: string; name: string }>>(`/data-models?projectId=${projectId}`),
  );
  return patch !== null;
}
