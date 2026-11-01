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

// ---------------------------------------------------------------------------
// `crew periscope down` and `crew periscope list` (CREW-2855)
// ---------------------------------------------------------------------------

export interface PeriscopeDownArgs {
  route?: string;
  /** The ticket number, digits only. */
  number: string;
  mode: 'keep' | 'discard';
  allowEmpty: boolean;
  json: boolean;
}

/**
 * `periscope down|end [route] NNN --keep|--discard [--allow-empty]`. Exactly
 * one of the two flags is required: crew never picks the ending path for the
 * viewer.
 */
export function parsePeriscopeDownArgs(
  positional: string[],
  flags: { keep: boolean; discard: boolean; allowEmpty: boolean; json: boolean },
): PeriscopeDownArgs {
  const usage = 'usage: crew periscope down [route] NNN --keep|--discard [--allow-empty] [--json]';
  const rest = positional.slice(2);   // [periscope, down|end, ...]
  if (rest.length === 0 || rest.length > 2) throw new PeriscopeError(usage);
  if (flags.keep === flags.discard) throw new PeriscopeError(`pass exactly one of --keep or --discard\n${usage}`);
  const m = /^(?:[A-Za-z]+-)?(\d+)$/.exec(rest[rest.length - 1]!);
  if (!m) throw new PeriscopeError(`"${rest[rest.length - 1]}" is not a ticket number\n${usage}`);
  return {
    ...(rest.length === 2 ? { route: rest[0] } : {}),
    number: m[1]!,
    mode: flags.keep ? 'keep' : 'discard',
    allowEmpty: flags.allowEmpty,
    json: flags.json,
  };
}

/** A Periscopes row joined to its ticket. */
export interface PeriscopeRowInfo {
  id: string;
  ticketRecordId: string;
  ticket: string;
  number: string;
  repo: string;
  state: string;
  url: string;
  worktree: string;
  branch: string;
  lastActivityAt: string | null;
}

export interface ChangedFile { path: string; added: number; removed: number }

export interface PeriscopeDownDeps {
  /** This ship's row(s) for the ticket number, any state, newest first. */
  rowsForTicket(number: string): Promise<PeriscopeRowInfo[]>;
  /** Uncommitted changes in the worktree. */
  hasChanges(worktree: string): boolean;
  /** Stages and commits everything with `message`. */
  commitAll(worktree: string, message: string): void;
  /** Pushes the branch (a plain fast-forward) and returns the pushed sha and remote name. */
  push(worktree: string, branch: string): { sha: string; remote: string };
  /** Files the branch changes against the remote base. */
  changedFiles(worktree: string): ChangedFile[];
  /** The ticket's current description, project and repo. */
  readTicket(ticketRecordId: string): Promise<{ description: string; hasProject: boolean; hasRepo: boolean }>;
  updateTicket(ticketRecordId: string, patch: { description?: string; fillProjectAndRepo: boolean; status: 'new' | 'discarded'; note?: string }): Promise<void>;
  postPushed(ticketRecordId: string, sha: string, remote: string, branch: string): Promise<void>;
  /** Kills what listens for the worktree. Returns how many processes were stopped. */
  stopServer(worktree: string, number: string): Promise<number>;
  /** Removes the worktree; with `deleteBranch` also the local branch. */
  removeWorktree(worktree: string, branch: string, deleteBranch: boolean): void;
  setRowState(rowId: string, state: 'kept' | 'discarded'): Promise<void>;
  say(event: string, message: string, data?: Record<string, unknown>): void;
}

export const PROTOTYPE_HEADING = '## Prototype';

/** The section `down --keep` appends to the ticket description. */
export function prototypeSection(files: ChangedFile[]): string {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return [
    PROTOTYPE_HEADING,
    '',
    'This branch began as a Periscope prototype and may be rewritten rather than treated as reviewed work.',
    '',
    ...(files.length === 0 ? ['No files differ from the base.'] : files.map((f) => `- \`${f.path}\` (+${f.added} −${f.removed})`)),
    '',
    `${files.length} file${files.length === 1 ? '' : 's'} changed, ${added} insertion${added === 1 ? '' : 's'}(+), ${removed} deletion${removed === 1 ? '' : 's'}(−)`,
  ].join('\n');
}

export interface PeriscopeDownResult {
  ticket: string;
  mode: 'keep' | 'discard';
  /** `unchanged` when the row was already kept or discarded. */
  outcome: 'done' | 'unchanged';
  state: string;
  sha?: string;
}

export async function runPeriscopeDown(d: PeriscopeDownDeps, args: PeriscopeDownArgs): Promise<PeriscopeDownResult> {
  const rows = await d.rowsForTicket(args.number);
  if (rows.length === 0) throw new PeriscopeError(`no periscope for ticket ${args.number} on this ship`);
  const row = rows.find((r) => r.state === 'live');
  if (!row) {
    const done = rows[0]!;
    d.say('unchanged', `${done.ticket} is already ${done.state}; nothing to do`);
    return { ticket: done.ticket, mode: args.mode, outcome: 'unchanged', state: done.state };
  }

  if (args.mode === 'discard') {
    const killed = await d.stopServer(row.worktree, row.number);
    d.say('server', killed ? `stopped ${killed} process(es)` : 'no server was listening');
    d.removeWorktree(row.worktree, row.branch, true);
    d.say('worktree', `removed ${row.worktree} and branch ${row.branch}`);
    await d.updateTicket(row.ticketRecordId, {
      status: 'discarded', fillProjectAndRepo: false, note: 'The periscope was discarded; nothing was pushed.',
    });
    d.say('ticket', `${row.ticket} closed as obsolete`);
    await d.setRowState(row.id, 'discarded');
    d.say('row', 'row is discarded');
    return { ticket: row.ticket, mode: 'discard', outcome: 'done', state: 'discarded' };
  }

  // Keep. Refuse before changing anything when there is nothing to keep.
  const dirty = d.hasChanges(row.worktree);
  if (!dirty && !args.allowEmpty) {
    throw new PeriscopeError(`${row.ticket} has nothing to commit; pass --allow-empty to keep the branch anyway, or --discard`);
  }
  if (dirty) {
    d.commitAll(row.worktree, `${row.ticket} Periscope prototype`);
    d.say('commit', `committed the worktree on ${row.branch}`);
  }
  const pushed = d.push(row.worktree, row.branch);
  d.say('push', `pushed ${pushed.sha} to ${pushed.remote}/${row.branch}`, { sha: pushed.sha });

  const t = await d.readTicket(row.ticketRecordId);
  const section = prototypeSection(d.changedFiles(row.worktree));
  const description = t.description.includes(PROTOTYPE_HEADING) ? t.description : `${t.description.trimEnd()}\n\n${section}`;
  await d.updateTicket(row.ticketRecordId, {
    description, fillProjectAndRepo: !t.hasProject || !t.hasRepo, status: 'new',
  });
  d.say('ticket', `${row.ticket} is new and unassigned with a Prototype section`);
  await d.postPushed(row.ticketRecordId, pushed.sha, pushed.remote, row.branch);

  const killed = await d.stopServer(row.worktree, row.number);
  d.say('server', killed ? `stopped ${killed} process(es)` : 'no server was listening');
  d.removeWorktree(row.worktree, row.branch, false);
  d.say('worktree', `removed ${row.worktree}; ${row.branch} stays, pushed`);
  await d.setRowState(row.id, 'kept');
  d.say('row', 'row is kept');
  return { ticket: row.ticket, mode: 'keep', outcome: 'done', state: 'kept', sha: pushed.sha };
}

export interface PeriscopeListEntry extends PeriscopeRowInfo { idleMinutes: number | null; listening: boolean }

export function periscopeListEntries(rows: PeriscopeRowInfo[], now: Date, isListening: (r: PeriscopeRowInfo) => boolean): PeriscopeListEntry[] {
  return rows.filter((r) => r.state === 'live').map((r) => {
    const at = r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : NaN;
    return { ...r, idleMinutes: Number.isNaN(at) ? null : Math.max(0, Math.floor((now.getTime() - at) / 60_000)), listening: isListening(r) };
  });
}

export function formatPeriscopeList(entries: PeriscopeListEntry[]): string {
  if (entries.length === 0) return 'no live periscopes on this ship';
  return entries.map((e) => [
    e.ticket, e.repo, e.worktree, e.url, e.state,
    e.idleMinutes === null ? 'idle ?' : `idle ${e.idleMinutes} min`,
    e.listening ? 'listening' : 'not listening',
  ].join('  ')).join('\n');
}
