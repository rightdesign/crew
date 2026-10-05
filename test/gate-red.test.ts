import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateRedTickets, gateRedComment, alreadyReported, lastLines, GATE_RED_AFTER } from '../src/gate-red.ts';
import type { MergeCandidate } from '../src/release.ts';
import type { Ticket, Comment } from '../src/tracker.ts';

const cand = (id: string, over: Partial<MergeCandidate> = {}): MergeCandidate =>
  ({ ticket: { id, issue_id: id } as Ticket, branch: null, entries: [], usedFallback: false, bump: 'patch', majorRequested: false, ...over });
const g = { sha: 'abcdef1234567', count: GATE_RED_AFTER, hook: 'pnpm -r typecheck', tail: 'error TS2353' };

test('gate-red tickets: merged this cycle plus already-merged, deduped; never-built excluded', () => {
  const t = gateRedTickets(
    [cand('A')],
    [cand('A', { skipReason: 'already-merged' }), cand('B', { skipReason: 'already-merged' }), cand('C', { skipReason: 'never-built' })],
  );
  assert.deepEqual(t.map((x) => x.id), ['A', 'B']);
});

test('gate-red comment names the hook, head and output, and is recognised on repeat', () => {
  const body = gateRedComment(g);
  assert.match(body, /pnpm -r typecheck/);
  assert.match(body, /abcdef12/);
  assert.match(body, /error TS2353/);
  const c = { ticket_id: 'A', body } as Comment;
  assert.equal(alreadyReported({ id: 'A' } as Ticket, g, [c]), true);
  assert.equal(alreadyReported({ id: 'B' } as Ticket, g, [c]), false);
  assert.equal(alreadyReported({ id: 'A' } as Ticket, { ...g, sha: 'ffffffff0000' }, [c]), false);
});

test('lastLines strips colour and keeps the tail', () => {
  assert.equal(lastLines('a\n\u001b[31mb\u001b[0m\nc\n', 2), 'b\nc');
});
