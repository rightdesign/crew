/**
 * `crew periscope up` (EPIC-077, CREW-2854): mint a draft ticket, cut and
 * prepare its worktree, start the repository's `preview` hook and record a
 * Periscopes row, so a viewer can look at a change running on this ship.
 *
 * The ticket comes first because every worktree mechanism (branch template,
 * ports, the sweep) keys on a ticket number, and a draft is invisible to the
 * lanes and to the release sweep. The assignee on that draft (the Pair row) is
 * the hold that keeps lanes off it.
 *
 * Everything here is injected (`PeriscopeDeps`) so the ordering and the
 * tear-down on failure are tested without git, a shell or a tracker;
 * `cli.ts` supplies the real ones.
 */

export class PeriscopeError extends Error {}

export interface PeriscopeUpArgs {
  /** Only when two positional arguments were given; otherwise the repo picks the route. */
  route?: string;
  repo: string;
  topic?: string;
  isolate: boolean;
  host?: string;
  assignee?: string;
  json: boolean;
}

/** The Ship settings a periscope reads, tolerant of a config that predates them (CREW-2853). */
export interface PeriscopeLimits { maxPeriscopes?: number; periscopeIdleMinutes?: number }

export const DEFAULT_MAX_PERISCOPES = 3;
export const DEFAULT_PERISCOPE_IDLE_MINUTES = 120;

/**
 * `periscope up [route] REPO [--topic TEXT] ...`. One positional is the repo;
 * two are `route repo`. The flags arrive already read by the caller.
 */
export function parsePeriscopeUpArgs(
  positional: string[],
  flags: { topic?: string; host?: string; assignee?: string; isolate: boolean; json: boolean },
): PeriscopeUpArgs {
  const rest = positional.slice(2);   // [periscope, up|start, ...]
  if (rest.length === 0 || rest.length > 2) {
    throw new PeriscopeError('usage: crew periscope up [route] REPO [--topic TEXT] [--isolate] [--host HOST] [--assignee CREW_ROW_ID] [--json]');
  }
  const topic = flags.topic?.trim();
  return {
    ...(rest.length === 2 ? { route: rest[0] } : {}),
    repo: rest[rest.length - 1]!,
    ...(topic ? { topic } : {}),
    isolate: flags.isolate,
    ...(flags.host ? { host: flags.host } : {}),
    ...(flags.assignee ? { assignee: flags.assignee } : {}),
    json: flags.json,
  };
}

/** `KEY=value` lines a hook prints (`ports`, `isolate`) as an environment. Other lines are ignored. */
export function parseEnvLines(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
  return env;
}

/** The preview URL: the last non-empty stdout line, accepted only when it is an http(s) URL. */
export function previewUrlFrom(output: string): string | undefined {
  const last = output.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return last && /^https?:\/\/\S+$/i.test(last) ? last : undefined;
}

export function periscopeCaps(l: PeriscopeLimits): { max: number; idleMinutes: number } {
  return {
    max: l.maxPeriscopes ?? DEFAULT_MAX_PERISCOPES,
    idleMinutes: l.periscopeIdleMinutes ?? DEFAULT_PERISCOPE_IDLE_MINUTES,
  };
}

export interface HookResult { code: number; output: string }

export interface DraftTicket { id: string; tag: string; issueId: string; prefix?: string | null }

export interface PeriscopeResult {
  ticket: string;
  ticketRecordId: string;
  worktree: string;
  branch: string;
  url: string;
  periscopeRecordId: string;
}

export interface PeriscopeDeps {
  /** The repo's `preview` hook; undefined when it declares none. */
  previewHook: string | undefined;
  hasPeriscopesTable: boolean;
  liveCount(): Promise<number>;
  caps: { max: number; idleMinutes: number };
  /** A reason the base branch is not safe to cut from (the `crew worktree` stop), else undefined. */
  baseProblem(): string | undefined;
  /** The topic when `--topic` was not given (a prompt), else undefined. */
  askTopic(): Promise<string | undefined>;
  fileDraft(title: string): Promise<DraftTicket>;
  /** Cuts the worktree for the ticket; throws a PeriscopeError naming why when it cannot. */
  cutWorktree(ticket: DraftTicket): { path: string; branch: string };
  /** Copies `worktrees.copy` files then runs `setup`; a non-zero result is a failure. */
  prepare(path: string): Promise<HookResult | null>;
  /** Runs a hook in the worktree; null when the repository declares none. */
  runHook(name: 'ports' | 'isolate' | 'handoff' | 'preview', cwd: string, env: Record<string, string>): Promise<HookResult | null>;
  createRow(fields: Record<string, unknown>): Promise<{ id: string }>;
  comment(ticketId: string, body: string): Promise<void>;
  /** Stops anything listening for the worktree, removes it and its branch. */
  teardown(path: string, branch: string): Promise<void>;
  /** Closes the draft as obsolete when nothing usable came of it. */
  closeDraft(ticketId: string, note: string): Promise<void>;
  now(): Date;
  host: string;
  say(event: string, message: string, data?: Record<string, unknown>): void;
}

const tail = (s: string, n = 20) => s.trimEnd().split('\n').slice(-n).join('\n');

export function progressComment(url: string, handoff: string | undefined): string {
  return [
    `Periscope is up: ${url}`,
    ...(handoff?.trim() ? ['', handoff.trim()] : []),
  ].join('\n');
}

/**
 * The refusals that come before anything is filed or written. Exported for
 * `--dry-run`, which reports them without acting.
 */
export async function periscopePreflight(d: Pick<PeriscopeDeps, 'previewHook' | 'hasPeriscopesTable' | 'liveCount' | 'caps'>, repo: string): Promise<void> {
  if (!d.previewHook) {
    throw new PeriscopeError(`${repo} declares no \`preview\` hook, so it cannot host a periscope — add one to its .crew.yaml (see the repository spec page, "hooks.preview")`);
  }
  if (!d.hasPeriscopesTable) {
    throw new PeriscopeError('this workspace has no Periscopes table — update the Issues template and run `crew connect`');
  }
  const live = await d.liveCount();
  if (live >= d.caps.max) {
    throw new PeriscopeError(`this ship already hosts ${live} live periscope(s) (ship.maxPeriscopes is ${d.caps.max}) — discard one first`);
  }
}

export async function runPeriscopeUp(d: PeriscopeDeps, args: PeriscopeUpArgs): Promise<PeriscopeResult> {
  await periscopePreflight(d, args.repo);
  const topic = args.topic ?? (await d.askTopic())?.trim();
  if (!topic) throw new PeriscopeError('a topic is required: pass --topic TEXT');
  const unsafe = d.baseProblem();
  if (unsafe) throw new PeriscopeError(`DO NOT CUT A WORKTREE FROM THIS BASE — ${unsafe}`);

  const draft = await d.fileDraft(`Periscope: ${topic}`);
  d.say('filed', `filed draft ${draft.tag}`, { ticket: draft.tag, ticketRecordId: draft.id });

  let wt: { path: string; branch: string } | undefined;
  const abandon = async (why: string): Promise<never> => {
    // Best effort each: a failure to clean one thing must not hide the reason or skip the rest.
    if (wt) await d.teardown(wt.path, wt.branch).catch(() => {});
    await d.closeDraft(draft.id, `Periscope abandoned: ${why.split('\n')[0]}`).catch(() => {});
    throw new PeriscopeError(why);
  };

  try {
    wt = d.cutWorktree(draft);
  } catch (e) {
    return abandon((e as Error).message);
  }
  d.say('worktree', `cut ${wt.path} on ${wt.branch}`, { worktree: wt.path, branch: wt.branch });

  const prepared = await d.prepare(wt.path);
  if (prepared && prepared.code !== 0) {
    return abandon(`setup failed (exit ${prepared.code})\n${tail(prepared.output)}`);
  }

  const env: Record<string, string> = { CREW_TICKET: draft.tag, CREW_BRANCH: wt.branch };
  const ports = await d.runHook('ports', wt.path, env);
  if (ports) Object.assign(env, parseEnvLines(ports.output));
  if (args.isolate) {
    const iso = await d.runHook('isolate', wt.path, env);
    if (iso && iso.code !== 0) return abandon(`isolate failed (exit ${iso.code})\n${tail(iso.output)}`);
    if (iso) Object.assign(env, parseEnvLines(iso.output));
  }
  const handoff = await d.runHook('handoff', wt.path, env);
  if (handoff && handoff.code !== 0) return abandon(`handoff failed (exit ${handoff.code})\n${tail(handoff.output)}`);

  const preview = await d.runHook('preview', wt.path, { ...env, CREW_PREVIEW_HOST: d.host });
  if (!preview || preview.code !== 0) {
    return abandon(`preview exited ${preview?.code ?? 'without running'}\n${tail(preview?.output ?? '')}`);
  }
  const url = previewUrlFrom(preview.output);
  if (!url) return abandon(`preview printed no URL as its last line\n${tail(preview.output)}`);
  d.say('preview', `preview at ${url}`, { url });

  const now = d.now();
  let row: { id: string };
  try {
    row = await d.createRow({
      issue_id: draft.id,
      url,
      host: d.host,
      worktree: wt.path,
      branch: wt.branch,
      state: 'live',
      isolated: args.isolate,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      expires_at: new Date(now.getTime() + d.caps.idleMinutes * 60_000).toISOString(),
    });
  } catch (e) {
    return abandon(`recording the Periscopes row failed: ${(e as Error).message}`);
  }
  d.say('recorded', 'recorded the Periscopes row', { periscopeRecordId: row.id });

  // The row and the server are real by now; a comment that fails to post
  // should not undo them, so say so and carry on.
  await d.comment(draft.id, progressComment(url, handoff?.output)).catch((e: Error) => {
    d.say('warning', `progress comment not posted: ${e.message}`);
  });

  return { ticket: draft.tag, ticketRecordId: draft.id, worktree: wt.path, branch: wt.branch, url, periscopeRecordId: row.id };
}
