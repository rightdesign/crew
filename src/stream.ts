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
  /** Present when `kind === 'tool'` — the path or the command's first word. */
  target?: string;
}

export interface StreamResult {
  sessionId?: string;
  numTurns?: number;
  totalCostUsd?: number;
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
  cacheCreationTokens?: number;
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
    return input.command.trim().split(/\s+/)[0];
  }
  return undefined;
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
      out.push({ kind: 'tool', tool: block.name, target: toolTarget(block.name, block.input) });
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

/** The final `{"type":"result"}` line, or undefined for anything else. */
export function extractResult(line: unknown): StreamResult | undefined {
  const obj = line as StreamLine;
  if (!obj || obj.type !== 'result') return undefined;
  return {
    sessionId: obj.session_id,
    numTurns: obj.num_turns,
    totalCostUsd: obj.total_cost_usd,
    inputTokens: obj.usage?.input_tokens,
    outputTokens: obj.usage?.output_tokens,
    cacheReadTokens: obj.usage?.cache_read_input_tokens,
    cacheCreationTokens: obj.usage?.cache_creation_input_tokens,
  };
}
