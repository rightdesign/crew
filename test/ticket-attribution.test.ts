import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketMentions, TicketAttributionTracker } from '../src/ticket-attribution.ts';

test('ticketMentions finds every ticket-key-shaped token, in order', () => {
  assert.deepEqual(ticketMentions('picking up ISSUE-621 instead of CREW-12'), ['ISSUE-621', 'CREW-12']);
  assert.deepEqual(ticketMentions('nothing here'), []);
});

test('tokens spent on turns naming no ticket credit whichever ticket was last named', () => {
  const t = new TicketAttributionTracker();
  t.add("I'll pick up ISSUE-621, the fixed ticket awaiting verification.", 100);
  t.add('let me fetch the full record and comments', 500);
  t.add('looks good, moving to verified', 50);
  assert.equal(t.winner(), 'ISSUE-621');
});

test('the winner is the ticket with the most attributed tokens, not the first or last mentioned', () => {
  const t = new TicketAttributionTracker();
  t.add('starting on ISSUE-100', 10);
  t.add('actually ISSUE-200 needs the bigger fix', 9000);
  t.add('back to ISSUE-100 to wrap up', 20);
  assert.equal(t.winner(), 'ISSUE-200');
});

test('a transcript that never names a ticket falls back to the pre-run hint', () => {
  const t = new TicketAttributionTracker();
  t.add('reading the repo to get oriented', 5000);
  assert.equal(t.winner('ISSUE-430'), 'ISSUE-430');
  assert.equal(t.winner(), undefined);
});

test('a zero-token or negative-token turn still updates "current" for later turns, but is not credited itself', () => {
  const t = new TicketAttributionTracker();
  t.add('mentions ISSUE-9 with no usage yet', 0);
  t.add('still on it', 42);
  assert.equal(t.winner(), 'ISSUE-9');
});

const upd = (recordId: string, status: string) => ({ tool: 'mcp__tablation__records_controller_update', input: { recordId, body: { status } } });
const cmt = (ticket_id: string) => ({ tool: 'mcp__tablation__records_controller_create', input: { body: { ticket_id, body: 'x' } } });

test('a run that mentions B most but claims and hands off A is attributed to A by handoff', () => {
  const t = new TicketAttributionTracker();
  t.add('claiming ISSUE-2278', 100);
  t.noteWrite(upd('uuid-a', 'in_progress').tool, upd('uuid-a', 'in_progress').input);
  t.add('reading TABL-2361, the migration split, in depth', 9000);
  t.note('handing off ISSUE-2278');
  t.noteWrite(upd('uuid-a', 'fixed').tool, upd('uuid-a', 'fixed').input);
  assert.deepEqual(t.decide('ISSUE-1'), { ticket: 'ISSUE-2278', by: 'handoff' });
});

test('a hand-off resolves via the recorded uuid even if another ticket was named last', () => {
  const t = new TicketAttributionTracker();
  t.note('claiming ISSUE-2360');
  t.noteWrite(upd('uuid-a', 'in_progress').tool, upd('uuid-a', 'in_progress').input);
  t.note('the design lives in TABL-2342');
  t.noteWrite(upd('uuid-a', 'fixed').tool, upd('uuid-a', 'fixed').input);
  assert.deepEqual(t.decide(), { ticket: 'ISSUE-2360', by: 'handoff' });
});

test('claim beats a comment on a follow-up; a comment on a known ticket attributes to it', () => {
  const t = new TicketAttributionTracker();
  t.note('claiming ISSUE-2278');
  t.noteWrite(upd('uuid-a', 'in_progress').tool, upd('uuid-a', 'in_progress').input);
  t.noteWrite(cmt('uuid-a').tool, cmt('uuid-a').input);
  t.noteWrite(cmt('uuid-unknown').tool, cmt('uuid-unknown').input);
  assert.deepEqual(t.decide(), { ticket: 'ISSUE-2278', by: 'claim' });
  const c = new TicketAttributionTracker();
  c.note('on ISSUE-5');
  c.noteWrite(upd('uuid-b', 'needs_info').tool, upd('uuid-b', 'needs_info').input);
  assert.equal(c.decide().ticket, 'ISSUE-5');
});

test('no writes falls back to mentions, then to the hint', () => {
  const t = new TicketAttributionTracker();
  t.add('looking at ISSUE-7', 50);
  assert.deepEqual(t.decide('ISSUE-1'), { ticket: 'ISSUE-7', by: 'mentions' });
  assert.deepEqual(new TicketAttributionTracker().decide('ISSUE-1'), { ticket: 'ISSUE-1', by: 'hint' });
});
