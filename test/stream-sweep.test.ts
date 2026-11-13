import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planStreamSweep, planSizeCapSweep, applyStreamSweep, type SweepLog } from '../src/stream-sweep.ts';

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

test('size cap removes the oldest artifacts first, keeps the live log and anything under a day old (CREW-3318)', () => {
  const { state, dir } = rig();
  const big = 'x'.repeat(1000);
  for (const [name, days] of [['a.jsonl', 5], ['b.jsonl', 3], ['c.jsonl', 2], ['fresh.jsonl', 0]] as const) {
    writeFileSync(join(dir, name), big);
    age(join(dir, name), days);
  }
  writeFileSync(join(state, 'events.jsonl'), big);
  age(join(state, 'events.jsonl'), 30);
  writeFileSync(join(state, 'events.20260101T000000Z.jsonl'), big);
  age(join(state, 'events.20260101T000000Z.jsonl'), 4);

  assert.deepEqual(planSizeCapSweep(state, 10_000), []);
  // 5 candidates of 1000 bytes; oldest first: a (5d), rotated events (4d), b (3d).
  assert.deepEqual(
    planSizeCapSweep(state, 2500).map((p) => p.replace(state, '')),
    ['/streams/a.jsonl', '/events.20260101T000000Z.jsonl', '/streams/b.jsonl'],
  );
  // A cap nothing can meet stops at the fresh file and never reaches the live log.
  const all = planSizeCapSweep(state, 1);
  assert.equal(all.length, 4);
  assert.ok(!all.some((p) => p.endsWith('fresh.jsonl') || p.endsWith('/events.jsonl')));
});
