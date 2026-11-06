/**
 * Periscope operations on the ship control API (EPIC-077, CREW-2859):
 * `POST /periscopes`, `POST /periscopes/<ticket>/down` and `GET /periscopes`.
 *
 * The chat agent is the brain for a Passenger's periscope and the ship only
 * executes the lifecycle, so each operation runs the very CLI command a person
 * would (`crew periscope up|down|list --json`) in a child process rather than
 * a second implementation that could drift. `up` is given `--host
 * ship.previewHost` (what `CREW_PREVIEW_HOST` is for a Passenger) and
 * `--requested-by`, which becomes the draft ticket's reporter.
 *
 * Credential: the control API does not run its general bearer check on these
 * paths; the per-route `member()` below is the gate, and `verifyIn` accepts a
 * ship key, a member key, or the workspace's own tunnel secret (CREW-2889).
 * `GET /periscopes` also answers `hosting`, the capability of each route the
 * caller may see.
 *
 * Gate: `routes[].hostPeriscopes` is the authorization. A ship with no route
 * that sets it answers 404 on these paths as if they did not exist; a route
 * that does not set it likewise. Past that the operation is not restricted,
 * except that the caller must be a member of the route's own workspace
 * (the control API's bearer check only proves membership of *some* workspace
 * this ship serves).
 *
 * `up` takes `issue` (a ticket number, `123` or `CREW-123`) instead of `topic` to open a
 * periscope on an existing ticket; the refusals are the CLI's own (CREW-2865).
 *
 * Progress: `up` and `down` print one JSON event per step on stderr. A caller
 * that sends `Accept: application/x-ndjson` (or `?stream=1`) gets those lines
 * as they happen, then a final `{"event":"done",...}` or `{"event":"error",
 * "status":N,"message":...}`; otherwise it gets the final object (or the
 * error) as one JSON reply. A refusal found before anything started (flag off,
 * bad body, cap reached, not a member) is always an ordinary 4xx, never a
 * stream.
 */

import { spawn } from 'node:child_process';
import type { AuthVerdict } from './control-api.ts';

export interface CliResult { code: number; stdout: string; stderr: string }

export interface PeriscopeHosting {
  /** Every enabled, connected route, with whether it hosts Passenger periscopes. */
  routes: { route: string; workspaceId: string; hostPeriscopes: boolean }[];
  previewHost?: string;
  /** `ship.relayPreviews`: the preview is reached through the relay, so `previewHost` is not required (CREW-3059). */
  relayPreviews?: boolean;
  maxPeriscopes: number;
  /** Runs `crew <args>`; each complete stderr line is passed to `onLine` as it arrives. */
  run: (args: string[], onLine: (line: string) => void) => Promise<CliResult>;
  /** Is `token` a member of `workspaceId`? */
  verifyIn: (token: string, workspaceId: string) => Promise<AuthVerdict>;
  /** Names of `route`'s connected repositories whose `.crew.yaml` declares a `preview` hook (CREW-2889). */
  previewRepos?: (route: string) => string[];
  /**
   * Per-periscope MCP endpoints (CREW-2862). When set, `up` is run with `--serve-mcp`
   * (the secret is minted by the command, never passed on its command line) and
   * the result goes to `onUp`, whose fields are merged into the answer; `onDown`
   * runs after a successful `down`. Neither may throw: a failure to register is
   * reported in the answer, and the periscope itself stays up.
   */
  mcp?: {
    onUp(route: { route: string; workspaceId: string }, result: Record<string, unknown>): Promise<Record<string, unknown>>;
    onDown(route: { route: string; workspaceId: string }, result: Record<string, unknown>): Promise<void>;
  };
}

export interface PeriscopeReply {
  status: number;
  body: unknown;
  /** When set, the reply is streamed as NDJSON: `status` is 200 and `body` is ignored. */
  stream?: (write: (event: unknown) => void) => Promise<void>;
}

const reply = (status: number, body: unknown): PeriscopeReply => ({ status, body });
const err = (status: number, message: string): PeriscopeReply => reply(status, { error: message });

const TICKET_RE = /^(?:[A-Za-z]+-)?\d+$/;
const MAX_FIELD = 200;

/** A value that goes onto a command line: bounded, one line, and never read as a flag. */
function plainText(v: unknown, field: string, required: boolean): string | undefined | { error: string } {
  if (v === undefined || v === null || v === '') return required ? { error: `${field} is required` } : undefined;
  if (typeof v !== 'string') return { error: `${field} must be a string` };
  const t = v.trim();
  if (!t) return required ? { error: `${field} is required` } : undefined;
  if (t.length > MAX_FIELD || /[\r\n\0]/.test(t)) return { error: `${field} must be one line of at most ${MAX_FIELD} characters` };
  if (t.startsWith('-')) return { error: `${field} must not start with "-"` };
  return t;
}

const isErr = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

/** The route a request names, or the only hosting route when it names none. */
function pickRoute(h: PeriscopeHosting, named: string | undefined): { route: string; workspaceId: string } | PeriscopeReply {
  const hosting = h.routes.filter((r) => r.hostPeriscopes);
  if (named !== undefined) {
    const hit = hosting.find((r) => r.route === named);
    return hit ?? err(404, 'not found');
  }
  if (hosting.length === 1) return hosting[0]!;
  return err(400, `route is required (this ship hosts periscopes on: ${hosting.map((r) => r.route).join(', ')})`);
}

/** The last line the CLI wrote, without its `crew periscope:` prefix. */
export function cliMessage(r: CliResult): string {
  const lines = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  // Progress events are JSON lines; a refusal is the plain one after them.
  const plain = lines.filter((l) => !l.startsWith('{'));
  const last = plain[plain.length - 1] ?? lines[lines.length - 1] ?? `crew exited with status ${r.code}`;
  return last.replace(/^crew periscope:\s*/, '');
}

/** The status a failed CLI run maps to. */
function failureStatus(r: CliResult): number {
  const m = cliMessage(r);
  if (/^no periscope for ticket /.test(m)) return 404;
  if (/^no ticket numbered /.test(m)) return 404;
  if (/already hosts \d+ live periscope/.test(m)) return 409;
  // `up --issue` refusals (CREW-2865): the ticket is taken, not malformed.
  if (/ is held by | has a live periscope on | has a run in flight on /.test(m)) return 409;
  return r.code === 1 ? 422 : 500;
}

function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]!) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not JSON */ }
  }
  return null;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/**
 * Runs a long operation either buffered or, when `streaming`, relaying each
 * progress event to the caller as it is printed.
 */
async function execute(
  h: PeriscopeHosting, args: string[], streaming: boolean,
  after?: (done: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<PeriscopeReply> {
  const finishRaw = (r: CliResult): { status: number; body: Record<string, unknown> } => {
    if (r.code !== 0) return { status: failureStatus(r), body: { error: cliMessage(r) } };
    const done = lastJsonLine(r.stdout);
    return done ? { status: 200, body: done } : { status: 502, body: { error: 'the command finished without a result' } };
  };
  /** The command's own result, then whatever the caller adds once it succeeded. */
  const finish = async (r: CliResult): Promise<{ status: number; body: Record<string, unknown> }> => {
    const f = finishRaw(r);
    return f.status === 200 && after ? { status: 200, body: await after(f.body) } : f;
  };
  if (!streaming) {
    const f = await finish(await h.run(args, () => {}));
    return reply(f.status, f.body);
  }
  return {
    status: 200,
    body: null,
    stream: async (write) => {
      const r = await h.run(args, (line) => { const ev = parseLine(line); if (ev) write(ev); });
      const f = await finish(r);
      write(f.status === 200 ? f.body : { event: 'error', status: f.status, message: f.body.error });
    },
  };
}

export interface PeriscopeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string;
  /** Parsed JSON body, or null when it was not a small JSON object. */
  body: Record<string, unknown> | null;
  wantsStream: boolean;
}

/** Does `path` belong to this module? Everything under `/periscopes`. */
export const isPeriscopePath = (p: string): boolean => p === '/periscopes' || p.startsWith('/periscopes/');

export async function handlePeriscopes(h: PeriscopeHosting | undefined, q: PeriscopeRequest): Promise<PeriscopeReply> {
  // Off for the whole ship: indistinguishable from a path that was never there.
  if (!h || !h.routes.some((r) => r.hostPeriscopes)) return err(404, 'not found');
  // The control API no longer checks the bearer for these paths, so a missing one stops here.
  if (!q.token) return err(401, 'a bearer token is required');
  const down = /^\/periscopes\/([^/]+)\/down$/.exec(q.path);
  const isUp = q.path === '/periscopes' && q.method === 'POST';
  const isList = q.path === '/periscopes' && q.method === 'GET';
  if (q.path === '/periscopes' && !isUp && !isList) return err(405, 'method not allowed');
  if (down && q.method !== 'POST') return err(405, 'method not allowed');
  if (q.path !== '/periscopes' && !down) return err(404, 'not found');

  const member = async (workspaceId: string): Promise<PeriscopeReply | undefined> => {
    const v = await h.verifyIn(q.token, workspaceId);
    if (v === 'ok') return undefined;
    if (v === 'unavailable') return err(503, 'could not verify the key right now');
    return err(403, 'this key does not belong to the workspace of this route');
  };

  if (isList) {
    const named = q.query.get('route') ?? undefined;
    const candidates = named === undefined ? h.routes.filter((r) => r.hostPeriscopes) : [pickRoute(h, named)];
    const rows: unknown[] = [];
    const hosting: unknown[] = [];
    for (const c of candidates) {
      if ('status' in c) return c;
      const denied = await member(c.workspaceId);
      // Listing every route skips the ones this caller is not in; naming one is a refusal.
      if (denied) { if (named !== undefined) return denied; continue; }
      const r = await h.run(['periscope', 'list', c.route, '--json'], () => {});
      if (r.code !== 0) return err(failureStatus(r), cliMessage(r));
      try {
        const list = JSON.parse(r.stdout) as unknown;
        const mine = Array.isArray(list) ? list : [];
        for (const e of mine) rows.push({ route: c.route, ...(e as object) });
        hosting.push({
          route: c.route, workspaceId: c.workspaceId, previewHostSet: !!h.previewHost || h.relayPreviews === true,
          maxPeriscopes: h.maxPeriscopes, live: mine.length, repos: h.previewRepos?.(c.route) ?? [],
        });
      } catch { return err(502, 'the list command did not answer JSON'); }
    }
    return reply(200, { periscopes: rows, hosting });
  }

  const b = q.body;
  if (!b) return err(400, 'body must be a small JSON object');
  const routeName = plainText(b.route, 'route', false);
  if (isErr(routeName)) return err(400, routeName.error);
  const picked = pickRoute(h, routeName);
  if ('status' in picked) return picked;
  const denied = await member(picked.workspaceId);
  if (denied) return denied;

  if (down) {
    const ticket = decodeURIComponent(down[1]!);
    if (!TICKET_RE.test(ticket)) return err(400, 'ticket must be a ticket number such as 123 or CREW-123');
    if (b.outcome !== 'keep' && b.outcome !== 'discard') return err(400, 'outcome must be "keep" or "discard"');
    if (b.allowEmpty !== undefined && typeof b.allowEmpty !== 'boolean') return err(400, 'allowEmpty must be a boolean');
    return execute(h, [
      'periscope', 'down', picked.route, ticket, `--${b.outcome}`,
      ...(b.allowEmpty === true ? ['--allow-empty'] : []), '--json',
    ], q.wantsStream, h.mcp ? async (done) => { await h.mcp!.onDown(picked, done); return done; } : undefined);
  }

  const repo = plainText(b.repo, 'repo', true);
  // `issue` periscopes a ticket that already exists (CREW-2865), so it replaces `topic`.
  const hasIssue = b.issue !== undefined && b.issue !== null && b.issue !== '';
  const topic = plainText(b.topic, 'topic', !hasIssue);
  let issue: string | undefined;
  if (hasIssue) {
    const raw = typeof b.issue === 'number' ? String(b.issue) : typeof b.issue === 'string' ? b.issue.trim() : '';
    if (!TICKET_RE.test(raw)) return err(400, 'issue must be a ticket number such as 123 or CREW-123');
    if (topic !== undefined && !isErr(topic)) return err(400, 'issue and topic cannot be combined: issue periscopes a ticket that already exists');
    issue = String(Number.parseInt(/(\d+)$/.exec(raw)![1]!, 10));
  }
  const requestedBy = plainText(b.requestedBy, 'requestedBy', false);
  for (const v of [repo, topic, requestedBy]) if (isErr(v)) return err(400, v.error);
  if (b.isolate !== undefined && typeof b.isolate !== 'boolean') return err(400, 'isolate must be a boolean');
  if (!h.previewHost && !h.relayPreviews) return err(409, 'this ship has no ship.previewHost, so a Passenger could not reach a periscope');

  // Over the cap: refuse before anything is filed. The command checks again, which covers a race.
  const live = await h.run(['periscope', 'list', picked.route, '--json'], () => {});
  if (live.code === 0) {
    try {
      const n = (JSON.parse(live.stdout) as unknown[]).length;
      if (n >= h.maxPeriscopes) return err(409, `this ship already hosts ${n} live periscope(s) (ship.maxPeriscopes is ${h.maxPeriscopes}) — discard one first`);
    } catch { /* the command's own check still applies */ }
  }
  return execute(h, [
    'periscope', 'up', picked.route, repo as string,
    ...(issue ? ['--issue', issue] : ['--topic', topic as string]),
    ...(h.previewHost ? ['--host', h.previewHost] : []),
    ...(requestedBy && !issue ? ['--requested-by', requestedBy as string] : []),
    ...(b.isolate === true ? ['--isolate'] : []), ...(h.mcp ? ['--serve-mcp'] : []), '--no-open', '--json',
  ], q.wantsStream, h.mcp ? async (done) => ({ ...done, ...(await h.mcp!.onUp(picked, done)) }) : undefined);
}

/** Runs this same crew program with `args`, relaying complete stderr lines as they arrive. */
export function runCrew(args: string[], onLine: (line: string) => void, timeoutMs = 20 * 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1] ?? '', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      stderr += text;
      pending += text;
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, i).trim(); pending = pending.slice(i + 1); if (line) onLine(line); }
    });
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: `${stderr}${e.message}\n` }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}
