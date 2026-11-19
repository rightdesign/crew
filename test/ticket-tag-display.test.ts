import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownRunBanner } from '../src/poll.ts';
import { flagComment, escalateComment, type StrandedVerified } from '../src/stranded-verified.ts';
import { namesOf } from '../src/claim.ts';
import { repoUnservableItem, repoUnservableKey } from '../src/repo-refresh.ts';
import { describeUnplaceable } from '../src/release.ts';
import type { Ticket } from '../src/tracker.ts';

// CREW-3760: what a person reads names a ticket by its tag; keys stay the Issue ID.
const own = (tag: string | null) => ({
  ticket: { id: 'row-1', issue_id: 'ISSUE-3760', issue_tag: tag, description: undefined },
  inFlight: () => false,
});

test('the run banner names a tagged ticket by its tag, and an untagged one by its Issue ID', () => {
  assert.match(ownRunBanner(own('CREW-3760')), /Your ticket for this run: CREW-3760\./);
  assert.doesNotMatch(ownRunBanner(own('CREW-9')), /ISSUE-3760/);
  assert.match(ownRunBanner(own(null)), /Your ticket for this run: ISSUE-3760\./);
});

const stranded = (): StrandedVerified => ({
  candidate: { ticket: { id: 'r', issue_id: 'ISSUE-3760', issue_tag: 'CREW-12' } as Ticket },
  base: 'main', remote: 'origin', priorFlags: 0,
} as unknown as StrandedVerified); // only the fields the comment text reads

test('the stranded flag and escalation comments name the tag and list every searched name', () => {
  const flag = flagComment(stranded());
  assert.match(flag, /`CREW-12` is `verified`/);
  assert.match(flag, /bounded `ISSUE-3760` or `CREW-12` in a commit/);
  assert.match(escalateComment(stranded()), /`CREW-12` was flagged/);
});

test('claim skip messages map ids to tags, falling back to the id', () => {
  const tickets = [{ issue_id: 'ISSUE-5', issue_tag: 'TABL-5' }, { issue_id: 'ISSUE-6', issue_tag: null }];
  assert.equal(namesOf(['ISSUE-5', 'ISSUE-6', 'ISSUE-7'], tickets), 'TABL-5, ISSUE-6, ISSUE-7');
});

test('the repo-unservable attention names the tag but keys on the id', () => {
  const item = repoUnservableItem('r1', 'ISSUE-5', 'repository "x"', undefined, 'TABL-5');
  assert.match(item.message, /^r1: TABL-5 is skipped/);
  assert.equal(item.key, repoUnservableKey('r1', 'ISSUE-5'));
});

test('unplaceable notes name tickets by tag', () => {
  const t = { issue_id: 'ISSUE-8', issue_tag: 'CREW-8', status: 'verified' } as Ticket;
  const notes = describeUnplaceable([{ ticket: t, reason: 'no-repo' }], 'verified');
  assert.match(notes[0]!.message, /CREW-8/);
  assert.doesNotMatch(notes[0]!.message, /ISSUE-8/);
});
