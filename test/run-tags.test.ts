import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunTags, type TagSource } from '../src/run-tags.ts';
import type { Ticket } from '../src/tracker.ts';

const board = (prefix: string, number: number, id: string): TagSource => {
  const t = { id, issue_id: `ISSUE-${number}`, issue_tag: `${prefix}-${number}` } as Ticket;
  return {
    ticketsByIds: async (ids) => (ids.includes(id) ? [t] : []),
    ticketsByKeys: async (keys) => (keys.includes(t.issue_id) ? [t] : []),
  };
};

test('the same issue number on two routes keeps each route\'s own prefix', async () => {
  const sources: Record<string, TagSource> = { tablation: board('TABL', 157, 'a'), fincalc: board('FINC', 157, 'b') };
  const tagOf = await resolveRunTags(
    [{ route: 'tablation', ticket: 'ISSUE-157', ticketRecordId: 'a' }, { route: 'fincalc', ticket: 'ISSUE-157', ticketRecordId: 'b' }],
    (r) => sources[r],
  );
  assert.equal(tagOf('tablation', 'ISSUE-157'), 'TABL-157');
  assert.equal(tagOf('fincalc', 'ISSUE-157'), 'FINC-157');
});

test('an unresolvable route or unreachable tracker shows the raw key, never another route\'s tag', async () => {
  const failing: TagSource = { ticketsByIds: async () => { throw new Error('down'); }, ticketsByKeys: async () => { throw new Error('down'); } };
  const tagOf = await resolveRunTags(
    [{ route: 'tablation', ticket: 'ISSUE-157' }, { route: 'gone', ticket: 'ISSUE-157' }, { route: 'down', ticket: 'ISSUE-157' }],
    (r) => (r === 'tablation' ? board('TABL', 157, 'a') : r === 'down' ? failing : undefined),
  );
  assert.equal(tagOf('gone', 'ISSUE-157'), 'ISSUE-157');
  assert.equal(tagOf('down', 'ISSUE-157'), 'ISSUE-157');
  assert.equal(tagOf(undefined, 'ISSUE-157'), 'ISSUE-157');
  assert.equal(tagOf('gone', null), null);
});
