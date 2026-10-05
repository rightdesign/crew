/**
 * `crew connect` registers the Tablation MCP server with Claude Code (CREW-1378,
 * reopening CREW-436), so an interactive session (Pair, a `grill_link` session)
 * has the `mcp__tablation__*` tools with no manual `claude mcp add`.
 *
 * Scope is `user`, not the `local` the ticket names: Claude Code's local scope
 * is keyed to the directory `mcp add` ran in, so "open Claude Code in any
 * directory" could not hold. User scope still lives in `~/.claude.json`, never
 * in a shared repo file. The key is plaintext there and reaches everything its
 * holder can, same as the manual path in GETTING_STARTED §2.6.
 *
 * Detection uses only the exit status of `claude mcp get` plus the JSON file;
 * the CLI's text output is never parsed. The key is redacted from every message.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MCP_SERVER_NAME = 'tablation';

export type McpState =
  | { state: 'no-claude' }
  | { state: 'missing' }
  | { state: 'registered'; url: string }
  /** A `tablation` server exists but is not this route's (or is not in user scope). */
  | { state: 'different'; detail: string };

export interface McpOpts {
  /** `ship.agent.bin`. */
  bin: string;
  /** `<baseUrl>/api/mcp`. */
  url: string;
  key: string;
  /** Directory holding `.claude.json`; defaults to the user's home. */
  home?: string;
}

const redact = (s: string, key: string): string => (key ? s.split(key).join('sk_***') : s);

export function mcpUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/mcp`;
}

function runClaude(bin: string, args: string[]): { status: number | null; missing: boolean; stderr: string } {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000 });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { status: r.status, missing, stderr: r.stderr ?? '' };
}

interface McpEntry { url?: string; headers?: Record<string, string> }

function userScopeEntry(home: string): McpEntry | undefined {
  try {
    const j = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, McpEntry> };
    return j.mcpServers?.[MCP_SERVER_NAME];
  } catch {
    return undefined;
  }
}

/** Read-only: what Claude Code has registered under `tablation`, against this route. */
export function inspectClaudeMcp(o: McpOpts): McpState {
  const got = runClaude(o.bin, ['mcp', 'get', MCP_SERVER_NAME]);
  if (got.missing) return { state: 'no-claude' };
  if (got.status !== 0) return { state: 'missing' };
  const entry = userScopeEntry(o.home ?? homedir());
  if (!entry) {
    return { state: 'different', detail: `a "${MCP_SERVER_NAME}" server exists, but not in user scope (~/.claude.json) — a project or local registration` };
  }
  if (entry.url !== o.url) return { state: 'different', detail: `it points at ${entry.url ?? '(no url)'}, not ${o.url}` };
  const auth = Object.entries(entry.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  if (auth !== `Bearer ${o.key}`) return { state: 'different', detail: `it is registered with a different key than this route's` };
  return { state: 'registered', url: o.url };
}

/**
 * Register when missing; report (never clobber) a different registration unless
 * `replace`. Returns the one line to print.
 */
export function ensureClaudeMcp(o: McpOpts & { replace?: boolean; dryRun?: boolean }): string {
  const manual = `claude mcp add --transport http ${MCP_SERVER_NAME} ${o.url} --header "Authorization: Bearer <key>" --scope user`;
  const st = inspectClaudeMcp(o);
  if (st.state === 'no-claude') return `mcp: \`${o.bin}\` not found, so Claude Code was not configured. To do it by hand: ${manual}`;
  if (st.state === 'registered') return `mcp: ${MCP_SERVER_NAME} already registered with Claude Code → ${st.url}`;
  if (st.state === 'different' && !o.replace) {
    return `mcp: left Claude Code's "${MCP_SERVER_NAME}" server alone — ${st.detail}. Re-run with --mcp replace to overwrite it.`;
  }
  if (o.dryRun) return `(dry run) would register the ${MCP_SERVER_NAME} MCP server with Claude Code → ${o.url}`;
  if (st.state === 'different') {
    // `remove` without --scope fails when the entry lives in more than one scope; user scope is the one we own.
    runClaude(o.bin, ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'user']);
  }
  const add = runClaude(o.bin, [
    'mcp', 'add', '--transport', 'http', MCP_SERVER_NAME, o.url,
    '--header', `Authorization: Bearer ${o.key}`, '--scope', 'user',
  ]);
  if (add.status !== 0) {
    return `mcp: \`claude mcp add\` failed (${redact(add.stderr.trim(), o.key) || `exit ${add.status}`}). To do it by hand: ${manual}`;
  }
  return `mcp: registered the ${MCP_SERVER_NAME} MCP server with Claude Code → ${o.url} (user scope, ~/.claude.json)`;
}
