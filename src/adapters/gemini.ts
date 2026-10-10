/**
 * The Gemini CLI harness adapter (CREW-1521, EPIC-035 §5–§9): headless runs
 * through `gemini -p '' --output-format stream-json` (prompt on stdin).
 *
 * Written from Gemini CLI's documented stream-json schema, not from a recorded
 * session — the Studio has no `gemini` binary or Google account yet, so the
 * fixture under `test/fixtures/` is hand-built from that schema and the real
 * headless run in the ticket's acceptance is still owed.
 *
 * Stream events (one JSON object per line):
 *   init        { session_id, model }
 *   message     { role: 'user'|'assistant', content, delta? }
 *   tool_use    { tool_name, tool_id, parameters }
 *   tool_result { tool_id, status, output? }
 *   error       { severity, message }
 *   result      { status, stats: { total_tokens, input_tokens, output_tokens, cached, duration_ms, tool_calls } }
 */

import type { RoleName } from '../config.ts';
import type { StreamKindEvent, StreamResult } from '../stream.ts';
import { toolTarget } from '../stream.ts';
import { ensureGeminiMcp, inspectGeminiMcp } from '../pair-install.ts';
import type { HarnessAdapter } from '../toolchain.ts';
import { profileFor, type CapabilityProfile } from '../capability.ts';

/**
 * Google billing and routing variables. Any of these in the inherited
 * environment silently selects an API key or Vertex project over the operator's
 * own Google login, so they are unset at exec, mirroring the Claude adapter.
 */
export const BILLING_VARS_TO_UNSET = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_MODEL',
];

const READ_TOOLS = ['read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content'];

/**
 * The neutral capability profile as Gemini's `--allowed-tools` list (tools that
 * run without a confirmation prompt) plus its approval mode. Headless, a tool
 * outside the list that needs confirmation is refused, which is what makes the
 * list a grant. `edit` is auto-approval of everything (`yolo`), so it has no
 * list to enforce.
 */
export function geminiGrantFor(p: CapabilityProfile): { approvalMode: 'default' | 'yolo'; allowed: string[] } {
  if (p.level === 'read') return { approvalMode: 'default', allowed: [...READ_TOOLS, 'run_shell_command'] };
  if (p.level === 'write') return { approvalMode: 'default', allowed: [...READ_TOOLS, 'run_shell_command', 'write_file'] };
  return { approvalMode: 'yolo', allowed: [] };
}

export function geminiGrantArgs(role: RoleName): string[] {
  const g = geminiGrantFor(profileFor(role));
  return ['--approval-mode', g.approvalMode, ...(g.allowed.length ? ['--allowed-tools', g.allowed.join(',')] : [])];
}

interface GeminiLine {
  type?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  parameters?: Record<string, unknown>;
  session_id?: string;
  stats?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; cached?: number; tool_calls?: number };
}

export function mapGeminiLine(line: unknown): StreamKindEvent[] {
  const obj = line as GeminiLine | null;
  if (!obj || typeof obj !== 'object') return [];
  if (obj.type === 'message' && obj.role === 'assistant' && obj.content) return [{ kind: 'text', text: obj.content }];
  if (obj.type === 'tool_use') return [{ kind: 'tool', tool: obj.tool_name, target: toolTarget(obj.tool_name === 'run_shell_command' ? 'Bash' : obj.tool_name, obj.parameters) }];
  return [];
}

/**
 * Per-run mapper that coalesces an assistant turn's `delta` fragments into one
 * `text` event, so the runner's one-cycle-per-`text` rule yields a cycle per
 * turn. The pending turn is flushed by a tool call, a non-assistant message, the
 * `result` line, or end of stream.
 */
export function createGeminiStreamMapper(): { map(line: unknown): StreamKindEvent[]; flush(): StreamKindEvent[] } {
  let pending = '';
  const flush = (): StreamKindEvent[] => {
    const text = pending;
    pending = '';
    return text ? [{ kind: 'text', text }] : [];
  };
  return {
    flush,
    map(line) {
      const obj = line as GeminiLine | null;
      if (obj && typeof obj === 'object' && obj.type === 'message' && obj.role === 'assistant') {
        if (obj.content) pending += obj.content;
        return [];
      }
      // Anything else ends the turn in progress; tool calls then follow it.
      return [...flush(), ...mapGeminiLine(line)];
    },
  };
}

// The CLI reports `tool_calls` but no turn count; sessions are the closest unit it exposes, so numTurns stays absent.
export function extractGeminiResult(line: unknown): StreamResult | undefined {
  const obj = line as GeminiLine | null;
  // The session id arrives on `init`, the token stats on `result`; the runner merges the two.
  if (obj?.type === 'init') return obj.session_id ? { sessionId: obj.session_id } : undefined;
  if (!obj || obj.type !== 'result') return undefined;
  const s = obj.stats;
  return {
    inputTokens: s?.input_tokens,
    outputTokens: s?.output_tokens,
    cacheReadTokens: s?.cached,
  };
}

export const geminiAdapter: HarnessAdapter = {
  harness: 'gemini',
  displayName: 'Gemini CLI',
  vendor: 'google',
  ownsModel: (model) => model.startsWith('gemini-'),
  // Gemini CLI has no per-run reasoning knob, so a tier's `reasoning` is ignored.
  defaultBin: 'gemini',
  defaultModel: 'gemini-2.5-pro',
  defaultTiers: {
    light: { model: 'gemini-2.5-flash' },
    standard: { model: 'gemini-2.5-pro' },
    deep: { model: 'gemini-2.5-pro' },
  },
  limitations: [
    'the tool grant is an allow list of tools that skip confirmation, not a sandbox: run_shell_command is allowed in every profile and sub-commands cannot be restricted',
    'there is no deny list: destructive shell patterns (rm -rf, forced pushes, curl | sh) are not refused at the tool layer, unlike the Claude adapter',
    'the edit profile runs in yolo mode (auto-approves every tool); the write profile (QA) withholds replace, not shell writes',
    'design tools (skills, design canvas) are unavailable on this harness',
    'the tracker MCP server is read from ~/.gemini/settings.json (there is no per-run --mcp-config), and MCP tool calls in the read and write profiles are not on the allow list',
    'the stream carries no thinking blocks and streams assistant text in fragments, so the runner coalesces fragments into one Agent Log cycle per assistant turn; no turn count or cost is reported',
  ],

  invocation(spec, o) {
    const args = [
      // The prompt arrives on stdin; `-p` puts the CLI in non-interactive mode.
      '-p', '',
      '--model', o.model,
      '--output-format', 'stream-json',
      ...geminiGrantArgs(o.role),
      ...spec.args,
    ];
    return spec.launcher
      ? { bin: spec.launcherBin ?? spec.launcher, args: [spec.bin, ...args] }
      : { bin: spec.bin, args };
  },

  runEnv: (spec) => ({ ...spec.env }),

  provider: () => 'google',

  unsetEnv: BILLING_VARS_TO_UNSET,
  mapStreamLine: mapGeminiLine,
  createStreamMapper: createGeminiStreamMapper,
  extractResult: extractGeminiResult,
  extractTurnTokens: () => undefined,

  inspectMcp(o) {
    return inspectGeminiMcp(o);
  },
  ensureMcp: (o) => ensureGeminiMcp(o),
};
