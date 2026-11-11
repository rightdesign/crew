/**
 * The ship control API (CREW-2788): an HTTP API the daemon serves on a unix
 * socket under the state dir, scoped to monitoring and control.
 *
 * Why it exists: a monitor (crew-macos) reads the ship's disk today, which
 * cannot work for a ship it cannot read. This is the interface for those
 * ships; reaching it remotely (the relay's control path) and the client's
 * transport are separate tickets.
 *
 * Surface (every request needs a bearer token, even for unknown paths, so the
 * API never reveals which routes exist to an unauthenticated caller):
 *
 *  - `GET /status`            `crew status --json`, plus `daemon` liveness and `pause`.
 *  - `GET /events`            incremental tail of the ship event log.
 *  - `GET /streams`           the live run listing.
 *  - `GET /streams/<run>`     incremental tail of one run's stream.
 *  - `POST /streams/<run>/messages`  `{ text, author? }` (CREW-3119): a note for a live run. Crew records it
 *                             on the run's Agent Log row (a `user` cycle), writes it to the harness when the
 *                             run still reads input, and answers `{ cycleId, state, acceptsInput }` with
 *                             `state` `delivered` or `carried_forward` (the next run of the work item reads
 *                             it in its brief). 404 for an unknown or finished run, 409 for a live run this
 *                             daemon cannot reach or the platform refused; same bearer check as other writes.
 *  - `POST /seats/<role>/notes`  `{ text, ticket?, author? }` (CREW-3249): a note for a seat with no live run.
 *                             Crew spools it on this ship (`seat-notes.ts`) and the seat's next run (of that
 *                             ticket, when `ticket` is given) reads it in its brief. Answers
 *                             `{ id, state: "carried_forward", carriedForward: true }`; 400 for an unknown role.
 *  - `POST /pause`, `/resume` `{ "role"?: "dev"|"design"|"qa" }`.
 *  - `POST /release/pause`, `/release/resume`.
 *  - `POST /scheduler/{start,stop,restart}`  wraps `planDaemonControl`; answers 202.
 *  - `GET /doctor`            `crew doctor --json`; read-only, never `--fix`.
 *  - `GET /diagnostics`       redacted, allow-listed diagnostic bundle (CREW-3008, `diagnostics.ts`).
 *  - `POST /periscopes`, `POST /periscopes/<ticket>/down`, `GET /periscopes`
 *                             Passenger periscopes (CREW-2859, `periscope-control.ts`);
 *                             404 unless a route sets `hostPeriscopes: true`.
 *  - `POST /periscopes/<ticket>/mcp`  one periscope's MCP server (CREW-2862,
 *                             `periscope-mcp.ts`). The one path NOT behind the
 *                             tracker-key check: its own per-periscope secret is
 *                             the credential, and anything else answers 404.
 *
 * Nothing under setup, connect, key minting or provisioning is exposed, and no
 * endpoint accepts or returns a secret. Pause is the same sentinel files
 * `crew pause` writes, so the daemon's next pass and `crew status` see it.
 *
 * Incremental tails: `after=<cursor>` returns the lines written since, plus
 * the `cursor` to send next. A cursor is opaque (base64url of file identity +
 * byte offset). Identity is the inode, so an `events.jsonl` rotated by
 * rename (`rotateEventsFile`) is still found under its new name and read to
 * its end before the tail moves on to the live file. With no cursor the
 * response is the last `tail` lines (default 100; 0 for none) and a cursor at
 * the end. `wait=<seconds>` (max 30) holds the request until something is
 * appended or the time is up. Only whole lines are returned; a line still
 * being written is left for the next call.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, rmSync, statSync, watch,
} from 'node:fs';
import { createConnection, type Server } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { RoleName } from './config.ts';
import { addSeatNote } from './seat-notes.ts';
import { eventFileFor, ROTATED_EVENTS_RE } from './events.ts';
import { liveRuns, type LiveRun } from './live-runs.ts';
import { appendRunNote } from './run-snapshot.ts';
import { runInputFor } from './run-input.ts';
import { markMessage, postMessage } from './agent-log.ts';
import { readDaemonStarted } from './daemon.ts';
import { secretsMatch } from './secret-compare.ts';
import type { State } from './state.ts';
import { handlePeriscopes, isPeriscopePath, type PeriscopeHosting } from './periscope-control.ts';

/** The roles `crew pause <role>` accepts and the poll honors (`poll.ts` `pausedRoles`). */
const PAUSABLE: readonly RoleName[] = ['dev', 'design', 'qa'];

export const CONTROL_SOCKET_NAME = 'control.sock';
export const controlSocketFor = (stateDir: string): string => join(stateDir, CONTROL_SOCKET_NAME);

/** macOS limits a unix socket path to 104 bytes including the NUL. */
const MAX_SOCKET_PATH = 100;
const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_WAIT_SECONDS = 30;
const DEFAULT_TAIL_LINES = 100;
const MAX_BODY_BYTES = 4096;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthVerdict = 'ok' | 'unauthorized' | 'forbidden' | 'unavailable';

export interface ControlAuthOptions {
  /** `https://app.tablation.com` — `/api/auth/me` is appended. */
  baseUrl: string;
  /** Every workspace this ship serves. */
  workspaceIds: string[];
  /** The ship's own tracker key(s); matched locally, no round trip. */
  shipKeys: () => string[];
  /**
   * The Passenger MCP secret of the tunnel a workspace has up (CREW-2889).
   * It is the one credential the in-app chat holds for this ship, so it opens
   * the periscope operations of its own workspace through `verifyIn` and
   * nothing else: `verify` never consults it.
   */
  workspaceSecrets?: (workspaceId: string) => string[];
  userAgent?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a definite verdict is reused. Default 60 s. */
  cacheMs?: number;
  timeoutMs?: number;
}

/**
 * Bearer-token check. A token is good when it is one of the ship's own keys,
 * or `/api/auth/me?workspaceId=<served>` answers 200 JSON for it (the same
 * check the relay and the passenger MCP make). A token the tracker rejects is
 * 401 (invalid or revoked); one the tracker knows but that belongs to no
 * served workspace is 403. A tracker outage is `unavailable`, which fails
 * closed and is never cached. Verdicts are cached under a hash of the token,
 * so the raw token is never held.
 */
export class ControlAuth {
  private readonly cache = new Map<string, { verdict: AuthVerdict; at: number }>();
  private readonly o: ControlAuthOptions;
  constructor(o: ControlAuthOptions) { this.o = o; }

  async verify(token: string): Promise<AuthVerdict> {
    if (!token) return 'unauthorized';
    for (const k of this.o.shipKeys()) if (k && secretsMatch(token, k)) return 'ok';
    const now = (this.o.now ?? Date.now)();
    const id = createHash('sha256').update(token).digest('hex');
    const hit = this.cache.get(id);
    if (hit && now - hit.at < (this.o.cacheMs ?? 60_000)) return hit.verdict;
    const verdict = await this.ask(token);
    if (verdict !== 'unavailable') {
      this.cache.set(id, { verdict, at: now });
      if (this.cache.size > 256) for (const [k, v] of this.cache) if (now - v.at >= (this.o.cacheMs ?? 60_000)) this.cache.delete(k);
    }
    return verdict;
  }

  /**
   * Like `verify`, but the token must belong to `workspaceId` itself, not just
   * to some workspace this ship serves. The ship's own keys pass.
   */
  async verifyIn(token: string, workspaceId: string): Promise<AuthVerdict> {
    if (!token) return 'unauthorized';
    for (const k of this.o.shipKeys()) if (k && secretsMatch(token, k)) return 'ok';
    for (const k of this.o.workspaceSecrets?.(workspaceId) ?? []) if (k && secretsMatch(token, k)) return 'ok';
    const now = (this.o.now ?? Date.now)();
    const id = `${workspaceId}:${createHash('sha256').update(token).digest('hex')}`;
    const hit = this.cache.get(id);
    if (hit && now - hit.at < (this.o.cacheMs ?? 60_000)) return hit.verdict;
    const verdict = await this.ask(token, [workspaceId]);
    if (verdict !== 'unavailable') this.cache.set(id, { verdict, at: now });
    return verdict;
  }

  private async ask(token: string, workspaceIds: string[] = this.o.workspaceIds): Promise<AuthVerdict> {
    const doFetch = this.o.fetch ?? fetch;
    const base = this.o.baseUrl.replace(/\/+$/, '');
    let forbidden = false;
    for (const ws of workspaceIds) {
      let res: Response;
      try {
        res = await doFetch(`${base}/api/auth/me?workspaceId=${encodeURIComponent(ws)}`, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': this.o.userAgent ?? 'Mozilla/5.0 CrewShipControl/1.0' },
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
        });
      } catch { return 'unavailable'; }
      if (res.status === 401) return 'unauthorized';
      if (res.status === 403) { forbidden = true; continue; }
      if (res.status !== 200) return 'unavailable';
      // A 200 from a SPA catch-all would accept anything (the passenger MCP's
      // ISSUE-694): require /auth/me's own JSON.
      if (!(res.headers.get('content-type') ?? '').includes('application/json')) return 'unavailable';
      return 'ok';
    }
    return forbidden ? 'forbidden' : 'unauthorized';
  }
}

// ---------------------------------------------------------------------------
// Incremental tails
// ---------------------------------------------------------------------------

interface Cursor { dev: number; ino: number; off: number }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.dev, c.ino, c.off])).toString('base64url');
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const a = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(a) && a.length === 3 && a.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) {
      return { dev: a[0] as number, ino: a[1] as number, off: a[2] as number };
    }
  } catch { /* fall through */ }
  return null;
}

export interface TailResult {
  lines: string[];
  cursor: string;
  /** True when the cursor could not be honored (file replaced or truncated) and the read restarted. */
  reset: boolean;
}

/** `live` plus, for the event log, every `events.<stamp>.jsonl` beside it. */
function candidates(live: string, rotated: boolean): string[] {
  const out = [live];
  if (!rotated) return out;
  try {
    for (const n of readdirSync(dirname(live))) if (ROTATED_EVENTS_RE.test(n)) out.push(join(dirname(live), n));
  } catch { /* directory gone */ }
  return out;
}

function readRange(path: string, from: number, max: number): { text: string; size: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.max(0, Math.min(size - from, max));
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString('utf8'), size };
  } finally { closeSync(fd); }
}

/** The last `n` whole lines of `path` and a cursor at its current end. */
function lastLines(path: string, n: number): TailResult {
  const st = statSync(path);
  const cursorAt = (off: number) => encodeCursor({ dev: st.dev, ino: st.ino, off });
  if (n <= 0 || st.size === 0) return { lines: [], cursor: cursorAt(st.size), reset: false };
  // Read back in chunks until n newlines are seen or the file start is reached.
  let start = st.size;
  let text = '';
  while (start > 0 && text.split('\n').length <= n + 1 && st.size - start < MAX_TAIL_BYTES) {
    const step = Math.min(64 * 1024, start);
    start -= step;
    text = readRange(path, start, step).text + text;
  }
  let lines = text.split('\n');
  if (start > 0) lines = lines.slice(1); // the first line is cut in half
  // Only whole lines: drop an unterminated trailing fragment and move the cursor before it.
  let end = st.size;
  if (!text.endsWith('\n')) { const frag = lines.pop() ?? ''; end -= Buffer.byteLength(frag); } else lines.pop();
  return { lines: lines.slice(-n).filter((l) => l.length), cursor: cursorAt(end), reset: false };
}

/**
 * Lines appended to `live` (and any rotated sibling when `rotated`) since
 * `after`. See the file header for the cursor semantics.
 */
export function readTail(live: string, opts: { after?: string; tail?: number; rotated?: boolean; maxBytes?: number }): TailResult {
  const max = opts.maxBytes ?? MAX_TAIL_BYTES;
  if (!existsSync(live)) {
    return { lines: [], cursor: opts.after ?? encodeCursor({ dev: 0, ino: 0, off: 0 }), reset: false };
  }
  const cur = opts.after ? decodeCursor(opts.after) : null;
  if (!opts.after) return lastLines(live, opts.tail ?? DEFAULT_TAIL_LINES);

  let reset = false;
  let path = live;
  let off = 0;
  if (!cur) { reset = true; } else {
    const found = candidates(live, opts.rotated ?? false).find((p) => {
      try { const s = statSync(p); return s.ino === cur.ino && s.dev === cur.dev; } catch { return false; }
    });
    if (found) { path = found; off = cur.off; } else reset = true;
  }
  let size = statSync(path).size;
  if (off > size) { off = 0; reset = true; } // truncated in place
  if (off >= size && path !== live) {
    // Finished reading a rotated file: continue from the start of the live one.
    path = live; off = 0; size = statSync(path).size;
  }
  const { text } = readRange(path, off, max);
  const cut = text.lastIndexOf('\n');
  const whole = cut < 0 ? '' : text.slice(0, cut + 1);
  const st = statSync(path);
  return {
    lines: whole.split('\n').filter((l) => l.length),
    cursor: encodeCursor({ dev: st.dev, ino: st.ino, off: off + Buffer.byteLength(whole) }),
    reset,
  };
}

/** Resolves when `dir` sees activity or `ms` passes, whichever is first. */
function waitForChange(dir: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let w: ReturnType<typeof watch> | undefined;
    const done = () => { clearTimeout(t); clearInterval(poll); signal.removeEventListener('abort', done); try { w?.close(); } catch { /* closed */ } resolve(); };
    const t = setTimeout(done, ms);
    // fs.watch is advisory on some filesystems; a short poll is the backstop.
    const poll = setInterval(done, 500);
    signal.addEventListener('abort', done);
    try { w = watch(dir, done); w.on('error', () => {}); } catch { /* the poll covers it */ }
  });
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface SchedulerAction { action: 'start' | 'stop' | 'restart' }

export interface ControlDeps {
  stateDir: string;
  state: State;
  auth: Pick<ControlAuth, 'verify'>;
  /** `crew status --json` as an object, or null when it could not be produced. */
  status: () => Promise<Record<string, unknown> | null>;
  /** `crew doctor --json` as an object, or null when it could not be produced. */
  doctor: () => Promise<unknown | null>;
  /** The redacted diagnostic bundle (CREW-3008); absent: the path is a 404. */
  diagnostics?: () => Promise<Record<string, unknown>>;
  /** Begins the action after the response is sent; false when the host has no service manager to drive. */
  scheduler: (a: SchedulerAction['action']) => { accepted: boolean; detail: string };
  startedAt?: number;
  /** Passenger periscope hosting; absent on a ship that cannot host them. */
  periscopes?: PeriscopeHosting;
  /**
   * Serves `/periscopes/<ticket>/mcp` (CREW-2862). Called BEFORE the bearer
   * check: that path is authenticated by the periscope's own secret, which the
   * handler checks. Absent: the path is a plain 404.
   */
  periscopeMcp?: (req: IncomingMessage, res: ServerResponse, ticket: string) => Promise<void>;
  log?: (m: string) => void;
}

interface Reply { status: number; body: unknown; stream?: (write: (event: unknown) => void) => Promise<void> }
const reply = (status: number, body: unknown): Reply => ({ status, body });
const err = (status: number, message: string): Reply => reply(status, { error: message });

function pauseDoc(state: State) {
  return {
    crew: state.isPaused(),
    release: state.isReleasePaused(),
    roles: Object.fromEntries(PAUSABLE.map((r) => [r, state.isRolePaused(r)])),
  };
}

function describeStream(r: LiveRun) {
  return {
    run: basename(r.streamPath).replace(/\.jsonl$/, ''),
    pid: r.pid,
    ticket: r.ticket,
    role: r.role,
    model: r.model,
    startedAt: r.spawnedAt,
    // No run-time limit is enforced today; the field is here so a reader needs no change when one is.
    deadline: null,
  };
}

const RUN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) return null;
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

async function tailReply(path: string, q: URLSearchParams, rotated: boolean, abort: AbortSignal): Promise<Reply> {
  const after = q.get('after') ?? undefined;
  const tail = q.has('tail') ? Number(q.get('tail')) : undefined;
  if (tail !== undefined && !(Number.isInteger(tail) && tail >= 0 && tail <= 1000)) return err(400, 'tail must be an integer from 0 to 1000');
  const wait = q.has('wait') ? Number(q.get('wait')) : 0;
  if (!(Number.isFinite(wait) && wait >= 0)) return err(400, 'wait must be a number of seconds');
  if (after !== undefined && !decodeCursor(after)) return err(400, 'after is not a cursor this API issued');
  const deadline = Date.now() + Math.min(wait, MAX_WAIT_SECONDS) * 1000;
  let r = readTail(path, { after, tail, rotated });
  // A long-poll only makes sense with a cursor: without one the caller has seen nothing yet.
  while (after && !r.lines.length && !r.reset && Date.now() < deadline && !abort.aborted) {
    await waitForChange(dirname(path), deadline - Date.now(), abort);
    r = readTail(path, { after: r.cursor, rotated });
  }
  return reply(200, r);
}

const NOTE_MAX_CHARS = 4000;
const SEAT_ROLES: readonly RoleName[] = ['dev', 'design', 'qa', 'triage', 'pair'];

/** `POST /streams/<run>/messages` (CREW-3119). */
async function postRunMessage(deps: ControlDeps, run: string, body: Record<string, unknown> | null): Promise<Reply> {
  if (!RUN_NAME_RE.test(run) || run.includes('..')) return err(400, 'not a run name');
  const live = liveRuns(deps.stateDir).find((r) => basename(r.streamPath, '.jsonl') === run.replace(/\.jsonl$/, ''));
  const carry = 'A note for the work item posted from the platform is carried forward into its next run\'s brief.';
  if (!live) return err(404, `no live run ${run}: it is unknown or has finished. ${carry}`);
  if (!body) return err(400, 'body must be a small JSON object');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > NOTE_MAX_CHARS) return err(400, `text must be a string of 1 to ${NOTE_MAX_CHARS} characters`);
  if (body.author !== undefined && typeof body.author !== 'string') return err(400, 'author must be a string');
  const input = runInputFor(basename(live.streamPath, '.jsonl'));
  const rowId = input?.agentLogRowId();
  if (!input?.target || !rowId) return err(409, `run ${run} is live but this daemon cannot record a note on it (it did not start the run, or the run has no Agent Log row). ${carry}`);
  try {
    const recorded = await postMessage(input.target, rowId, text);
    const acceptsInput = input.accepts();
    const state = acceptsInput ? await input.deliver(recorded, (body.author as string | undefined) || undefined) : 'carried_forward';
    if (!acceptsInput) await markMessage(input.target, rowId, recorded.id, 'carried_forward');
    appendRunNote(live.streamPath, {
      id: recorded.id, text, author: (body.author as string | undefined) || null,
      at: recorded.occurredAt ?? new Date().toISOString(), state: state === 'delivered' ? 'delivered' : 'carried_forward',
    });
    return reply(200, { cycleId: recorded.id, state, acceptsInput });
  } catch (e) {
    return err(409, `the platform did not take the note: ${(e as Error).message}. ${carry}`);
  }
}

/** `POST /seats/<role>/notes` (CREW-3249). */
function postSeatNote(deps: ControlDeps, role: string, body: Record<string, unknown> | null): Reply {
  if (!SEAT_ROLES.includes(role as RoleName)) return err(400, `role must be one of ${SEAT_ROLES.join(', ')}`);
  if (!body) return err(400, 'body must be a small JSON object');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > NOTE_MAX_CHARS) return err(400, `text must be a string of 1 to ${NOTE_MAX_CHARS} characters`);
  if (body.author !== undefined && typeof body.author !== 'string') return err(400, 'author must be a string');
  if (body.ticket !== undefined && (typeof body.ticket !== 'string' || !body.ticket.trim() || body.ticket.length > 64)) return err(400, 'ticket must be a ticket tag');
  try {
    const note = addSeatNote(deps.stateDir, {
      role: role as RoleName, text,
      ...(body.ticket ? { ticket: (body.ticket as string).trim() } : {}),
      ...(body.author ? { author: (body.author as string).trim() } : {}),
    });
    return reply(200, { id: note.id, state: 'carried_forward', carriedForward: true });
  } catch (e) {
    return err(500, `could not store the note: ${(e as Error).message}`);
  }
}

export async function route(deps: ControlDeps, method: string, url: URL, req: IncomingMessage, abort: AbortSignal): Promise<Reply> {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const get = method === 'GET';
  const post = method === 'POST';

  if (isPeriscopePath(p)) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]?.trim() ?? '';
    // Only a POST has a body worth reading; a malformed one is a 400 from the handler.
    const body = method === 'POST' ? await readJsonBody(req) : {};
    return handlePeriscopes(deps.periscopes, {
      method, path: p, query: url.searchParams, token, body,
      wantsStream: url.searchParams.get('stream') === '1' || (req.headers.accept ?? '').includes('application/x-ndjson'),
    });
  }

  if (p === '/status' && get) {
    const doc = await deps.status();
    if (!doc) return err(502, 'could not produce the status document');
    return reply(200, {
      ...doc,
      daemon: {
        alive: true,
        pid: process.pid,
        startedAt: deps.startedAt ?? readDaemonStarted(deps.stateDir),
        uptimeSeconds: Math.round(process.uptime()),
      },
      pause: pauseDoc(deps.state),
    });
  }
  if (p === '/events' && get) return tailReply(eventFileFor(deps.stateDir), url.searchParams, true, abort);
  if (p === '/streams' && get) return reply(200, { streams: liveRuns(deps.stateDir).map(describeStream) });
  if (p.startsWith('/streams/') && get) {
    const run = decodeURIComponent(p.slice('/streams/'.length));
    // The name becomes a path: only a plain file name inside streams/, and never a sidecar or event file.
    if (!RUN_NAME_RE.test(run) || run.includes('..') || /\.(pid|meta\.json|events\.jsonl)$/.test(run)) return err(400, 'not a run name');
    const file = join(deps.stateDir, 'streams', run.endsWith('.jsonl') ? run : `${run}.jsonl`);
    if (!existsSync(file)) return err(404, 'no such run');
    return tailReply(file, url.searchParams, false, abort);
  }
  const note = /^\/streams\/([^/]+)\/messages$/.exec(p);
  if (note && post) return postRunMessage(deps, decodeURIComponent(note[1]!), await readJsonBody(req));
  const seatNote = /^\/seats\/([^/]+)\/notes$/.exec(p);
  if (seatNote && post) return postSeatNote(deps, decodeURIComponent(seatNote[1]!), await readJsonBody(req));
  if ((p === '/pause' || p === '/resume') && post) {
    const body = await readJsonBody(req);
    if (!body) return err(400, 'body must be a small JSON object');
    const role = body.role;
    if (role !== undefined && !PAUSABLE.includes(role as RoleName)) return err(400, `role must be one of ${PAUSABLE.join(', ')}`);
    if (p === '/pause') deps.state.pause(role as RoleName | undefined);
    else deps.state.resume(role as RoleName | undefined);
    return reply(200, { ok: true, pause: pauseDoc(deps.state) });
  }
  if ((p === '/release/pause' || p === '/release/resume') && post) {
    deps.state.setReleasePaused(p === '/release/pause');
    return reply(200, { ok: true, pause: pauseDoc(deps.state) });
  }
  const sched = /^\/scheduler\/(start|stop|restart)$/.exec(p);
  if (sched && post) {
    const r = deps.scheduler(sched[1] as SchedulerAction['action']);
    return r.accepted ? reply(202, { accepted: true, detail: r.detail }) : err(409, r.detail);
  }
  if (p === '/doctor' && get) {
    const doc = await deps.doctor();
    return doc ? reply(200, doc) : err(502, 'could not produce the doctor report');
  }
  if (p === '/diagnostics' && get && deps.diagnostics) return reply(200, await deps.diagnostics());
  const known = ['/status', '/events', '/streams', '/pause', '/resume', '/release/pause', '/release/resume', '/doctor', ...(deps.diagnostics ? ['/diagnostics'] : [])];
  if (known.includes(p) || p.startsWith('/streams/') || seatNote || sched) return err(405, 'method not allowed');
  return err(404, 'not found');
}

function send(res: ServerResponse, r: Reply): void | Promise<void> {
  if (r.stream) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    return r.stream((ev) => { if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`); }).then(() => { res.end(); });
  }
  const body = JSON.stringify(r.body);
  res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

/** A socket file whose owner is gone: nothing accepts on it. */
async function socketIsStale(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return new Promise((resolve) => {
    const c = createConnection(path);
    c.once('connect', () => { c.destroy(); resolve(false); });
    c.once('error', () => resolve(true));
  });
}

export interface RunningControlServer { server: Server; path: string; close(): Promise<void> }

/**
 * Starts the server. Resolves to null — never rejects — when it cannot
 * listen (path too long, another live daemon on the socket): a control API
 * that fails to start must not take the scheduler down with it.
 */
export async function startControlServer(deps: ControlDeps): Promise<RunningControlServer | null> {
  const path = controlSocketFor(deps.stateDir);
  const log = deps.log ?? (() => {});
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    log(`control API not started: socket path is too long for a unix socket (${path})`);
    return null;
  }
  if (await socketIsStale(path)) rmSync(path, { force: true });
  else if (existsSync(path)) { log(`control API not started: ${path} is in use by another process`); return null; }

  const server = createServer((req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    void (async () => {
      try {
        const mcp = /^\/periscopes\/([^/]+)\/mcp\/?$/.exec(new URL(req.url ?? '/', 'http://ship').pathname);
        if (mcp) {
          if (!deps.periscopeMcp) return send(res, err(404, 'not found'));
          return await deps.periscopeMcp(req, res, decodeURIComponent(mcp[1]!));
        }
        // Periscope operations are gated by `handlePeriscopes` and its per-route
        // membership check (CREW-2889), which also accepts a workspace's tunnel secret.
        if (isPeriscopePath(new URL(req.url ?? '/', 'http://ship').pathname.replace(/\/+$/, '') || '/')) {
          return await send(res, await route(deps, req.method ?? 'GET', new URL(req.url ?? '/', 'http://ship'), req, abort.signal));
        }
        const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
        const verdict = await deps.auth.verify(m?.[1]?.trim() ?? '');
        if (verdict === 'unauthorized') return send(res, err(401, 'invalid or revoked key'));
        if (verdict === 'forbidden') return send(res, err(403, 'this key does not belong to a workspace this ship serves'));
        if (verdict === 'unavailable') return send(res, err(503, 'could not verify the key right now'));
        await send(res, await route(deps, req.method ?? 'GET', new URL(req.url ?? '/', 'http://ship'), req, abort.signal));
      } catch (e) {
        log(`control API request failed: ${(e as Error).message}`);
        if (!res.headersSent) send(res, err(500, 'internal error'));
        else res.end();
      }
    })();
  });
  return new Promise((resolve) => {
    server.once('error', (e) => { log(`control API not started: ${(e as Error).message}`); resolve(null); });
    server.listen(path, () => {
      try { chmodSync(path, 0o600); } catch { /* best effort; the bearer token is the real gate */ }
      server.on('error', (e) => log(`control API error: ${(e as Error).message}`));
      resolve({
        server, path,
        close: () => new Promise<void>((done) => { server.close(() => { rmSync(path, { force: true }); done(); }); }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Scheduler actions
// ---------------------------------------------------------------------------

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs service-manager commands detached from this process. `stop` unloads
 * the very unit the daemon runs under, so the follow-up `start` of a restart
 * cannot be run by the daemon itself; a detached shell outlives it. The short
 * sleep lets the 202 reach the caller first.
 */
export function runDetached(commands: string[][], spawnFn: typeof spawn = spawn): void {
  const script = `sleep 1; ${commands.map((c) => c.map(shq).join(' ')).join('; ')}`;
  const child = spawnFn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function schedulerHandler(
  control: { startCommand: string[] | null; stopCommand: string[] | null },
  run: (commands: string[][]) => void = runDetached,
): ControlDeps['scheduler'] {
  return (action) => {
    const { startCommand: start, stopCommand: stop } = control;
    if (!start || !stop) return { accepted: false, detail: 'this host has no service manager for the daemon (cron or none)' };
    const commands = action === 'start' ? [start] : action === 'stop' ? [stop] : [stop, start];
    run(commands);
    return { accepted: true, detail: `${action} requested` };
  };
}

/**
 * Runs this same crew program with `args` and parses its stdout as JSON, so
 * `/status` and `/doctor` return exactly what the CLI prints rather than a
 * second implementation that could drift. Null on a non-JSON answer or a
 * timeout. A non-zero exit is not a failure here: `doctor` exits non-zero
 * when it finds a blocker, and that report is the answer.
 */
export function crewJson(args: string[], timeoutMs = 60_000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    execFile(process.execPath, [process.argv[1] ?? '', ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) => {
      try {
        const v = JSON.parse(String(stdout)) as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch { resolve(null); }
    });
  });
}
