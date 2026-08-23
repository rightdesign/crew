import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  rank, rankScalar, effectivePriority, severityRank, issueNumber, compareRank,
} from '../src/priority.ts';

/** Rank the same tickets through lib/priority.jq, the implementation this port replaces. */
function jqRank(tickets: unknown[]): number[][] {
  const out = execFileSync(
    'jq',
    ['-L', 'lib', '-c', 'include "priority"; [ .[] | rank ]'],
    { input: JSON.stringify(tickets), encoding: 'utf8' },
  );
  return JSON.parse(out) as number[][];
}

test('effective priority: explicit can only move a ticket forward (ISSUE-159 vs ISSUE-142)', () => {
  // An S2 marked "P2 Medium" must not fall behind an unmarked S2.
  assert.equal(effectivePriority({ severity: 's2', priority: 'p2' }), 1);
  assert.equal(effectivePriority({ severity: 's2' }), 1);
  // An explicit P0 pulls an S3 forward.
  assert.equal(effectivePriority({ severity: 's3', priority: 'p0' }), 0);
});

test('severity fallback differs by role: 2 as a priority, 4 as a tiebreaker', () => {
  assert.equal(effectivePriority({}), 2);
  assert.equal(severityRank({}), 4);
});

test('issueNumber survives junk ids', () => {
  assert.equal(issueNumber({ issue_id: 'ISSUE-326' }), 326);
  assert.equal(issueNumber({}), 0);
  assert.equal(issueNumber({ issue_id: 'nonsense' }), 0);
});

test('rankScalar orders the same way as the tuple', () => {
  const a = { issue_id: 'ISSUE-2', severity: 's1' };
  const b = { issue_id: 'ISSUE-1', severity: 's3' };
  assert.ok(rankScalar(a) < rankScalar(b));
  assert.ok(compareRank(a, b) < 0);
});

test('matches lib/priority.jq across the full matrix', () => {
  const severities = ['s1', 's2', 's3', 's4', 'weird', null];
  const priorities = ['p0', 'p1', 'p2', 'p3', 'weird', null];
  const tickets = [];
  let n = 1;
  for (const severity of severities) {
    for (const priority of priorities) {
      tickets.push({ issue_id: `ISSUE-${n++}`, severity, priority });
    }
  }
  assert.deepEqual(tickets.map(rank), jqRank(tickets));
});

test('matches lib/priority.jq on the live open queue', () => {
  const raw = process.env.CREW_TEST_TICKETS;
  if (!raw) return; // fixture-free run; the matrix test above still covers the logic
  const tickets = JSON.parse(raw) as { issue_id: string }[];
  assert.deepEqual(tickets.map(rank), jqRank(tickets));
  // and the derived ordering itself agrees, not just the keys
  const mine = [...tickets].sort(compareRank).map((t) => t.issue_id);
  const theirs = JSON.parse(
    execFileSync('jq', ['-L', 'lib', '-c', 'include "priority"; [ sort_by(rank)[] | .issue_id ]'],
      { input: raw, encoding: 'utf8' }),
  ) as string[];
  assert.deepEqual(mine, theirs);
});
