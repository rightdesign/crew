import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { countsAsAssisted, markCrewAssisted, markCrewAssistedAtLaunch } from '../src/crew-assisted.ts';
import type { Ticket } from '../src/tracker.ts';

const COL = DEFAULT_CONTRACT.columns.crewAssisted;
const T = (o: Partial<Ticket> = {}): Ticket => ({ id: 't1', issue_id: 'CREW-1', status: 'in_progress', ...o }) as Ticket;

function fake(hasColumn: boolean, row: Ticket = T()) {
  const writes: Array<Record<string, unknown>> = [];
  let probes = 0;
  let reads = 0;
  return {
    writes, get probes() { return probes; }, get reads() { return reads; },
    tracker: {
      contract: DEFAULT_CONTRACT,
      async hasCrewAssistedColumn() { probes++; return hasColumn; },
      async updateTicket(_id: string, patch: Record<string, unknown>) { writes.push(patch); return {}; },
      async ticket() { reads++; return row; },
    },
  };
}

test('dev and qa count by default; triage, design and pair do not', () => {
  for (const r of ['dev', 'qa'] as const) assert.equal(countsAsAssisted({}, r), true);
  for (const r of ['triage', 'design', 'pair'] as const) assert.equal(countsAsAssisted({}, r), false);
});

test('assistedRoles narrows or switches the marking off', () => {
  assert.equal(countsAsAssisted({ assistedRoles: ['dev'] }, 'dev'), true);
  assert.equal(countsAsAssisted({ assistedRoles: ['dev'] }, 'qa'), false);
  assert.equal(countsAsAssisted({ assistedRoles: [] }, 'dev'), false);
});

test('a dev run marks the ticket with one update', async () => {
  const f = fake(true);
  assert.equal(await markCrewAssisted(f.tracker, {}, 'dev', T()), true);
  assert.deepEqual(f.writes, [{ [COL]: true }]);
});

test('a triage run writes nothing and does not even probe', async () => {
  const f = fake(true);
  assert.equal(await markCrewAssisted(f.tracker, {}, 'triage', T()), false);
  assert.deepEqual(f.writes, []);
  assert.equal(f.probes, 0);
});

test('a workspace without the column gets no write', async () => {
  const f = fake(false);
  assert.equal(await markCrewAssisted(f.tracker, {}, 'dev', T()), false);
  assert.deepEqual(f.writes, []);
});

test('an already-true ticket costs no write and no probe', async () => {
  const f = fake(true);
  assert.equal(await markCrewAssisted(f.tracker, {}, 'qa', T({ [COL]: true })), false);
  assert.deepEqual(f.writes, []);
  assert.equal(f.probes, 0);
});

test('assistedRoles: [] leaves the column untouched', async () => {
  const f = fake(true);
  assert.equal(await markCrewAssisted(f.tracker, { assistedRoles: [] }, 'dev', T()), false);
  assert.deepEqual(f.writes, []);
});

test('at launch: reads the row only for a counting role, and reuses a row already read', async () => {
  const warns: string[] = [];
  const skipped = fake(true);
  await markCrewAssistedAtLaunch(skipped.tracker, {}, 'design', 't1', undefined, (m) => warns.push(m));
  assert.equal(skipped.reads, 0);
  const read = fake(true);
  await markCrewAssistedAtLaunch(read.tracker, {}, 'dev', 't1', undefined, (m) => warns.push(m));
  assert.equal(read.reads, 1);
  assert.deepEqual(read.writes, [{ [COL]: true }]);
  const reused = fake(true);
  await markCrewAssistedAtLaunch(reused.tracker, {}, 'dev', 't1', T(), (m) => warns.push(m));
  assert.equal(reused.reads, 0);
  assert.deepEqual(warns, []);
});

test('a run with no ticket (refused before a claim) writes nothing', async () => {
  const f = fake(true);
  await markCrewAssistedAtLaunch(f.tracker, {}, 'dev', null, undefined, () => {});
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads, 0);
});

test('a failed write warns and does not throw', async () => {
  const f = fake(true);
  f.tracker.updateTicket = async () => { throw new Error('boom'); };
  const warns: string[] = [];
  await markCrewAssistedAtLaunch(f.tracker, {}, 'dev', 't1', T(), (m) => warns.push(m));
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /boom/);
});
