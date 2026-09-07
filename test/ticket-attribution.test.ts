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
