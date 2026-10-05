/**
 * A test gate that stays red on the same head, said out loud on the board
 * (CREW-1368).
 *
 * The release phase squash-merges a verified ticket onto the local base, runs
 * the repo's `test` hook, and pushes only if it passes. When the hook fails,
 * the merge sits on the local base, unshipped, every cycle — and the only
 * trace was a WARN in the crew log. The ticket itself read as merely
 * "verified", so a person re-flipped it, or the stranded sweep misread it,
 * with nothing on the ticket saying the real cause was a red gate.
 *
 * So: after GATE_RED_AFTER consecutive failures on the same head, post one
 * comment on each ticket the head is holding back, quoting the end of the
 * hook's output. Once per head — a new head that fails again earns a new note.
 */

import type { Comment, Ticket } from './tracker.ts';
import type { MergeCandidate } from './release.ts';

export const GATE_RED_MARKER = '<!-- crew:test-gate-red';

/** Consecutive failures on one head before the board is told. */
export const GATE_RED_AFTER = 3;

export interface GateRed {
  sha: string;
  count: number;
  /** The hook's label, e.g. the command line it runs. */
  hook: string;
  /** The last lines of the hook's output. */
  tail: string;
}

export const lastLines = (output: string, n: number): string =>
  output.replace(/\u001b\[[0-9;]*m/g, '').trimEnd().split('\n').slice(-n).join('\n');

/** The tickets a red head is holding back: merged this cycle, or merged on an earlier one. */
export function gateRedTickets(merged: MergeCandidate[], merges: MergeCandidate[]): Ticket[] {
  const seen = new Set<string>();
  const out: Ticket[] = [];
  for (const c of [...merged, ...merges.filter((m) => m.skipReason === 'already-merged')]) {
    if (seen.has(c.ticket.id)) continue;
    seen.add(c.ticket.id);
    out.push(c.ticket);
  }
  return out;
}

export function gateRedComment(g: GateRed): string {
  return `${GATE_RED_MARKER} ${g.sha.slice(0, 8)} -->
**This ticket is merged on the base, but the release test gate is red — nothing has shipped.**

The \`test\` hook (\`${g.hook}\`) has failed ${g.count} cycles running on the same head (\`${g.sha.slice(0, 8)}\`). The ticket's commit is on the base and will ship once the gate passes; it is not stranded, and re-setting it to \`verified\` will not help. Last lines of the hook's output:

\`\`\`
${g.tail}
\`\`\`
`;
}

/** Whether this head's note is already on the ticket (belt and braces to the state file). */
export const alreadyReported = (ticket: Ticket, g: GateRed, comments: Comment[]): boolean =>
  comments.some((c) => c.ticket_id === ticket.id && (c.body ?? '').includes(`${GATE_RED_MARKER} ${g.sha.slice(0, 8)}`));
