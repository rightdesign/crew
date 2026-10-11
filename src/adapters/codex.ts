/**
 * The Codex CLI harness adapter (CREW-1520, EPIC-035 §5/§6/§7/§8/§9).
 *
 * `codex exec --json` is Codex's non-interactive mode: the prompt arrives on
 * stdin (`-`), progress is a JSONL stream of thread/turn/item events, and the
 * sandbox is a flag. Nothing here has been run against a live Codex account
 * yet: the stream shapes below follow the documented `exec --json` events and
 * are covered by a hand-written fixture until a real session is recorded.
 */

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import type { RoleName } from '../config.ts';
import { profileFor, type CapabilityProfile } from '../capability.ts';
import type { StreamKindEvent, StreamResult } from '../stream.ts';
import type { HarnessAdapter, McpRegistrationOpts, McpRegistration } from '../toolchain.ts';
import type { PairInstaller } from '../pair-install.ts';
import {
  PAIR_KEY_VAR, SERVER, readIfExists, writeFileMkdir, installBlockFile, removeBlockFile, blockVerdict,
  type McpFileState, tomlTableRange, tomlValue, tomlString, upsertTomlTable, removeTomlTable,
} from '../pair-files.ts';

/**
 * Billing: a variable like these in the environment makes Codex bill an API
 * account instead of the operator's Codex login. Removed at exec, like the
 * Claude adapter's; a toolchain entry's own `env:` is applied afterwards, so
 * setting one there is how an operator opts in (or points at a local endpoint).
 */
export const CODEX_BILLING_VARS_TO_UNSET = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_PROJECT', 'CODEX_API_KEY',
];

/**
 * The neutral capability level as a Codex sandbox mode (§6). Codex has no
 * per-tool allow/deny. `read` is the read-only sandbox. `write` and `edit` are
 * NOT `workspace-write`: that mode keeps every `.git` directory read-only (the
 * checkout's own included, whatever `writable_roots`/`--add-dir` add — verified
 * with `codex sandbox` on 0.162), so a seat could neither cut its worktree nor
 * commit, and under `approval_policy="never"` the escalation Codex would
 * normally ask for is auto-rejected. The first real run (SBX-1530) stopped on
 * exactly that. So they run with no filesystem sandbox, which is also what the
 * Claude adapter's unsandboxed Bash amounts to; the lane guard and the persona
 * remain the backstop, and the capability matrix says so.
 */
export function codexSandboxFor(p: CapabilityProfile): 'read-only' | 'danger-full-access' {
  return p.level === 'read' ? 'read-only' : 'danger-full-access';
}

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

// ── Stream mapping (§9) ─────────────────────────────────────────────────────

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  query?: string;
  server?: string;
  tool?: string;
  changes?: { path?: string }[];
}
interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number };
}

/** `/bin/zsh -lc "git status"` → `git`; a bare command → its first word. */
export function commandTarget(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-\w*c\s+(['"]?)([\s\S]*)\1$/.exec(command.trim());
  const inner = (wrapped ? wrapped[2]! : command).trim();
  return inner.split(/\s+/)[0] || undefined;
}

/**
 * The thought/text/tool events a *completed* item carries. Started and updated
 * items are ignored so a command or message is reported once, not three times.
 */
export function mapCodexLine(line: unknown): StreamKindEvent[] {
  const l = line as CodexLine;
  if (!l || l.type !== 'item.completed' || !l.item) return [];
  const it = l.item;
  switch (it.type) {
    case 'reasoning': return it.text ? [{ kind: 'thought', text: it.text }] : [];
    case 'agent_message': return it.text ? [{ kind: 'text', text: it.text }] : [];
    case 'command_execution': return [{ kind: 'tool', tool: 'command', target: commandTarget(it.command) }];
    case 'file_change': return [{ kind: 'tool', tool: 'file_change', target: it.changes?.[0]?.path }];
    case 'mcp_tool_call': return [{ kind: 'tool', tool: `mcp__${it.server ?? 'mcp'}__${it.tool ?? 'tool'}` }];
    case 'web_search': return [{ kind: 'tool', tool: 'web_search', target: it.query }];
    default: return [];
  }
}

/**
 * The session id (`thread.started`) and a turn's usage (`turn.completed`). The
 * runner merges these field by field, so the last turn's usage wins and the
 * session id survives it. Codex's `input_tokens` already includes the cached
 * part, which is reported separately as `cacheReadTokens`; `cache_write_input_tokens`
 * (present in the recorded 0.162 stream) is `cacheWriteTokens`. It reports no cost.
 */
export function extractCodexResult(line: unknown): StreamResult | undefined {
  const l = line as CodexLine;
  if (!l) return undefined;
  if (l.type === 'thread.started' && l.thread_id) return { sessionId: l.thread_id };
  if (l.type === 'turn.completed' && l.usage) {
    return {
      inputTokens: l.usage.input_tokens, outputTokens: l.usage.output_tokens,
      cacheReadTokens: l.usage.cached_input_tokens, cacheWriteTokens: l.usage.cache_write_input_tokens,
    };
  }
  return undefined;
}

export function extractCodexTurnTokens(line: unknown): number | undefined {
  const l = line as CodexLine;
  if (!l || l.type !== 'turn.completed' || !l.usage) return undefined;
  return (l.usage.input_tokens ?? 0) + (l.usage.output_tokens ?? 0);
}

// ── Pair + MCP in Codex's user config (§7, §8) ──────────────────────────────

export function codexTable(url: string): string[] {
  return [`[mcp_servers.${SERVER}]`, `url = ${tomlString(url)}`, `bearer_token_env_var = ${tomlString(PAIR_KEY_VAR)}`];
}


const codexPaths = (home: string) => ({
  instructions: join(home, '.codex', 'AGENTS.md'),
  config: join(home, '.codex', 'config.toml'),
});


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


// ── The adapter ─────────────────────────────────────────────────────────────

function binMissing(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export const codexAdapter: HarnessAdapter = {
  harness: 'codex',
  displayName: 'Codex',
  vendor: 'openai',
  ownsModel: (model) => /^(gpt-|o\d|codex-)/.test(model),
  // The tier's reasoning is Codex's effort level; anything else is ignored.
  applyReasoning: (spec, reasoning) => (REASONING_EFFORTS.includes(reasoning) ? { ...spec, reasoningEffort: reasoning } : spec),
  defaultBin: 'codex',
  // What Codex CLI itself starts with today (the `gpt-5-codex` family the first
  // cut named now answers 404 "does not exist or you do not have access" from
  // the Responses API for a 2026 API key, which the recording for CREW-1520
  // hit first). An operator pins something else per toolchain entry or tier.
  defaultModel: 'gpt-5.5',
  defaultTiers: {
    light: { model: 'gpt-5.4-mini', reasoning: 'low' },
    standard: { model: 'gpt-5.5' },
    deep: { model: 'gpt-5.5', reasoning: 'high' },
  },
  limitations: [
    'no per-tool allow or deny list, and a push (even a forced one) is not blocked',
    'the write (QA) and edit (dev, design) profiles run with no filesystem sandbox (danger-full-access): Codex\'s workspace-write keeps every .git directory read-only, so a sandboxed seat could not cut a worktree or commit, and a headless run cannot approve the escalation',
    'the read profile (triage) runs in the read-only sandbox, which has no network, so it can reach the tracker only through the MCP tools, not curl',
    'the design canvas and skills are unavailable',
    'no cost is reported (tokens only)',
  ],

  invocation(spec, o) {
    const profile = profileFor(o.role);
    const mode = codexSandboxFor(profile);
    const cfg = (k: string, v: string) => ['-c', `${k}=${tomlString(v)}`];
    const args = [
      'exec', '--json', '--skip-git-repo-check',
      '--sandbox', mode,
      '--model', o.model,
      // Headless: nobody can answer an approval prompt.
      '-c', 'approval_policy="never"',
      ...(spec.reasoningEffort ? cfg('model_reasoning_effort', spec.reasoningEffort) : []),
      // The tracker MCP for this run only, as -c overrides: the config file is
      // untouched and the key is named by variable, never written (§7).
      // `default_tools_approval_mode="approve"` is load-bearing: Codex asks
      // before an MCP tool call by default, and under `approval_policy="never"`
      // that question is auto-rejected ("MCP tool call requires approval, but
      // approval policy is never" — seen on the first real recording), which
      // would cut a headless seat off from the tracker entirely.
      ...(o.mcp
        ? [
            ...cfg(`mcp_servers.${SERVER}.url`, o.mcp.url),
            ...cfg(`mcp_servers.${SERVER}.bearer_token_env_var`, o.mcp.keyVar),
            ...cfg(`mcp_servers.${SERVER}.default_tools_approval_mode`, 'approve'),
          ]
        : []),
      ...spec.args,
      // Prompt on stdin.
      '-',
    ];
    return spec.launcher
      ? { bin: spec.launcher, args: [spec.bin, ...args] }
      : { bin: spec.bin, args };
  },

  runEnv: (spec) => ({ ...spec.env }),
  provider: () => 'openai',
  unsetEnv: CODEX_BILLING_VARS_TO_UNSET,
  mapStreamLine: mapCodexLine,
  extractResult: extractCodexResult,
  extractTurnTokens: extractCodexTurnTokens,

  inspectMcp(o: McpRegistrationOpts): McpRegistration {
    if (binMissing(o.bin)) return { state: 'no-binary' };
    const st = codexMcpState(readIfExists(codexPaths(o.home ?? homedir()).config) ?? '', o.url);
    return st.state === 'registered' ? { state: 'registered', url: o.url } : st;
  },

  ensureMcp(o) {
    const p = codexPaths(o.home ?? homedir());
    const config = readIfExists(p.config) ?? '';
    const st = codexMcpState(config, o.url);
    if (st.state === 'registered') return `mcp: ${SERVER} already registered with Codex → ${o.url}`;
    if (st.state === 'different' && !o.replace) {
      return `mcp: left Codex's "${SERVER}" server alone — ${st.detail}. Re-run with --mcp replace to overwrite it.`;
    }
    if (o.dryRun) return `(dry run) would register the ${SERVER} MCP server with Codex → ${o.url}`;
    writeFileMkdir(p.config, upsertTomlTable(config, `mcp_servers.${SERVER}`, codexTable(o.url)));
    return `mcp: registered the ${SERVER} MCP server with Codex → ${o.url} (${p.config}; key read from $${PAIR_KEY_VAR})`;
  },
};
