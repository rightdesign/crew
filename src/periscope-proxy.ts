/**
 * The periscope proxy (EPIC-078 Map v1 §5, CREW-2880).
 *
 * A small reverse proxy in front of the URL a repository's `preview` hook
 * printed. It does three things the repository used to do for itself:
 *
 * 1. Appends one `<script type="module">` to HTML responses, loading the
 *    inspector overlay, which the proxy serves from its own assets.
 * 2. Accepts the overlay's click on `/__periscope/pointed` and appends the line
 *    to the worktree's drop file (`periscope-pointed.ts`).
 * 3. Passes everything else through unchanged, upgrades (the hot-reload
 *    websocket) included.
 *
 * `inject: false` is the `periscope.inspector: repo` switch: a repository that
 * serves its own overlay and route gets a plain pass-through.
 *
 * Content-security-policy headers that would block the injected script are
 * rewritten to add the proxy's own origin (`'self'`, which is the proxy's
 * origin because the page is served from it) and nothing else. A policy
 * delivered by a `<meta>` tag inside the HTML is not rewritten.
 *
 * `requestFilter` is the seam for authentication (EPIC-077's Passenger
 * milestone): it runs before anything is served or proxied and answers
 * `false` after writing its own response to refuse. This ticket adds no
 * authentication and no remote reach; the proxy binds to the host it is given.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { dirname, isAbsolute } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { INSPECTOR_ROUTE, INSPECTOR_SOURCE, POINTED_ROUTE } from './periscope-inspector.ts';
import { killGently, pidsOnPort, proxyPortFor } from './ports.ts';
import { pointedAtFile, type PointedAt } from './periscope-pointed.ts';

const MAX_BODY_BYTES = 8 * 1024;
const SCRIPT_TAG = `<script type="module" src="${INSPECTOR_ROUTE}"></script>`;

export interface PeriscopeProxyOptions {
  /** The dev server's own URL. */
  target: URL;
  /** Absolute path of the worktree's `.crew/pointed-at.jsonl`. */
  dropFile: string;
  /** Inject the overlay and serve the pointed route; false is a plain pass-through. */
  inject: boolean;
  /** Authentication seam: return false after writing a response to refuse the request. */
  requestFilter?: (req: IncomingMessage, res: ServerResponse | Socket) => boolean | Promise<boolean>;
  now?: () => Date;
}

/** Validates an untrusted pointed body; null for anything malformed. */
export function parsePointedBody(raw: string): Omit<PointedAt, 'at'> | null {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const p = b.path;
  const line = b.line;
  if (typeof p !== 'string' || p.length === 0 || p.length > 500) return null;
  if (isAbsolute(p) || p.split(/[\\/]/).includes('..')) return null;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
  const entry: Omit<PointedAt, 'at'> = { path: p, line };
  if (typeof b.column === 'number' && Number.isInteger(b.column) && b.column >= 0) entry.column = b.column;
  if (typeof b.component === 'string' && b.component.length <= 200) entry.component = b.component;
  if (typeof b.url === 'string') entry.url = b.url.slice(0, 2000);
  return entry;
}

/** Appends one JSON line (with `at` stamped), creating the directory if needed. */
export function appendPointed(file: string, entry: Omit<PointedAt, 'at'>, now: Date = new Date()): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ...entry, at: now.toISOString() })}\n`);
}

/** Directives whose sources must admit the proxy's own origin for the overlay to load and post. */
const CSP_DIRECTIVES = new Set(['default-src', 'script-src', 'script-src-elem', 'connect-src']);

/**
 * Adds `'self'` to the directives that would block the injected script or its
 * post. `'none'` is replaced (it cannot be combined with other sources).
 * Directives for other things are untouched.
 */
export function relaxCsp(policy: string): string {
  return policy.split(';').map((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens[0]?.toLowerCase();
    if (!name || !CSP_DIRECTIVES.has(name)) return part.trim();
    const sources = tokens.slice(1).filter((t) => t.toLowerCase() !== "'none'");
    if (!sources.some((t) => t.toLowerCase() === "'self'")) sources.push("'self'");
    return [tokens[0], ...sources].join(' ');
  }).filter(Boolean).join('; ');
}

/** Inserts the overlay tag before the last `</body>`, else at the end. */
export function injectScript(html: string): string {
  const i = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return i === -1 ? html + SCRIPT_TAG : html.slice(0, i) + SCRIPT_TAG + html.slice(i);
}

function decode(body: Buffer, encoding: string | undefined): Buffer | undefined {
  switch ((encoding ?? '').toLowerCase().trim()) {
    case '': case 'identity': return body;
    case 'gzip': case 'x-gzip': return gunzipSync(body);
    case 'deflate': return inflateSync(body);
    case 'br': return brotliDecompressSync(body);
    default: return undefined;
  }
}

function forwardHeaders(req: IncomingMessage, target: URL): OutgoingHttpHeaders {
  const h: OutgoingHttpHeaders = { ...req.headers, host: target.host };
  // Origin and Referer name the proxy; dev servers that check them expect their own.
  if (typeof h.origin === 'string') h.origin = target.origin;
  if (typeof h.referer === 'string') {
    try { const r = new URL(h.referer); h.referer = `${target.origin}${r.pathname}${r.search}`; } catch { /* leave it */ }
  }
  return h;
}

function refuse(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

function handlePointed(req: IncomingMessage, res: ServerResponse, o: PeriscopeProxyOptions): void {
  if (req.method !== 'POST') return refuse(res, 405, { Allow: 'POST' });
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) { aborted = true; refuse(res, 413); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const entry = parsePointedBody(Buffer.concat(chunks).toString('utf8'));
    if (!entry) return refuse(res, 400);
    try {
      appendPointed(o.dropFile, entry, o.now?.());
      refuse(res, 204);
    } catch {
      refuse(res, 500);
    }
  });
}

function proxyRequest(req: IncomingMessage, res: ServerResponse, o: PeriscopeProxyOptions): void {
  const { target } = o;
  const secure = target.protocol === 'https:';
  const upstream = (secure ? httpsRequest : httpRequest)({
    hostname: target.hostname,
    port: target.port || (secure ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req, target),
  }, (up) => {
    const headers: OutgoingHttpHeaders = { ...up.headers };
    if (typeof headers.location === 'string' && headers.location.startsWith(target.origin)) {
      headers.location = headers.location.slice(target.origin.length) || '/';
    }
    const csp = headers['content-security-policy'];
    if (o.inject && typeof csp === 'string') headers['content-security-policy'] = relaxCsp(csp);
    const isHtml = /^text\/html\b/i.test(String(up.headers['content-type'] ?? ''));
    if (!o.inject || !isHtml || req.method === 'HEAD') {
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
      return;
    }
    // HTML to be edited: buffer it, decompress if needed, inject, resend uncompressed.
    const chunks: Buffer[] = [];
    up.on('data', (c: Buffer) => chunks.push(c));
    up.on('end', () => {
      let html: Buffer | undefined;
      try { html = decode(Buffer.concat(chunks), String(up.headers['content-encoding'] ?? '')); } catch { html = undefined; }
      if (!html) {
        // An encoding we cannot read, or a corrupt body: send it as it came rather than break the page.
        res.writeHead(up.statusCode ?? 502, headers);
        res.end(Buffer.concat(chunks));
        return;
      }
      const out = Buffer.from(injectScript(html.toString('utf8')), 'utf8');
      delete headers['content-encoding'];
      delete headers.etag;
      delete headers['transfer-encoding'];
      headers['content-length'] = String(out.length);
      res.writeHead(up.statusCode ?? 502, headers);
      res.end(out);
    });
    up.on('error', () => res.destroy());
  });
  upstream.on('error', (e) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`periscope proxy: ${target.origin} is not answering (${e.message})\n`);
  });
  req.pipe(upstream);
}

function proxyUpgrade(req: IncomingMessage, client: Socket, head: Buffer, o: PeriscopeProxyOptions): void {
  const { target } = o;
  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);
  const up = secure ? tlsConnect({ host: target.hostname, port, servername: target.hostname }) : netConnect({ host: target.hostname, port });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
  // A browser reloading a page with a live HMR socket just goes away. Its FIN
  // arrives as `end`, and the sockets allow half-open, so pipe() alone would
  // leave the upstream tunnel open: tie the two together on end and on close.
  const hangUp = () => { up.destroy(); client.destroy(); };
  client.on('end', hangUp);
  client.on('close', hangUp);
  up.on('end', hangUp);
  up.on('close', hangUp);
  up.on(secure ? 'secureConnect' : 'connect', () => {
    const headers = forwardHeaders(req, target);
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
}

export function createPeriscopeProxy(o: PeriscopeProxyOptions): Server {
  const server = createServer(async (req, res) => {
    try {
      if (o.requestFilter && !(await o.requestFilter(req, res))) return;
      const path = (req.url ?? '/').split('?')[0];
      if (o.inject && path === INSPECTOR_ROUTE && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : INSPECTOR_SOURCE);
        return;
      }
      if (o.inject && path === POINTED_ROUTE) return handlePointed(req, res, o);
      proxyRequest(req, res, o);
    } catch {
      if (!res.headersSent) refuse(res, 500); else res.destroy();
    }
  });
  server.on('upgrade', async (req, socket: Socket, head) => {
    try {
      if (o.requestFilter && !(await o.requestFilter(req, socket))) return;
      proxyUpgrade(req, socket, head, o);
    } catch {
      socket.destroy();
    }
  });
  return server;
}

// ---------------------------------------------------------------------------
// Running it as its own process
// ---------------------------------------------------------------------------

export interface ProxyLaunch {
  worktree: string;
  /** The dev server URL the `preview` hook printed. */
  target: string;
  host: string;
  port: number;
  inject: boolean;
}

/** The environment the detached proxy process reads (`crew periscope-proxy`). */
export function proxyEnv(l: ProxyLaunch): Record<string, string> {
  return {
    CREW_PROXY_TARGET: l.target,
    CREW_PROXY_HOST: l.host,
    CREW_PROXY_PORT: String(l.port),
    CREW_PROXY_INJECT: l.inject ? '1' : '0',
  };
}

/**
 * The URL a viewer is given: the dev server's own path and query, on the
 * proxy's origin. `host` is the address the proxy binds, which is also what
 * the `preview` hook was told to bind.
 */
export function proxiedUrl(previewUrl: string, host: string, port: number): string {
  const u = new URL(previewUrl);
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}${u.pathname === '/' && !u.search ? '/' : u.pathname}${u.search}`;
}

/** Entry point of `crew periscope-proxy <dropFile>`; everything else arrives in the environment. */
export function runProxyFromEnv(dropFile: string, env: NodeJS.ProcessEnv = process.env): Server {
  const target = env.CREW_PROXY_TARGET;
  const port = Number(env.CREW_PROXY_PORT);
  if (!target || !Number.isInteger(port) || port <= 0) throw new Error('periscope-proxy: CREW_PROXY_TARGET and CREW_PROXY_PORT are required');
  const server = createPeriscopeProxy({ target: new URL(target), dropFile, inject: env.CREW_PROXY_INJECT !== '0' });
  server.on('error', (e) => { process.stderr.write(`periscope-proxy: ${e.message}\n`); process.exit(1); });
  server.listen(port, env.CREW_PROXY_HOST || 'localhost');
  return server;
}

/** True once something accepts a connection on host:port. */
export function accepts(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * Starts the proxy for a worktree as a detached process (it must outlive the
 * `crew periscope up` that starts it) and returns the viewer's URL. Whatever
 * already listens on the ticket's proxy port is a stale proxy from an earlier
 * run and is stopped first. The drop file path is on the command line so
 * `pidsInWorktree` finds the process by its worktree as well as by its port.
 */
export async function launchProxy(
  invocation: string[],
  worktree: string,
  previewUrl: string,
  number: number,
  o: { host: string; inject: boolean; waitMs?: number },
): Promise<string> {
  const port = proxyPortFor(number);
  const stale = pidsOnPort(port);
  if (stale.length) await killGently(stale);
  const launch: ProxyLaunch = { worktree, target: previewUrl, host: o.host, port, inject: o.inject };
  const [cmd, ...args] = invocation;
  const child = spawn(cmd!, [...args, 'periscope-proxy', pointedAtFile(worktree)], {
    detached: true, stdio: 'ignore', cwd: worktree, env: { ...process.env, ...proxyEnv(launch) },
  });
  child.unref();
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + (o.waitMs ?? 10_000);
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the proxy process exited before listening on ${o.host}:${port}`);
    if (await accepts(o.host, port)) return proxiedUrl(previewUrl, o.host, port);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
  throw new Error(`the proxy did not start listening on ${o.host}:${port}`);
}
