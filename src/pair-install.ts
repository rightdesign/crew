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

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudePair } from './adapters/claude.ts';
import { codexPair } from './adapters/codex.ts';
import {
  type McpFileState, PAIR_KEY_VAR, SERVER, readIfExists, writeFileMkdir, installBlockFile, removeBlockFile, blockVerdict,
  PAIR_BLOCK_START, PAIR_BLOCK_END, pairBlock, hasPairBlock, pairBlockIsBroken, upsertPairBlock, removePairBlock,
} from './pair-files.ts';

export * from './pair-files.ts';
export { codexTable, codexPair } from './adapters/codex.ts';

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
  /** Host platform; defaults to this process's. Only Copilot's per-OS VS Code paths read it. */
  platform?: NodeJS.Platform;
  /** Reads a variable from the login environment (not this process's), for tests; defaults to `launchctl getenv` on macOS. */
  loginEnv?: (name: string) => string | undefined;
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
  /**
   * A warning when the harness will not see `$CREW_API_KEY` from where it is
   * normally launched (CREW-1527), or undefined when all is well or unknowable.
   */
  envWarning?(o: PairOpts): string | undefined;
}

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

/**
 * The `tablation` entry in Gemini CLI's user settings, without the Pair block —
 * what the headless adapter needs (Gemini has no per-run `--mcp-config`, so the
 * entry must already be in `~/.gemini/settings.json`). `installPair` writes the
 * same entry through this shape.
 */
export function inspectGeminiMcp(o: { url: string; home?: string }): { state: 'missing' } | { state: 'registered'; url: string } | { state: 'different'; detail: string } {
  const p = geminiPaths(o.home ?? homedir());
  const settings = readGeminiSettings(p.config);
  if (!settings) return { state: 'different', detail: `${p.config} is not a JSON object` };
  const st = geminiMcpState(settings, o.url);
  return st.state === 'registered' ? { state: 'registered', url: o.url } : st;
}

export function ensureGeminiMcp(o: { url: string; home?: string; replace?: boolean; dryRun?: boolean }): string {
  const p = geminiPaths(o.home ?? homedir());
  const settings = readGeminiSettings(p.config);
  if (!settings) return `gemini: ${p.config} is not a JSON object — fix it by hand; nothing was written`;
  const st = geminiMcpState(settings, o.url);
  if (st.state === 'registered') return `gemini: ${SERVER} MCP server already registered in ${p.config}`;
  if (st.state === 'different' && !o.replace) {
    return `gemini: left ${p.config} alone — a "${SERVER}" server exists and ${st.detail}. Re-run with --mcp replace to overwrite it.`;
  }
  if (!o.dryRun) {
    writeFileMkdir(p.config, `${JSON.stringify({ ...settings, mcpServers: { ...settings.mcpServers, [SERVER]: geminiEntry(o.url) } }, null, 2)}\n`);
  }
  return `gemini: ${o.dryRun ? '(dry run) would register' : 'registered'} ${SERVER} in ${p.config} (key read from $${PAIR_KEY_VAR})`;
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

// ── GitHub Copilot in VS Code ───────────────────────────────────────────────

/**
 * VS Code has no `copilot` CLI to register an MCP server with, so both pieces
 * live in the editor's *user profile* directory — which is per-OS, and per
 * flavour (`Code`, `Code - Insiders`):
 *
 *   - `mcp.json`, `servers.tablation`, an HTTP server whose header interpolates
 *     `${env:CREW_API_KEY}` (VS Code expands it; the key is never written, §7);
 *   - `prompts/crew-pair.instructions.md` with `applyTo: "**"`, which VS Code
 *     attaches to every chat. The `prompts/` folder under the user directory is
 *     where the default profile's user-level instruction files live (it is what
 *     `Chat: New Instructions File` ▸ "User" offers). Non-default profiles keep
 *     their own `profiles/<id>/prompts`; crew installs for the default profile.
 *
 * Every flavour that already has a user directory gets the install, so an
 * operator running Insiders is covered; with none present, stable `Code` is
 * created (the files are inert until VS Code reads them).
 */
const VSCODE_FLAVOURS = ['Code', 'Code - Insiders'];

function vscodeUserDirs(o: PairOpts): string[] {
  const home = o.home ?? homedir();
  const platform = o.platform ?? process.platform;
  const root =
    platform === 'darwin' ? join(home, 'Library', 'Application Support')
      : platform === 'win32' ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : join(home, '.config');
  const all = VSCODE_FLAVOURS.map((f) => join(root, f, 'User'));
  const present = all.filter((d) => existsSync(d));
  return present.length > 0 ? present : [all[0]!];
}

const COPILOT_FRONTMATTER = '---\napplyTo: "**"\n---\n\n';

interface VscodeMcp { servers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>; [k: string]: unknown }

/** Undefined for a file that exists but is not a plain JSON object (VS Code allows comments there; we will not rewrite those away). */
function readVscodeMcp(path: string): VscodeMcp | undefined {
  const text = readIfExists(path);
  if (text === undefined || text.trim() === '') return {};
  try {
    const j: unknown = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as VscodeMcp) : undefined;
  } catch {
    return undefined;
  }
}

const COPILOT_AUTH = `Bearer \${env:${PAIR_KEY_VAR}}`;
const copilotEntry = (url: string) => ({ type: 'http', url, headers: { Authorization: COPILOT_AUTH } });

function copilotMcpState(s: VscodeMcp, url: string): McpFileState {
  const e = s.servers?.[SERVER];
  if (!e) return { state: 'missing' };
  if (e.url !== url) return { state: 'different', detail: `it points at ${e.url ?? '(no url)'}, not ${url}` };
  if (e.headers?.Authorization !== COPILOT_AUTH) return { state: 'different', detail: `it does not read its key from \${env:${PAIR_KEY_VAR}}` };
  return { state: 'registered' };
}

/** The instructions file is ours alone, but a block already in it is upserted, not clobbered. */
function installCopilotInstructions(path: string, dryRun?: boolean): { changed: boolean; error?: string } {
  const before = readIfExists(path);
  const base = before ?? COPILOT_FRONTMATTER;
  if (pairBlockIsBroken(base)) return { changed: false, error: `${path} has an unmatched ${PAIR_BLOCK_START}/${PAIR_BLOCK_END} marker — fix it by hand` };
  const after = upsertPairBlock(base, pairBlock('copilot'));
  if (after === before) return { changed: false };
  if (!dryRun) writeFileMkdir(path, after);
  return { changed: true };
}

function removeCopilotInstructions(path: string, dryRun?: boolean): boolean {
  const before = readIfExists(path);
  if (before === undefined || !hasPairBlock(before)) return false;
  if (dryRun) return true;
  const after = removePairBlock(before);
  // Frontmatter alone is the file we created; anything more is the operator's.
  if (after.trim() === '' || after.trim() === COPILOT_FRONTMATTER.trim()) rmSync(path);
  else writeFileSync(path, after);
  return true;
}

export const copilotPair: PairInstaller = {
  harness: 'copilot',
  displayName: 'GitHub Copilot (VS Code)',

  installPair(o) {
    const lines: string[] = [];
    for (const dir of vscodeUserDirs(o)) {
      const mcpPath = join(dir, 'mcp.json');
      const instrPath = join(dir, 'prompts', 'crew-pair.instructions.md');
      const settings = readVscodeMcp(mcpPath);
      if (!settings) { lines.push(`pair(copilot): ${mcpPath} is not a plain JSON object (comments are not supported) — fix it by hand; nothing was written there`); continue; }
      const st = copilotMcpState(settings, o.url);
      if (st.state === 'different' && !o.replace) {
        lines.push(`pair(copilot): left ${mcpPath} alone — a "${SERVER}" server exists and ${st.detail}. Re-run with --mcp replace to overwrite it.`);
        continue;
      }
      const instr = installCopilotInstructions(instrPath, o.dryRun);
      if (instr.error) { lines.push(`pair(copilot): ${instr.error}`); continue; }
      const mcpChanged = st.state !== 'registered';
      if (mcpChanged && !o.dryRun) {
        const next: VscodeMcp = { ...settings, servers: { ...settings.servers, [SERVER]: copilotEntry(o.url) } };
        writeFileMkdir(mcpPath, `${JSON.stringify(next, null, 2)}\n`);
      }
      lines.push(!instr.changed && !mcpChanged
        ? `pair(copilot): already installed (${instrPath}, ${mcpPath})`
        : `pair(copilot): ${o.dryRun ? '(dry run) would install' : 'installed'} the Pair instructions in ${instrPath} and ${SERVER} in ${mcpPath} (key read from \${env:${PAIR_KEY_VAR}})`);
    }
    return lines.join('\n');
  },

  verifyPair(o) {
    const verdicts = vscodeUserDirs(o).map((dir): PairVerdict => {
      const instrPath = join(dir, 'prompts', 'crew-pair.instructions.md');
      const mcpPath = join(dir, 'mcp.json');
      const b = blockVerdict(instrPath, 'copilot');
      if (!b.ok) return b;
      const settings = readVscodeMcp(mcpPath);
      if (!settings) return { ok: false, detail: `${mcpPath} is not a plain JSON object` };
      const st = copilotMcpState(settings, o.url);
      if (st.state === 'missing') return { ok: false, detail: `no ${SERVER} server in ${mcpPath}` };
      if (st.state === 'different') return { ok: false, detail: `${SERVER} in ${mcpPath} ${st.detail}` };
      return { ok: true, detail: `${instrPath}, ${mcpPath}` };
    });
    return verdicts.find((v) => !v.ok) ?? { ok: true, detail: verdicts.map((v) => v.detail).join('; ') };
  },

  removePair(o) {
    const lines: string[] = [];
    for (const dir of vscodeUserDirs(o)) {
      const mcpPath = join(dir, 'mcp.json');
      const hadBlock = removeCopilotInstructions(join(dir, 'prompts', 'crew-pair.instructions.md'), o.dryRun);
      const settings = readVscodeMcp(mcpPath);
      // Only an entry in the shape install writes is ours to remove; a different one is the operator's.
      const st = settings ? copilotMcpState(settings, o.url) : ({ state: 'missing' } as const);
      const hadMcp = st.state === 'registered';
      const kept = st.state === 'different' ? `; left the existing ${SERVER} server alone — ${st.detail}` : '';
      if (hadMcp && settings && !o.dryRun) {
        const { [SERVER]: _gone, ...rest } = settings.servers ?? {};
        const next: VscodeMcp = { ...settings };
        if (Object.keys(rest).length > 0) next.servers = rest;
        else delete next.servers;
        if (Object.keys(next).length === 0) rmSync(mcpPath);
        else writeFileSync(mcpPath, `${JSON.stringify(next, null, 2)}\n`);
      }
      const what = hadBlock && hadMcp ? `the Pair instructions and ${SERVER} server` : hadBlock ? 'the Pair instructions' : `the ${SERVER} server`;
      lines.push(hadBlock || hadMcp
        ? `pair(copilot): ${o.dryRun ? '(dry run) would remove' : 'removed'} ${what} (${dir})${kept}`
        : `pair(copilot): nothing to remove in ${dir}${kept}`);
    }
    return lines.join('\n');
  },

  /**
   * VS Code launched from the Dock or Spotlight does not inherit a shell's
   * exports, so `${env:CREW_API_KEY}` expands to nothing there. macOS only: the
   * login environment is `launchctl`'s, and it is the one place we can ask.
   */
  envWarning(o) {
    if ((o.platform ?? process.platform) !== 'darwin') return undefined;
    const get = o.loginEnv ?? ((name: string) => {
      const r = spawnSync('launchctl', ['getenv', name], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : undefined;
    });
    if (get(PAIR_KEY_VAR)) return undefined;
    return `$${PAIR_KEY_VAR} is not in the login environment, so VS Code started from the Dock will not send the tracker key. Launch VS Code from a terminal (\`code .\`), or run \`launchctl setenv ${PAIR_KEY_VAR} <key>\` once per login.`;
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Every harness Pair can be installed for. A harness with a headless adapter
 * carries its installer on the adapter (Claude); one that has Pair but no
 * carries its installer on the adapter (Claude, Codex); one whose installer
 * predates its adapter (Gemini) or that never gets one (Copilot has no headless
 * CLI) registers here on its own — the same list either way.
 */
const PAIR_INSTALLERS: Record<string, PairInstaller> = {
  [claudePair.harness]: claudePair,
  [codexPair.harness]: codexPair,
  [geminiPair.harness]: geminiPair,
  [copilotPair.harness]: copilotPair,
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
