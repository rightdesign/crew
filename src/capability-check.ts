/**
 * `crew connect`'s capability checklist (CREW-2240): what the signed-in member
 * may do among the things connect and `crew agents sync` write, reported up
 * front rather than discovered one refused write at a time.
 */

import { get, type AuthOptions, type Discovered } from './connect.ts';
import { PERSONA_NAME, isAdminRole } from './agents.ts';
import { ROLE_NAMES } from './config.ts';

/**
 * `info` (CREW-3452) is neither a grant nor a miss: a fact worth stating that
 * needs nothing from anyone, so it is not stored with the route and `crew
 * doctor` never repeats it.
 */
export type CapabilityStatus = 'ok' | 'missing' | 'skipped' | 'info';

export interface CapabilityItem {
  key: 'crew-table' | 'ships-table' | 'repos-table' | 'mint-agent-keys' | 'sync-personas';
  label: string;
  status: CapabilityStatus;
  /** What to ask a workspace admin for; set when `status` is `missing`. */
  askFor?: string;
  /** Why it was skipped (no such table, or the probe itself failed), or the sentence an `info` item carries. */
  note?: string;
}

const WRITE_LEVELS = new Set(['WRITE', 'DELETE']);

/** One table's record-write access for this key, or `undefined` when it can't be read. */
async function canWriteTable(o: AuthOptions, modelId: string): Promise<boolean | undefined> {
  try {
    const { access } = await get<{ access?: string }>(o, `/data-models/${modelId}/access`);
    return access === undefined ? undefined : WRITE_LEVELS.has(access);
  } catch { return undefined; }
}

async function projectCapabilities(o: AuthOptions, projectId: string | undefined): Promise<Record<string, boolean> | undefined> {
  if (!projectId) return undefined;
  try { return await get<Record<string, boolean>>(o, `/projects/${projectId}/capabilities`); } catch { return undefined; }
}

const LANE_ROLES = ROLE_NAMES.filter((r) => r !== 'pair');

/**
 * A member cannot write the workspace-level Agents table, and does not need to:
 * running on the rows the workspace already defines is the normal member setup,
 * so that is reported as `info`. Only a lane role with no Agents row at all is a
 * real blocker, because an admin has to run the sync once to create it.
 */
async function memberPersonaItem(o: AuthOptions, found: Discovered): Promise<CapabilityItem> {
  const key = 'sync-personas';
  const label = 'sync personas and skills';
  try {
    const model = await get<{ id: string }>(o, `/data-models/agents?workspaceId=${found.workspaceId}`);
    const rows = await get<Array<{ name?: string }>>(o, `/data-models/${model.id}/records?limit=200`);
    const absent = LANE_ROLES.filter((r) => !rows.some((row) => row.name === PERSONA_NAME[r]));
    if (absent.length > 0) {
      return { key, label, status: 'missing', askFor: `one \`crew agents sync\` run (no Agents row for ${absent.map((r) => PERSONA_NAME[r]).join(', ')})` };
    }
    return { key, label, status: 'info', note: "this ship uses the workspace's personas and skills as they are" };
  } catch {
    return { key, label, status: 'skipped', note: 'could not read the Agents table' };
  }
}

/**
 * Checks the fixed list against the project `found` resolved. Never throws: an
 * answer that can't be read is `skipped` with a note, not a miss, because a
 * false "ask an admin" is worse than the one refused write it replaces.
 */
export async function checkCapabilities(o: AuthOptions, found: Discovered): Promise<CapabilityItem[]> {
  const admin = isAdminRole(found.role);
  const table = async (
    key: CapabilityItem['key'], label: string, tableName: string, modelId: string | undefined, askFor: string,
  ): Promise<CapabilityItem> => {
    if (!modelId) return { key, label, status: 'skipped', note: `no ${tableName} table in this project` };
    const ok = await canWriteTable(o, modelId);
    if (ok === undefined) return { key, label, status: 'skipped', note: 'could not read access' };
    return ok ? { key, label, status: 'ok' } : { key, label, status: 'missing', askFor };
  };
  const [crew, ships, repos, caps] = await Promise.all([
    table('crew-table', 'write the Crew table', 'Crew', found.crewModelId ?? found.models.crew, 'WRITE access on the Crew table'),
    table('ships-table', 'write the Ships table', 'Ships', found.shipsModelId, 'WRITE access on the Ships table'),
    table('repos-table', 'create Repos rows', 'Repos', found.reposModelId, 'WRITE access on the Repos table'),
    projectCapabilities(o, found.projectId),
  ]);
  const mint: CapabilityItem = admin || caps?.MINT_AGENT_KEYS
    ? { key: 'mint-agent-keys', label: 'mint agent keys', status: 'ok' }
    : caps
      ? { key: 'mint-agent-keys', label: 'mint agent keys', status: 'missing', askFor: 'the "Mint agent keys" capability' }
      : { key: 'mint-agent-keys', label: 'mint agent keys', status: 'skipped', note: 'could not read capabilities' };
  const sync: CapabilityItem = admin
    ? { key: 'sync-personas', label: 'sync personas and skills', status: 'ok' }
    : await memberPersonaItem(o, found);
  return [crew, ships, repos, mint, sync];
}

/** The stored form of a miss, repeated by `crew doctor`. */
export function missLine(i: CapabilityItem): string {
  return `${i.label} — ask a workspace admin for ${i.askFor ?? 'access'}`;
}

export function describeCapability(i: CapabilityItem): string {
  if (i.status === 'ok') return `ok       ${i.label}`;
  if (i.status === 'info') return `info     ${i.label} (${i.note ?? ''})`;
  if (i.status === 'skipped') return `skipped  ${i.label} (${i.note ?? 'not checked'})`;
  return `missing  ${missLine(i)}`;
}
