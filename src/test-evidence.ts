/**
 * The evidence a failed test gate puts in its alert (CREW-2210).
 *
 * A bare "tests failed" sent a lane to reproduce on the base alone, when the
 * gate had run on the base plus every verified branch. So the alert carries
 * what failed (test names, then the first error) and the composition it ran
 * on (base, candidate head, merged branches), and states that reproduction
 * must use that composition.
 */

import { lastLines } from './gate-red.ts';

const MAX_FAIL_LINES = 20;
const ANSI = /\u001b\[[0-9;]*m/g;

// vitest `FAIL …`, jest `● …`, node:test `not ok …`.
const FAIL_LINE = /^\s*(FAIL\b|●\s|not ok\b)/;
const ERROR_LINE = /\b(?:[A-Z]\w*)?Error\b[:\s]/;

/**
 * Lines that identify the failure, preferred over a raw tail: the failing
 * test lines (deduplicated, capped) and the first error with its next lines.
 * Falls back to the last `tailLines` lines when the output has neither.
 */
export function failureSummary(output: string, tailLines = 15): string {
  const lines = output.replace(ANSI, '').trimEnd().split('\n');
  const names: string[] = [];
  for (const l of lines) {
    if (FAIL_LINE.test(l) && !names.includes(l.trim())) names.push(l.trim());
    if (names.length >= MAX_FAIL_LINES) break;
  }
  const at = lines.findIndex((l) => ERROR_LINE.test(l));
  if (names.length === 0 && at < 0) return lastLines(output, tailLines);
  const parts = [...names];
  if (at >= 0) parts.push('', ...lines.slice(at, at + 4).map((l) => l.trimEnd()));
  return parts.join('\n').trim();
}

export interface GateComposition {
  /** The checkout's head the gate ran on. */
  head: string;
  /** The base before this cycle's merges. */
  base: string;
  /** The branches merged for this cycle, with the ticket key each carries. */
  branches: { key: string; branch: string; tip: string }[];
}

/** The fixed line `describeComposition` leads with; recurrence matches on it. */
export const headLine = (head: string): string => `Candidate head \`${head.slice(0, 8)}\`.`;

export function describeComposition(c: GateComposition): string {
  const rows = c.branches.length
    ? c.branches.map((b) => `- ${b.key} \`${b.branch}\` @ \`${b.tip.slice(0, 8)}\``).join('\n')
    : '- (none merged this cycle)';
  return `${headLine(c.head)} Base before merging \`${c.base.slice(0, 8)}\`. Merged branches:\n\n${rows}\n\n` +
    'The gate runs on the base plus every verified branch above, not on the base alone: ' +
    'reproduce on that composition. A fix that compiles only on the composition belongs on one of ' +
    'those branches (the one owning the failing file, after merging the others into it), not on a ' +
    'new branch cut from the base: a separate fix branch conflicts with the branches it contains ' +
    'when the release squash-merges them all. Re-queue the touched ticket to QA and close this ' +
    'alert with a note.';
}
