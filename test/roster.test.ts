import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster, crewLabel, isHold, holdIds, memberByIdentity, rosterMarkdown } from '../src/roster.ts';

const CONFIGURED = [
  { id: 'dev-1', role: 'Dev', kind: 'seat' as const },
  { id: 'qa-1', role: 'QA', kind: 'seat' as const },
  { id: 'op-1', role: 'Operator', kind: 'hold' as const },
  { id: 'pair-1', role: 'live session', kind: 'hold' as const },
  { id: 'sam-1', role: '', kind: 'hold' as const },
];

test('name is primary; role is parenthetical only when the name lacks it', () => {
  const r = buildRoster(CONFIGURED, [
    { id: 'dev-1', name: 'Robin' },
    { id: 'qa-1', name: 'QA agent' },
    { id: 'op-1', name: 'Brad C.' },
    { id: 'pair-1', name: 'Pair agent' },
    { id: 'sam-1', name: 'Sam' },
  ]);
  assert.equal(crewLabel(r.get('dev-1')), 'Robin (Dev)');
  assert.equal(crewLabel(r.get('qa-1')), 'QA agent');          // not "QA agent (QA)"
  assert.equal(crewLabel(r.get('op-1')), 'Brad C. (Operator)');
  assert.equal(crewLabel(r.get('pair-1')), 'Pair agent (live session)');
  assert.equal(crewLabel(r.get('sam-1')), 'Sam');              // hold with no role
});

test('every label shape the jq produced is still produced', () => {
  // Captured from lib/roster.jq before it was deleted. These five rows are the
  // whole of what crewlabel can do: role appended, role withheld because the
  // name already carries it, a person, a session, and a hold with no role.
  const r = buildRoster(CONFIGURED, [
    { id: 'dev-1', name: 'Robin' }, { id: 'qa-1', name: 'QA agent' },
    { id: 'op-1', name: 'Brad C.' }, { id: 'pair-1', name: 'Pair agent' },
    { id: 'sam-1', name: 'Sam' },
  ]);
  assert.deepEqual(
    [...r.values()].map((m) => crewLabel(m)),
    ['Robin (Dev)', 'QA agent', 'Brad C. (Operator)', 'Pair agent (live session)', 'Sam'],
  );
});

test('a missing Name falls back to the role, not to blank', () => {
  const r = buildRoster(CONFIGURED, [{ id: 'dev-1', name: '' }]);
  assert.equal(crewLabel(r.get('dev-1')), 'Dev');
});

test('holds are recognised by id, and unknown ids are not holds', () => {
  const r = buildRoster(CONFIGURED, []);
  assert.ok(isHold(r, 'op-1'));
  assert.ok(isHold(r, 'pair-1'));
  assert.ok(!isHold(r, 'dev-1'));
  assert.ok(!isHold(r, 'someone-else'));
  assert.ok(!isHold(r, null));
  assert.deepEqual(holdIds(r).sort(), ['op-1', 'pair-1', 'sam-1']);
});

test('the roster block names the running seat and marks it', () => {
  const r = buildRoster(CONFIGURED, [{ id: 'dev-1', name: 'Robin' }, { id: 'qa-1', name: 'QA agent' }]);
  const md = rosterMarkdown(r, 'dev-1');
  assert.match(md, /You are \*\*Robin \(Dev\)\*\*/);
  assert.match(md, /\| dev \| Robin \(Dev\)  ← you \| `dev-1` \|/);
  assert.match(md, /Not crew — these are holds/);
});

test('a Crew row linked to an account resolves from that identity id (CREW-1304)', () => {
  const r = buildRoster(CONFIGURED, [
    { id: 'dev-1', name: 'Robin' },
    { id: 'op-1', name: 'Brad C.', user_id: 'ident-brad' },
    { id: 'sam-1', name: 'Sam', user_id: null },
  ]);
  assert.equal(r.get('op-1')?.userId, 'ident-brad');
  assert.equal(r.get('dev-1')?.userId, null);
  assert.equal(memberByIdentity(r, 'ident-brad')?.id, 'op-1');
  assert.equal(memberByIdentity(r, 'ident-nobody'), undefined);
  assert.equal(memberByIdentity(r, null), undefined);
  assert.equal(memberByIdentity(r, undefined), undefined);
});

test('a Crew row with a user_id that is not a configured member still resolves, as a person (CREW-1390)', () => {
  const r = buildRoster(CONFIGURED, [
    { id: 'dev-1', name: 'Robin' },
    { id: 'other-op', name: 'Brad Choate', user_id: 'ident-brad' },
    { id: 'agent-elsewhere', name: 'Dev elsewhere' }, // no user_id: not a person
  ]);
  const m = memberByIdentity(r, 'ident-brad');
  assert.equal(m?.id, 'other-op');
  assert.equal(crewLabel(m), 'Brad Choate (person)');
  assert.ok(!isHold(r, 'other-op'), 'a person on another ship is not a hold here');
  assert.ok(!holdIds(r).includes('other-op'));
  assert.ok(!r.has('agent-elsewhere'));
  assert.ok(!rosterMarkdown(r, 'dev-1').includes('Brad Choate'), 'not listed in the roster block');
});

test('a configured member keeps its classification when its row also carries a user_id', () => {
  const r = buildRoster(CONFIGURED, [{ id: 'op-1', name: 'Brad C.', user_id: 'ident-brad' }]);
  assert.equal(r.get('op-1')?.kind, 'hold');
  assert.equal(memberByIdentity(r, 'ident-brad')?.id, 'op-1');
});
