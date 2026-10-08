import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualProjectIds, withinWorkMode } from '../src/work-mode.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';

test('only rows saying manual are manual; missing or null is automatic', () => {
  const ids = manualProjectIds(
    [{ id: 'a', work_mode: 'manual' }, { id: 'b', work_mode: 'automatic' }, { id: 'c', work_mode: null }, { id: 'd' }],
    DEFAULT_CONTRACT,
  );
  assert.deepEqual([...ids], ['a']);
});

test('withinWorkMode keeps own-assigned tickets and tickets with no project', () => {
  const m = new Set(['pm']);
  const ts = [
    { id: '1', project_id: 'pm', assignee_id: null },
    { id: '2', project_id: 'pm', assignee_id: 'me' },
    { id: '3', project_id: 'pa', assignee_id: null },
    { id: '4', project_id: null, assignee_id: null },
  ];
  assert.deepEqual(withinWorkMode(ts, 'me', m).map((t) => t.id), ['2', '3', '4']);
  assert.deepEqual(withinWorkMode(ts, undefined, m).map((t) => t.id), ['3', '4']);
});
