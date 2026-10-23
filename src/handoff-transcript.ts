/**
 * Reading a run's transcript for a hand-off that never landed (CREW-2363).
 *
 * A session that pushes its branch while the tracker is down gets a 5xx on the
 * `status: fixed` write (and on its hand-off comment), polls, gives up and
 * exits 0. Nothing on the board says so, and crew's own post-run check needs
 * that same tracker to learn anything. The stream is the only witness, so this
 * watches it: every ticket-targeted hand-off write (`classifyWrite`) is paired
 * with its tool result, and a hand-off write whose result is a transport or
 * 5xx failure, with no later success for the same ticket, is a pending hand-off.
 *
 * Only transport-shaped failures count (a 5xx, an HTML error page, a reset or
 * timeout). A 4xx is the tracker refusing the write, which replaying the same
 * body would only repeat.
 */

import { classifyWrite } from './ticket-attribution.ts';

/** What a failed hand-off needs in order to be replayed later. */
export interface PendingHandoffDraft {
  /** The Issues record id the hand-off write targeted. */
  ticketRecordId: string;
  /** The body of the failed status write, replayed verbatim. */
  patch: Record<string, unknown>;
  /** The body of a hand-off comment create that failed for this ticket, if any. */
  comment?: string;
  /** A hand-off comment for this ticket was written successfully, so the final text must not be posted again. */
  commentLanded?: boolean;
  /** The run's last assistant text (the hand-off summary), or the harness's `result`. */
  finalText: string;
}

const TRANSPORT_FAILURE = /\b50[0-4]\b|<!doctype|<html|unexpected token '?<|fetch failed|econn(reset|refused)|etimedout|socket hang up|timed out|bad gateway|service unavailable/i;

interface Block {
  type?: string; id?: string; name?: string; input?: Record<string, unknown>;
  text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof (c as Block).text === 'string' ? (c as Block).text : '')).join('\n');
  return '';
}

/**
 * A write that succeeded echoes the record back as JSON, and that record's own text can contain
 * "502" or "timed out". So the pattern is applied only to a result flagged `is_error` or one that is
 * not a JSON document; a JSON result counts as a failure only when it is an error envelope
 * (`statusCode` >= 500).
 */
function isTransportFailure(isError: boolean, text: string): boolean {
  if (!isError) {
    try {
      const doc: unknown = JSON.parse(text);
      if (doc && typeof doc === 'object') {
        const code = (doc as { statusCode?: unknown }).statusCode;
        return typeof code === 'number' && code >= 500;
      }
    } catch { /* not JSON: an HTML error page or a client error string */ }
  }
  return TRANSPORT_FAILURE.test(text);
}

interface Write { kind: 'handoff' | 'comment'; recordId: string; body: Record<string, unknown> }

export class HandoffTranscriptTracker {
  private readonly open = new Map<string, Write>();
  /** Per ticket record: the last hand-off status write's outcome. */
  private readonly status = new Map<string, { ok: boolean; patch: Record<string, unknown> }>();
  /** Per ticket record: the last hand-off comment that failed after the status write's turn. */
  private readonly comment = new Map<string, string>();
  private readonly landed = new Set<string>();
  private lastText = '';
  private resultLine = '';

  feed(parsed: unknown): void {
    const line = parsed as { type?: string; message?: { content?: unknown }; result?: unknown };
    if (!line || typeof line !== 'object') return;
    if (line.type === 'result' && typeof line.result === 'string') this.resultLine = line.result;
    const content = line.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as Block[]) {
      if (line.type === 'assistant' && b.type === 'text' && b.text?.trim()) this.lastText = b.text.trim();
      else if (line.type === 'assistant' && b.type === 'tool_use' && b.id) {
        const w = classifyWrite(b.name, b.input);
        const body = b.input?.body;
        if (w?.recordId && (w.kind === 'handoff' || w.kind === 'comment') && body && typeof body === 'object') {
          this.open.set(b.id, { kind: w.kind, recordId: w.recordId, body: body as Record<string, unknown> });
        }
      } else if (line.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const w = this.open.get(b.tool_use_id);
        if (!w) continue;
        this.open.delete(b.tool_use_id);
        const failed = isTransportFailure(b.is_error === true, resultText(b.content));
        if (w.kind === 'handoff') this.status.set(w.recordId, { ok: !failed, patch: w.body });
        else if (failed && typeof w.body.body === 'string') this.comment.set(w.recordId, w.body.body);
        else if (!failed) { this.comment.delete(w.recordId); this.landed.add(w.recordId); }
      }
    }
  }

  /** The hand-off that did not land, or null when every hand-off write succeeded (or none was tried). */
  pending(): PendingHandoffDraft | null {
    const failed = [...this.status].filter(([, s]) => !s.ok).at(-1);
    if (!failed) return null;
    const [ticketRecordId, s] = failed;
    return {
      ticketRecordId, patch: s.patch,
      ...(this.comment.has(ticketRecordId) ? { comment: this.comment.get(ticketRecordId) } : {}),
      ...(this.landed.has(ticketRecordId) ? { commentLanded: true } : {}),
      finalText: this.lastText || this.resultLine,
    };
  }
}
