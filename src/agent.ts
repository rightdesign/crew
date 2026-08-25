/**
 * Running one agent session.
 *
 * Ported from run_agent in bin/crew. Assembling the prompt and deciding the
 * invocation are separated from performing it, so the whole decision can be
 * inspected — `crew run --dry-run` prints exactly what would be launched
 * without launching it.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, createWriteStream, type WriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Route, RoleName, Ship } from './config.ts';
import { routeSlug } from './config.ts';
import { API_KEY_VAR } from './environment.ts';
import type { Emitter } from './events.ts';
import { mapStreamLine, extractResult } from './stream.ts';

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
   * Everything specific to this route and repository — ids, hooks, the
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
  route: string;
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
  model: string;
  /**
   * Where the raw `stream-json` NDJSON for this run is saved, unmodified,
   * as it is parsed (ISSUE-401) — the post-mortem artifact and what
   * crew-macos will browse.
   */
  streamPath: string;
  /**
   * Fine-grained per-block (thought/text/tool) events, mapped from the
   * stream but kept OUT of the shared `events.jsonl` that `crew status`
   * scans — a long session is thousands of tool calls, and that file is
   * not the place for them. A view opts in by tailing this file directly.
   */
  eventsPath: string;
  /** Best-effort — the ticket this run is expected to work, if known yet. */
  ticket?: string;
}

export interface PlanOptions {
  role: RoleName;
  route: Route;
  ship: Ship;
  crewHome: string;
  stateDir: string;
  roster: string;
  environment: string;
  /** The tracker key, handed to the session in the environment. */
  apiKey?: string;
  /**
   * Groups this run with the rest of its poll cycle in the streams
   * directory — same id as the `Emitter` driving the run (`emit.cycle`).
   */
  cycle: string;
  /** Best-effort — the top actionable ticket the poll saw, if any. */
  ticket?: string;
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
  const routeLabel = routeSlug(o.route.route);
  const digestPath = join(o.stateDir, `digest-${routeLabel}-${o.role}.md`);   // see poll.ts digestPath()
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

  const streamsDir = join(o.stateDir, 'streams');
  const base = `${routeLabel}-${o.role}-${o.cycle}`;

  return {
    role: o.role,
    route: routeLabel,
    // The route's directory, which is a STARTING POINT and not the
    // ticket's repo: the runner cannot know which ticket the session will
    // take, so it cannot know the checkout either. Where an area spans
    // several repos this is whichever one `repos` happened to list first
    // (config.ts), and the digest's `repo` column is what actually places
    // the work. Kept deliberately rather than guessed at (ISSUE-349).
    cwd: o.route.dir,
    bin: o.ship.agent.bin,
    args: [
      '-p', '--allowedTools', ...allowedTools(o.role), '--model', o.ship.agent.model,
      '--output-format', 'stream-json', '--verbose',
    ],
    prompt,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    unsetEnv: BILLING_VARS_TO_UNSET,
    setEnv: o.apiKey ? { [API_KEY_VAR]: o.apiKey } : {},
    digestAttached: digest !== undefined,
    digestAgeSeconds: ageSeconds,
    model: o.ship.agent.model,
    streamPath: join(streamsDir, `${base}.jsonl`),
    eventsPath: join(streamsDir, `${base}.events.jsonl`),
    ticket: o.ticket,
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
    `stream:  ${p.streamPath}`,
  ].join('\n');
}

export interface RunResult {
  code: number;
  ms: number;
}

/**
 * Opens a sink for writing, or gives up quietly.
 *
 * Same rule as `Emitter.emit`'s own sinks: a stream that cannot be prepared
 * degrades observability, it must never prevent the agent run itself.
 */
function openSink(path: string): WriteStream | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return createWriteStream(path, { flags: 'a' });
  } catch {
    return undefined;
  }
}

/**
 * Launch it.
 *
 * The prompt goes in on STDIN, never as an argv string. `claude -p` reads it
 * either way, but an argument is world-readable in `ps` output for the whole
 * run — a full policy document, including credentials it tells the agent to
 * provision, once sat in every process listing on the machine. Stdin also
 * keeps the runner clear of ARG_MAX.
 *
 * Stdout is `--output-format stream-json`: NDJSON, one object per assistant
 * turn/tool-call/tool-result plus a final `{type:"result"}`. It is piped
 * rather than inherited (ISSUE-401) so the crew can both save it verbatim
 * (`plan.streamPath` — the post-mortem artifact) and map it onto the crew's
 * own event model (`plan.eventsPath` — see the module doc on `AgentPlan`
 * for why that is a separate file from the shared `events.jsonl`).
 */
export function spawnAgent(plan: AgentPlan, emit: Emitter): Promise<RunResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const rawSink = openSink(plan.streamPath);
  const eventsSink = openSink(plan.eventsPath);

  return new Promise((resolve, reject) => {
    const child = spawn(plan.bin, plan.args, {
      cwd: plan.cwd,
      env: { ...scrubbedEnv(), ...plan.setEnv },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let buf = '';
    let result: ReturnType<typeof extractResult>;

    const handleLine = (line: string) => {
      if (!line) return;
      try { rawSink?.write(`${line}\n`); } catch { /* a lost stream copy must not stop the run */ }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;   // not our schema's stability guarantee — drop and move on
      }
      try {
        result = extractResult(parsed) ?? result;
        for (const ev of mapStreamLine(parsed)) {
          const e = {
            at: new Date().toISOString(),
            cycle: emit.cycle,
            route: plan.route,
            step: 'agent' as const,
            level: 'info' as const,
            message: ev.kind === 'tool' ? `${ev.tool ?? 'tool'}${ev.target ? ` ${ev.target}` : ''}` : ev.kind,
            role: plan.role,
            ...(plan.ticket ? { ticket: plan.ticket } : {}),
            data: { kind: ev.kind, ...(ev.text ? { text: ev.text } : {}), ...(ev.tool ? { tool: ev.tool } : {}), ...(ev.target ? { target: ev.target } : {}) },
          };
          eventsSink?.write(`${JSON.stringify(e)}\n`);
        }
      } catch {
        /* a shape this run's mapping does not expect must not kill the cycle */
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    child.on('error', (err) => reject(new AgentError(`cannot run ${plan.bin}: ${err.message}`)));
    child.on('close', (code) => {
      if (buf) handleLine(buf);
      rawSink?.end();
      eventsSink?.end();
      try {
        writeFileSync(`${plan.streamPath}.meta.json`, JSON.stringify({
          route: plan.route, role: plan.role, ticket: plan.ticket ?? null,
          startedAt, exitCode: code ?? 1, model: plan.model,
          sessionId: result?.sessionId ?? null, numTurns: result?.numTurns ?? null,
          totalCostUsd: result?.totalCostUsd ?? null,
        }));
      } catch { /* ditto — the sidecar is a convenience, not load-bearing */ }
      const ms = Date.now() - started;
      emit.emit(`agent run finished (exit ${code ?? 1})`, {
        data: {
          ms, code: code ?? 1,
          ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result?.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
          ...(result?.totalCostUsd !== undefined ? { totalCostUsd: result.totalCostUsd } : {}),
        },
      });
      resolve({ code: code ?? 1, ms });
    });
    child.stdin.end(plan.prompt);
  });
}
