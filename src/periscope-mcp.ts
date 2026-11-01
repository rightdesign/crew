/**
 * The MCP server of one periscope (EPIC-077, CREW-2862): the chat agent's
 * hands in the worktree the ship cut for a Passenger's session.
 *
 * Served by the daemon on the control API at `/periscopes/<ticket>/mcp`, so it
 * reaches the workspace through the relay's `control` path. It is a deliberate,
 * scoped amendment to the Passenger promise of a read-only surface: writes
 * exist, but only inside this one worktree and only until the periscope ends.
 * Nothing here touches the Passenger container or its mounts
 * (`passenger-mcp.ts` is unchanged and still registers no write-shaped tool).
 *
 * Boundaries, each enforced in code rather than by the tool descriptions:
 *  - Every path is resolved against the worktree's real path and refused when
 *    it, or the deepest existing ancestor of a path to be created, resolves
 *    outside it (symlinks included). `.git` is never touched.
 *  - `run_hook` runs only a hook the repository declares, by name; there is no
 *    shell tool. `isolate` is allowed only for a row opened `--isolate`.
 *  - Git is `status`, `diff` and `commit` on the ticket branch: no push, no
 *    checkout, no other worktree.
 *  - A bearer secret per periscope (`periscope-endpoints.ts`), checked before
 *    any tool is built. Another periscope's secret, no secret and an ended
 *    periscope all answer the same 404, so a caller learns nothing about which
 *    tickets exist.
 *
 * Every `tools/call` refreshes the periscope's activity through `touch`, so a
 * session that is working keeps the idle-expiry pass (`periscope-idle.ts`) away.
 *
 * Unlike `passenger-mcp.ts` this does not use `@modelcontextprotocol/server-
 * filesystem`'s `validatePath`: that keeps its allowed roots in process-wide
 * state, and the daemon serves many periscopes (and other work) in one process.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { git, GitError } from './git.ts';
import { secretsMatch } from './secret-compare.ts';
import { readPeriscopeSecret } from './periscope-endpoints.ts';
import { parseEnvLines, type HookResult } from './periscope-cmd.ts';
import type { PeriscopeSidecar } from './periscope-state.ts';

/** The hooks a caller may name. `setup` and `release` are the ship's, not a session's. */
export const PERISCOPE_HOOKS = ['test', 'build', 'ports', 'handoff', 'preview', 'isolate'] as const;
export type PeriscopeHook = (typeof PERISCOPE_HOOKS)[number];

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_HOOK_OUTPUT = 20_000;
const MAX_DIFF = 200_000;
const MAX_SEARCH_RESULTS = 500;

export class PathRefusal extends Error {}

const isInside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/**
 * The deepest ancestor of `p` (or `p`) that exists, resolved through symlinks,
 * with the part below it. A dangling symlink is not "a path that does not exist
 * yet": `realpath` fails on it with ENOENT, but a write through it creates the
 * file at its target, so the link is followed by hand and the walk continues
 * from where it points.
 */
async function realAncestor(p: string): Promise<{ real: string; rest: string }> {
  let cur = p;
  const tail: string[] = [];
  let hops = 0;
  for (;;) {
    try {
      return { real: await realpath(cur), rest: tail.slice().reverse().join(sep) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new PathRefusal(`cannot resolve ${p}`);
    }
    let isLink = false;
    try {
      isLink = (await lstat(cur)).isSymbolicLink();
    } catch {
      // Nothing at `cur` at all: it is the missing part of a path to be created.
    }
    if (isLink) {
      if (++hops > 40) throw new PathRefusal(`too many symbolic links resolving ${p}`);
      cur = resolve(dirname(cur), await readlink(cur));
      continue;
    }
    const parent = dirname(cur);
    if (parent === cur) throw new PathRefusal(`cannot resolve ${p}`);
    tail.push(basename(cur));
    cur = parent;
  }
}

/**
 * `requested` (relative to the worktree, or absolute under it) as an absolute
 * path inside `root`. Refuses anything that leaves the worktree after symlink
 * resolution, and anything inside `.git`. The path need not exist (a file to
 * be created); the deepest ancestor that does must be inside.
 */
export async function resolveInWorktree(root: string, requested: string): Promise<string> {
  if (!requested || requested.includes('\0')) throw new PathRefusal('path is required');
  const realRoot = await realpath(root);
  let abs: string;
  if (isAbsolute(requested)) {
    abs = resolve(requested);
    // The caller may hold the worktree path as the ship wrote it rather than its real path.
    if (isInside(root, abs)) abs = join(realRoot, relative(root, abs));
  } else {
    abs = resolve(realRoot, requested);
  }
  if (!isInside(realRoot, abs)) throw new PathRefusal(`${requested} is outside this periscope's worktree`);
  const { real, rest } = await realAncestor(abs);
  const final = rest ? join(real, rest) : real;
  if (!isInside(realRoot, final)) throw new PathRefusal(`${requested} is outside this periscope's worktree`);
  if (relative(realRoot, final).split(sep).includes('.git')) throw new PathRefusal('.git is not reachable from a periscope');
  return final;
}

/** A glob (`*`, `**`, `?`) as a regular expression over a `/`-separated relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const tailText = (s: string, max = MAX_HOOK_OUTPUT): string => (s.length > max ? `…(${s.length - max} earlier characters omitted)\n${s.slice(-max)}` : s);
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

export interface PeriscopeMcpDeps {
  stateDir: string;
  /** The live periscope on this ship for a ticket path segment (`CREW-12` or `12`), or undefined. */
  find(segment: string): PeriscopeSidecar | undefined;
  /**
   * Runs a hook the repository declares in `cwd`; null when it declares none.
   * Rejects only for a failure to run it at all.
   */
  runHook(sc: PeriscopeSidecar, name: PeriscopeHook, env: Record<string, string>): Promise<HookResult | null>;
  /** Records activity on the periscope (its row's `last_activity_at` / `expires_at`). Failures are swallowed. */
  touch(sc: PeriscopeSidecar): Promise<void>;
  log?(message: string): void;
}

/** The environment a hook sees: the ticket, the branch, and whatever `ports` (and `isolate`) print for this worktree. */
async function hookEnv(d: PeriscopeMcpDeps, sc: PeriscopeSidecar, name: PeriscopeHook): Promise<Record<string, string>> {
  const env: Record<string, string> = { CREW_TICKET: sc.ticket, CREW_BRANCH: sc.branch };
  if (name !== 'ports') {
    const ports = await d.runHook(sc, 'ports', env);
    if (ports) Object.assign(env, parseEnvLines(ports.output));
    if (sc.isolated && name !== 'isolate') {
      const iso = await d.runHook(sc, 'isolate', env);
      if (iso && iso.code === 0) Object.assign(env, parseEnvLines(iso.output));
    }
  }
  if (name === 'preview') env.CREW_PREVIEW_HOST = sc.host || 'localhost';
  return env;
}

/** The MCP server for one periscope. Each tool resolves its paths against `sc.worktree` afresh. */
export function createPeriscopeMcpServer(d: PeriscopeMcpDeps, sc: PeriscopeSidecar): McpServer {
  const server = new McpServer({ name: `crew-periscope-${sc.ticket}`, version: '0.1.0' });
  const root = sc.worktree;
  const inTree = (p: string) => resolveInWorktree(root, p);
  const rel = async (abs: string) => relative(await realpath(root), abs) || '.';

  server.registerTool('read_file', {
    title: 'Read File',
    description: 'Read a text file in this periscope\'s worktree. `head`/`tail` return only the first/last N lines.',
    inputSchema: { path: z.string(), head: z.number().int().positive().optional(), tail: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path, head, tail }) => {
    if (head && tail) return text('Cannot specify both head and tail', true);
    const abs = await inTree(path);
    const st = await stat(abs);
    if (!st.isFile()) return text(`${path} is not a file`, true);
    if (st.size > MAX_READ_BYTES) return text(`${path} is ${st.size} bytes; read it in parts with head or tail (limit ${MAX_READ_BYTES})`, true);
    const content = await readFile(abs, 'utf8');
    const lines = content.split('\n');
    return text(head ? lines.slice(0, head).join('\n') : tail ? lines.slice(-tail).join('\n') : content);
  });

  server.registerTool('list_directory', {
    title: 'List Directory',
    description: 'List the entries directly inside a directory of the worktree ("." is its root), each marked [FILE] or [DIR].',
    inputSchema: { path: z.string().default('.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path }) => {
    const abs = await inTree(path);
    const entries = (await readdir(abs, { withFileTypes: true })).filter((e) => e.name !== '.git');
    const lines = await Promise.all(entries.map(async (e) => {
      if (e.isDirectory()) return `[DIR]  ${e.name}`;
      const size = (await lstat(join(abs, e.name))).size;
      return `[FILE] ${e.name} (${size} bytes)`;
    }));
    return text(lines.join('\n') || '(empty)');
  });

  server.registerTool('search_files', {
    title: 'Search Files',
    description:
      'Find files in the worktree whose path (relative to the worktree) matches the glob `pattern` (`*` stays within a directory, `**` crosses them). ' +
      'Lists files git tracks or would not ignore, so `node_modules` and build output do not appear.',
    inputSchema: { pattern: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ pattern }) => {
    const re = globToRegExp(pattern);
    const listing = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const hits = listing.split('\0').filter((f) => f && re.test(f)).slice(0, MAX_SEARCH_RESULTS);
    return text(hits.length ? hits.join('\n') : 'No matches found');
  });

  server.registerTool('write_file', {
    title: 'Write File',
    description: 'Create a file in the worktree, or replace its whole content. Parent directories are created.',
    inputSchema: { path: z.string(), content: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ path, content }) => {
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return text(`content exceeds ${MAX_WRITE_BYTES} bytes`, true);
    const abs = await inTree(path);
    if (abs === await realpath(root)) return text('path must name a file', true);
    await mkdir(dirname(abs), { recursive: true });
    // The parent now exists: check once more that it is still inside before writing.
    await inTree(path);
    await writeFile(abs, content);
    return text(`Wrote ${Buffer.byteLength(content)} bytes to ${await rel(abs)}`);
  });

  server.registerTool('edit_file', {
    title: 'Edit File',
    description:
      'Replace an exact string in a file. `oldString` must occur exactly once unless `replaceAll` is true; ' +
      'whitespace and line endings must match.',
    inputSchema: { path: z.string(), oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ path, oldString, newString, replaceAll }) => {
    const abs = await inTree(path);
    const st = await stat(abs);
    if (!st.isFile()) return text(`${path} is not a file`, true);
    if (st.size > MAX_WRITE_BYTES) return text(`${path} is too large to edit`, true);
    const before = await readFile(abs, 'utf8');
    const count = before.split(oldString).length - 1;
    if (count === 0) return text(`oldString was not found in ${path}`, true);
    if (count > 1 && !replaceAll) return text(`oldString occurs ${count} times in ${path}; make it unique or set replaceAll`, true);
    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, () => newString);
    await writeFile(abs, after);
    return text(`Edited ${await rel(abs)} (${replaceAll ? count : 1} replacement${(replaceAll ? count : 1) === 1 ? '' : 's'})`);
  });

  server.registerTool('create_directory', {
    title: 'Create Directory',
    description: 'Create a directory (and any missing parents) in the worktree.',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ path }) => {
    const abs = await inTree(path);
    await mkdir(abs, { recursive: true });
    await inTree(path);
    return text(`Created ${await rel(abs)}`);
  });

  server.registerTool('delete_file', {
    title: 'Delete File',
    description: 'Delete one file (or symlink) from the worktree. Directories are not deleted.',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ path }) => {
    // A symlink is removed itself, never its target: resolve the parent, not the link.
    const parent = await inTree(dirname(path) === '' ? '.' : dirname(path));
    const abs = join(parent, basename(path));
    if (basename(path) === '.git' || abs === parent) return text('path must name a file', true);
    const st = await lstat(abs).catch(() => undefined);
    if (!st) return text(`${path} does not exist`, true);
    if (st.isDirectory()) return text(`${path} is a directory; only files are deleted`, true);
    await rm(abs, { force: false });
    return text(`Deleted ${await rel(abs)}`);
  });

  server.registerTool('run_hook', {
    title: 'Run Hook',
    description:
      'Run one of the repository\'s declared hooks in this worktree, with this periscope\'s environment, and return its output. ' +
      `Allowed names: ${PERISCOPE_HOOKS.join(', ')} (\`isolate\` only for a periscope opened isolated). A hook the repository does not declare is refused.`,
    inputSchema: { name: z.enum(PERISCOPE_HOOKS) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ name }) => {
    if (name === 'isolate' && !sc.isolated) return text('isolate is allowed only for a periscope opened with --isolate', true);
    const env = await hookEnv(d, sc, name);
    const res = await d.runHook(sc, name, env);
    if (!res) return text(`${sc.repo} declares no \`${name}\` hook`, true);
    return text(`exit ${res.code}\n${tailText(res.output)}`, res.code !== 0);
  });

  const branchGuard = (): string | undefined => {
    const head = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return head === sc.branch ? undefined : `the worktree is on ${head}, not the ticket branch ${sc.branch}`;
  };

  server.registerTool('git_status', {
    title: 'Git Status',
    description: 'Branch and changed files (`git status --short --branch`) of this worktree.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(git(root, ['status', '--short', '--branch', '--untracked-files=all'])));

  server.registerTool('git_diff', {
    title: 'Git Diff',
    description: 'The uncommitted changes against HEAD (staged and unstaged), optionally limited to one path. New untracked files appear in git_status, not here.',
    inputSchema: { path: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path }) => {
    const args = ['diff', 'HEAD', '--no-ext-diff', '--no-color'];
    if (path) args.push('--', relative(await realpath(root), await inTree(path)) || '.');
    const out = git(root, args);
    return text(out ? tailText(out, MAX_DIFF) : '(no changes)');
  });

  server.registerTool('git_commit', {
    title: 'Git Commit',
    description: 'Stage every change in the worktree and commit it on the ticket branch. It never pushes; ending the periscope with `--keep` does.',
    inputSchema: { message: z.string().min(1).max(2000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ message }) => {
    const wrong = branchGuard();
    if (wrong) return text(wrong, true);
    git(root, ['add', '-A']);
    try {
      git(root, ['commit', '--no-verify', '-m', message]);
    } catch (e) {
      if (e instanceof GitError && /nothing to commit|no changes added/.test(e.message)) return text('Nothing to commit', true);
      throw e;
    }
    return text(`Committed ${git(root, ['rev-parse', '--short', 'HEAD'])} on ${sc.branch}`);
  });

  return server;
}

const NOT_FOUND = { error: 'not found' };
const json = (res: ServerResponse, status: number, body: unknown) => {
  const b = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' });
  res.end(b);
};

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serves one request to `/periscopes/<segment>/mcp`. This runs BEFORE the
 * control API's tracker-key check: the periscope's own secret is the only
 * credential here, and a key for the workspace opens nothing. Stateless
 * transport, like the Passenger server: each call is independent.
 */
export async function handlePeriscopeMcp(d: PeriscopeMcpDeps, req: IncomingMessage, res: ServerResponse, segment: string): Promise<void> {
  const sc = d.find(segment);
  const secret = sc ? readPeriscopeSecret(d.stateDir, sc.ticketRecordId) : undefined;
  const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]?.trim() ?? '';
  // One answer for no such periscope, an ended one, and the wrong secret.
  if (!sc || !secret || !presented || !secretsMatch(presented, secret)) return json(res, 404, NOT_FOUND);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  }
  const raw = await readBody(req);
  if (raw === null) return json(res, 413, { jsonrpc: '2.0', error: { code: -32600, message: 'request body too large' }, id: null });
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch {
    return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null });
  }
  const isCall = (m: unknown) => !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call';
  if (Array.isArray(parsed) ? parsed.some(isCall) : isCall(parsed)) await d.touch(sc).catch((e: Error) => d.log?.(`periscope ${sc.ticket} activity not recorded: ${e.message}`));
  try {
    const server = createPeriscopeMcpServer(d, sc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    res.on('close', () => { void transport.close(); void server.close(); });
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message || 'internal error' }, id: null });
  }
}

/** The live periscope a path segment (`CREW-12`, `crew-12` or `12`) names, from the sidecars. */
export function findPeriscope(sidecars: PeriscopeSidecar[], segment: string): PeriscopeSidecar | undefined {
  const m = /^(?:([A-Za-z]+)-)?(\d+)$/.exec(segment);
  if (!m) return undefined;
  const num = String(Number(m[2]));
  return sidecars.find((sc) => {
    const t = /^(?:([A-Za-z]+)-)?0*(\d+)$/.exec(sc.ticket);
    if (!t || t[2] !== num) return false;
    return !m[1] || !t[1] || m[1].toLowerCase() === t[1].toLowerCase();
  });
}
