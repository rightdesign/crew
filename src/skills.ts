/**
 * `crew skills sync` — pushes crew's local skill files
 * (`prompts/<promptSet>/skills/*.md`) into a workspace's `Agent Skills`
 * table.
 *
 * A skill is not a persona: it is not tied to a `RoleName`, not polled, and
 * not concatenated ahead of a run's roster/environment/digest sections —
 * it is fetched on demand, by name, by whatever session needs it (today:
 * a Pair session invoked via an Epic's `grill_link`, using the Tablation
 * MCP tool `agent_skills_controller_get_skill`). This module only owns
 * getting the local file's content into the workspace table; nothing here
 * fetches or assembles a skill into a running session's prompt.
 *
 * Mirrors `agents.ts`'s `syncPersonas` shape closely (same client, same
 * compare-and-swap divergence handling via `RecordsResource.update`'s
 * `expectedUpdatedAt`/`StaleWriteError`) — see that file's own doc comment
 * for the reasoning. The one real difference: skills are keyed by an
 * open-ended `name` string parsed out of each file's frontmatter, not a
 * fixed `RoleName` union, so there is no per-skill "seat" to link back to
 * and no equivalent of `linkCrewSeats`.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TablationClient, StaleWriteError, TablationApiError } from '@tablation/client';
import type { Route } from './config.ts';
import { resolveApiKey } from './config.ts';
import { skillMarkerNames } from './skill-include.ts';
import { promptSourceFields, isPromptGateRejection, hasPromptBaselineColumn, needsBaselineBackfill } from './agents.ts';

export class SkillSyncError extends Error {}

export interface LocalSkill {
  name: string;
  description: string;
  prompt: string;
  file: string;
}

/**
 * Splits a leading `---\n...\n---\n` YAML frontmatter block from the rest
 * of the file (the skill's `prompt`). Frontmatter must carry `name` and
 * `description` — the two fields the `Agent Skills` table requires beyond
 * `prompt` itself (`agent_skills_controller_get_skill` looks rows up by
 * exact `name`).
 */
export function parseSkillFile(path: string): LocalSkill {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new SkillSyncError(`${path}: missing YAML frontmatter (expected a leading --- block)`);
  const frontmatter = match[1]!;
  const body = match[2]!;
  const meta = parseYaml(frontmatter) as { name?: unknown; description?: unknown };
  if (typeof meta.name !== 'string' || !meta.name) throw new SkillSyncError(`${path}: frontmatter is missing "name"`);
  if (typeof meta.description !== 'string' || !meta.description) {
    throw new SkillSyncError(`${path}: frontmatter is missing "description"`);
  }
  return { name: meta.name, description: meta.description, prompt: body, file: path };
}

/** Every `*.md` skill file under `${promptsDir}/skills/`. Empty array if the directory doesn't exist — a prompt set need not define any skills. */
export function listLocalSkills(promptsDir: string): LocalSkill[] {
  const dir = join(promptsDir, 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseSkillFile(join(dir, f)));
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  updated_at: string;
  /** TABL-1540: true = an operator locked this prompt; crew never writes it. Absent on an older server. */
  prompt_customized?: boolean | null;
  /** CREW-1559: `prompt !== prompt_baseline` on a non-customized row means a person edited it. Null on a row never stamped. */
  prompt_source?: string | null;
  prompt_baseline?: string | null;
}

export type SkillSyncAction = 'created' | 'updated' | 'unchanged' | 'diverged' | 'overridden' | 'forced';

export interface SkillSyncOutcome {
  name: string;
  action: SkillSyncAction;
  skillId: string;
}

export interface SyncSkillsResult {
  outcomes: SkillSyncOutcome[];
  /**
   * The new `route.resolved.agentSkills` — every skill synced this pass
   * (created/updated/unchanged all refresh their entry; `diverged` keeps
   * whatever was cached before, since crew did not write the row this
   * time). The caller persists this into the resolved state file; nothing
   * here touches disk itself.
   */
  agentSkills: Record<string, { skillId: string; lastSyncedUpdatedAt: string }>;
}

/**
 * `route.resolved.workspaceId` and `resolveApiKey(route)` are required —
 * same as every other tracker-talking command, this only works on a route
 * `crew connect` has already resolved.
 */
export async function syncSkills(
  route: Route,
  opts: { userAgent?: string; dryRun?: boolean; force?: boolean },
): Promise<SyncSkillsResult> {
  if (!route.resolved) {
    throw new SkillSyncError(`route "${route.route}" has no resolved ids — run \`crew connect\` first`);
  }
  const workspaceId = route.resolved.workspaceId;
  const client = new TablationClient({
    baseUrl: `${route.baseUrl}/api`,
    apiKey: resolveApiKey(route),
    headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  } as ConstructorParameters<typeof TablationClient>[0]);

  let skillsModel: Awaited<ReturnType<typeof client.dataModels.get>>;
  try {
    skillsModel = await client.dataModels.get('agent_skills', workspaceId);
  } catch (e) {
    if (e instanceof TablationApiError && e.status === 404) {
      throw new SkillSyncError(
        `workspace ${workspaceId} has no Agent Skills table yet — every workspace auto-provisions one; ` +
          `an older workspace may still need its one-time backfill`,
      );
    }
    throw e;
  }

  const local = listLocalSkills(route.promptsDir);
  const rows = await client.records.list<SkillRow>(skillsModel.id, { limit: 200 });
  const cache = route.resolved.agentSkills ?? {};
  const outcomes: SkillSyncOutcome[] = [];
  const agentSkills: SyncSkillsResult['agentSkills'] = { ...cache };

  for (const skill of local) {
    const row = rows.find((r) => r.name === skill.name);

    if (!row) {
      if (opts.dryRun) { outcomes.push({ name: skill.name, action: 'created', skillId: '(dry run)' }); continue; }
      const created = await client.records.create<SkillRow>(skillsModel.id, {
        name: skill.name, description: skill.description, prompt: skill.prompt,
        ...promptSourceFields(skillsModel, skill.prompt),
      });
      agentSkills[skill.name] = { skillId: created.id, lastSyncedUpdatedAt: created.updated_at };
      outcomes.push({ name: skill.name, action: 'created', skillId: created.id });
      continue;
    }

    if (row.description === skill.description && row.prompt === skill.prompt) {
      // In sync content-wise regardless of who wrote it last — nothing to
      // push, just (re)anchor the cache to the row's current updated_at so
      // a later sync's compare-and-swap has the right baseline.
      let anchoredAt = row.updated_at;
      if (!opts.dryRun && needsBaselineBackfill(skillsModel, row)) {
        // CREW-1559: a row written before the baseline columns existed is
        // never re-stamped otherwise, so the app shows it as unmanaged.
        // Content is equal, so the write gate accepts it.
        try {
          anchoredAt = (await client.records.update<SkillRow>(
            skillsModel.id, row.id, promptSourceFields(skillsModel, skill.prompt), row.updated_at,
          )).updated_at;
        } catch (e) {
          if (!(e instanceof StaleWriteError) && !isPromptGateRejection(e)) throw e;
        }
      }
      agentSkills[skill.name] = { skillId: row.id, lastSyncedUpdatedAt: anchoredAt };
      outcomes.push({ name: skill.name, action: 'unchanged', skillId: row.id });
      continue;
    }

    if (row.prompt_customized === true) {
      // TABL-1540: the operator's explicit lock — never written, not even by --force.
      agentSkills[skill.name] = { skillId: row.id, lastSyncedUpdatedAt: row.updated_at };
      outcomes.push({ name: skill.name, action: 'overridden', skillId: row.id });
      continue;
    }

    const body = { description: skill.description, prompt: skill.prompt, ...promptSourceFields(skillsModel, skill.prompt) };

    if (opts.force) {
      // Same as the persona `--force`: the operator has decided a local edit is meant to be discarded, so no CAS.
      if (opts.dryRun) { outcomes.push({ name: skill.name, action: 'forced', skillId: row.id }); continue; }
      try {
        const updated = await client.records.update<SkillRow>(skillsModel.id, row.id, body);
        agentSkills[skill.name] = { skillId: row.id, lastSyncedUpdatedAt: updated.updated_at };
        outcomes.push({ name: skill.name, action: 'forced', skillId: row.id });
      } catch (e) {
        if (!isPromptGateRejection(e)) throw e;
        outcomes.push({ name: skill.name, action: 'overridden', skillId: row.id });
      }
      continue;
    }

    // CREW-1559: with a baseline on the row, divergence is judged by its
    // content alone — `prompt === prompt_baseline` is unedited whichever ship
    // wrote it last. The per-ship cache can't tell another ship's sync from a
    // human edit, so it is only the fallback for a row with no baseline
    // (TABL-1540: those are only moved by --force or matching content).
    let knownBaseline: string | undefined;
    if (hasPromptBaselineColumn(skillsModel) && typeof row.prompt_baseline === 'string') {
      if (row.prompt !== row.prompt_baseline) {
        outcomes.push({ name: skill.name, action: 'diverged', skillId: row.id });
        continue;
      }
      knownBaseline = row.updated_at;
    } else {
      knownBaseline = cache[skill.name]?.skillId === row.id ? cache[skill.name]?.lastSyncedUpdatedAt : undefined;
    }
    if (!knownBaseline) {
      // No cache entry for this row — crew has never synced it (or the
      // state dir was wiped) and cannot prove the current content is its
      // own last write, so this is diverged by definition: an unwritten
      // `expectedUpdatedAt` below would skip the compare-and-swap
      // entirely and silently clobber whatever is actually there.
      outcomes.push({ name: skill.name, action: 'diverged', skillId: row.id });
      continue;
    }

    if (opts.dryRun) {
      outcomes.push({ name: skill.name, action: 'updated', skillId: row.id });
      continue;
    }

    try {
      const updated = await client.records.update<SkillRow>(
        skillsModel.id, row.id, body, knownBaseline,
      );
      agentSkills[skill.name] = { skillId: row.id, lastSyncedUpdatedAt: updated.updated_at };
      outcomes.push({ name: skill.name, action: 'updated', skillId: row.id });
    } catch (e) {
      if (e instanceof StaleWriteError) {
        // A workspace admin (or anything else) changed this row since crew
        // last wrote it — never overwrite, same policy as `agents.ts`'s
        // persona sync. Leave the cache exactly as it was; the caller
        // surfaces this as a warning.
        outcomes.push({ name: skill.name, action: 'diverged', skillId: row.id });
        continue;
      }
      if (isPromptGateRejection(e)) {
        // Flagged "Customize prompt" between the list and this write.
        outcomes.push({ name: skill.name, action: 'overridden', skillId: row.id });
        continue;
      }
      throw e;
    }
  }

  return { outcomes, agentSkills };
}

/** One human-readable line per skill, for `crew skills sync`'s own stdout. */
export function describeSkillSyncOutcome(o: SkillSyncOutcome): string {
  switch (o.action) {
    case 'created': return `${o.name}: created (${o.skillId})`;
    case 'updated': return `${o.name}: prompt updated from crew's local file`;
    case 'unchanged': return `${o.name}: already in sync`;
    case 'overridden': return `${o.name}: override in place — prompt not synced (clear "Customize prompt" on the Agent Skills row to resume)`;
    case 'forced': return `${o.name}: overwritten from crew's local file (--force)`;
    case 'diverged': return `${o.name}: HAS LOCAL EDITS — crew's default is newer but was NOT applied; review ${o.skillId} in the app before syncing again`;
  }
}

/**
 * Workspace Agent Skills rows that differ from crew's local file because
 * someone edited them, keyed by skill name — what `planAgentRun` consults
 * before the local file when expanding `{{skill: Name}}` includes (CREW-1534).
 *
 * Covers every row in the workspace, so a diverged brief can include a skill
 * an admin created that crew's preset does not ship. A row
 * whose `updated_at` still equals the one crew cached at its last write is
 * crew's own stale copy, not an edit, so the local file wins — the same
 * distinction `fetchDivergedPrompt` draws for persona rows (ISSUE-1382). With
 * no cached baseline a differing row is treated as an edit, so an admin's
 * change is never silently dropped. Best-effort like `fetchDivergedPrompt`:
 * a missing table or unreachable tracker returns nothing and the local file
 * is used.
 */
export async function fetchSkillOverrides(
  route: Route,
  opts: { userAgent?: string },
): Promise<Record<string, string>> {
  if (!route.resolved) return {};
  const client = new TablationClient({
    baseUrl: `${route.baseUrl}/api`,
    apiKey: resolveApiKey(route),
    headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  } as ConstructorParameters<typeof TablationClient>[0]);

  let rows: SkillRow[];
  try {
    const model = await client.dataModels.get('agent_skills', route.resolved.workspaceId);
    rows = await client.records.list<SkillRow>(model.id, { limit: 200 });
  } catch {
    return {};
  }

  const local = new Map(listLocalSkills(route.promptsDir).map((s) => [s.name, s]));
  const cache = route.resolved.agentSkills ?? {};
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name;
    if (row.prompt === local.get(name)?.prompt) continue;
    // CREW-1559: an unedited, non-customized row is crew's own stale copy whoever wrote it.
    if (row.prompt_customized !== true && row.prompt === row.prompt_baseline) continue;
    const cached = cache[name];
    if (cached?.skillId === row.id && cached.lastSyncedUpdatedAt === row.updated_at) continue;
    out[name] = row.prompt;
  }
  return out;
}

/**
 * Warnings for every `{{skill: Name}}` marker in a prompt set's persona
 * briefs that names a skill the set does not ship — `crew agents sync` prints
 * them, since an include of a missing skill refuses the run (CREW-1534).
 */
export function skillMarkerWarnings(
  promptsDir: string,
  personaPrompts: Partial<Record<string, string>>,
): string[] {
  const shipped = new Set(listLocalSkills(promptsDir).map((s) => s.name));
  const out: string[] = [];
  for (const [role, text] of Object.entries(personaPrompts)) {
    for (const name of skillMarkerNames(text ?? '')) {
      if (!shipped.has(name)) out.push(`${role}: brief includes {{skill: ${name}}} but this prompt set ships no skill with that name`);
    }
  }
  return out;
}
