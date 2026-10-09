import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAssigneeIds, isAutomatic, projectWorkModes, withinWorkMode, type WorkModes } from '../src/work-mode.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';

test('work_mode maps to manual/hybrid/automatic; missing or null is automatic', () => {
  const modes = projectWorkModes(
    [
      { id: 'a', work_mode: 'manual' }, { id: 'b', work_mode: 'automatic' }, { id: 'c', work_mode: null },
      { id: 'd' }, { id: 'e', work_mode: 'hybrid' },
    ],
    DEFAULT_CONTRACT,
  );
  assert.deepEqual([...modes], [['a', 'manual'], ['b', 'automatic'], ['c', 'automatic'], ['d', 'automatic'], ['e', 'hybrid']]);
});

test('agentAssigneeIds needs an agent_id and excludes hold rows', () => {
  const ids = agentAssigneeIds(
    [{ id: 'dev', agent_id: 'x' }, { id: 'hold', agent_id: 'y' }, { id: 'person' }, { id: 'p2', agent_id: null }],
    (id) => id === 'hold',
  );
  assert.deepEqual([...ids], ['dev']);
});

const wm: WorkModes = {
  modes: new Map([['pa', 'automatic'], ['pm', 'manual'], ['ph', 'hybrid']] as const),
  agentAssignees: new Set(['otherShipDev', 'qa']),
};
const ts = [
  { id: 'auto', project_id: 'pa', assignee_id: null },
  { id: 'manualMine', project_id: 'pm', assignee_id: 'me' },
  { id: 'manualAgent', project_id: 'pm', assignee_id: 'qa' },
  { id: 'hybridNone', project_id: 'ph', assignee_id: null },
  { id: 'hybridHold', project_id: 'ph', assignee_id: 'brad' },
  { id: 'hybridAgent', project_id: 'ph', assignee_id: 'otherShipDev' },
  { id: 'noProject', project_id: null, assignee_id: 'qa' },
  { id: 'unknownProject', project_id: 'gone', assignee_id: null },
];

test('withinWorkMode: automatic kept, manual and project-less dropped, hybrid only when agent-assigned', () => {
  assert.deepEqual(withinWorkMode(ts, wm).map((t) => t.id), ['auto', 'hybridAgent', 'unknownProject']);
});

test('withinWorkMode filters nothing without a mode map', () => {
  assert.equal(withinWorkMode(ts, undefined).length, ts.length);
  assert.equal(withinWorkMode(ts, { modes: new Map(), agentAssignees: new Set() }).length, ts.length);
});

test('isAutomatic is true only for automatic projects', () => {
  assert.equal(isAutomatic({ project_id: 'pa' }, wm), true);
  assert.equal(isAutomatic({ project_id: 'ph' }, wm), false);
  assert.equal(isAutomatic({ project_id: null }, wm), false);
  assert.equal(isAutomatic({ project_id: null }, undefined), true);
});

// CREW-1496: sweeps, release phase and status honour work mode.
import { planSweep, computeBlockedIds, blockerInfoMap } from '../src/blocked.ts';
import { planStalled, STALLED_AFTER_MS } from '../src/stalled.ts';
import { skippedByMode, withoutManualVerified, projectModeLabels } from '../src/work-mode.ts';
import type { Ticket } from '../src/tracker.ts';

const sweepWm: WorkModes = {
  modes: new Map([['pa', 'automatic'], ['pm', 'manual'], ['ph', 'hybrid']] as const),
  agentAssignees: new Set(['dev']),
};
const tk = (id: string, o: Partial<Ticket>): Ticket =>
  ({ id, issue_id: id, status: 'accepted', updated_at: '2026-10-09T00:00:00Z', blocked_by: ['x'], ...o }) as Ticket;

test('blocked sweep: manual and project-less never parked or restored; hybrid only when agent-assigned', () => {
  const blocker = tk('x', { status: 'accepted', blocked_by: [] });
  const tickets = [
    blocker,
    tk('auto', { project_id: 'pa' }),
    tk('manual', { project_id: 'pm' }),
    tk('manualBlockedStale', { project_id: 'pm', status: 'blocked', blocked_by: [] }),
    tk('none', { project_id: null }),
    tk('hybridUnassigned', { project_id: 'ph' }),
    tk('hybridAgent', { project_id: 'ph', assignee_id: 'dev' }),
  ];
  const info = blockerInfoMap(tickets);
  const steps = planSweep(tickets, info, computeBlockedIds(tickets, info), sweepWm);
  assert.deepEqual(steps.map((s) => s.ticket.id).sort(), ['auto', 'hybridAgent']);
  // no work modes: unchanged behaviour
  assert.equal(planSweep(tickets, info, computeBlockedIds(tickets, info)).length, 6);
});

test('stalled sweep skips manual and unassigned hybrid tickets', () => {
  const old = new Date(Date.now() - STALLED_AFTER_MS - 60_000).toISOString();
  const mk = (id: string, o: Partial<Ticket>) => tk(id, { status: 'in_progress', updated_at: old, blocked_by: [], ...o });
  const out = planStalled(
    [mk('a', { project_id: 'pa' }), mk('m', { project_id: 'pm' }), mk('h', { project_id: 'ph' }), mk('ha', { project_id: 'ph', assignee_id: 'dev' })],
    [], [], DEFAULT_CONTRACT, new Set(), Date.now(), sweepWm,
  );
  assert.deepEqual(out.map((s) => s.ticket.id).sort(), ['a', 'ha']);
});

test('skippedByMode counts what the sweeps leave alone', () => {
  const ts = [
    tk('a', { project_id: 'pa' }), tk('m', { project_id: 'pm' }), tk('n', { project_id: null }),
    tk('h', { project_id: 'ph' }), tk('ha', { project_id: 'ph', assignee_id: 'dev' }),
  ];
  assert.deepEqual(skippedByMode(ts, sweepWm), { manual: 2, hybrid: 1 });
  assert.deepEqual(skippedByMode(ts, undefined), { manual: 0, hybrid: 0 });
});

test('withoutManualVerified drops only verified manual/project-less; hybrid verified releases like automatic', () => {
  const ts = [
    tk('av', { project_id: 'pa', status: 'verified' }),
    tk('mv', { project_id: 'pm', status: 'verified' }),
    tk('nv', { project_id: null, status: 'verified' }),
    tk('hv', { project_id: 'ph', status: 'verified' }),
    tk('mf', { project_id: 'pm', status: 'fixed' }),
  ];
  assert.deepEqual(withoutManualVerified(ts, 'verified', sweepWm).map((t) => t.id), ['av', 'hv', 'mf']);
  assert.equal(withoutManualVerified(ts, 'verified', undefined).length, 5);
});

test('projectModeLabels renders Name (mode)', () => {
  assert.deepEqual(
    projectModeLabels([{ id: '1', name: 'Crew', mode: 'automatic' }, { id: '2', mode: 'hybrid' }]).map((p) => p.label),
    ['Crew (automatic)', '2 (hybrid)'],
  );
});
