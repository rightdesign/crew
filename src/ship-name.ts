/**
 * Ship name sync (CREW-2495): `ship.name` in crew.yaml and the `name` of this
 * machine's row on each workspace's Ships table are two copies of one fact.
 * They are reconciled three ways against `shipName`, the name this route last
 * saw agree, recorded in its resolved file:
 *
 *   - the row changed, crew.yaml did not   -> adopt the row's name locally
 *   - crew.yaml changed, the row did not   -> push it to the row
 *   - both changed (and disagree)          -> the Ships row wins, with a warning
 *
 * The row is matched by `machine_id` only. A name match cannot survive a
 * rename (the two names are exactly what differs), and a workspace whose
 * Ships table has no `machine_id` column has nothing to compare, so it keeps
 * the old behavior: the name in crew.yaml is the name, and nothing syncs.
 *
 * The decision (`planNameSync`) is pure; `syncRouteName` applies it to one
 * route's rows; `reconcileShipName` does the file and event plumbing the
 * daemon, `connect`, `status` and `crew ship rename` all share.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { resolvedPathFor, type Route, type Ship } from './config.ts';
import { ensureMachineId } from './machine-id.ts';
import { Tracker, type ShipRow } from './tracker.ts';

export class ShipNameError extends Error {}

/** Which side moved since the last sync. */
export type NameDrift = 'none' | 'row' | 'local' | 'both';
export type NameAction = 'none' | 'adopt' | 'push' | 'row-wins';

/** A trimmed, non-empty name with no control characters. */
export function validateShipName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ShipNameError('the ship name cannot be empty');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ShipNameError('the ship name cannot contain control characters');
  return name;
}

/**
 * What differs, and which name wins. With no `lastSynced` (a route that has
 * never recorded one) the baseline is unknown, so any disagreement counts as
 * both having moved: the row wins, loudly.
 */
export function planNameSync(local: string, row: string, lastSynced: string | undefined): { drift: NameDrift; action: NameAction } {
  if (local === row) return { drift: 'none', action: 'none' };
  const rowMoved = lastSynced === undefined || row !== lastSynced;
  const localMoved = lastSynced === undefined || local !== lastSynced;
  if (rowMoved && localMoved) return { drift: 'both', action: 'row-wins' };
  if (rowMoved) return { drift: 'row', action: 'adopt' };
  return { drift: 'local', action: 'push' };
}

/** `ship.name` from a crew.yaml text, undefined when it names none. */
export function shipNameOfYaml(text: string): string | undefined {
  const v = parseDocument(text).getIn(['ship', 'name']);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** `ship.name` set in a crew.yaml text, comments and ordering intact. */
export function setShipNameInYaml(text: string, name: string): string {
  const doc = parseDocument(text);
  doc.setIn(['ship', 'name'], name);
  return doc.toString();
}

export type RowPick =
  | { kind: 'row'; row: ShipRow; by: 'machine_id' | 'name' }
  | { kind: 'unsupported' | 'none' | 'ambiguous' };

/**
 * This machine's Ships row. `byName` (rename only) additionally accepts a row
 * with no machine id whose name is one this ship has used.
 */
export function pickShipRow(rows: ShipRow[], machineId: string | undefined, byName: string[] = []): RowPick {
  const hasColumn = rows.some((r) => 'machine_id' in r);
  if (!hasColumn || !machineId) return { kind: 'unsupported' };
  const byId = rows.filter((r) => r.machine_id === machineId);
  if (byId.length === 1) return { kind: 'row', row: byId[0]!, by: 'machine_id' };
  if (byId.length > 1) return { kind: 'ambiguous' };
  const names = new Set(byName.map((n) => n.trim()));
  const named = rows.filter((r) => !r.machine_id && names.has((r.name ?? '').trim()));
  if (named.length === 1) return { kind: 'row', row: named[0]!, by: 'name' };
  return { kind: named.length > 1 ? 'ambiguous' : 'none' };
}

export interface RouteNameResult {
  status: 'ok' | 'unsupported' | 'no-row' | 'ambiguous' | 'refused';
  drift: NameDrift;
  action: NameAction;
  /** The name in force after this sync (what crew.yaml should say). */
  name: string;
  rowId?: string;
  rowName?: string;
  /** The name replaced, for `adopt` / `row-wins`. */
  from?: string;
  /** Why the row write was refused (`status: 'refused'`). */
  error?: string;
}

export interface RouteNameInput {
  local: string;
  lastSynced: string | undefined;
  rows: ShipRow[];
  machineId: string | undefined;
  /** Writes the row; undefined for a read-only report. */
  rename?: (rowId: string, name: string) => Promise<void>;
}

/** Apply (or, without `rename`, only report) the three-way rule for one route. */
export async function syncRouteName(i: RouteNameInput): Promise<RouteNameResult> {
  const picked = pickShipRow(i.rows, i.machineId);
  if (picked.kind !== 'row') {
    const status = picked.kind === 'none' ? 'no-row' : picked.kind;
    return { status, drift: 'none', action: 'none', name: i.local };
  }
  const rowName = (picked.row.name ?? '').trim();
  if (!rowName) return { status: 'no-row', drift: 'none', action: 'none', name: i.local };
  const { drift, action } = planNameSync(i.local, rowName, i.lastSynced);
  const base = { drift, rowId: picked.row.id, rowName };
  if (action === 'push') {
    if (!i.rename) return { status: 'ok', ...base, action, name: i.local };
    try {
      await i.rename(picked.row.id, i.local);
    } catch (e) {
      return { status: 'refused', ...base, action: 'none', name: i.local, error: (e as Error).message };
    }
    return { status: 'ok', ...base, action, name: i.local };
  }
  if (action === 'adopt' || action === 'row-wins') return { status: 'ok', ...base, action, name: rowName, from: i.local };
  return { status: 'ok', ...base, action, name: i.local };
}

/** The `shipName` recorded in a route's resolved file. */
export function readSyncedName(resolvedFile: string): string | undefined {
  if (!existsSync(resolvedFile)) return undefined;
  try {
    const v = (JSON.parse(readFileSync(resolvedFile, 'utf8')) as { shipName?: unknown }).shipName;
    return typeof v === 'string' ? v : undefined;
  } catch { return undefined; }
}

/** Record `name` as this route's last-synced ship name. A route with no resolved file has nothing to record into. */
export function writeSyncedName(resolvedFile: string, name: string): void {
  if (!existsSync(resolvedFile)) return;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(resolvedFile, 'utf8')) as Record<string, unknown>; } catch { return; }
  if (raw.shipName === name) return;
  raw.shipName = name;
  mkdirSync(dirname(resolvedFile), { recursive: true });
  const tmp = `${resolvedFile}.tmp${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(tmp, resolvedFile);
}

/** The slice of an `Emitter` this needs. */
export interface NameEmitter {
  emit(message: string, extra?: { step?: 'poll'; data?: Record<string, unknown> }): unknown;
  warn(message: string, extra?: { step?: 'poll'; data?: Record<string, unknown> }): unknown;
}

export interface ReconcileInput {
  route: string;
  configFile: string;
  stateDir: string;
  /** The in-memory ship; `name` is updated when a name is adopted. */
  ship: { name: string };
  machineId: string | undefined;
  rows: () => Promise<ShipRow[]>;
  rename: (rowId: string, name: string) => Promise<void>;
  emit?: NameEmitter;
  /** Report only: no file or row is written. */
  readOnly?: boolean;
}

/**
 * One route's reconcile: read crew.yaml's current name (a hand edit made while
 * the daemon runs counts), apply the rule, then write whichever side lost and
 * the route's last-synced name. Never throws on a board problem; an
 * unreadable Ships table is "nothing to compare".
 */
export async function reconcileShipName(i: ReconcileInput): Promise<RouteNameResult> {
  let local = i.ship.name;
  try { local = shipNameOfYaml(readFileSync(i.configFile, 'utf8')) ?? local; } catch { /* keep the in-memory name */ }
  const resolvedFile = resolvedPathFor(i.stateDir, i.route);
  const lastSynced = readSyncedName(resolvedFile);
  let rows: ShipRow[] = [];
  try { rows = await i.rows(); } catch { /* treated as no Ships table */ }
  const result = await syncRouteName({
    local, lastSynced, rows, machineId: i.machineId, rename: i.readOnly ? undefined : i.rename,
  });
  if (i.readOnly || result.status === 'unsupported') return result;
  if (result.status === 'refused') {
    i.emit?.warn(`could not rename the Ships row to "${local}": ${result.error}`, { step: 'poll', data: { event: 'ship_rename_refused', route: i.route, to: local } });
    return result;
  }
  if (result.status !== 'ok') return result;
  if (result.action === 'adopt' || result.action === 'row-wins') {
    const text = readFileSync(i.configFile, 'utf8');
    writeFileSync(i.configFile, setShipNameInYaml(text, result.name));
    i.ship.name = result.name;
    if (result.action === 'row-wins') {
      i.emit?.warn(
        `ship name changed in both crew.yaml ("${result.from}") and the Ships table ("${result.name}"); the Ships row wins`,
        { step: 'poll', data: { event: 'ship_renamed', route: i.route, from: result.from, to: result.name, source: 'table', conflict: true } },
      );
    } else {
      i.emit?.emit(`ship renamed to "${result.name}" in the Ships table; crew.yaml updated`, {
        step: 'poll', data: { event: 'ship_renamed', route: i.route, from: result.from, to: result.name, source: 'table' },
      });
    }
  } else if (result.action === 'push') {
    i.emit?.emit(`ship name "${result.name}" pushed to the Ships table`, {
      step: 'poll', data: { event: 'ship_renamed', route: i.route, from: result.rowName, to: result.name, source: 'crew.yaml' },
    });
  }
  writeSyncedName(resolvedFile, result.name);
  return result;
}

/**
 * `reconcileShipName` against a live route: builds the tracker and reads this
 * machine's id. For the daemon pass, the one-shot cycle and `status`. Never
 * throws; a route with no resolved ids or no Ships table is "unsupported".
 */
export async function reconcileRouteShipName(o: {
  route: Route; ship: Ship; configFile: string; emit?: NameEmitter; readOnly?: boolean; machineId?: string;
}): Promise<RouteNameResult> {
  const fallback: RouteNameResult = { status: 'unsupported', drift: 'none', action: 'none', name: o.ship.name };
  if (!o.route.resolved?.shipsModelId) return fallback;
  try {
    const machineId = o.machineId ?? ensureMachineId(o.ship.stateDir);
    const tracker = new Tracker(o.route, o.ship);
    return await reconcileShipName({
      route: o.route.route, configFile: o.configFile, stateDir: o.ship.stateDir, ship: o.ship, machineId,
      rows: () => tracker.shipRows(), rename: (id, name) => tracker.renameShipRow(id, name),
      emit: o.emit, readOnly: o.readOnly,
    });
  } catch {
    return fallback;
  }
}
