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
}

export type SkillSyncAction = 'created' | 'updated' | 'unchanged' | 'diverged';

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
  opts: { userAgent?: string; dryRun?: boolean },
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
      });
      agentSkills[skill.name] = { skillId: created.id, lastSyncedUpdatedAt: created.updated_at };
      outcomes.push({ name: skill.name, action: 'created', skillId: created.id });
      continue;
    }

    if (row.description === skill.description && row.prompt === skill.prompt) {
      // In sync content-wise regardless of who wrote it last — nothing to
      // push, just (re)anchor the cache to the row's current updated_at so
      // a later sync's compare-and-swap has the right baseline.
      agentSkills[skill.name] = { skillId: row.id, lastSyncedUpdatedAt: row.updated_at };
      outcomes.push({ name: skill.name, action: 'unchanged', skillId: row.id });
      continue;
    }

    const knownBaseline = cache[skill.name]?.skillId === row.id ? cache[skill.name]?.lastSyncedUpdatedAt : undefined;
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
        skillsModel.id, row.id, { description: skill.description, prompt: skill.prompt }, knownBaseline,
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
    case 'diverged': return `${o.name}: HAS LOCAL EDITS — crew's default is newer but was NOT applied; review ${o.skillId} in the app before syncing again`;
  }
}
