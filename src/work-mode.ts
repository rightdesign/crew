/**
 * Project work mode (CREW-1445).
 *
 * A Projects row may say `work_mode: manual`: the crew's building lanes then
 * consider only tickets a human has assigned to that lane's own seat. Status
 * alone never qualifies a manual project's ticket, and a lane never
 * self-assigns one. QA is deliberately untouched — a `fixed` ticket is a
 * check on finished work, not new work, and the usual hold rules still apply.
 *
 * A missing column or a null value is `automatic`, so an install that has not
 * added the column behaves exactly as it did before.
 */

import type { Contract } from './contract.ts';

/** Ids of the project rows in manual mode. */
export function manualProjectIds(
  rows: Array<Record<string, unknown> & { id: string }>,
  contract: Contract,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r[contract.columns.workMode] === contract.manualWorkMode) out.add(r.id);
  return out;
}

/**
 * `tickets` minus those a building lane may not touch: a manual-project
 * ticket not assigned to `me`. Pass `me` undefined (a seat this ship does not
 * crew) and every manual-project ticket drops.
 */
export function withinWorkMode<T extends { project_id?: string | null; assignee_id?: string | null }>(
  tickets: T[],
  me: string | undefined,
  manual: Set<string> | undefined,
): T[] {
  if (!manual || manual.size === 0) return tickets;
  return tickets.filter((t) => !t.project_id || !manual.has(t.project_id) || (!!me && t.assignee_id === me));
}
