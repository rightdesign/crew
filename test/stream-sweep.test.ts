import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planStreamSweep, applyStreamSweep, type SweepLog } from '../src/stream-sweep.ts';

const silentLog: SweepLog = { emit: () => {}, warn: () => {} };
const DAY = 24 * 60 * 60 * 1000;

function rig() {
  const state = mkdtempSync(join(tmpdir(), 'crew-streams-'));
  const dir = join(state, 'streams');
  mkdirSync(dir, { recursive: true });
  return { state, dir };
}

function age(path: string, daysAgo: number) {
  const t = (Date.now() - daysAgo * DAY) / 1000;
  utimesSync(path, t, t);
}

test('no streams directory at all is not an error — just nothing to sweep', () => {
  const state = mkdtempSync(join(tmpdir(), 'crew-streams-'));
  assert.deepEqual(planStreamSweep(state, 7), []);
});

test('an artifact older than the retention window is swept; a fresh one is kept', () => {
  const { state, dir } = rig();
  writeFileSync(join(dir, 'proj-dev-old.jsonl'), '{}\n', { flag: 'w' });
  writeFileSync(join(dir, 'proj-dev-new.jsonl'), '{}\n', { flag: 'w' });
  age(join(dir, 'proj-dev-old.jsonl'), 10);
  age(join(dir, 'proj-dev-new.jsonl'), 1);

  const plan = planStreamSweep(state, 7);
  assert.deepEqual(plan, [join(dir, 'proj-dev-old.jsonl')]);

  const removed = applyStreamSweep(plan, false, silentLog);
  assert.equal(removed, 1);
  assert.ok(!existsSync(join(dir, 'proj-dev-old.jsonl')));
  assert.ok(existsSync(join(dir, 'proj-dev-new.jsonl')));
});

test('a dry run reports what it would remove and touches nothing', () => {
  const { state, dir } = rig();
  writeFileSync(join(dir, 'proj-dev-old.jsonl'), '{}\n', { flag: 'w' });
  age(join(dir, 'proj-dev-old.jsonl'), 30);

  const plan = planStreamSweep(state, 7);
  const removed = applyStreamSweep(plan, true, silentLog);
  assert.equal(removed, 0);
  assert.ok(existsSync(join(dir, 'proj-dev-old.jsonl')));
});
