/**
 * Running one agent session.
 *
 * Ported from run_agent in bin/crew. Assembling the prompt and deciding the
 * invocation are separated from performing it, so the whole decision can be
 * inspected — `crew run --dry-run` prints exactly what would be launched
 * without launching it.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection, RoleName, Ship } from './config.ts';
import { API_KEY_VAR } from './environment.ts';
import type { Emitter } from './events.ts';

/**
 * A digest older than this is treated as absent. Acting on a stale queue is
 * worse than rebuilding it: the ticket it names may already have moved.
 */
export const DIGEST_MAX_AGE_SECONDS = 600;

/**
 * The permission grant. In headless mode `--allowedTools` IS the whole grant,
 * so a tool missing here is denied mid-run rather than prompted for.
 *
 * QA gets no Edit: it verifies, it never fixes. That is not a sandbox — Bash
 * can write files, and QA needs Bash for git, dev servers and Playwright —
 * but withholding the editing tool makes "bounce it back rather than fix it"
 * the path of least resistance instead of a rule to remember. Write stays,
 * for throwaway verification scripts.
 */
export function allowedTools(role: RoleName): string[] {
  // Triage classifies and nothing else: no Edit, no Write. It reads reports,
  // sets fields and comments. Withholding both editing tools makes "this is
  // not yours to fix" structural rather than a rule in a brief.
  if (role === 'triage') return ['Bash', 'Read'];
  if (role === 'qa') return ['Bash', 'Read', 'Write', 'Grep', 'Glob'];
  const base = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'];
  // The design role additionally loads skills and publishes a design canvas.
  return role === 'design' ? [...base, 'Skill', 'Artifact'] : base;
}

/**
 * Billing, and it has bitten before.
 *
 * Any of these present in the environment silently takes precedence over the
 * operator's subscription auth, and a sibling agent once burned ~66.5M tokens
 * against an org's API credits in a week purely because it inherited
 * ANTHROPIC_API_KEY from a project's .env. They are unset at exec rather than
 * merely left unassigned, because ~/.claude/settings.json has flipped billing
 * before and a local override cannot be relied on to win.
 */
export const BILLING_VARS_TO_UNSET = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
  'CLOUD_ML_REGION',
  'ANTHROPIC_MODEL',
];

export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const v of BILLING_VARS_TO_UNSET) delete out[v];
  return out;
}

export interface PromptParts {
  roster: string;
  /**
   * Everything specific to this connection and repository — ids, hooks, the
   * worktree convention. The briefs name none of it (ISSUE-293), so without
   * this section they refer to things the session has no way to resolve.
   */
  environment: string;
  common: string;
  brief: string;
  digest?: string;
  digestAgeSeconds?: number;
  digestBytes?: number;
}

/**
 * Roster first, then the environment, then the shared policy, then this
 * role's brief, then the queue.
 *
 * The roster leads because everything below refers to seats and to the
 * operator generically, and it is what binds those words to real names. The
 * environment comes next for the same reason: the briefs name no id, path or
 * command, so it is what binds THOSE words to real ones.
 */
export function assemblePrompt(p: PromptParts): string {
  const sections = [p.roster, p.environment, `${p.common}${p.brief}`];
  if (p.digest) sections.push(p.digest);
  return sections.join('\n\n');
}

export interface AgentPlan {
  role: RoleName;
  cwd: string;
  bin: string;
  args: string[];
  /** Passed on stdin, never as argv — see `spawnAgent`. */
  prompt: string;
  promptBytes: number;
  unsetEnv: string[];
  /**
   * Added to the session's environment. Carries the tracker key, so that a
   * brief never has to tell an agent where someone else's secrets are kept.
   */
  setEnv: Record<string, string>;
  digestAttached: boolean;
  digestAgeSeconds?: number;
}

export interface PlanOptions {
  role: RoleName;
  conn: Connection;
  ship: Ship;
  crewHome: string;
  stateDir: string;
  roster: string;
  environment: string;
  /** The tracker key, handed to the session in the environment. */
  apiKey?: string;
  /** Injected for testing; defaults to the real clock. */
  now?: () => number;
}

export class AgentError extends Error {}

/** Everything the run WOULD do, decided without doing any of it. */
export function planAgentRun(o: PlanOptions): AgentPlan {
  const briefPath = join(o.crewHome, 'prompts', `lane-${o.role}.md`);
  if (!existsSync(briefPath)) {
    throw new AgentError(`no brief at ${briefPath} — refusing to run an unscoped session`);
  }
  const commonPath = join(o.crewHome, 'prompts', 'common.md');
  if (!existsSync(commonPath)) throw new AgentError(`no shared policy at ${commonPath}`);

  const now = o.now ?? (() => Date.now());
  const digestPath = join(o.stateDir, `digest-${o.conn.name}-${o.role}.md`);   // see poll.ts digestPath()
  let digest: string | undefined;
  let ageSeconds: number | undefined;
  if (existsSync(digestPath)) {
    ageSeconds = Math.floor((now() - statSync(digestPath).mtimeMs) / 1000);
    if (ageSeconds <= DIGEST_MAX_AGE_SECONDS) digest = readFileSync(digestPath, 'utf8');
  }

  const prompt = assemblePrompt({
    roster: o.roster,
    environment: o.environment,
    common: readFileSync(commonPath, 'utf8'),
    brief: readFileSync(briefPath, 'utf8'),
    digest,
  });

  return {
    role: o.role,
    // The connection's directory, which is a STARTING POINT and not the
    // ticket's repo: the runner cannot know which ticket the session will
    // take, so it cannot know the checkout either. Where an area spans
    // several repos this is whichever one `repos` happened to list first
    // (config.ts), and the digest's `repo` column is what actually places
    // the work. Kept deliberately rather than guessed at (ISSUE-349).
    cwd: o.conn.dir,
    bin: o.ship.agent.bin,
    args: ['-p', '--allowedTools', ...allowedTools(o.role), '--model', o.ship.agent.model],
    prompt,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    unsetEnv: BILLING_VARS_TO_UNSET,
    setEnv: o.apiKey ? { [API_KEY_VAR]: o.apiKey } : {},
    digestAttached: digest !== undefined,
    digestAgeSeconds: ageSeconds,
  };
}

/** A human-readable account of a plan, for `--dry-run`. */
export function describePlan(p: AgentPlan): string {
  return [
    `role:    ${p.role}`,
    `cwd:     ${p.cwd}`,
    `command: ${p.bin} ${p.args.join(' ')}`,
    `prompt:  ${p.promptBytes} bytes on stdin (never argv)`,
    `digest:  ${p.digestAttached ? `attached, ${p.digestAgeSeconds}s old` : 'absent — the agent will fetch the tracker itself'}`,
    `unset:   ${p.unsetEnv.join(' ')}`,
    // The VALUE is deliberately absent: --dry-run output is pasted into
    // tickets and chat.
    `set:     ${Object.keys(p.setEnv).join(' ') || '(nothing)'}`,
  ].join('\n');
}

export interface RunResult {
  code: number;
  ms: number;
}

/**
 * Launch it.
 *
 * The prompt goes in on STDIN, never as an argv string. `claude -p` reads it
 * either way, but an argument is world-readable in `ps` output for the whole
 * run — a full policy document, including credentials it tells the agent to
 * provision, once sat in every process listing on the machine. Stdin also
 * keeps the runner clear of ARG_MAX.
 */
export function spawnAgent(plan: AgentPlan, emit: Emitter): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(plan.bin, plan.args, {
      cwd: plan.cwd,
      env: { ...scrubbedEnv(), ...plan.setEnv },
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', (err) => reject(new AgentError(`cannot run ${plan.bin}: ${err.message}`)));
    child.on('close', (code) => {
      const ms = Date.now() - started;
      emit.emit(`agent run finished (exit ${code ?? 1})`, { data: { ms, code: code ?? 1 } });
      resolve({ code: code ?? 1, ms });
    });
    child.stdin.end(plan.prompt);
  });
}
