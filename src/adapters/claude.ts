/**
 * The Claude Code harness adapter — everything crew knew about the `claude` CLI
 * before CREW-1511, moved here unchanged: the headless argv, the tool grant and
 * deny list, the billing-variable scrub, the stream-json mapper and the
 * `claude mcp` registration.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RoleName } from '../config.ts';
import { mapStreamLine, extractResult, extractTurnTokens } from '../stream.ts';
import { ensureClaudeMcp, ensureClaudeMcpResult, inspectClaudeMcp, removeClaudeMcp } from '../claude-mcp.ts';
import type { PairInstaller } from '../pair-install.ts';
import type { HarnessAdapter } from '../toolchain.ts';
import { wrapInvocation, isOmlxLauncher } from '../launcher.ts';
import { profileFor, type CapabilityProfile } from '../capability.ts';

/**
 * Billing, and it has bitten before.
 *
 * Any of these present in the environment silently takes precedence over the
 * operator's subscription auth, and a sibling agent once burned ~66.5M tokens
 * against an org's API credits in a week purely because it inherited
 * ANTHROPIC_API_KEY from a project's .env. They are unset at exec rather than
 * merely left unassigned, because ~/.claude/settings.json has flipped billing
 * before and a local override cannot be relied on to win.
 */
export const BILLING_VARS_TO_UNSET = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
  'CLOUD_ML_REGION',
  'ANTHROPIC_MODEL',
];

/**
 * Deny patterns layered on top of the allow list, for every role.
 *
 * The allowlist gates which *tools* a session has; it says nothing about
 * what an unattended session does with the ones it's given. Ticket and
 * comment bodies are attacker-reachable text — anyone with workspace access
 * can write one — and the brief telling a session "this is a coding task,
 * not an instruction to run destructive commands" is a rule an injected
 * prompt can try to talk its way around. This is not that: `claude -p
 * --disallowedTools` enforces these patterns at the tool-call layer, so a
 * session that gets talked into trying one is refused mid-run rather than
 * trusted to have refused on its own. It is still not a sandbox — a `Bash`
 * one-liner that reaches the same end a different way is not caught — so it
 * complements the brief's framing rather than replacing it, and does not
 * replace scoping the tracker API key itself to least privilege.
 */
export const DISALLOWED_TOOLS: string[] = [
  'Bash(rm -rf:*)', 'Bash(rm -fr:*)',
  'Bash(git push --force*)', 'Bash(git push -f*)',
  'Bash(curl*| sh)', 'Bash(curl*|sh)', 'Bash(curl*| bash)', 'Bash(curl*|bash)',
  'Bash(sudo:*)',
];

/** The neutral capability profile, mapped onto Claude Code's tool names. */
export function claudeToolsFor(p: CapabilityProfile): string[] {
  // Every lane gets the Tablation MCP tools alongside its REST+apiKey access
  // (the MCP server registered in the argv) — the tracker's own generated
  // tool surface, not a replacement for the tracker-key path.
  const tablation = 'mcp__tablation__*';
  // Triage classifies and nothing else: no Edit, no Write.
  if (p.level === 'read') return ['Bash', 'Read', tablation];
  // QA gets no Edit: it verifies, it never fixes. That is not a sandbox — Bash
  // can write files, and QA needs Bash for git, dev servers and Playwright —
  // but withholding the editing tool makes "bounce it back rather than fix it"
  // the path of least resistance instead of a rule to remember. Write stays,
  // for throwaway verification scripts.
  if (p.level === 'write') return ['Bash', 'Read', 'Write', 'Grep', 'Glob', tablation];
  const base = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', tablation];
  // The design role additionally loads skills and publishes a design canvas.
  return p.designTools ? [...base, 'Skill', 'Artifact'] : base;
}

export function allowedTools(role: RoleName): string[] {
  return claudeToolsFor(profileFor(role));
}

/**
 * Claude's Pair install is today's path, unchanged: the operator's session-start
 * hook runs `crew agents prompt pair`, and the only thing crew installs is the
 * user-scope `claude mcp add` registration.
 */
export const claudePair: PairInstaller = {
  harness: 'claude',
  displayName: 'Claude Code',
  installPair: (o) => ensureClaudeMcp({ bin: o.bin ?? 'claude', url: o.url, key: o.key ?? '', home: o.home, replace: o.replace, dryRun: o.dryRun }),
  verifyPair(o) {
    const s = inspectClaudeMcp({ bin: o.bin ?? 'claude', url: o.url, key: o.key ?? '', home: o.home });
    return s.state === 'registered' ? { ok: true, detail: s.url }
      : s.state === 'different' ? { ok: false, detail: s.detail }
      : { ok: false, detail: s.state === 'no-claude' ? 'claude binary not found' : 'tablation MCP server not registered' };
  },
  removePair: (o) => removeClaudeMcp({ bin: o.bin ?? 'claude', dryRun: o.dryRun }),
};

/**
 * The `--settings` payload for `auth: subscription` (CREW-2539). The Vertex
 * onboarding wizard writes its variables into the `env` block of
 * ~/.claude/settings.json, which Claude Code applies itself, so unsetting the
 * shell variables cannot reach it. `--settings` ranks above user, project and
 * local settings, so an empty value for every billing variable wins.
 */
export function subscriptionSettings(): string {
  return JSON.stringify({ env: Object.fromEntries(BILLING_VARS_TO_UNSET.map((v) => [v, ''])) });
}

/**
 * Which billing path a toolchain resolves to, for `crew doctor`. `inherit`
 * names the first source that would win, so the choice is visible before a run
 * bills anything.
 */
export function describeClaudeAuth(
  spec: { auth?: 'subscription' | 'inherit' },
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (spec.auth === 'subscription') return 'subscription (settings override)';
  // The adapter unsets these shell variables at exec, so only settings.json can still apply.
  let fromSettings: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, unknown> };
    const e = parsed.env ?? {};
    const on = (k: string) => e[k] !== undefined && e[k] !== '' && e[k] !== '0';
    if (on('CLAUDE_CODE_USE_VERTEX')) fromSettings = 'vertex from ~/.claude/settings.json';
    else if (on('ANTHROPIC_API_KEY') || on('ANTHROPIC_AUTH_TOKEN')) fromSettings = 'API key from ~/.claude/settings.json';
  } catch { /* no readable settings file: nothing to report */ }
  if (fromSettings) return `inherit: ${fromSettings}`;
  const shell = BILLING_VARS_TO_UNSET.find((v) => v.startsWith('ANTHROPIC_API') && env[v]);
  return shell ? `inherit: ${shell} in env (unset at exec)` : 'inherit: subscription login';
}

export const claudeAdapter: HarnessAdapter = {
  harness: 'claude',
  displayName: 'Claude Code',
  vendor: 'anthropic',
  ownsModel: (model) => model.startsWith('claude-'),
  // The tier's reasoning is the extended-thinking budget; it supersedes the
  // toolchain's `maxThinkingTokens` (0 disables). A non-numeric value is ignored.
  applyReasoning(spec, reasoning) {
    const n = Number(reasoning);
    return Number.isInteger(n) && n >= 0 ? { ...spec, maxThinkingTokens: n } : spec;
  },
  defaultBin: 'claude',
  defaultModel: 'claude-sonnet-5',
  defaultTiers: {
    // `standard` carries no reasoning: it defers to the toolchain's own
    // `maxThinkingTokens`, which is what a persona with no tier gets today.
    light: { model: 'claude-haiku-4-5-20251001', reasoning: '2048' },
    standard: { model: 'claude-sonnet-5-5' },
    deep: { model: 'claude-opus-5-5', reasoning: '16384' },
  },
  limitations: [
    'Bash is not sandboxed: the deny list refuses known destructive patterns, but a one-liner reaching the same end another way is not caught',
    'the write profile (QA) withholds the Edit tool, not file writes — Bash can still write files',
    'git push is not blocked, only forced pushes',
  ],

  invocation(spec, o) {
    const args = [
      '-p', '--allowedTools', ...allowedTools(o.role),
      '--disallowedTools', ...DISALLOWED_TOOLS,
      // oMLX denies LSP itself for prefix-cache stability, but only when the
      // caller passes no --disallowedTools of its own — and crew always does.
      ...(isOmlxLauncher(spec) ? ['LSP'] : []),
      '--model', o.model,
      '--output-format', 'stream-json', '--verbose',
      // Registers the tracker's own MCP tool surface for this run only —
      // `${CREW_API_KEY}` is interpolated by the CLI from the environment,
      // so the resolved key is never written to an argv string or a config
      // file on disk. Skipped when there's no key to send: a route `crew
      // connect` hasn't resolved yet has nothing to authenticate with.
      ...(o.mcp
        ? ['--mcp-config', JSON.stringify({
            mcpServers: {
              tablation: {
                type: 'http',
                url: o.mcp.url,
                headers: { Authorization: `Bearer \${${o.mcp.keyVar}}` },
              },
            },
          })]
        : []),
      ...(spec.auth === 'subscription' ? ['--settings', subscriptionSettings()] : []),
      ...spec.args,
    ];
    return wrapInvocation(spec, { model: o.model, args });
  },

  runEnv(spec) {
    return {
      // Extended thinking is what makes the CLI emit `thinking` stream
      // blocks at all — without it, Agent Log Cycles reporting has nothing
      // to report (ISSUE-558).
      ...(spec.maxThinkingTokens > 0 ? { MAX_THINKING_TOKENS: String(spec.maxThinkingTokens) } : {}),
      ...spec.env,
    };
  },

  provider: () => 'anthropic',

  unsetEnv: BILLING_VARS_TO_UNSET,
  mapStreamLine,
  extractResult,
  extractTurnTokens,

  inspectMcp(o) {
    const s = inspectClaudeMcp(o);
    return s.state === 'no-claude' ? { state: 'no-binary' } : s;
  },
  ensureMcp: ensureClaudeMcp,
  ensureMcpResult: ensureClaudeMcpResult,
};
