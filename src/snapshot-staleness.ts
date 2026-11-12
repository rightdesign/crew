/**
 * Is a route's connect snapshot (`ResolvedIds`) out of date? (CREW-3274)
 *
 * `crew connect` writes the ids of the workspace's optional tables and this
 * ship's release seat once; nothing re-reads them. A workspace that gained a
 * table (or a Crew row) afterwards looks, to every doctor line that reads the
 * snapshot, as if it lacked it. This compares the snapshot with the workspace
 * as it is now, once per route, so doctor can say "the snapshot is old" instead
 * of "the workspace has no such table".
 *
 * Pure: the live listing is passed in, so it is tested without a tracker.
 */
import type { ResolvedIds } from './config.ts';

/** The optional tables `discover()` looks up by name, and the snapshot key each lands in. */
export const SNAPSHOT_TABLES = [
  { key: 'periscopesModelId', name: 'Periscopes' },
  { key: 'shipsModelId', name: 'Ships' },
  { key: 'epicsModelId', name: 'Epics' },
  { key: 'locksModelId', name: 'Locks' },
  { key: 'reposModelId', name: 'Repos' },
  { key: 'areaModelId', name: 'Projects' },
] as const;

export interface SnapshotDiff {
  /** Tables the workspace has now that the snapshot lacks. */
  added: string[];
  /** Tables the snapshot names that the workspace no longer has (or has under another id). */
  removed: string[];
  /** The workspace has this ship's Release Crew row; the snapshot has no release seat. */
  releaseSeatNew: boolean;
  /** The Ships row was matched by name and carries no `machine_id` (it predates machine ids). */
  shipRowLacksMachineId: boolean;
}

export interface LiveSnapshot {
  /** The project's data models as `GET /data-models?projectId=` lists them. */
  models: Array<{ id: string; name: string }>;
  /** This ship's Release Crew row, when the workspace has it. */
  releaseSeat?: string;
  /** `false` when a Ships row exists for this ship but has no `machine_id` set. */
  shipRowHasMachineId?: boolean;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The release seat a fresh connect would resolve: a Crew row scoped to this ship whose name says "release". */
export function liveReleaseSeat(
  crew: Array<{ id: string; name?: string | null; ship_id?: unknown }>,
  shipRowId: string | undefined,
): string | undefined {
  if (!shipRowId) return undefined;
  const idOf = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { id?: string }).id : undefined);
  return crew.find((r) => idOf(r.ship_id) === shipRowId && (r.name ?? '').toLowerCase().includes('release'))?.id;
}

export function compareSnapshot(resolved: ResolvedIds, live: LiveSnapshot): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const t of SNAPSHOT_TABLES) {
    const have = resolved[t.key];
    const now = live.models.find((m) => same(m.name, t.name))?.id;
    if (now && !have) added.push(t.name);
    else if (have && now !== have) removed.push(t.name);
  }
  return {
    added,
    removed,
    releaseSeatNew: !resolved.releaseSeat && !!live.releaseSeat,
    shipRowLacksMachineId: live.shipRowHasMachineId === false,
  };
}

export const isStale = (d: SnapshotDiff): boolean =>
  d.added.length > 0 || d.removed.length > 0 || d.releaseSeatNew || d.shipRowLacksMachineId;

/** `3 days`, `2 hours`, `just now` — for doctor's verbose line. */
export function snapshotAge(connectedAt: string | undefined, now: Date = new Date()): string {
  if (!connectedAt) return 'unknown (connected before connectedAt was recorded)';
  const ms = now.getTime() - Date.parse(connectedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const units: Array<[string, number]> = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];
  for (const [u, size] of units) {
    const n = Math.floor(ms / size);
    if (n >= 1) return `${n} ${u}${n === 1 ? '' : 's'}`;
  }
  return 'just now';
}

/** The one stale-snapshot finding for a route; undefined when nothing differs. */
export function staleSnapshotMessage(route: string, d: SnapshotDiff): string | undefined {
  if (!isStale(d)) return undefined;
  const parts: string[] = [];
  if (d.added.length) parts.push(`new in the workspace: ${d.added.join(', ')}`);
  if (d.removed.length) parts.push(`no longer in the workspace: ${d.removed.join(', ')}`);
  if (d.releaseSeatNew) parts.push('this ship\'s Release seat row exists');
  if (d.shipRowLacksMachineId) parts.push('the Ships row has no machine_id (it predates machine ids; connect writes it)');
  return `${route}: the connect snapshot for this route is out of date (${parts.join('; ')}) — run \`crew connect ${route}\` then \`crew reload\` (or \`crew doctor ${route} --fix\`)`;
}
