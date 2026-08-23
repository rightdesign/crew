import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildRoster, crewLabel, isHold, holdIds, rosterMarkdown } from '../src/roster.ts';

const CONFIGURED = [
  { id: 'dev-1', role: 'Dev', kind: 'seat' as const },
  { id: 'qa-1', role: 'QA', kind: 'seat' as const },
  { id: 'op-1', role: 'Operator', kind: 'hold' as const },
  { id: 'pair-1', role: 'live session', kind: 'hold' as const },
  { id: 'sam-1', role: '', kind: 'hold' as const },
];

test('name is primary; role is parenthetical only when the name lacks it', () => {
  const r = buildRoster(CONFIGURED, [
    { id: 'dev-1', name: 'Trevor' },
    { id: 'qa-1', name: 'QA agent' },
    { id: 'op-1', name: 'Brad C.' },
    { id: 'pair-1', name: 'Pair agent' },
    { id: 'sam-1', name: 'Sam' },
  ]);
  assert.equal(crewLabel(r.get('dev-1')), 'Trevor (Dev)');
  assert.equal(crewLabel(r.get('qa-1')), 'QA agent');          // not "QA agent (QA)"
  assert.equal(crewLabel(r.get('op-1')), 'Brad C. (Operator)');
  assert.equal(crewLabel(r.get('pair-1')), 'Pair agent (live session)');
  assert.equal(crewLabel(r.get('sam-1')), 'Sam');              // hold with no role
});

test('agrees with lib/roster.jq', () => {
  const rows = [
    { id: 'dev-1', name: 'Trevor' }, { id: 'qa-1', name: 'QA agent' },
    { id: 'op-1', name: 'Brad C.' }, { id: 'pair-1', name: 'Pair agent' },
    { id: 'sam-1', name: 'Sam' },
  ];
  const r = buildRoster(CONFIGURED, rows);
  const asJq = Object.fromEntries(
    [...r.values()].map((m) => [m.id, { name: m.name, role: m.role, kind: m.kind === 'hold' ? 'hold' : 'agent' }]),
  );
  const theirs = JSON.parse(execFileSync('jq',
    ['-L', 'lib', '-c', 'include "roster"; . as $r | [ to_entries[] | crewlabel($r; .key) ]'],
    { input: JSON.stringify(asJq), encoding: 'utf8' })) as string[];
  assert.deepEqual([...r.values()].map((m) => crewLabel(m)), theirs);
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
  const r = buildRoster(CONFIGURED, [{ id: 'dev-1', name: 'Trevor' }, { id: 'qa-1', name: 'QA agent' }]);
  const md = rosterMarkdown(r, 'dev-1');
  assert.match(md, /You are \*\*Trevor \(Dev\)\*\*/);
  assert.match(md, /\| dev \| Trevor \(Dev\)  ← you \| `dev-1` \|/);
  assert.match(md, /Not crew — these are holds/);
});
