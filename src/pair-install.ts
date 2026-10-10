/**
 * Pair on non-Claude harnesses (CREW-1517, EPIC-035 §8).
 *
 * Pair works on Claude Code because the operator's session-start hook runs
 * `crew agents prompt pair` and `crew connect` registers the tracker MCP with
 * `claude mcp add`. Only those two are Claude-specific. A harness with no such
 * hook gets the same two things from user-level files instead:
 *
 *   - a managed, delimited block in the harness's global instructions file that
 *     tells the agent to run `crew agents prompt pair` first and follow it;
 *   - a `tablation` MCP entry in the harness's user config, which names the key
 *     by environment variable only — the key itself is never written (§7).
 *
 * Nothing here is ever written into a repository. Each installer is idempotent
 * (running it twice changes nothing), verifiable by `crew doctor`, and removable
 * by `crew disconnect` without touching anything it did not add.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudePair } from './adapters/claude.ts';

export const PAIR_BLOCK_START = '<!-- crew:pair start -->';
export const PAIR_BLOCK_END = '<!-- crew:pair end -->';
export const PAIR_KEY_VAR = 'CREW_API_KEY';
const SERVER = 'tablation';

export interface PairOpts {
  /** Directory the harness's user-level files hang off; defaults to the user's home. */
  home?: string;
  /** `<baseUrl>/api/mcp`. */
  url: string;
  /** The tracker key. Only the Claude path needs it (its `mcp add` takes the key inline); the others name an env var. */
  key?: string;
  /** The harness binary, for installers that drive a CLI (Claude). */
  bin?: string;
  replace?: boolean;
  dryRun?: boolean;
}

export interface PairVerdict {
  ok: boolean;
  detail: string;
}

export interface PairInstaller {
  harness: string;
  displayName: string;
  /** Idempotent. Returns the one line to print. */
  installPair(o: PairOpts): string;
  verifyPair(o: PairOpts): PairVerdict;
  /** Removes exactly what `installPair` added. Returns the one line to print. */
  removePair(o: PairOpts): string;
}

// ── Managed instructions block ──────────────────────────────────────────────

/** What the block tells the agent. `harness` lets `crew agents prompt pair` say which CLI it serves. */
export function pairBlock(harness: string): string {
  return [
    PAIR_BLOCK_START,
    '## Tablation Pair (managed by `crew connect` — edit nothing between the markers)',
    '',
    'At the start of every session, run `crew agents prompt pair --harness ' + harness + '` and follow what it prints.',
    `The Tablation tracker tools come from the \`${SERVER}\` MCP server; its key is read from \`$${PAIR_KEY_VAR}\`.`,
    PAIR_BLOCK_END,
  ].join('\n');
}

const BLOCK_RE = new RegExp(`${escapeRe(PAIR_BLOCK_START)}[\\s\\S]*?${escapeRe(PAIR_BLOCK_END)}\\n?`);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasPairBlock(text: string): boolean {
  return BLOCK_RE.test(text);
}

/** A start marker with no end (or the reverse) is not ours to guess about; callers refuse to write. */
export function pairBlockIsBroken(text: string): boolean {
  return !hasPairBlock(text) && (text.includes(PAIR_BLOCK_START) || text.includes(PAIR_BLOCK_END));
}

/** Insert the block, or replace the existing one in place. Foreign content is preserved. */
export function upsertPairBlock(text: string, block: string): string {
  if (hasPairBlock(text)) return text.replace(BLOCK_RE, () => `${block}\n`);
  if (text.trim() === '') return `${block}\n`;
  return `${text.replace(/\n*$/, '')}\n\n${block}\n`;
}

/** Remove the block and the blank line that separated it from what precedes it. */
export function removePairBlock(text: string): string {
  if (!hasPairBlock(text)) return text;
  return text.replace(new RegExp(`\\n*${BLOCK_RE.source}`), '\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function writeFileMkdir(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Install the block into `path`; returns what happened. */
function installBlockFile(path: string, harness: string, dryRun?: boolean): { changed: boolean; error?: string } {
  const before = readIfExists(path) ?? '';
  if (pairBlockIsBroken(before)) return { changed: false, error: `${path} has an unmatched ${PAIR_BLOCK_START}/${PAIR_BLOCK_END} marker — fix it by hand` };
  const after = upsertPairBlock(before, pairBlock(harness));
  if (after === before) return { changed: false };
  if (!dryRun) writeFileMkdir(path, after);
  return { changed: true };
}

function removeBlockFile(path: string, dryRun?: boolean): boolean {
  const before = readIfExists(path);
  if (before === undefined || !hasPairBlock(before)) return false;
  if (dryRun) return true;
  const after = removePairBlock(before);
  if (after.trim() === '') rmSync(path);
  else writeFileSync(path, after);
  return true;
}

function blockVerdict(path: string, harness: string): PairVerdict {
  const text = readIfExists(path);
  if (text === undefined || !hasPairBlock(text)) return { ok: false, detail: `no managed block in ${path}` };
  if (!text.includes(pairBlock(harness))) return { ok: false, detail: `the managed block in ${path} is out of date — run crew connect` };
  return { ok: true, detail: '' };
}

// ── TOML (Codex): edit one table, leave every other byte alone ─────────────

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

/** Normalizes `mcp_servers."tablation"` and `mcp_servers.tablation` to one spelling. */
const tableName = (raw: string): string => raw.replace(/["']/g, '').replace(/\s*\.\s*/g, '.');

/** Line range [start, end) of the named table, header included, or undefined. */
function tomlTableRange(lines: string[], name: string): [number, number] | undefined {
  const start = lines.findIndex((l) => {
    const m = HEADER_RE.exec(l);
    return m !== null && tableName(m[1]!) === name;
  });
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i]!)) { end = i; break; }
  }
  // Trailing blank lines belong to the gap before the next table, not to this one.
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--;
  return [start, end];
}

const tomlString = (v: string): string => JSON.stringify(v);

export function codexTable(url: string): string[] {
  return [`[mcp_servers.${SERVER}]`, `url = ${tomlString(url)}`, `bearer_token_env_var = ${tomlString(PAIR_KEY_VAR)}`];
}

export function upsertTomlTable(text: string, name: string, table: string[]): string {
  const lines = text.split('\n');
  const r = tomlTableRange(lines, name);
  if (r) {
    lines.splice(r[0], r[1] - r[0], ...table);
    return lines.join('\n');
  }
  const body = text.replace(/\n*$/, '');
  return body === '' ? `${table.join('\n')}\n` : `${body}\n\n${table.join('\n')}\n`;
}

/** Removes the named table and any `name.child` sub-tables (e.g. `[mcp_servers.x.env]`). */
export function removeTomlTable(text: string, name: string): string {
  const lines = text.split('\n');
  let r = tomlTableRange(lines, name);
  if (!r) return text;
  while (r) {
    let [start, end] = r;
    // Swallow the blank line that separated this table from what precedes it.
    if (start > 0 && lines[start - 1]!.trim() === '') start--;
    lines.splice(start, end - start);
    const childName = lines
      .map((l) => HEADER_RE.exec(l))
      .map((m) => (m ? tableName(m[1]!) : undefined))
      .find((n) => n !== undefined && n.startsWith(`${name}.`));
    r = childName === undefined ? undefined : tomlTableRange(lines, childName);
  }
  const out = lines.join('\n').replace(/^\n+/, '');
  return out.trim() === '' ? '' : out.replace(/\n*$/, '\n');
}

function tomlValue(lines: string[], range: [number, number], key: string): string | undefined {
  for (let i = range[0] + 1; i < range[1]; i++) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(lines[i]!);
    if (m) return m[1];
  }
  return undefined;
}

// ── Codex ───────────────────────────────────────────────────────────────────

const codexPaths = (home: string) => ({
  instructions: join(home, '.codex', 'AGENTS.md'),
  config: join(home, '.codex', 'config.toml'),
});

type McpFileState = { state: 'missing' } | { state: 'registered' } | { state: 'different'; detail: string };

function codexMcpState(config: string, url: string): McpFileState {
  const lines = config.split('\n');
  const r = tomlTableRange(lines, `mcp_servers.${SERVER}`);
  if (!r) return { state: 'missing' };
  const got = tomlValue(lines, r, 'url');
  const env = tomlValue(lines, r, 'bearer_token_env_var');
  if (got !== url) return { state: 'different', detail: `it points at ${got ?? '(no url)'}, not ${url}` };
  if (env !== PAIR_KEY_VAR) return { state: 'different', detail: `it does not read its key from $${PAIR_KEY_VAR}` };
  return { state: 'registered' };
}

export const codexPair: PairInstaller = {
  harness: 'codex',
  displayName: 'Codex',

  installPair(o) {
    const p = codexPaths(o.home ?? homedir());
    const config = readIfExists(p.config) ?? '';
    const st = codexMcpState(config, o.url);
    if (st.state === 'different' && !o.replace) {
      return `pair(codex): left ${p.config} alone — a "${SERVER}" server exists and ${st.detail}. Re-run with --mcp replace to overwrite it.`;
    }
    const block = installBlockFile(p.instructions, 'codex', o.dryRun);
    if (block.error) return `pair(codex): ${block.error}`;
    let mcpChanged = false;
    if (st.state !== 'registered') {
      mcpChanged = true;
      if (!o.dryRun) writeFileMkdir(p.config, upsertTomlTable(config, `mcp_servers.${SERVER}`, codexTable(o.url)));
    }
    if (!block.changed && !mcpChanged) return `pair(codex): already installed (${p.instructions}, ${p.config})`;
    return `pair(codex): ${o.dryRun ? '(dry run) would install' : 'installed'} the Pair block in ${p.instructions} and ${SERVER} in ${p.config} (key read from $${PAIR_KEY_VAR})`;
  },

  verifyPair(o) {
    const p = codexPaths(o.home ?? homedir());
    const b = blockVerdict(p.instructions, 'codex');
    if (!b.ok) return b;
    const st = codexMcpState(readIfExists(p.config) ?? '', o.url);
    if (st.state === 'missing') return { ok: false, detail: `no ${SERVER} server in ${p.config}` };
    if (st.state === 'different') return { ok: false, detail: `${SERVER} in ${p.config} ${st.detail}` };
    return { ok: true, detail: `${p.instructions}, ${p.config}` };
  },

  removePair(o) {
    const p = codexPaths(o.home ?? homedir());
    const hadBlock = removeBlockFile(p.instructions, o.dryRun);
    const config = readIfExists(p.config);
    // Only an entry in the shape install writes is ours to remove; a different one is the operator's.
    const st = codexMcpState(config ?? '', o.url);
    const hadMcp = config !== undefined && st.state === 'registered';
    const kept = st.state === 'different' ? `; left the existing ${SERVER} server alone — ${st.detail}` : '';
    if (hadMcp && !o.dryRun) {
      const after = removeTomlTable(config, `mcp_servers.${SERVER}`);
      if (after === '') rmSync(p.config);
      else writeFileSync(p.config, after);
    }
    const what = hadBlock && hadMcp ? `the Pair block and ${SERVER} server` : hadBlock ? 'the Pair block' : `the ${SERVER} server`;
    return hadBlock || hadMcp
      ? `pair(codex): ${o.dryRun ? '(dry run) would remove' : 'removed'} ${what}${kept}`
      : `pair(codex): nothing to remove${kept}`;
  },
};

// ── Gemini CLI ──────────────────────────────────────────────────────────────

const geminiPaths = (home: string) => ({
  instructions: join(home, '.gemini', 'GEMINI.md'),
  config: join(home, '.gemini', 'settings.json'),
});

interface GeminiSettings { mcpServers?: Record<string, { httpUrl?: string; headers?: Record<string, string> }>; [k: string]: unknown }

/** Undefined for a file that exists but is not a JSON object — never overwritten. */
function readGeminiSettings(path: string): GeminiSettings | undefined {
  const text = readIfExists(path);
  if (text === undefined || text.trim() === '') return {};
  try {
    const j: unknown = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as GeminiSettings) : undefined;
  } catch {
    return undefined;
  }
}

const geminiEntry = (url: string) => ({ httpUrl: url, headers: { Authorization: `Bearer $${PAIR_KEY_VAR}` } });

function geminiMcpState(s: GeminiSettings, url: string): McpFileState {
  const e = s.mcpServers?.[SERVER];
  if (!e) return { state: 'missing' };
  if (e.httpUrl !== url) return { state: 'different', detail: `it points at ${e.httpUrl ?? '(no httpUrl)'}, not ${url}` };
  if (e.headers?.Authorization !== `Bearer $${PAIR_KEY_VAR}`) return { state: 'different', detail: `it does not read its key from $${PAIR_KEY_VAR}` };
  return { state: 'registered' };
}

export const geminiPair: PairInstaller = {
  harness: 'gemini',
  displayName: 'Gemini CLI',

  installPair(o) {
    const p = geminiPaths(o.home ?? homedir());
    const settings = readGeminiSettings(p.config);
    if (!settings) return `pair(gemini): ${p.config} is not a JSON object — fix it by hand; nothing was written`;
    const st = geminiMcpState(settings, o.url);
    if (st.state === 'different' && !o.replace) {
      return `pair(gemini): left ${p.config} alone — a "${SERVER}" server exists and ${st.detail}. Re-run with --mcp replace to overwrite it.`;
    }
    const block = installBlockFile(p.instructions, 'gemini', o.dryRun);
    if (block.error) return `pair(gemini): ${block.error}`;
    const mcpChanged = st.state !== 'registered';
    if (mcpChanged && !o.dryRun) {
      const next = { ...settings, mcpServers: { ...settings.mcpServers, [SERVER]: geminiEntry(o.url) } };
      writeFileMkdir(p.config, `${JSON.stringify(next, null, 2)}\n`);
    }
    if (!block.changed && !mcpChanged) return `pair(gemini): already installed (${p.instructions}, ${p.config})`;
    return `pair(gemini): ${o.dryRun ? '(dry run) would install' : 'installed'} the Pair block in ${p.instructions} and ${SERVER} in ${p.config} (key read from $${PAIR_KEY_VAR})`;
  },

  verifyPair(o) {
    const p = geminiPaths(o.home ?? homedir());
    const b = blockVerdict(p.instructions, 'gemini');
    if (!b.ok) return b;
    const settings = readGeminiSettings(p.config);
    if (!settings) return { ok: false, detail: `${p.config} is not a JSON object` };
    const st = geminiMcpState(settings, o.url);
    if (st.state === 'missing') return { ok: false, detail: `no ${SERVER} server in ${p.config}` };
    if (st.state === 'different') return { ok: false, detail: `${SERVER} in ${p.config} ${st.detail}` };
    return { ok: true, detail: `${p.instructions}, ${p.config}` };
  },

  removePair(o) {
    const p = geminiPaths(o.home ?? homedir());
    const hadBlock = removeBlockFile(p.instructions, o.dryRun);
    const settings = readGeminiSettings(p.config);
    // Only an entry in the shape install writes is ours to remove; a different one is the operator's.
    const st = settings ? geminiMcpState(settings, o.url) : ({ state: 'missing' } as const);
    const hadMcp = st.state === 'registered';
    const kept = st.state === 'different' ? `; left the existing ${SERVER} server alone — ${st.detail}` : '';
    if (hadMcp && settings && !o.dryRun) {
      const { [SERVER]: _gone, ...rest } = settings.mcpServers ?? {};
      const next: GeminiSettings = { ...settings };
      if (Object.keys(rest).length > 0) next.mcpServers = rest;
      else delete next.mcpServers;
      if (Object.keys(next).length === 0) rmSync(p.config);
      else writeFileSync(p.config, `${JSON.stringify(next, null, 2)}\n`);
    }
    const what = hadBlock && hadMcp ? `the Pair block and ${SERVER} server` : hadBlock ? 'the Pair block' : `the ${SERVER} server`;
    return hadBlock || hadMcp
      ? `pair(gemini): ${o.dryRun ? '(dry run) would remove' : 'removed'} ${what}${kept}`
      : `pair(gemini): nothing to remove${kept}`;
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Every harness Pair can be installed for. A harness with a headless adapter
 * carries its installer on the adapter (Claude); one that has Pair but no
 * adapter yet registers here on its own (Codex and Gemini until CREW-1520/1521,
 * Copilot once its ticket lands) — the same list either way.
 */
const PAIR_INSTALLERS: Record<string, PairInstaller> = {
  [claudePair.harness]: claudePair,
  [codexPair.harness]: codexPair,
  [geminiPair.harness]: geminiPair,
};

export const PAIR_HARNESS_NAMES = Object.keys(PAIR_INSTALLERS);

export const DEFAULT_PAIR: string[] = ['claude'];

export function isPairHarness(name: string): boolean {
  return Object.hasOwn(PAIR_INSTALLERS, name);
}

export function pairInstallerFor(harness: string): PairInstaller {
  const i = Object.hasOwn(PAIR_INSTALLERS, harness) ? PAIR_INSTALLERS[harness] : undefined;
  if (!i) throw new Error(`no Pair installer for "${harness}" (have: ${PAIR_HARNESS_NAMES.join(', ')})`);
  return i;
}

/** The persona-prompt line `crew agents prompt pair --harness H` adds, or '' for an unknown harness. */
export function harnessPromptNote(harness: string | undefined): string {
  if (!harness || !isPairHarness(harness)) return '';
  return `\n\n(This Pair session is running in ${pairInstallerFor(harness).displayName}.)\n`;
}
