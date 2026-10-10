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
import { finished } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Route, RoleName, Ship } from './config.ts';
import { routeSlug } from './config.ts';
import { API_KEY_VAR } from './environment.ts';
import type { Emitter } from './events.ts';
import { adapterFor, resolveToolchain } from './toolchain.ts';
import { reportAgentRun, type AgentLogTarget, type AgentCycle } from './agent-log.ts';
import { TicketAttributionTracker } from './ticket-attribution.ts';

/**
 * A digest older than this is treated as absent. Acting on a stale queue is
 * worse than rebuilding it: the ticket it names may already have moved.
 */
export const DIGEST_MAX_AGE_SECONDS = 600;

const LEGACY_TOOLCHAIN_HARNESS = 'claude';

// The tool grant, deny list and billing scrub are the Claude adapter's now
// (CREW-1511); re-exported so existing importers keep working.
export { allowedTools, DISALLOWED_TOOLS, BILLING_VARS_TO_UNSET } from './adapters/claude.ts';

/** The environment a session inherits: the process's own, minus the harness's billing-sensitive vars. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env, harness = LEGACY_TOOLCHAIN_HARNESS): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const v of adapterFor(harness).unsetEnv) delete out[v];
  return out;
}

/**
 * Set in every headless agent session's environment (below), to whichever
 * role planned the run. Two independent things key off it: the operator's
 * `pair-context-hook.sh` (see the comment on `setEnv.CREW_LANE_ROLE` below),
 * and `cli.ts`'s own refusal of state-writing subcommands run from inside a
 * session (ISSUE-980) — the same value, read for a second, unrelated reason.
 */
export const CREW_LANE_ROLE_VAR = 'CREW_LANE_ROLE';

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
  /**
   * Which toolchain (`toolchains:` entry) and harness adapter planned this
   * run. `harness` is optional so a hand-built plan means Claude, as before.
   */
  toolchain?: string;
  harness?: string;
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
  /**
   * Where to report this run's Agent Log / Agent Log Cycles rows
   * (ISSUE-416/ISSUE-457), when the route has a resolved workspace to
   * report into and a key to report with. Undefined skips reporting
   * entirely — same as a route `crew connect` hasn't run on yet.
   */
  agentLog?: AgentLogTarget;
  /**
   * ISSUE-377/529 — carried straight through to `reportAgentRun`, see
   * `AgentRunReport.promptVersion`/`promptSha` (agent-log.ts) for what each
   * one means and how `crew logbook show --prompt` uses it.
   */
  promptVersion?: string;
  promptSha: string;
}

export interface PlanOptions {
  role: RoleName;
  route: Route;
  ship: Ship;
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
  /**
   * A workspace admin's live edit to this role's Agent-table prompt
   * (`agents.ts` `fetchDivergedPrompt`, ISSUE-526), replacing
   * `common.md`+`lane-<role>.md` wholesale when present — that row's
   * `prompt` field IS what those two files' concatenation seeds it with, so
   * a diverged row already carries the full replacement text, not just the
   * lane-specific part. Undefined (the common case) keeps today's
   * local-files behavior; fetching it is the caller's job, not
   * `planAgentRun`'s — this function stays local-I/O only.
   */
  divergedPrompt?: string;
  /**
   * The linked Agent row's own `model` field (`agents.ts`
   * `fetchSeatAgentModel`, ISSUE-611), overriding `ship.agent.model` for
   * this run when the workspace has set one. Undefined (no seat, no linked
   * Agent, or the row has no `model`) keeps today's ship-wide default.
   * Fetching it is the caller's job, same as `divergedPrompt` above.
   */
  agentModel?: string;
  /**
   * `role`'s linked Agent row id, straight from `agents.ts`'s
   * `resolveAgentId` (ISSUE-670) — the same cache-then-seat-fallback
   * resolution `fetchDivergedPrompt`/`fetchSeatAgentModel` already use, so
   * Agent Log attribution stops depending on `crew agents sync` ever having
   * run. Before this field existed, `agentLog.agentId` below read the sync
   * cache directly and stayed empty for any route provisioned solely
   * through `crew connect` (ISSUE-609/610/611) — every one of that route's
   * runs then logged as "Unknown persona" in the Activity Log, since the
   * seat-linked Agent row was resolvable but nothing was resolving it for
   * logging. Undefined (no seat, no linked Agent, unreachable tracker) keeps
   * today's no-Agent-reference report.
   */
  resolvedAgentId?: string;
}

export class AgentError extends Error {}

/**
 * The agent binary could not be started at all: `spawn` emitted `error`,
 * typically ENOENT because `ship.agent.bin` is not on this machine's PATH.
 * Nothing ran, so there is no run to log, and the daemon treats it as a
 * failed start rather than a started role (ISSUE-1365).
 */
export class AgentSpawnError extends AgentError {}

/** Everything the run WOULD do, decided without doing any of it. */
export function planAgentRun(o: PlanOptions): AgentPlan {
  const briefPath = join(o.route.promptsDir, 'personas', `lane-${o.role}.md`);
  if (!existsSync(briefPath)) {
    throw new AgentError(`no brief at ${briefPath} — refusing to run an unscoped session`);
  }
  const commonPath = join(o.route.promptsDir, 'personas', 'common.md');
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

  const common = readFileSync(commonPath, 'utf8');
  const brief = readFileSync(briefPath, 'utf8');
  // A diverged row's prompt is the full common+brief replacement (see
  // `divergedPrompt`'s own doc on `PlanOptions`), so it goes entirely into
  // `brief` with `common` left empty rather than splitting it back apart.
  const effectiveCommon = o.divergedPrompt ? '' : common;
  const effectiveBrief = o.divergedPrompt ?? brief;
  const prompt = assemblePrompt({
    roster: o.roster,
    environment: o.environment,
    common: effectiveCommon,
    brief: effectiveBrief,
    digest,
  });
  // ISSUE-377/529: hashed at composition time, over whatever content was
  // actually assembled above (the diverged replacement when present, else
  // the local common+brief) — exactly the string `crew agents sync`
  // (agents.ts's `personaDefaultPrompt`) pushes into this role's Agents row
  // when not diverged, so a later `crew logbook show --prompt` can tell
  // whether the local file has moved on from what `prompt_version` points at.
  const promptSha = createHash('sha256').update(`${effectiveCommon}${effectiveBrief}`).digest('hex');

  const streamsDir = join(o.stateDir, 'streams');
  const base = `${routeLabel}-${o.role}-${o.cycle}`;
  const toolchain = resolveToolchain(o.ship, o.route);
  const adapter = adapterFor(toolchain.harness);
  const model = o.agentModel ?? toolchain.model;
  const invocation = adapter.invocation(toolchain, {
    role: o.role,
    model,
    // Skipped when there's no key to send: a route `crew connect` hasn't
    // resolved yet has nothing to authenticate the MCP connection with either.
    mcp: o.apiKey ? { url: `${o.route.baseUrl}/api/mcp`, keyVar: API_KEY_VAR } : undefined,
  });

  // Reporting needs a resolved workspace (`crew connect`) and a key to call
  // it with — either is missing for a route that hasn't been connected, or
  // in tests that build a bare Route by hand. `agentId` is best-effort on
  // top of that: `o.resolvedAgentId` (ISSUE-670) already fell back to the
  // seat's own linked Agent row when `crew agents sync` has never run, and
  // the endpoint accepts a run with no Agent reference for the cases even
  // that can't resolve (no seat, no linked Agent, unreachable tracker).
  const agentLog: AgentPlan['agentLog'] = o.route.resolved && o.apiKey
    ? {
        baseUrl: o.route.baseUrl,
        workspaceId: o.route.resolved.workspaceId,
        apiKey: o.apiKey,
        userAgent: o.ship.userAgent,
        agentId: o.resolvedAgentId,
      }
    : undefined;

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
    bin: invocation.bin,
    args: invocation.args,
    toolchain: toolchain.name,
    harness: toolchain.harness,
    prompt,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    unsetEnv: adapter.unsetEnv,
    setEnv: {
      ...(o.apiKey ? { [API_KEY_VAR]: o.apiKey } : {}),
      ...adapter.runEnv(toolchain),
      // The operator's global SessionStart hook (pair-context-hook.sh) injects
      // the interactive Pair persona's prompt for any session it can't tell
      // apart from a person's own terminal. Every headless lane run this
      // planner produces carries a real ticket brief already (`prompt`
      // above) — it must never be replaced by the Pair persona with no
      // ticket attached, which silently no-ops and strands the ticket
      // in_progress (ISSUE-490, ISSUE-591). Setting this is what lets that
      // hook tell the two apart; it has nothing to do with the run itself.
      [CREW_LANE_ROLE_VAR]: o.role,
    },
    digestAttached: digest !== undefined,
    digestAgeSeconds: ageSeconds,
    model,
    streamPath: join(streamsDir, `${base}.jsonl`),
    eventsPath: join(streamsDir, `${base}.events.jsonl`),
    ticket: o.ticket,
    agentLog,
    promptVersion: o.route.resolved?.agentPersonas?.[o.role]?.historyId,
    promptSha,
  };
}

/** A human-readable account of a plan, for `--dry-run`. */
export function describePlan(p: AgentPlan): string {
  return [
    `role:    ${p.role}`,
    // Only for a non-default toolchain, so a plain Claude run's output is unchanged.
    ...(p.toolchain && p.toolchain !== 'claude' ? [`toolchain: ${p.toolchain} (${p.harness ?? 'claude'})`] : []),
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
 * Ends a sink and waits for its buffered writes to actually land on disk.
 *
 * `WriteStream#end()` is asynchronous — a caller reading the file right after
 * `spawnAgent`'s promise resolves (as tests and any post-mortem tooling do)
 * can otherwise see a short or empty file. Same degrade-quietly contract as
 * `openSink`: a sink that errors on flush must not fail the run it was only
 * ever a side-channel for.
 */
function endSink(sink: WriteStream | undefined): Promise<void> {
  if (!sink) return Promise.resolve();
  sink.end();
  return finished(sink).catch(() => undefined);
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
  const adapter = adapterFor(plan.harness ?? LEGACY_TOOLCHAIN_HARNESS);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const rawSink = openSink(plan.streamPath);
  const eventsSink = openSink(plan.eventsPath);

  return new Promise((resolve, reject) => {
    const child = spawn(plan.bin, plan.args, {
      cwd: plan.cwd,
      env: { ...scrubbedEnv(process.env, adapter.harness), ...plan.setEnv },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let buf = '';
    let result: ReturnType<typeof adapter.extractResult>;
    // One buffered Agent Log Cycle per `thought` block or assistant `text`
    // turn seen, in order (ISSUE-594 widened this from thinking-only) — the
    // whole point of Agent Log Cycles (WORKSPACE_AGENTS_PLAN.md) is capturing
    // a run's visible output, and a turn with neither contributes nothing
    // worth a row. Flushed against the Agent Log row's id once the run
    // finishes and that row exists — see the `close` handler below.
    const cycles: AgentCycle[] = [];
    // Which ticket this run actually spent its tokens on, independent of
    // `plan.ticket` (the pre-run poll hint) — see `ticket-attribution.ts`'s
    // module doc for why the two can diverge.
    const attribution = new TicketAttributionTracker();

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
        result = adapter.extractResult(parsed) ?? result;
        let turnText = '';
        for (const ev of adapter.mapStreamLine(parsed)) {
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
          if ((ev.kind === 'thought' || ev.kind === 'text') && ev.text) {
            turnText += `${ev.text}\n`;
            const cycleIndex = cycles.length;
            cycles.push({
              cycleIndex,
              occurredAt: e.at,
              thinking: ev.text,
              // A conversational `text` turn is tagged 'assistant' so it's
              // distinguishable from a thinking block once both share this
              // buffer (ISSUE-594) — matching the precedent
              // `agent-chat.service.ts`'s logChatRun (ISSUE-504) already set
              // for the same column. A `thought` cycle stays untagged, same
              // as before this change.
              ...(ev.kind === 'text' ? { role: 'assistant' as const } : {}),
            });
            // A second event alongside the raw `thought`/`text` one above
            // (ISSUE-481) — a live consumer (crew-macos's log window) wants
            // the same text correlated with the Agent Log Cycle it will end
            // up as (`cycleIndex`, matching `AgentCycle` above) plus which
            // seat/persona produced it, not just the bare text the source
            // event carries. `cycleIndex` only exists here, in the buffer
            // this function already owns, not in `mapStreamLine` — that
            // mapper is deliberately a pure, per-line function with no run
            // state (module doc above), so it stays the one place deciding
            // "is this a thinking block or a text turn", and this is the one
            // place that knows which numbered cycle it became. `role`,
            // `route`, `ticket` are already on the envelope via the `e`
            // spread, which is what a persona display already needs.
            eventsSink?.write(`${JSON.stringify({
              ...e,
              message: 'cycle',
              data: { kind: 'cycle', cycleIndex, text: ev.text },
            })}\n`);
          }
        }
        // Only an `assistant` line carries `message.usage` (one real API
        // call), so this is a no-op for every other line type — including
        // the tool-only assistant lines already folded into `turnText`
        // above as an empty string, which `TicketAttributionTracker.add`
        // treats as "no new mention, keep crediting whatever ticket was
        // last named."
        const turnTokens = adapter.extractTurnTokens(parsed);
        if (turnTokens !== undefined) attribution.add(turnText, turnTokens);
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

    // Set when `spawn` itself failed. Node still emits `close` after `error`
    // in that case, and the close handler below must not then report a run
    // that never happened: no "agent run finished" event, no Agent Log row.
    let spawnFailed = false;
    child.on('error', (err) => {
      spawnFailed = true;
      reject(new AgentSpawnError(`cannot run ${plan.bin}: ${err.message}`));
    });
    child.on('close', async (code) => {
      if (buf) handleLine(buf);
      await Promise.all([endSink(rawSink), endSink(eventsSink)]);
      if (spawnFailed) return;
      // The ticket the transcript actually spent the most tokens on, falling
      // back to the pre-run poll hint when the visible text never named one
      // (e.g. an administrative run with nothing ticket-specific to say).
      const attributedTicket = attribution.winner(plan.ticket);
      try {
        writeFileSync(`${plan.streamPath}.meta.json`, JSON.stringify({
          route: plan.route, role: plan.role, ticket: plan.ticket ?? null,
          attributedTicket: attributedTicket ?? null,
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
      if (plan.agentLog) {
        try {
          await reportAgentRun(plan.agentLog, {
            ticketReference: attributedTicket,
            outcome: (code ?? 1) === 0 ? 'success' : 'error',
            startedAt,
            finishedAt: new Date().toISOString(),
            cycles,
            model: plan.model,
            tokensIn: result?.inputTokens,
            tokensOut: result?.outputTokens,
            cacheReadTokens: result?.cacheReadTokens,
            cacheWriteTokens: result?.cacheCreationTokens,
            costUsd: result?.totalCostUsd,
            promptVersion: plan.promptVersion,
            promptSha: plan.promptSha,
          });
        } catch (e) {
          // A workspace that has never been provisioned/backfilled (ISSUE-465),
          // or a plain network hiccup, must not fail the run it is reporting
          // on — same reasoning as `openSink`'s degrade-quietly contract above.
          emit.warn(`could not report agent log: ${(e as Error).message}`, { step: 'agent' });
        }
      }
      resolve({ code: code ?? 1, ms });
    });
    // An agent that exits (or closes stdin) before the prompt is fully written
    // breaks the pipe under this write. Without a listener that EPIPE is an
    // unhandled 'error' event and takes the whole `crew run` down with a stack
    // trace (CREW-983) — instead of the run being reported, as it should be,
    // by the `close` handler above, which sees the child's real exit code
    // either way. So the write failing is noted, never fatal.
    child.stdin.on('error', (err) => {
      emit.warn(`agent closed stdin before the prompt was delivered: ${err.message}`, { step: 'agent' });
    });
    child.stdin.end(plan.prompt);
  });
}
