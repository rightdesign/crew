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
import { findMcpRegistration, keyFingerprint, recordMcpRegistration } from './mcp-registrations.ts';

export const MCP_SERVER_NAME = 'tablation';

export type McpState =
  | { state: 'no-claude' }
  | { state: 'missing' }
  | { state: 'registered'; url: string }
  /** A `tablation` server exists but is not this route's (or is not in user scope). */
  | { state: 'different'; detail: string; crewWrote?: string };

/** What an `ensure` did, for `mcp_registered` consumers that switch on it instead of the message text. */
export type McpAction = 'registered' | 'replaced' | 'kept';

export interface McpOpts {
  /** `ship.agent.bin`. */
  bin: string;
  /** `<baseUrl>/api/mcp`. */
  url: string;
  key: string;
  /** Directory holding `.claude.json`; defaults to the user's home. */
  home?: string;
  /** Where `mcp-registrations.json` lives; without it every differing key is treated as foreign. */
  stateDir?: string;
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
  if (auth !== `Bearer ${o.key}`) {
    // CREW-2514: a key crew itself issued earlier (same URL, recorded fingerprint) is crew's to update.
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const mine = o.stateDir && bearer
      ? findMcpRegistration(o.stateDir, { harness: 'claude', scope: 'user', name: MCP_SERVER_NAME, url: o.url, key: bearer })
      : undefined;
    if (mine) return { state: 'different', detail: `crew registered an earlier key here`, crewWrote: mine.at };
    return { state: 'different', detail: `it points at ${o.url} with a key that is not one crew issued` };
  }
  return { state: 'registered', url: o.url };
}

/**
 * Register when missing; report (never clobber) a different registration unless
 * `replace`. Returns the one line to print.
 */
export function ensureClaudeMcp(o: McpOpts & { replace?: boolean; dryRun?: boolean }): string {
  return ensureClaudeMcpResult(o).line;
}

/** As `ensureClaudeMcp`, plus the `action` taken (absent when nothing was written or kept for a reason other than a foreign entry). */
export function ensureClaudeMcpResult(o: McpOpts & { replace?: boolean; dryRun?: boolean }): { line: string; action?: McpAction; url: string } {
  const r = ensureInner(o);
  return { ...r, url: o.url };
}

function ensureInner(o: McpOpts & { replace?: boolean; dryRun?: boolean }): { line: string; action?: McpAction } {
  const manual = `claude mcp add --transport http ${MCP_SERVER_NAME} ${o.url} --header "Authorization: Bearer <key>" --scope user`;
  const st = inspectClaudeMcp(o);
  if (st.state === 'no-claude') return { line: `mcp: \`${o.bin}\` not found, so Claude Code was not configured. To do it by hand: ${manual}` };
  if (st.state === 'registered') return { line: `mcp: ${MCP_SERVER_NAME} already registered with Claude Code → ${st.url}`, action: 'registered' };
  // CREW-2514: an entry crew wrote itself, one rotated key ago, is replaced without asking.
  const crewWrote = st.state === 'different' ? st.crewWrote : undefined;
  const ours = crewWrote !== undefined;
  if (st.state === 'different' && !o.replace && !ours) {
    return { line: `mcp: left Claude Code's "${MCP_SERVER_NAME}" server alone — ${st.detail}. Re-run with --mcp replace to overwrite it.`, action: 'kept' };
  }
  if (o.dryRun) return { line: `(dry run) would register the ${MCP_SERVER_NAME} MCP server with Claude Code → ${o.url}` };
  if (st.state === 'different') {
    // `remove` without --scope fails when the entry lives in more than one scope; user scope is the one we own.
    runClaude(o.bin, ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'user']);
  }
  const add = runClaude(o.bin, [
    'mcp', 'add', '--transport', 'http', MCP_SERVER_NAME, o.url,
    '--header', `Authorization: Bearer ${o.key}`, '--scope', 'user',
  ]);
  if (add.status !== 0) {
    return { line: `mcp: \`claude mcp add\` failed (${redact(add.stderr.trim(), o.key) || `exit ${add.status}`}). To do it by hand: ${manual}` };
  }
  if (o.stateDir) {
    try {
      recordMcpRegistration(o.stateDir, { harness: 'claude', scope: 'user', name: MCP_SERVER_NAME, url: o.url, keyFingerprint: keyFingerprint(o.key) });
    } catch {
      // Provenance is a convenience; a read-only state dir must not fail the registration.
    }
  }
  if (crewWrote !== undefined) {
    return { line: `mcp: updated the key crew registered on ${crewWrote.slice(0, 10)} → ${o.url}`, action: 'replaced' };
  }
  return {
    line: `mcp: ${st.state === 'different' ? 'replaced' : 'registered'} the ${MCP_SERVER_NAME} MCP server with Claude Code → ${o.url} (user scope, ~/.claude.json)`,
    action: st.state === 'different' ? 'replaced' : 'registered',
  };
}

/** Remove the user-scope `tablation` registration (`crew disconnect`). Leaves other scopes alone. */
export function removeClaudeMcp(o: { bin: string; dryRun?: boolean }): string {
  const got = runClaude(o.bin, ['mcp', 'get', MCP_SERVER_NAME]);
  if (got.missing) return `mcp: \`${o.bin}\` not found, so Claude Code was not touched`;
  if (got.status !== 0) return `mcp: no ${MCP_SERVER_NAME} server registered with Claude Code`;
  if (o.dryRun) return `(dry run) would remove the ${MCP_SERVER_NAME} MCP server from Claude Code (user scope)`;
  const rm = runClaude(o.bin, ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'user']);
  return rm.status === 0
    ? `mcp: removed the ${MCP_SERVER_NAME} MCP server from Claude Code (user scope)`
    : `mcp: \`claude mcp remove\` failed (${rm.stderr.trim() || `exit ${rm.status}`})`;
}
