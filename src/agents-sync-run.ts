import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ROLE_NAMES, resolvedPathFor, type Route } from './config.ts';
import {
  syncPersonas, fetchKeyRole, isAdminRole, isForbidden, personaDefaultPrompt, describeSyncOutcome, describeCrewLink,
} from './agents.ts';
import { syncSkills, skillMarkerWarnings, describeSkillSyncOutcome } from './skills.ts';

export interface AgentsSyncRunOptions {
  userAgent?: string;
  stateDir: string;
  dryRun?: boolean;
  force?: boolean;
  /** Where the outcome lines go: stdout for `crew agents sync`, stderr for `crew connect` (whose stdout is the route block). */
  say: (line: string) => void;
  /** Where a warning goes. */
  warn: (line: string) => void;
}

export interface AgentsSyncRunResult {
  personaResult: Awaited<ReturnType<typeof syncPersonas>>;
  skillResult?: Awaited<ReturnType<typeof syncSkills>>;
  /** True when this key could not write the workspace's Agents / Agent Skills rows and only linked what exists. */
  readOnly: boolean;
  /** A persona or skill whose workspace row differs from crew's: needs an operator, not this run's failure. */
  diverged: boolean;
}

/**
 * The persona + skill sync `crew agents sync` performs, shared with `crew
 * connect` (CREW-2241) so an admin's first connect leaves the workspace with
 * its Agents / Agent Skills rows without a second command. Throws
 * `AgentsSyncError` / `SkillSyncError` for the caller to report; seat key
 * minting is deliberately not here (`connect` and `agents sync` each own it).
 *
 * CREW-1797: the persona/skill rows are a workspace admin's. A non-admin key
 * links this ship's seats to whatever rows exist and writes nothing else; a
 * 403 from any admin-only write is reported the same way instead of thrown.
 * An unreadable role keeps today's behavior (attempt, let the 403 decide).
 */
export async function runAgentsSync(target: Route, o: AgentsSyncRunOptions): Promise<AgentsSyncRunResult> {
  const dryRun = o.dryRun ?? false;
  const force = o.force ?? false;
  const keyRole = target.resolved?.role ?? await fetchKeyRole(target, o.userAgent);
  let readOnly = !isAdminRole(keyRole);
  const runPersonas = (ro: boolean) => syncPersonas(target, { userAgent: o.userAgent, dryRun, force, readOnly: ro });
  let personaResult: Awaited<ReturnType<typeof syncPersonas>>;
  try {
    personaResult = await runPersonas(readOnly);
  } catch (e) {
    if (readOnly || !isForbidden(e)) throw e;
    readOnly = true;
    personaResult = await runPersonas(true);
  }
  o.say(`route: ${target.route}`);
  for (const p of personaResult.outcomes) o.say(describeSyncOutcome(p));
  for (const l of personaResult.crewLinks) o.say(describeCrewLink(l));
  if (personaResult.releaseNote) o.say(personaResult.releaseNote);
  // CREW-1534: a brief's `{{skill: Name}}` include of a skill this preset
  // does not ship would refuse every run of that seat, so say so here.
  const briefs = Object.fromEntries(ROLE_NAMES.map((r) => [r, personaDefaultPrompt(target.promptsDir, r)]));
  for (const w of skillMarkerWarnings(target.promptsDir, briefs)) o.warn(`warning: ${w}`);
  // "Agents" means every agent-shaped resource crew owns — personas AND
  // skills; `crew skills sync` stays available for pushing skills alone.
  let skillResult: Awaited<ReturnType<typeof syncSkills>> | undefined;
  if (!readOnly) {
    try {
      skillResult = await syncSkills(target, { userAgent: o.userAgent, dryRun, force });
    } catch (e) {
      if (isForbidden(e)) readOnly = true;
      else throw e;
    }
  }
  for (const s of skillResult?.outcomes ?? []) o.say(describeSkillSyncOutcome(s));
  if (!dryRun) {
    // Persist `agentPersonas` and `agentSkills` into this route's resolved
    // state file — merge-not-clobber, since a hand-authored `contract` block
    // or another field this knows nothing about must survive untouched.
    const resolvedPath = resolvedPathFor(o.stateDir, target.route);
    const raw = existsSync(resolvedPath) ? JSON.parse(readFileSync(resolvedPath, 'utf8')) : {};
    raw.agentPersonas = personaResult.agentPersonas;
    if (skillResult) raw.agentSkills = skillResult.agentSkills;
    if (personaResult.releaseAgentId) raw.releaseAgentId = personaResult.releaseAgentId;
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, `${JSON.stringify(raw, null, 2)}\n`);
    if (target.resolved) {
      target.resolved.agentPersonas = personaResult.agentPersonas;
      if (personaResult.releaseAgentId) target.resolved.releaseAgentId = personaResult.releaseAgentId;
    }
  }
  if (readOnly) {
    o.say("personas and skills: not synced (this key is not a workspace admin; the workspace's rows are used as they are)");
  }
  const diverged = personaResult.outcomes.some((p) => p.action === 'diverged')
    || (skillResult?.outcomes.some((s) => s.action === 'diverged') ?? false);
  return { personaResult, skillResult, readOnly, diverged };
}
