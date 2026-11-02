/**
 * Registers a worktree's symbol service as a second MCP server (CREW-2872).
 *
 * Each harness reads a project-level server list from the directory it is
 * started in, so crew writes the file the harness already knows the shape of
 * instead of inventing a hand-off: `.mcp.json` (Claude), `.codex/config.toml`
 * (Codex), `.gemini/settings.json` (Gemini). An existing file is merged, never
 * replaced, and only the `code` entry is touched. The files are hidden from git
 * through the worktree's `info/exclude` and die with the worktree, so nothing
 * needs undoing. A session that is already running (the one that ran
 * `periscope up` from the main checkout) does not re-read them; a harness that
 * asks the person to approve a project-scoped server once is behaving as
 * designed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INTEL_SERVER_NAME } from './intel.ts';
import { excludeFromGit } from './periscope-pointed.ts';

/** Worktree-relative path of each harness's project-level server list. */
export const INTEL_CONFIG_FILES = ['.mcp.json', '.codex/config.toml', '.gemini/settings.json'] as const;

/** Merges the `code` entry into a JSON config under `mcpServers`; throws on unparseable existing text. */
export function mergeJsonServer(existing: string | undefined, entry: Record<string, unknown>, server: string): string {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== '') {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('is not a JSON object');
    doc = parsed as Record<string, unknown>;
  }
  const servers = doc.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('has an mcpServers that is not an object');
  doc.mcpServers = { ...(servers as Record<string, unknown> | undefined), [server]: entry };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Sets `[mcp_servers.<server>]` in a Codex TOML file, leaving every other line
 * alone. Only that one table is replaced (up to the next `[` header), so a
 * hand-written file keeps its comments and order.
 */
export function mergeTomlServer(existing: string | undefined, url: string, server: string): string {
  const table = `[mcp_servers.${server}]\nurl = ${JSON.stringify(url)}\n`;
  const text = existing ?? '';
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[mcp_servers.${server}]`);
  if (start < 0) return text === '' ? table : `${text}${text.endsWith('\n') ? '' : '\n'}\n${table}`;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const keepTail = lines.slice(end);
  return [...lines.slice(0, start), ...table.trimEnd().split('\n'), ...(keepTail.length && keepTail[0] !== '' ? [''] : []), ...keepTail].join('\n');
}

/** Whether git tracks `rel` in the worktree (an exclude entry cannot hide a tracked file). */
function tracked(worktree: string, rel: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: worktree, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface RegisterResult {
  /** Worktree-relative files that now carry the server. */
  written: string[];
  /** One-line reasons for files left alone. */
  skipped: string[];
}

/**
 * Writes the `code` server into each harness's project-level file in the
 * worktree. A file that cannot be merged safely is left untouched and reported;
 * it never throws.
 */
export function registerCodeServer(worktree: string, url: string, server: string = INTEL_SERVER_NAME): RegisterResult {
  const out: RegisterResult = { written: [], skipped: [] };
  const plans: Array<[string, (old: string | undefined) => string]> = [
    ['.mcp.json', (old) => mergeJsonServer(old, { type: 'http', url }, server)],
    ['.codex/config.toml', (old) => mergeTomlServer(old, url, server)],
    ['.gemini/settings.json', (old) => mergeJsonServer(old, { httpUrl: url }, server)],
  ];
  for (const [rel, merge] of plans) {
    const file = join(worktree, rel);
    try {
      const next = merge(existsSync(file) ? readFileSync(file, 'utf8') : undefined);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next);
      // A tracked file stays visible to git however it is excluded; mark it so `down --keep` cannot commit the entry.
      if (tracked(worktree, rel)) execFileSync('git', ['update-index', '--skip-worktree', '--', rel], { cwd: worktree, stdio: 'ignore' });
      else excludeFromGit(worktree, rel);
      out.written.push(rel);
    } catch (e) {
      out.skipped.push(`${rel} left alone: ${(e as Error).message}`);
    }
  }
  return out;
}
