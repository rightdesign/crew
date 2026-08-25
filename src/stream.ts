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
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamLine {
  type?: string;
  message?: { role?: string; content?: ContentBlock[] | string };
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
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

/** The final `{"type":"result"}` line, or undefined for anything else. */
export function extractResult(line: unknown): StreamResult | undefined {
  const obj = line as StreamLine;
  if (!obj || obj.type !== 'result') return undefined;
  return { sessionId: obj.session_id, numTurns: obj.num_turns, totalCostUsd: obj.total_cost_usd };
}
