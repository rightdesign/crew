/**
 * Turning one line of `claude --output-format stream-json` into the crew's
 * own event shape.
 *
 * Kept separate from `agent.ts` (which owns the child process and the
 * files) so the mapping itself — the part with actual decisions in it — is
 * plain, synchronous and directly testable against fixture lines, without
 * spawning anything.
 */

export interface StreamKindEvent {
  kind: 'thought' | 'text' | 'tool';
  /** Present when `kind === 'thought'` or `'text'` — the block's content, verbatim. */
  text?: string;
  /** Present when `kind === 'tool'`. */
  tool?: string;
  /** Present when `kind === 'tool'` — the path or the command's first word (after any leading `cd <path> &&`). */
  target?: string;
  /**
   * Present when `kind === 'tool'` and the call had arguments worth showing: a
   * readable, capped rendering of them (the whole command for a shell call,
   * otherwise `key: value` lines). Written to the mapped stream.
   */
  detail?: string;
  /** Present when `kind === 'tool'` and the call's arguments carried a one-line description (the shell tool does). */
  description?: string;
  /**
   * Present when `kind === 'tool'` — the call's raw arguments, for in-process
   * inspection only; never written to a sink. A tracker body can be large, so
   * what reaches the stream is `detail`, which caps each value and the whole.
   */
  input?: Record<string, unknown>;
}

export interface StreamResult {
  sessionId?: string;
  numTurns?: number;
  /** Only when the harness reports a cost itself; crew carries no price tables, so otherwise absent (null in the sidecar). */
  costUsd?: number;
  /**
   * From the result line's own `usage` block — present on every
   * `claude --output-format stream-json` result event, not just when
   * prompt caching was used (a run with no cache hits reports 0, not an
   * absent field). `undefined` here only for a result line that predates
   * this shape or genuinely omits `usage`.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Cache writes are Anthropic's usage schema; other harnesses leave this absent. */
  cacheWriteTokens?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface StreamLine {
  type?: string;
  message?: { role?: string; content?: ContentBlock[] | string; usage?: UsageBlock };
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: UsageBlock;
}

/**
 * A short, human-scannable stand-in for a tool call's argument — the file
 * path for an editing tool, the command's first word for Bash, or nothing
 * for a tool this doesn't recognize.
 */
export function toolTarget(name: string | undefined, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['file_path', 'path', 'notebook_path', 'url', 'pattern']) {
    const v = input[key];
    if (typeof v === 'string' && v) return v;
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    return shellTarget(input.command);
  }
  return undefined;
}

/**
 * The first word of a shell command, looking past leading `cd <path> &&` /
 * `cd <path>;` steps since agents begin most commands that way. A command that
 * is only a directory change keeps its own first word (`cd`).
 */
export function shellTarget(command: string): string | undefined {
  let rest = command.trim();
  for (;;) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(rest);
    if (!m || m[0].length >= rest.length) break;
    rest = rest.slice(m[0].length);
  }
  return rest.split(/\s+/)[0] || undefined;
}

/** Cap on `detail` as a whole, and on each single argument value within it. */
export const TOOL_DETAIL_MAX = 4000;
export const TOOL_DETAIL_VALUE_MAX = 1000;

function capText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The capped, readable rendering of a tool call's arguments for the mapped
 * stream, and the call's own description when it has one. `shell` marks a
 * shell call, whose command is shown whole; any other call's arguments become
 * `key: value` lines (strings as-is, the rest JSON), skipping the value
 * `target` already shows. Both fields are absent when there is nothing to say.
 */
export function toolDetail(
  input: Record<string, unknown> | undefined,
  opts: { shell?: boolean; target?: string } = {},
): { detail?: string; description?: string } {
  if (!input) return {};
  const out: { detail?: string; description?: string } = {};
  const desc = input.description;
  if (typeof desc === 'string' && desc.trim()) out.description = capText(desc.trim(), TOOL_DETAIL_VALUE_MAX);
  const lines: string[] = [];
  for (const [key, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (opts.shell && key === 'description') continue;
    if (typeof v === 'string' && opts.target !== undefined && v === opts.target && !(opts.shell && key === 'command')) continue;
    const text = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
    if (opts.shell && key === 'command') { lines.unshift(capText(text, TOOL_DETAIL_VALUE_MAX)); continue; }
    lines.push(`${key}: ${capText(text, TOOL_DETAIL_VALUE_MAX)}`);
  }
  if (lines.length) out.detail = capText(lines.join('\n'), TOOL_DETAIL_MAX);
  return out;
}

/**
 * Every thinking/text/tool_use block an assistant message carries, in
 * order. A line that is not an assistant message, or an assistant message
 * with no recognized block, yields an empty array — never null, so a
 * caller can always spread the result.
 */
export function mapStreamLine(line: unknown): StreamKindEvent[] {
  const obj = line as StreamLine;
  if (!obj || obj.type !== 'assistant') return [];
  const content = obj.message?.content;
  if (!Array.isArray(content)) return [];
  const out: StreamKindEvent[] = [];
  for (const block of content) {
    if (block.type === 'thinking') out.push({ kind: 'thought', text: block.thinking });
    else if (block.type === 'text') out.push({ kind: 'text', text: block.text });
    else if (block.type === 'tool_use') {
      const target = toolTarget(block.name, block.input);
      out.push({ kind: 'tool', tool: block.name, target, ...toolDetail(block.input, { shell: block.name === 'Bash', target }), input: block.input });
    }
  }
  return out;
}

/**
 * A single assistant turn's own token cost — unlike the run-wide totals on
 * the final `result` line, `message.usage` is present on every `assistant`
 * stream line (one real API call each), which is what lets a caller weigh
 * *which part* of a multi-ticket run actually spent the tokens (ISSUE-621
 * mis-attribution). Undefined for anything but an assistant line, or one
 * that carries no `usage` block at all.
 */
export function extractTurnTokens(line: unknown): number | undefined {
  const obj = line as StreamLine;
  if (!obj || obj.type !== 'assistant') return undefined;
  const usage = obj.message?.usage;
  if (!usage) return undefined;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/**
 * The prompt prefix a run paid for on one API call: input plus cache-creation
 * tokens of an `assistant` line's `usage` (cache reads are zero on a run's
 * first call, so for that line this is the system prompt, tool schemas and
 * lane brief). The caller keeps only the first line that has one.
 */
export function extractPrefixTokens(line: unknown): number | undefined {
  const obj = line as StreamLine;
  if (!obj || obj.type !== 'assistant') return undefined;
  const usage = obj.message?.usage;
  if (!usage) return undefined;
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** The final `{"type":"result"}` line, or undefined for anything else. */
export function extractResult(line: unknown): StreamResult | undefined {
  const obj = line as StreamLine;
  if (!obj || obj.type !== 'result') return undefined;
  return {
    sessionId: obj.session_id,
    numTurns: obj.num_turns,
    costUsd: obj.total_cost_usd,
    inputTokens: obj.usage?.input_tokens,
    outputTokens: obj.usage?.output_tokens,
    cacheReadTokens: obj.usage?.cache_read_input_tokens,
    cacheWriteTokens: obj.usage?.cache_creation_input_tokens,
  };
}
