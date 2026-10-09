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
