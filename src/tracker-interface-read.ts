/**
 * Reading what the app declares about the work tracker interface (CREW-3579),
 * and the per-cycle check built on it.
 *
 * `readInterfaceState` asks the platform which apps in the workspace implement
 * `work-tracker` (the platform's find operation) and, for this route's app,
 * for the declaration's conformance. `checkTrackerInterface` turns that into
 * ship attention the way `checkCrewFloor` does for the crew version: one item
 * per condition, not repeated while open, cleared the cycle it is resolved.
 */

import type { Route, Ship } from './config.ts';
import { resolveApiKey } from './config.ts';
import {
  clearShipAttention, raiseShipAttention, type RaiseOptions, type ShipAttentionItem,
} from './ship-attention.ts';
import {
  ALLOW_UNDECLARED_TRACKER_APPS, TRACKER_INTERFACE_NAME, acceptedLabel, describeDifferences, sideToUpdate,
  versionAccepted, versionLabel,
  type InterfaceMapping, type InterfaceVersion, type UnmetRoleLike,
} from './tracker-interface.ts';

/**
 * The legacy ship-wide keys. Items are keyed per route now (CREW-3643); these
 * remain as the base of the new keys and so the checker can drop any item an
 * older crew left open under them.
 */
export const INTERFACE_MISMATCH_KEY = 'tracker_interface';
export const INTERFACE_UNDECLARED_KEY = 'tracker_interface_undeclared';
export const INTERFACE_OVERRIDE_KEY = `${INTERFACE_MISMATCH_KEY}_override`;

/** One item per route and condition, so one route's clean read never closes another's item. */
export const interfaceKey = (base: string, route: string): string => `${base}:${route}`;

const routeLabel = (route: string): string => `route ${route}: `;

export type Getter = <T>(path: string) => Promise<T>;

export type InterfaceState =
  | { kind: 'undeclared' }
  /** The platform could not be asked (offline, or a failure other than "the feature is absent"). */
  | { kind: 'unreadable' }
  | {
      kind: 'declared';
      version: InterfaceVersion;
      accepted: boolean;
      mapping: InterfaceMapping;
      /** Null when the platform would not show conformance to this key (it needs a workspace admin). */
      conforms: boolean | null;
      unmet: UnmetRoleLike[];
    };

interface Implementer {
  project: { id: string };
  interfaceName: string;
  version: InterfaceVersion;
  mapping: Partial<InterfaceMapping>;
}
interface DeclarationRow { name: string; conforms: boolean; unmet: UnmetRoleLike[] }

function statusOf(e: unknown): number | undefined {
  return typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;
}

/** Every app in the workspace declaring the interface, at any version. */
export async function findImplementers(get: Getter, workspaceId: string): Promise<Implementer[] | 'unreadable'> {
  try {
    return await get<Implementer[]>(
      `/app-interfaces/implementers?workspaceId=${encodeURIComponent(workspaceId)}&name=${encodeURIComponent(TRACKER_INTERFACE_NAME)}`);
  } catch (e) {
    // A platform that predates app interfaces has no such route: nothing is declared there.
    if (statusOf(e) === 404) return [];
    return 'unreadable';
  }
}

export async function readInterfaceState(get: Getter, workspaceId: string, projectId: string): Promise<InterfaceState> {
  const found = await findImplementers(get, workspaceId);
  if (found === 'unreadable') return { kind: 'unreadable' };
  const mine = found.find((i) => i.project.id === projectId && i.interfaceName === TRACKER_INTERFACE_NAME);
  if (!mine) return { kind: 'undeclared' };
  const mapping: InterfaceMapping = {
    tables: { ...mine.mapping.tables }, fields: { ...mine.mapping.fields }, values: { ...mine.mapping.values },
  };
  const accepted = versionAccepted(mine.version);
  let conforms: boolean | null = null;
  let unmet: UnmetRoleLike[] = [];
  try {
    const rows = await get<DeclarationRow[]>(`/projects/${encodeURIComponent(projectId)}/interfaces`);
    const row = rows.find((r) => r.name === TRACKER_INTERFACE_NAME);
    if (row) { conforms = row.conforms; unmet = row.unmet ?? []; }
  } catch { /* conformance is shown to workspace admins only; the mapping alone still reads */ }
  return { kind: 'declared', version: mine.version, accepted, mapping, conforms, unmet };
}

export function mappingKey(m: InterfaceMapping): string {
  return JSON.stringify([m.tables, m.fields, m.values], (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v);
}

// ---- the messages --------------------------------------------------------

export function versionMismatchMessage(v: InterfaceVersion): string {
  const side = sideToUpdate(v);
  return `the app declares work-tracker interface ${versionLabel(v)} but this crew reads ${acceptedLabel()} — no ticket will be picked. ` +
    (side === 'crew'
      ? 'Update crew (`npm install -g @tablation/crew`, or the Crew app).'
      : 'Update the app: apply the newest Issues template to the project.') +
    ' Resumes automatically once the versions agree';
}

export function nonConformingMessage(unmet: readonly UnmetRoleLike[]): string {
  return `the app declares the work-tracker interface but does not conform — no ticket will be picked. ` +
    `${describeDifferences(unmet).join('; ')}. Fix the app’s tables or its mapping (Settings → Interfaces). Resumes automatically once it conforms`;
}

export const MAPPING_CHANGED_MESSAGE =
  'the app’s work-tracker mapping changed since `crew connect` — no ticket will be picked until you rerun `crew connect`. Resumes automatically once the stored mapping matches';

export const UNDECLARED_MESSAGE =
  'the app declares no work-tracker interface, so crew reads it from its built-in defaults by table name. ' +
  'Ask the operator to update the app’s Issues template so it declares one; nothing is blocked meanwhile. Clears itself once the app declares it';

export const OVERRIDE_IGNORED_MESSAGE =
  'crew.yaml carries a `contract:` override for this route, but the app declares the work-tracker interface and its declaration wins — the override is ignored';

/** The blocking message for a state, or null when crew may work the app. */
export function blockingMessage(state: InterfaceState, storedMappingKey: string | undefined): string | null {
  if (state.kind !== 'declared') return null;
  if (!state.accepted) return versionMismatchMessage(state.version);
  if (state.conforms === false) return nonConformingMessage(state.unmet);
  if (storedMappingKey !== undefined && storedMappingKey !== mappingKey(state.mapping)) return MAPPING_CHANGED_MESSAGE;
  return null;
}

// ---- the per-cycle check -------------------------------------------------

export function mismatchItem(route: string, message: string, nowIso = new Date().toISOString()): ShipAttentionItem {
  return { kind: 'tracker_interface', key: interfaceKey(INTERFACE_MISMATCH_KEY, route), since: nowIso, message: routeLabel(route) + message };
}
export function undeclaredItem(route: string, nowIso = new Date().toISOString()): ShipAttentionItem {
  return { kind: 'tracker_interface', key: interfaceKey(INTERFACE_UNDECLARED_KEY, route), since: nowIso, message: routeLabel(route) + UNDECLARED_MESSAGE };
}
export function overrideItem(route: string, nowIso = new Date().toISOString()): ShipAttentionItem {
  return { kind: 'tracker_interface', key: interfaceKey(INTERFACE_OVERRIDE_KEY, route), since: nowIso, message: routeLabel(route) + OVERRIDE_IGNORED_MESSAGE };
}

function open(state: RaiseOptions['state'], key: string): string | null {
  return state.shipAttention().previous().find((i) => i.key === key)?.message ?? null;
}

/**
 * Raises or clears the interface items for this cycle. Returns the stop
 * message while crew must claim nothing, else null. A state that could not be
 * read leaves every item as it was.
 */
export async function checkTrackerInterface(
  o: RaiseOptions & { route: Route; ship: Ship },
  deps: { read?: (route: Route, ship: Pick<Ship, 'userAgent'>) => Promise<InterfaceState> } = {},
): Promise<string | null> {
  const r = o.route.resolved;
  if (!r?.projectId) return null;
  const name = o.route.route;
  const mismatchKey = interfaceKey(INTERFACE_MISMATCH_KEY, name);
  const undeclaredKey = interfaceKey(INTERFACE_UNDECLARED_KEY, name);
  const overrideKey = interfaceKey(INTERFACE_OVERRIDE_KEY, name);
  // An older crew kept these three ship-wide; drop whatever it left open so none is stranded.
  for (const legacy of [INTERFACE_MISMATCH_KEY, INTERFACE_UNDECLARED_KEY, INTERFACE_OVERRIDE_KEY]) clearShipAttention(o.state, legacy);
  const state = await (deps.read ?? readForRoute)(o.route, o.ship);
  if (state.kind === 'unreadable') return open(o.state, mismatchKey);

  if (state.kind === 'undeclared') {
    clearShipAttention(o.state, mismatchKey);
    clearShipAttention(o.state, overrideKey);
    if (ALLOW_UNDECLARED_TRACKER_APPS) {
      await raiseShipAttention(o, undeclaredItem(name));
      return null;
    }
    const message = 'the app declares no work-tracker interface and this crew requires one — no ticket will be picked. Update the app’s Issues template. Resumes automatically once it declares one';
    await raiseShipAttention(o, mismatchItem(name, message));
    return message;
  }

  clearShipAttention(o.state, undeclaredKey);
  if (o.route.contractAuthored) await raiseShipAttention(o, overrideItem(name));
  else clearShipAttention(o.state, overrideKey);

  const message = blockingMessage(state, r.trackerInterface?.mappingKey);
  if (message) {
    await raiseShipAttention(o, mismatchItem(name, message));
    return message;
  }
  clearShipAttention(o.state, mismatchKey);
  return null;
}

/** The live read for a route, with the route's own key. */
export async function readForRoute(route: Route, ship: Pick<Ship, 'userAgent'>): Promise<InterfaceState> {
  const r = route.resolved;
  if (!r?.projectId) return { kind: 'unreadable' };
  const get: Getter = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${route.baseUrl.replace(/\/+$/, '')}/api${path}`, {
      headers: { Authorization: `Bearer ${resolveApiKey(route)}`, 'User-Agent': ship.userAgent },
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  };
  try {
    return await readInterfaceState(get, r.workspaceId, r.projectId);
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * What `crew doctor` and `crew connect` report about the interface, as lines
 * and whether any of them is a problem (a blocking one). Reads live.
 */
export function interfaceReport(
  state: InterfaceState, o: { storedMappingKey?: string; contractAuthored?: boolean },
): { line: string; problem: boolean }[] {
  if (state.kind === 'unreadable') return [{ line: 'work tracker interface: could not be read from the platform', problem: false }];
  if (state.kind === 'undeclared') {
    return [{
      line: ALLOW_UNDECLARED_TRACKER_APPS
        ? `work tracker interface: not declared — read from built-in defaults by table name (non-blocking). ${UNDECLARED_MESSAGE}`
        : 'work tracker interface: not declared, and this crew requires one',
      problem: !ALLOW_UNDECLARED_TRACKER_APPS,
    }];
  }
  const lines: { line: string; problem: boolean }[] = [];
  const blocking = blockingMessage(state, o.storedMappingKey);
  if (!state.accepted) lines.push({ line: `work tracker interface: ${versionMismatchMessage(state.version)}`, problem: true });
  else if (state.conforms === false) {
    lines.push({ line: `work tracker interface ${versionLabel(state.version)}: does not conform`, problem: true });
    for (const d of describeDifferences(state.unmet)) lines.push({ line: `  - ${d}`, problem: true });
  } else if (blocking) lines.push({ line: `work tracker interface: ${blocking}`, problem: true });
  else lines.push({ line: `work tracker interface ${versionLabel(state.version)}: ${state.conforms ? 'conforms' : 'declared (conformance not visible to this key)'}`, problem: false });
  if (o.contractAuthored) lines.push({ line: `work tracker interface: ${OVERRIDE_IGNORED_MESSAGE}`, problem: false });
  return lines;
}
