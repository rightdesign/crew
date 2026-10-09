/**
 * Project work mode (CREW-1445, widened by CREW-1493 / EPIC-034).
 *
 * A Projects row says `work_mode`:
 *
 * - `automatic` (the default): every lane works the project's tickets by status.
 * - `manual`: no agentic automation at all. No lane — dev, design, QA or
 *   triage — selects, claims or wakes for the project's tickets.
 * - `hybrid`: a lane considers a ticket only when it is assigned to an agent
 *   (a Crew row with a linked `agent_id` that is not a hold row of this ship).
 *   Matching is by the row's Agent, not by seat id, so a ticket assigned to
 *   another ship's Developer row is eligible on this ship too.
 *
 * A ticket with no `project_id` has no mode to read and is treated as manual.
 * A missing column or a null value is `automatic`, so an install that has not
 * added the column behaves exactly as it did before.
 */

import type { Contract } from './contract.ts';

export type WorkMode = 'automatic' | 'manual' | 'hybrid';

/** What the selection needs to apply work mode: each project's mode, and who counts as an agent. */
export interface WorkModes {
  /** Project row id -> mode. Empty means the workspace has no readable Projects table: no filtering. */
  modes: Map<string, WorkMode>;
  /** Crew row ids that are an agent (non-null `agent_id`) and not a hold of this ship. */
  agentAssignees: Set<string>;
}

/** Every project row's mode, keyed by row id. */
export function projectWorkModes(
  rows: Array<Record<string, unknown> & { id: string }>,
  contract: Contract,
): Map<string, WorkMode> {
  const out = new Map<string, WorkMode>();
  for (const r of rows) {
    const v = r[contract.columns.workMode];
    out.set(r.id, v === contract.manualWorkMode ? 'manual' : v === contract.hybridWorkMode ? 'hybrid' : 'automatic');
  }
  return out;
}

/**
 * Crew rows that count as "an agent" for a hybrid project: linked to an Agents
 * row and not one of this ship's hold rows (a hold is a person, or a person's
 * interactive session — never automation).
 */
export function agentAssigneeIds(
  crewRows: Array<{ id: string; agent_id?: string | null }>,
  isHoldRow: (id: string) => boolean,
): Set<string> {
  return new Set(crewRows.filter((r) => !!r.agent_id && !isHoldRow(r.id)).map((r) => r.id));
}

/** The mode governing a ticket. No project is manual; an unknown project id is automatic. */
export function modeOf(t: { project_id?: string | null }, wm: WorkModes): WorkMode {
  if (!t.project_id) return 'manual';
  return wm.modes.get(t.project_id) ?? 'automatic';
}

/**
 * `tickets` minus those automation may not touch: manual and project-less
 * tickets always drop; hybrid tickets drop unless assigned to an agent.
 * Absent `wm` (tests, a workspace with no Projects table) filters nothing.
 */
export function withinWorkMode<T extends { project_id?: string | null; assignee_id?: string | null }>(
  tickets: T[],
  wm: WorkModes | undefined,
): T[] {
  if (!wm || wm.modes.size === 0) return tickets;
  return tickets.filter((t) => {
    const mode = modeOf(t, wm);
    if (mode === 'automatic') return true;
    if (mode === 'manual') return false;
    return !!t.assignee_id && wm.agentAssignees.has(t.assignee_id);
  });
}

/** Whether a ticket's project is automatic (triage works only those). Absent `wm` is permissive. */
export function isAutomatic(t: { project_id?: string | null }, wm: WorkModes | undefined): boolean {
  if (!wm || wm.modes.size === 0) return true;
  return modeOf(t, wm) === 'automatic';
}

/**
 * Tickets the sweeps (blocked, stalled) must leave alone, counted by why
 * (CREW-1496): `manual` includes project-less tickets, `hybrid` is those not
 * assigned to an agent. Feeds the sweep's run summary so the omission is visible.
 */
export function skippedByMode(
  tickets: Array<{ project_id?: string | null; assignee_id?: string | null }>,
  wm: WorkModes | undefined,
): { manual: number; hybrid: number } {
  const out = { manual: 0, hybrid: 0 };
  if (!wm || wm.modes.size === 0) return out;
  const kept = new Set(withinWorkMode(tickets, wm));
  for (const t of tickets) {
    if (kept.has(t)) continue;
    out[modeOf(t, wm) === 'manual' ? 'manual' : 'hybrid']++;
  }
  return out;
}

/**
 * `tickets` minus `verified` ones in a manual (or project-less) project: the
 * release phase never merges, counts or warns about them (CREW-1496).
 * Hybrid is deliberately NOT filtered — a verified hybrid ticket releases
 * exactly like an automatic one. Every other status passes through untouched.
 */
export function withoutManualVerified<T extends { status: string; project_id?: string | null }>(
  tickets: T[],
  verifiedStatus: string,
  wm: WorkModes | undefined,
): T[] {
  if (!wm || wm.modes.size === 0) return tickets;
  return tickets.filter((t) => t.status !== verifiedStatus || modeOf(t, wm) !== 'manual');
}

/** `Name (mode)` per project, for `crew status`. */
export function projectModeLabels(
  rows: Array<{ id: string; name?: string; mode: WorkMode }>,
): Array<{ id: string; name: string; mode: WorkMode; label: string }> {
  return rows.map((r) => {
    const name = r.name ?? r.id;
    return { id: r.id, name, mode: r.mode, label: `${name} (${r.mode})` };
  });
}
