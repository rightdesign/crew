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

import { codeToolsParagraph, lspToolsParagraph, probeIntel, type IntelOutcome } from './intel.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PeriscopeSidecar } from './periscope-state.ts';
import { pointedAtEnv, type PointedAt } from './periscope-pointed.ts';
import { proxyPortFor } from './ports.ts';
import type { PreviewRelay } from './periscope-relay.ts';

export class PeriscopeError extends Error {}

/** A live Periscopes row that already exists for a ticket (CREW-2871). */
export interface LivePeriscope { ship: string; url: string; worktree: string }

/**
 * `up --issue` refused because the ticket already has a live periscope. `data` is
 * what `--json` reports: `{ refused: 'live_periscope_exists', ship, url, worktree }`.
 */
export class LivePeriscopeError extends PeriscopeError {
  readonly data: { refused: 'live_periscope_exists' } & LivePeriscope;
  constructor(tag: string, number: string, live: LivePeriscope) {
    super(`${tag} already has a live periscope on ${live.ship}: ${live.url} (worktree ${live.worktree}) — run \`crew periscope down ${number} --keep|--discard\` on ${live.ship}, or resume it there with \`crew periscope up --resume ${number}\``);
    this.data = { refused: 'live_periscope_exists', ...live };
  }
}

/**
 * Where `up --issue` leaves what it replaced, for `down` to report: one small file per ticket record.
 * Deliberately NOT under `periscopes/`: that directory holds the CREW-2857 sidecars, which
 * `crew status --json` reads wholesale and which share the `<ticketRecordId>.json` name.
 */
const priorDir = (stateDir: string) => join(stateDir, 'periscope-priors');
const priorPath = (stateDir: string, ticketRecordId: string) => join(priorDir(stateDir), `${ticketRecordId}.json`);

export function removePeriscopePrior(stateDir: string, ticketRecordId: string): void {
  rmSync(priorPath(stateDir, ticketRecordId), { force: true });
}

export function writePeriscopePrior(stateDir: string, ticketRecordId: string, prior: { assignee: string | null; status: string }): void {
  try {
    mkdirSync(priorDir(stateDir), { recursive: true });
    writeFileSync(priorPath(stateDir, ticketRecordId), JSON.stringify(prior));
  } catch { /* only a convenience for the report; the hold itself is on the ticket */ }
}

export function readPeriscopePrior(stateDir: string, ticketRecordId: string): { assignee: string | null; status: string } | undefined {
  try {
    const p = priorPath(stateDir, ticketRecordId);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { assignee: string | null; status: string }) : undefined;
  } catch { return undefined; }
}

export interface PeriscopeUpArgs {
  /** Only when two positional arguments were given; otherwise the repo picks the route. */
  route?: string;
  repo: string;
  /** Absent: prompted for in a terminal, else `<repo>, <date>`. */
  topic?: string;
  /** `--issue NNN`: periscope an existing ticket instead of filing a draft (digits only). */
  issue?: string;
  isolate: boolean;
  host?: string;
  /** `--no-relay`: open this periscope without a relayed preview even when `ship.relayPreviews` is on (CREW-3059). */
  noRelay?: boolean;
  assignee?: string;
  /** `--requested-by`: who the draft is for when the control API opens it on a Passenger's behalf; recorded as the ticket's reporter. */
  requestedBy?: string;
  json: boolean;
}

/** The Ship settings a periscope reads, tolerant of a config that predates them (CREW-2853). */
export interface PeriscopeLimits { maxPeriscopes?: number; periscopeIdleMinutes?: number }

export const DEFAULT_MAX_PERISCOPES = 3;
export const DEFAULT_PERISCOPE_IDLE_MINUTES = 120;
const DEFAULT_INTEL_STARTUP_SECONDS = 20;

/** What `periscope up` was typed with; `repo` is absent when the working directory names it. */
export type ParsedPeriscopeUpArgs = Omit<PeriscopeUpArgs, 'repo'> & { repo?: string };

/**
 * `periscope up [[route] REPO] [--topic TEXT] ...`. One positional is the
 * repo; two are `route repo`; none leaves both to the working directory
 * (CREW-2866). The flags arrive already read by the caller.
 */
export function parsePeriscopeUpArgs(
  positional: string[],
  flags: { topic?: string; issue?: string; host?: string; assignee?: string; requestedBy?: string; isolate: boolean; json: boolean; noRelay?: boolean },
): ParsedPeriscopeUpArgs {
  const usage = 'usage: crew periscope up [[route] REPO] [--topic TEXT | --issue NNN] [--isolate] [--host HOST] [--no-relay] [--assignee CREW_ROW_ID] [--requested-by ID] [--no-open] [--json]';
  const rest = positional.slice(2);   // [periscope, up|start, ...]
  if (rest.length > 2) throw new PeriscopeError(usage);
  const topic = flags.topic?.trim();
  let issue: string | undefined;
  if (flags.issue !== undefined) {
    if (topic) throw new PeriscopeError(`--issue and --topic cannot be combined: --issue periscopes a ticket that already exists\n${usage}`);
    const m = /^(?:[A-Za-z]+-)?(\d+)$/.exec(flags.issue.trim());
    if (!m) throw new PeriscopeError(`"${flags.issue}" is not a ticket number\n${usage}`);
    issue = String(Number.parseInt(m[1]!, 10));
  }
  return {
    ...(rest.length === 2 ? { route: rest[0] } : {}),
    ...(rest.length > 0 ? { repo: rest[rest.length - 1]! } : {}),
    ...(topic ? { topic } : {}),
    ...(issue ? { issue } : {}),
    isolate: flags.isolate,
    ...(flags.host ? { host: flags.host } : {}),
    ...(flags.noRelay ? { noRelay: true as const } : {}),
    ...(flags.assignee ? { assignee: flags.assignee } : {}),
    ...(flags.requestedBy?.trim() ? { requestedBy: flags.requestedBy.trim() } : {}),
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
  /** The brief's "Code tools" paragraph for this periscope (CREW-2872). */
  codeTools: string;
  /** `--issue`: the ticket already existed. */
  existing?: true;
  /** `--issue`: the ticket's status, which up and down leave alone. */
  priorStatus?: string;
}

/** A ticket `--issue` resolved, with what the refusals need to know about it. */
export interface ExistingTicket extends DraftTicket {
  status: string;
  closed: boolean;
  repoId: string | null;
  assignee: string | null;
  heldByShipId: string | null;
}

/** What `--issue` needs beyond the draft path. Absent when the caller supports only drafts. */
export interface ExistingDeps {
  /** The ticket with this number on the route's tracker, or undefined. */
  load(number: string): Promise<ExistingTicket | undefined>;
  /** The repository the command names; a ticket of another repository is refused. */
  repoId: string | null;
  repoName: string;
  /** This ship's Pair row, the only agent-less holder `--issue` takes over from. */
  pairId: string;
  shipId: string | null;
  /** The name of an assignee that is an agent seat (not this ship's Pair row), else undefined. */
  agentHolder(assigneeId: string): Promise<string | undefined>;
  /** The ticket's `live` Periscopes rows on any ship; an issue has at most one at a time (CREW-2871). */
  liveRows(ticketRecordId: string): Promise<LivePeriscope[]>;
  /** A run sidecar for the ticket exists on this ship. */
  hasLiveRun(ticketRecordId: string): boolean;
  /** Sets assignee to the Pair row and held-by to this ship; status is left alone. */
  hold(ticketId: string): Promise<void>;
  /** Puts the assignee back as it was and clears held-by (an up that failed). */
  restore(ticketId: string, assignee: string | null): Promise<void>;
  /** Records what `down` reports it cleared. */
  remember(ticketId: string, prior: { assignee: string | null; status: string }): void;
}

/**
 * Throws when the ticket already has a live periscope, on this ship or another.
 * Checked before the hold, the worktree or any other write; `--resume` does not
 * come through here because it reopens the existing row rather than adding one.
 */
export async function assertNoLivePeriscope(e: ExistingDeps, t: ExistingTicket, number: string): Promise<void> {
  const live = (await e.liveRows(t.id))[0];
  if (live) throw new LivePeriscopeError(t.tag, number, live);
}

/**
 * Why `--issue` refuses a ticket, or undefined when it may be periscoped. The
 * message names the holder; nothing has been written when it is returned.
 */
export async function existingRefusal(e: ExistingDeps, t: ExistingTicket): Promise<string | undefined> {
  if (t.closed) return `${t.tag} is ${t.status}; a closed ticket cannot be periscoped`;
  if (e.repoId && t.repoId !== e.repoId) return `${t.tag} belongs to a different repository than ${e.repoName}`;
  if (t.assignee && t.assignee !== e.pairId) {
    const agent = await e.agentHolder(t.assignee);
    if (agent) return `${t.tag} is held by ${agent}`;
  }
  if (t.heldByShipId && e.shipId && t.heldByShipId !== e.shipId) return `${t.tag} is held by another ship (${t.heldByShipId})`;
  if (e.hasLiveRun(t.id)) return `${t.tag} has a run in flight on this ship`;
  return undefined;
}

export interface PeriscopeDeps {
  /** The repo's `preview` hook; undefined when it declares none. */
  previewHook: string | undefined;
  hasPeriscopesTable: boolean;
  liveCount(): Promise<number>;
  caps: { max: number; idleMinutes: number };
  /** A reason the base branch is not safe to cut from (the `crew worktree` stop), else undefined. */
  baseProblem(): string | undefined;
  /** The topic when `--topic` was not given and a person is at a terminal (a prompt), else undefined. */
  askTopic(): Promise<string | undefined>;
  fileDraft(title: string): Promise<DraftTicket>;
  /** Cuts the worktree for the ticket; throws a PeriscopeError naming why when it cannot. */
  cutWorktree(ticket: DraftTicket): { path: string; branch: string };
  /** Copies `worktrees.copy` files then runs `setup`; a non-zero result is a failure. */
  prepare(path: string): Promise<HookResult | null>;
  /** Runs a hook in the worktree; null when the repository declares none. */
  runHook(name: 'ports' | 'isolate' | 'handoff' | 'preview' | 'intel', cwd: string, env: Record<string, string>): Promise<HookResult | null>;
  createRow(fields: Record<string, unknown>): Promise<{ id: string }>;
  /** Keeps the local record `crew status` reads (CREW-2857); a failure is a warning, not an abandon. */
  recordLocal?(sc: PeriscopeSidecar): void;
  /** Creates `.crew/pointed-at.jsonl` in the worktree and excludes `.crew/` from git (CREW-2874). */
  prepareDropFile(worktree: string): void;
  /**
   * Starts the periscope proxy in front of `previewUrl` and returns the URL a viewer
   * should use (CREW-2880). Absent where proxying is not supported; a throw abandons the `up`.
   */
  startProxy?(worktree: string, previewUrl: string, number: string): Promise<string>;
  /**
   * Relayed previews (CREW-3059): present when `ship.relayPreviews` is on and the relay is
   * configured. Used only together with `startProxy`, since the tunnel forwards the proxy.
   */
  relay?: PreviewRelay;
  /** Registers the symbol service as the `code` MCP server in the worktree's harness configuration; returns one-line reasons for files left alone. */
  registerCode?(worktree: string, url: string): { skipped: string[] };
  comment(ticketId: string, body: string): Promise<void>;
  /** Stops anything listening for the worktree, removes it and its branch. */
  teardown(path: string, branch: string): Promise<void>;
  /** Closes the draft as obsolete when nothing usable came of it. */
  closeDraft(ticketId: string, note: string): Promise<void>;
  /** `--issue` support (CREW-2865). */
  existing?: ExistingDeps;
  now(): Date;
  host: string;
  /** `ship.intelStartupSeconds`; the default when absent. */
  intelStartupSeconds?: number;
  /**
   * CREW-2916: the generated plugin directory when the repository's `hooks.intel` is an `*-lsp`
   * flavor. Such a flavor starts no service, so the probe is skipped and the paragraph tells the
   * session how to load the plugin.
   */
  lspPluginDir?: string;
  say(event: string, message: string, data?: Record<string, unknown>): void;
}

const tail = (s: string, n = 20) => s.trimEnd().split('\n').slice(-n).join('\n');

/** The topic when none was given and nobody was asked: the draft reads `Periscope: <repo>, <date>`. */
export function defaultTopic(repo: string, now: Date): string {
  return `${repo}, ${now.toISOString().slice(0, 10)}`;
}

/** The platform's "open this URL" program, or undefined where there is none. */
export function openerFor(platform: string): string | undefined {
  return platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : undefined;
}

/**
 * What `periscope up` prints on stdout. At a terminal the URL comes first and
 * the worktree path on the line after it, so a person can click the one and
 * `cd` to the other; piped, the order is unchanged from the first cut.
 */
export function upOutput(res: PeriscopeResult, terminal: boolean): string {
  const block = terminal ? `${res.ticket}\n${res.url}\n${res.worktree}\n` : `${res.ticket}\n${res.worktree}\n${res.url}\n`;
  return `${block}\n${res.codeTools}\n`;
}

/** Whether to open the URL: `--open` forces it, `--no-open` forbids it, otherwise only a person at a terminal gets it. */
export function shouldOpen(f: { open: boolean; noOpen: boolean; json: boolean; terminal: boolean }): boolean {
  if (f.noOpen || f.json) return false;
  return f.open || f.terminal;
}

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
  const ex = d.existing;
  let draft: DraftTicket;
  let prior: ExistingTicket | undefined;
  if (args.issue) {
    if (!ex) throw new PeriscopeError('--issue is not supported here');
    prior = await ex.load(args.issue);
    if (!prior) throw new PeriscopeError(`no ticket numbered ${args.issue} on this route`);
    await assertNoLivePeriscope(ex, prior, args.issue);
    const refused = await existingRefusal(ex, prior);
    if (refused) throw new PeriscopeError(refused);
    const unsafe = d.baseProblem();
    if (unsafe) throw new PeriscopeError(`DO NOT CUT A WORKTREE FROM THIS BASE — ${unsafe}`);
    // The hold is the first write; the status is never touched.
    await ex.hold(prior.id);
    ex.remember(prior.id, { assignee: prior.assignee, status: prior.status });
    draft = prior;
    d.say('held', `holding ${prior.tag} (status ${prior.status} stays)`, { ticket: prior.tag, ticketRecordId: prior.id });
  } else {
    const topic = args.topic ?? (await d.askTopic())?.trim() ?? defaultTopic(args.repo, d.now());
    const unsafe = d.baseProblem();
    if (unsafe) throw new PeriscopeError(`DO NOT CUT A WORKTREE FROM THIS BASE — ${unsafe}`);
    draft = await d.fileDraft(`Periscope: ${topic}`);
    d.say('filed', `filed draft ${draft.tag}`, { ticket: draft.tag, ticketRecordId: draft.id });
  }

  let wt: { path: string; branch: string } | undefined;
  let tunnel: { pid: number; slug: string } | undefined;
  const abandon = async (why: string): Promise<never> => {
    // Best effort each: a failure to clean one thing must not hide the reason or skip the rest.
    if (tunnel) { try { d.relay?.stop(tunnel.pid, tunnel.slug); } catch { /* the ssh process is detached; nothing more to do */ } }
    if (wt) await d.teardown(wt.path, wt.branch).catch(() => {});
    if (prior) await d.existing!.restore(prior.id, prior.assignee).catch(() => {});
    else await d.closeDraft(draft.id, `Periscope abandoned: ${why.split('\n')[0]}`).catch(() => {});
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

  // The slug exists before the hooks run so a hook can be told the public origin (CREW_PREVIEW_URL).
  const relaySlug = d.relay && d.startProxy && !args.noRelay ? d.relay.newSlug() : undefined;
  const relayOrigin = relaySlug ? d.relay!.publicUrl(relaySlug) : undefined;
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

  try {
    d.prepareDropFile(wt.path);
  } catch (e) {
    return abandon(`preparing the drop file failed: ${(e as Error).message}`);
  }
  const preview = await d.runHook('preview', wt.path, {
    ...env, CREW_PREVIEW_HOST: d.host, ...(relayOrigin ? { CREW_PREVIEW_URL: relayOrigin } : {}), ...pointedAtEnv(wt.path),
  });
  if (!preview || preview.code !== 0) {
    return abandon(`preview exited ${preview?.code ?? 'without running'}\n${tail(preview?.output ?? '')}`);
  }
  const previewUrl = previewUrlFrom(preview.output);
  if (!previewUrl) return abandon(`preview printed no URL as its last line\n${tail(preview.output)}`);
  let url = previewUrl;
  if (d.startProxy) {
    try {
      url = await d.startProxy(wt.path, previewUrl, /(\d+)$/.exec(draft.issueId)?.[1] ?? '0');
    } catch (e) {
      return abandon(`starting the periscope proxy failed: ${(e as Error).message}`);
    }
    d.say('proxy', `proxy at ${url} in front of ${previewUrl}`, { url, previewUrl });
  }
  // A relayed preview forwards the proxy; if the relay will not take it the periscope still comes up on the LAN address.
  let relayed: { slug: string; pid: number; localUrl: string } | undefined;
  if (relaySlug) {
    const outcome = await d.relay!.open(relaySlug, url);
    if (outcome.ok) {
      relayed = { slug: relaySlug, pid: outcome.pid, localUrl: url };
      tunnel = { pid: outcome.pid, slug: relaySlug };
      url = relayOrigin!;
      d.say('relay', `preview relayed at ${url}`, { url, localUrl: relayed.localUrl });
    } else {
      d.say('warning', `the preview is not relayed: ${outcome.reason}; it is reachable at ${url} on the ship's network only`, { url });
    }
  }
  d.say('preview', `preview at ${url}`, { url });

  // The symbol service is optional: whatever happens to it, the periscope comes up.
  const intel: IntelOutcome = d.lspPluginDir ? { state: 'absent' } : await probeIntel(
    { runHook: (e) => d.runHook('intel', wt!.path, e) },
    env, d.intelStartupSeconds ?? DEFAULT_INTEL_STARTUP_SECONDS,
  );
  if (intel.state === 'ready') d.say('intel', `symbol service at ${intel.url} (${intel.tools.length} tools)`, { intelUrl: intel.url, intelTools: intel.tools });
  else if (intel.state === 'failed') d.say('warning', `symbol service not started: ${intel.reason}`);
  let codeOutcome: IntelOutcome = intel;
  if (intel.state === 'ready' && d.registerCode) {
    try {
      for (const why of d.registerCode(wt.path, intel.url).skipped) d.say('warning', why);
    } catch (e) {
      codeOutcome = { state: 'failed', reason: `registering it failed: ${(e as Error).message}` };
      d.say('warning', `symbol service not registered: ${(e as Error).message}`);
    }
  }
  const codeTools = d.lspPluginDir
    ? `${lspToolsParagraph('claude')} Start the Claude session with \`--plugin-dir ${d.lspPluginDir}\` to load it.`
    : codeToolsParagraph(codeOutcome);

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

  try {
    d.recordLocal?.({
      ticket: draft.tag, ticketRecordId: draft.id, periscopeRecordId: row.id, repo: args.repo,
      worktree: wt.path, branch: wt.branch, url, host: d.host, state: 'live', isolated: args.isolate,
      ...(relayed ? {
        slug: relayed.slug, localUrl: relayed.localUrl, tunnelPid: relayed.pid,
        tunnelStartedAt: now.toISOString(), tunnelSettled: true, tunnelQuickExits: 0,
      } : {}),
      ...(intel.state === 'ready' ? { intelUrl: intel.url, intelTools: intel.tools } : {}),
      startedAt: now.toISOString(), lastActivityAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + d.caps.idleMinutes * 60_000).toISOString(),
    });
  } catch (e) {
    d.say('warning', `local periscope record not written: ${(e as Error).message}`);
  }

  // The row and the server are real by now; a comment that fails to post
  // should not undo them, so say so and carry on.
  await d.comment(draft.id, progressComment(url, handoff?.output)).catch((e: Error) => {
    d.say('warning', `progress comment not posted: ${e.message}`);
  });

  return {
    ticket: draft.tag, ticketRecordId: draft.id, worktree: wt.path, branch: wt.branch, url, periscopeRecordId: row.id, codeTools,
    ...(prior ? { existing: true as const, priorStatus: prior.status } : {}),
  };
}

// ---------------------------------------------------------------------------
// `crew periscope down` and `crew periscope list` (CREW-2855)
// ---------------------------------------------------------------------------

export interface PeriscopeDownArgs {
  route?: string;
  /** The ticket number, digits only; absent when the working directory is the periscope's worktree. */
  number?: string;
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
  const usage = 'usage: crew periscope down [[route] NNN] --keep|--discard [--allow-empty] [--json]';
  const rest = positional.slice(2);   // [periscope, down|end, ...]
  if (rest.length > 2) throw new PeriscopeError(usage);
  if (flags.keep === flags.discard) throw new PeriscopeError(`pass exactly one of --keep or --discard\n${usage}`);
  const m = rest.length === 0 ? null : /^(?:[A-Za-z]+-)?(\d+)$/.exec(rest[rest.length - 1]!);
  if (rest.length > 0 && !m) throw new PeriscopeError(`"${rest[rest.length - 1]}" is not a ticket number\n${usage}`);
  return {
    ...(rest.length === 2 ? { route: rest[0] } : {}),
    ...(m ? { number: m[1]! } : {}),
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
  /** The proxy address behind a relayed `url` (from the local record), else absent. */
  localUrl?: string;
  /** The newest line of the worktree's drop file, when `list` read one. */
  pointedAt?: PointedAt | null;
}

/**
 * The live periscope whose worktree contains `cwd` — how `down` with no ticket
 * number knows which one is meant. Both sides are expected to be real paths.
 */
export function rowForCwd(rows: PeriscopeRowInfo[], cwd: string): PeriscopeRowInfo | undefined {
  return rows.find((r) => r.state === 'live' && r.worktree !== '' && (cwd === r.worktree || cwd.startsWith(`${r.worktree}/`)));
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
  readTicket(ticketRecordId: string): Promise<{ description: string; hasProject: boolean; hasRepo: boolean; isDraft?: boolean }>;
  /**
   * `status: 'released'` is an `--issue` periscope ending: clear the assignee and
   * held-by, change nothing else but the description when one is given.
   */
  updateTicket(ticketRecordId: string, patch: { description?: string; fillProjectAndRepo: boolean; status: 'new' | 'discarded' | 'released'; note?: string }): Promise<void>;
  /** What `up --issue` recorded for the ticket, if anything. */
  priorHold?(ticketRecordId: string): { assignee: string | null; status: string } | undefined;
  /** Whether the remote has the branch; a local branch whose remote copy exists is never deleted. */
  remoteHasBranch?(worktree: string, branch: string): boolean;
  postPushed(ticketRecordId: string, sha: string, remote: string, branch: string): Promise<void>;
  /** Kills the periscope's relay tunnel, if it has one (CREW-3059); done before the proxy and server stop. Returns how many processes were stopped. */
  stopTunnel?(ticketRecordId: string): number;
  /** Kills what listens for the worktree. Returns how many processes were stopped. */
  stopServer(worktree: string, number: string): Promise<number>;
  /** Deletes the worktree's crew-managed symbol-service folder (CREW-2914); the main-checkout index stays. */
  dropIntel?(number: string): void;
  /** Removes the worktree; with `deleteBranch` also the local branch. */
  removeWorktree(worktree: string, branch: string, deleteBranch: boolean): void;
  setRowState(rowId: string, state: 'kept' | 'discarded'): Promise<void>;
  /** Drops the local record `crew status` reads (CREW-2857); a failure is a warning, not an abort. */
  forgetLocal?(ticketRecordId: string): void;
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
  /** `--issue` periscope: the ticket already existed and its status is untouched. */
  existing?: true;
  status?: string;
}

/** A tunnel that will not stop must not keep `down` from ending the periscope. */
function stopTunnel(d: PeriscopeDownDeps, ticketRecordId: string): void {
  try {
    const n = d.stopTunnel?.(ticketRecordId) ?? 0;
    if (n > 0) d.say('tunnel', 'stopped the relay tunnel');
  } catch (e) { d.say('warn', `could not stop the relay tunnel: ${(e as Error).message}`); }
}

function forgetLocal(d: PeriscopeDownDeps, ticketRecordId: string): void {
  try { d.forgetLocal?.(ticketRecordId); } catch (e) { d.say('warn', `could not remove the local periscope record: ${(e as Error).message}`); }
}

export async function runPeriscopeDown(d: PeriscopeDownDeps, args: PeriscopeDownArgs & { number: string }): Promise<PeriscopeDownResult> {
  const rows = await d.rowsForTicket(args.number);
  if (rows.length === 0) throw new PeriscopeError(`no periscope for ticket ${args.number} on this ship`);
  const row = rows.find((r) => r.state === 'live');
  if (!row) {
    const done = rows[0]!;
    d.say('unchanged', `${done.ticket} is already ${done.state}; nothing to do`);
    return { ticket: done.ticket, mode: args.mode, outcome: 'unchanged', state: done.state };
  }

  // A draft is the periscope's own ticket; anything else is a ticket someone
  // else owns, whose status neither ending touches.
  const existing = (await d.readTicket(row.ticketRecordId)).isDraft === false;
  const prior = existing ? d.priorHold?.(row.ticketRecordId) : undefined;

  if (existing && args.mode === 'discard') {
    stopTunnel(d, row.ticketRecordId);
    const killed = await d.stopServer(row.worktree, row.number);
    d.dropIntel?.(row.number);
    d.say('server', killed ? `stopped ${killed} process(es)` : 'no server was listening');
    const onRemote = d.remoteHasBranch?.(row.worktree, row.branch) ?? true;
    d.removeWorktree(row.worktree, row.branch, !onRemote);
    d.say('worktree', onRemote ? `removed ${row.worktree}; ${row.branch} stays, it is on the remote` : `removed ${row.worktree} and branch ${row.branch}`);
    await d.updateTicket(row.ticketRecordId, { status: 'released', fillProjectAndRepo: false });
    d.say('ticket', `${row.ticket} hold cleared; status unchanged${prior ? ` (assignee before the periscope: ${prior.assignee ?? 'none'})` : ''}`);
    await d.setRowState(row.id, 'discarded');
    d.say('row', 'row is discarded');
    forgetLocal(d, row.ticketRecordId);
    return { ticket: row.ticket, mode: 'discard', outcome: 'done', state: 'discarded', existing: true, ...(prior ? { status: prior.status } : {}) };
  }

  if (args.mode === 'discard') {
    stopTunnel(d, row.ticketRecordId);
    const killed = await d.stopServer(row.worktree, row.number);
    d.dropIntel?.(row.number);
    d.say('server', killed ? `stopped ${killed} process(es)` : 'no server was listening');
    d.removeWorktree(row.worktree, row.branch, true);
    d.say('worktree', `removed ${row.worktree} and branch ${row.branch}`);
    await d.updateTicket(row.ticketRecordId, {
      status: 'discarded', fillProjectAndRepo: false, note: 'The periscope was discarded; nothing was pushed.',
    });
    d.say('ticket', `${row.ticket} closed as obsolete`);
    await d.setRowState(row.id, 'discarded');
    d.say('row', 'row is discarded');
    forgetLocal(d, row.ticketRecordId);
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
  if (existing) {
    await d.updateTicket(row.ticketRecordId, { description, fillProjectAndRepo: false, status: 'released' });
    d.say('ticket', `${row.ticket} has a Prototype section and no assignee; status unchanged${prior ? ` (assignee before the periscope: ${prior.assignee ?? 'none'})` : ''}`);
  } else {
    await d.updateTicket(row.ticketRecordId, {
      description, fillProjectAndRepo: !t.hasProject || !t.hasRepo, status: 'new',
    });
    d.say('ticket', `${row.ticket} is new and unassigned with a Prototype section`);
  }
  await d.postPushed(row.ticketRecordId, pushed.sha, pushed.remote, row.branch);

  stopTunnel(d, row.ticketRecordId);
    const killed = await d.stopServer(row.worktree, row.number);
  d.dropIntel?.(row.number);
  d.say('server', killed ? `stopped ${killed} process(es)` : 'no server was listening');
  d.removeWorktree(row.worktree, row.branch, false);
  d.say('worktree', `removed ${row.worktree}; ${row.branch} stays, pushed`);
  await d.setRowState(row.id, 'kept');
  d.say('row', 'row is kept');
  forgetLocal(d, row.ticketRecordId);
  return { ticket: row.ticket, mode: 'keep', outcome: 'done', state: 'kept', sha: pushed.sha, ...(existing ? { existing: true as const, ...(prior ? { status: prior.status } : {}) } : {}) };
}

export interface PeriscopeListEntry extends PeriscopeRowInfo {
  idleMinutes: number | null;
  listening: boolean;
  /** The row's URL is the periscope proxy's (CREW-2880), not the dev server's own. */
  proxied: boolean;
}

/** Whether `url` is on the ticket's proxy port. */
export function isProxyUrl(url: string, number: string): boolean {
  try { return Number(new URL(url).port) === proxyPortFor(Number(number)); } catch { return false; }
}

export function periscopeListEntries(rows: PeriscopeRowInfo[], now: Date, isListening: (r: PeriscopeRowInfo) => boolean): PeriscopeListEntry[] {
  return rows.filter((r) => r.state === 'live').map((r) => {
    const at = r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : NaN;
    return { ...r, idleMinutes: Number.isNaN(at) ? null : Math.max(0, Math.floor((now.getTime() - at) / 60_000)), listening: isListening(r), proxied: isProxyUrl(r.localUrl ?? r.url, r.number) };
  });
}

export function formatPeriscopeList(entries: PeriscopeListEntry[]): string {
  if (entries.length === 0) return 'no live periscopes on this ship';
  return entries.map((e) => [
    e.ticket, e.repo, e.worktree, e.localUrl ? `${e.url} (relayed from ${e.localUrl})` : e.proxied ? `${e.url} (proxy)` : e.url, e.state,
    e.idleMinutes === null ? 'idle ?' : `idle ${e.idleMinutes} min`,
    e.listening ? 'listening' : 'not listening',
  ].join('  ')).join('\n');
}
