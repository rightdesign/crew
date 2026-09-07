/**
 * The read-only MCP tool surface a Passenger session talks to (EPIC-014,
 * "Host Passengers" — CREW_PRD.md §9.10-9.11, ISSUE-551). Runs inside a
 * Ship's per-workspace container and answers `read_file`, `list_directory`,
 * `search_files`, `git_log`, and `git_blame` calls against one or more
 * directories on that Ship's own disk.
 *
 * The file/search tools are adapted from the official
 * `@modelcontextprotocol/server-filesystem` reference server rather than
 * reimplemented: `validatePath`/`searchFilesWithValidation`/etc. (its
 * `dist/lib.js`) already do the real security work here — symlink
 * resolution, Unicode-equivalent path matching, Windows-drive-path
 * rejection — and re-deriving that by hand risks missing one of those
 * cases. Its own `dist/index.js` isn't reused as-is because it (a) only
 * speaks stdio, never a remote transport, and (b) registers write-shaped
 * tools (`write_file`, `edit_file`, `move_file`, `create_directory`) that
 * must never exist on this surface at all — CREW_PRD.md §9.10/9.11 calls
 * for the tool surface itself to omit them, not merely leave them uncalled,
 * as one of two independent read-only enforcement layers (the other being
 * the container's own read-only bind mount). `dist/lib.js` has no declared
 * "exports" map, so any subpath is importable, but it also isn't a
 * published public API of that package — a future server-filesystem
 * release could reshape it without a semver bump. The test suite here is
 * what would catch that.
 *
 * `setAllowedDirectories` is process-wide global state inside
 * `dist/lib.js` (not scoped to a server instance) — harmless for how this
 * runs in production (one process serves one workspace's directories for
 * its whole lifetime), but it does mean two `createPassengerMcpServer`
 * calls in the same process share one root set; the last call wins. Tests
 * that need distinct roots run in separate files/processes for exactly this
 * reason.
 *
 * Real authentication (ISSUE-552) happens in `createPassengerHttpServer`,
 * before a request ever reaches the tool surface below. Per the relay's own
 * design (docs/RELAY.md in the synthesis repo, ISSUE-550), the relay's
 * `Authorization` gate is presence-only and explicitly defers real
 * credential validation to "the ship's own MCP server" — this is that
 * validation. It resolves the caller's Bearer token the same way ordinary
 * Passenger MCP access already does (CREW_PRD.md §7.6): a loopback
 * `GET /auth/me?workspaceId=<this container's own workspace>` call to
 * Tablation's own API. `ApiKeysService.validateKey` (run server-side by that
 * route) rejects an invalid/revoked key outright, and `AuthService.getMe`
 * separately 403s a valid key that isn't a member of the named workspace —
 * together this is exactly "does the resolved member belong to *this
 * container's* workspace" (decision 2 in the Map, b9f59bd9-8ed5-4479-b85d-
 * f0a64d00726c), with no per-repo filtering needed since decision 6 already
 * gives each workspace its own container.
 *
 * That workspace id is never taken from the caller or the request — it's
 * this container's own trusted config (`PASSENGER_MCP_WORKSPACE_ID`, set at
 * container launch, the same way `PASSENGER_MCP_ROOT` already is). This is
 * a different question from the relay's own still-open ship→workspace
 * *entitlement* gap (ISSUE-625: can a ship legitimately claim tunnel
 * bind-address `-R workspace-<id>:...`?) — that's about an untrusted,
 * self-asserted claim from a connecting ship, whereas this container's own
 * workspace id is supplied by whatever trusted process launches it, not by
 * anything a caller sends. ISSUE-625 landing doesn't change this file.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  formatSize,
  getFileStats,
  readFileContent,
  searchFilesWithValidation,
  setAllowedDirectories,
  validatePath,
} from '@modelcontextprotocol/server-filesystem/dist/lib.js';
import { git, gitOk, GitError } from './git.ts';

export interface PassengerMcpServerOptions {
  /** Absolute directory paths this server may read from. Never empty. */
  allowedDirectories: string[];
}

export interface PassengerAuthConfig {
  /** Base URL of the Tablation API, e.g. `https://app.tablation.com/api`. */
  tablationApiBaseUrl: string;
  /**
   * The workspace this container serves — this container's own trusted
   * config (e.g. `PASSENGER_MCP_WORKSPACE_ID`), never anything read off the
   * incoming request. A caller's Bearer token must resolve to a member of
   * exactly this workspace.
   */
  workspaceId: string;
}

type CredentialCheck =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Resolves the caller's `Authorization` header against Tablation's own
 * `GET /auth/me` — the same loopback-to-Tablation shape the relay's
 * `TablationShipRegistry` already uses for its own Ships-row lookup
 * (apps/relay/src/shipRegistry.ts), just against a different route. Passes
 * the header straight through rather than re-deriving a bearer token, so a
 * malformed header reads the same way `/auth/me` itself would report it.
 * Never throws — a network failure against Tablation is a 502 verdict, not
 * an uncaught rejection, so the HTTP handler always has a status to answer
 * the caller with.
 */
async function validateCredential(
  authHeader: string | undefined,
  auth: PassengerAuthConfig,
): Promise<CredentialCheck> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'Missing or malformed Authorization header' };
  }
  const url = `${auth.tablationApiBaseUrl.replace(/\/+$/, '')}/auth/me?workspaceId=${encodeURIComponent(auth.workspaceId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: authHeader,
        // Cloudflare 403s a default fetch/curl UA in front of this host — see crew/src/connect.ts.
        'User-Agent': 'Mozilla/5.0 CrewPassengerMcp/0.1.0',
      },
    });
  } catch (error) {
    return { ok: false, status: 502, message: `Credential check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (res.status === 401) return { ok: false, status: 401, message: 'Invalid or revoked API key' };
  if (res.status === 403) return { ok: false, status: 403, message: 'Not a member of this workspace' };
  if (!res.ok) return { ok: false, status: 502, message: `Credential check failed: ${res.status} ${res.statusText}` };
  return { ok: true };
}

/**
 * `ref` reaches `git()` as a bare positional argument, before the `--`
 * that separates revisions from paths — so anything starting with `-` is
 * parsed by git as an OPTION, not a revision. `git log --output=<path>`
 * writes its formatted output to that file, turning a "read commit
 * history" call into an arbitrary-file-write primitive with no shell
 * involved (this is `execFileSync` with an argv array, so shell
 * metacharacters are inert — the injection is entirely git's own flag
 * parsing). Caught by QA on ISSUE-551's first review pass. Rejecting any
 * leading `-` closes this the same way git's own `--` boundary does for
 * paths; a real ref/sha/branch never legitimately starts with one.
 */
function assertSafeRef(ref: string): void {
  if (ref.startsWith('-')) {
    throw new Error(`ref must not start with "-": ${ref}`);
  }
}

/**
 * The file or directory a `git_log`/`git_blame` call names, resolved to its
 * repo root and repo-relative path. `git rev-parse --show-toplevel` has to
 * run from a directory that's actually inside the repo — `dirname()` of a
 * *file* target lands there, but `dirname()` of a *directory* target (e.g.
 * the repo root itself) walks one level too far up and out of the repo.
 */
async function resolveGitTarget(absolutePath: string): Promise<{ repoRoot: string; relativePath: string }> {
  const isDirectory = (await stat(absolutePath)).isDirectory();
  const repoRoot = gitOk(isDirectory ? absolutePath : dirname(absolutePath), ['rev-parse', '--show-toplevel']);
  if (!repoRoot) {
    throw new Error(`${absolutePath} is not inside a git repository`);
  }
  return { repoRoot, relativePath: relative(repoRoot, absolutePath) };
}

/**
 * Both the literal directory and its symlink-resolved real path, matching
 * `@modelcontextprotocol/server-filesystem`'s own CLI parsing in
 * `dist/index.js` (not reused directly — this module never runs that file).
 * Needed because macOS's `/tmp` -> `/private/tmp` and `TMPDIR` ->
 * `/private/var/...` symlinks mean the path a caller was handed and the
 * path `fs.realpath` reports for it can legitimately differ; `validatePath`
 * checks the request against the resolved path, so an allow-list holding
 * only the unresolved form rejects every request under it.
 */
async function resolveAllowedDirectories(dirs: string[]): Promise<string[]> {
  const resolved = new Set<string>();
  for (const dir of dirs) {
    const absolute = resolvePath(dir);
    resolved.add(absolute);
    try {
      resolved.add(await realpath(absolute));
    } catch {
      // Doesn't exist yet — validatePath will report that clearly per-request.
    }
  }
  return [...resolved];
}

/**
 * Builds the MCP server for one Passenger session's tool surface. Registers
 * only read-only tools — nothing here ever calls `fs.write*`, `fs.unlink`,
 * `fs.rename`, or a mutating git subcommand, and nothing write-shaped is
 * registered even as a disabled/unreachable tool.
 */
export async function createPassengerMcpServer(options: PassengerMcpServerOptions): Promise<McpServer> {
  if (options.allowedDirectories.length === 0) {
    throw new Error('createPassengerMcpServer requires at least one allowed directory');
  }
  setAllowedDirectories(await resolveAllowedDirectories(options.allowedDirectories));

  const server = new McpServer({ name: 'crew-passenger-filesystem', version: '0.1.0' });

  server.registerTool('read_file', {
    title: 'Read File',
    description:
      'Read the complete contents of a text file. Use `head`/`tail` to read only the first/last N lines ' +
      'of a large file. Only works within this session’s allowed directories.',
    inputSchema: {
      path: z.string(),
      head: z.number().int().positive().optional().describe('Return only the first N lines'),
      tail: z.number().int().positive().optional().describe('Return only the last N lines'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path, head, tail }) => {
    if (head && tail) throw new Error('Cannot specify both head and tail');
    const validPath = await validatePath(path);
    const content = await readFileContent(validPath);
    const lines = content.split('\n');
    const text = head ? lines.slice(0, head).join('\n') : tail ? lines.slice(-tail).join('\n') : content;
    return { content: [{ type: 'text', text }] };
  });

  server.registerTool('list_directory', {
    title: 'List Directory',
    description:
      'List the files and directories directly inside a path, each marked [FILE] or [DIR], with file sizes. ' +
      'Only works within this session’s allowed directories.',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path }) => {
    const validPath = await validatePath(path);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(validPath, { withFileTypes: true });
    const lines = await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) return `[DIR]  ${entry.name}`;
      const stats = await getFileStats(await validatePath(`${validPath}/${entry.name}`));
      return `[FILE] ${entry.name} (${formatSize(stats.size)})`;
    }));
    return { content: [{ type: 'text', text: lines.join('\n') || '(empty)' }] };
  });

  server.registerTool('search_files', {
    title: 'Search Files',
    description:
      'Recursively search for files and directories under `path` whose path (relative to `path`) matches ' +
      'the glob `pattern`. `*` does not cross a `/` — use `*.ts` to match only directly under `path`, or ' +
      '`**/*.ts` to match at any depth. Only searches within this session’s allowed directories.',
    inputSchema: {
      path: z.string(),
      pattern: z.string(),
      excludePatterns: z.array(z.string()).optional().default([]),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path, pattern, excludePatterns }) => {
    const validPath = await validatePath(path);
    const results = await searchFilesWithValidation(validPath, pattern, options.allowedDirectories, { excludePatterns });
    return { content: [{ type: 'text', text: results.length ? results.join('\n') : 'No matches found' }] };
  });

  server.registerTool('git_log', {
    title: 'Git Log',
    description:
      'Commit history touching a file or directory: hash, author, date, and subject — never a diff/patch, ' +
      'so a commit that also touched files outside this session’s allowed directories never leaks their ' +
      'content through here. `ref` defaults to HEAD.',
    inputSchema: {
      path: z.string(),
      ref: z.string().optional().default('HEAD'),
      maxCount: z.number().int().positive().max(500).optional().default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path, ref, maxCount }) => {
    assertSafeRef(ref);
    const validPath = await validatePath(path);
    const { repoRoot, relativePath } = await resolveGitTarget(validPath);
    const out = git(repoRoot, [
      'log', ref, `-n${maxCount}`, '--format=%H\x1f%an\x1f%ad\x1f%s', '--date=iso-strict',
      '--', relativePath || '.',
    ]);
    const lines = out
      ? out.split('\n').map((line) => {
        const [hash, author, date, subject] = line.split('\x1f');
        return `${hash?.slice(0, 8)}  ${date}  ${author}  ${subject}`;
      })
      : [];
    return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No commits found' }] };
  });

  server.registerTool('git_blame', {
    title: 'Git Blame',
    description:
      'Per-line authorship for a single file: which commit, author, and date last touched each line. ' +
      '`ref` defaults to HEAD. Only works on a file, not a directory.',
    inputSchema: { path: z.string(), ref: z.string().optional().default('HEAD') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path, ref }) => {
    assertSafeRef(ref);
    const validPath = await validatePath(path);
    const { repoRoot, relativePath } = await resolveGitTarget(validPath);
    if (!relativePath) throw new Error('git_blame requires a file, not a repository root');
    let out: string;
    try {
      out = git(repoRoot, ['blame', ref, '--date=short', '--', relativePath]);
    } catch (e) {
      if (e instanceof GitError) throw new Error(e.message);
      throw e;
    }
    return { content: [{ type: 'text', text: out || '(empty file)' }] };
  });

  server.registerTool('list_allowed_directories', {
    title: 'List Allowed Directories',
    description: 'The directories this Passenger session can read from. Subdirectories are also accessible.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({
    content: [{ type: 'text', text: options.allowedDirectories.join('\n') }],
  }));

  return server;
}

/**
 * Wraps `createPassengerMcpServer` in a plain HTTP listener speaking MCP's
 * StreamableHTTP transport at `POST /mcp`, stateless (`sessionIdGenerator:
 * undefined`) — each Passenger tool call is independent, so there's no
 * session state worth keeping across requests. No `express`/`hono`
 * dependency: `StreamableHTTPServerTransport#handleRequest` works directly
 * against Node's own `IncomingMessage`/`ServerResponse`, which is all a
 * single-route listener needs.
 *
 * `auth` is checked before any of the request body is even read — the
 * caller's `Authorization` header is enough to accept or reject, so an
 * unauthenticated caller never causes a tool surface to be built at all
 * (see `validateCredential`'s doc comment for what it checks).
 */
export function createPassengerHttpServer(options: PassengerMcpServerOptions, auth: PassengerAuthConfig): Server {
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    validateCredential(req.headers.authorization, auth)
      .then((credential) => {
        if (!credential.ok) {
          res.writeHead(credential.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: credential.message },
            id: null,
          }));
          return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = body ? JSON.parse(body) : undefined;
            const server = await createPassengerMcpServer(options);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(transport);
            await transport.handleRequest(req, res, parsed);
            res.on('close', () => { transport.close(); server.close(); });
          } catch (error) {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
                id: null,
              }));
            }
          }
        });
      })
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
            id: null,
          }));
        }
      });
  });
}
