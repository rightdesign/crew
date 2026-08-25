import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  rank, rankScalar, effectivePriority, severityRank, issueNumber, compareRank, agedRankScalar,
} from '../src/priority.ts';

/**
 * Every severity x priority combination, and the rank the jq implementation
 * gave it — captured from lib/priority.jq before that file was deleted.
 *
 * This started as a differential test that shelled out to the jq. Ranking is
 * the one thing in the crew with no natural oracle: the numbers are only
 * "right" because they are the numbers a working queue was already ordered by,
 * so they are pinned here rather than re-derived. Changing one changes what
 * the crew works on next.
 */
const MATRIX = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/priority-matrix.json'), 'utf8'),
) as { tickets: { issue_id: string; severity: string | null; priority: string | null }[]; ranks: number[][] };

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

test('the full severity x priority matrix ranks as it always has', () => {
  assert.equal(MATRIX.tickets.length, 36);   // 6 severities x 6 priorities, junk and null included
  assert.deepEqual(MATRIX.tickets.map((t) => rank(t)), MATRIX.ranks);
});

test('the matrix ordering is total and stable', () => {
  // Ranks are only useful if they order; equal ranks must fall back to the
  // issue number rather than leaving two tickets interchangeable.
  const sorted = [...MATRIX.tickets].sort(compareRank).map((t) => t.issue_id);
  assert.equal(new Set(sorted).size, sorted.length);
  assert.deepEqual([...MATRIX.tickets].sort(compareRank).map((t) => t.issue_id), sorted);
});

// ---------------------------------------------------------------------------
// agedRankScalar (ISSUE-383)
// ---------------------------------------------------------------------------

test('aging: no aging input leaves the rank untouched', () => {
  assert.equal(agedRankScalar(3_000_000_000, undefined, Date.now()), 3_000_000_000);
});

test('aging: no elapsed time is no bonus', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  assert.equal(agedRankScalar(1_000, { since: '2026-08-25T12:00:00.000Z' }, now), 1_000);
});

test('aging: erodes toward 0 as time passes, and never past it', () => {
  const since = '2026-08-25T00:00:00.000Z';
  const rawRank = 2_000;
  const at = (hours: number) => Date.parse(since) + hours * 3_600_000;
  const at0h = agedRankScalar(rawRank, { since }, at(0));
  const at24h = agedRankScalar(rawRank, { since }, at(24));
  const at48h = agedRankScalar(rawRank, { since }, at(48));
  const at1000h = agedRankScalar(rawRank, { since }, at(1_000));
  assert.equal(at0h, rawRank);
  assert.ok(at24h < at0h && at24h > 0);
  assert.equal(at48h, 0);
  assert.equal(at1000h, 0);   // saturating — never negative, never overtakes FIXED_RANK
});

test('aging: weight scales the RATE — double weight erodes in half the time', () => {
  const since = '2026-08-25T00:00:00.000Z';
  const now = Date.parse(since) + 24 * 3_600_000;
  const unweighted = agedRankScalar(2_000, { since }, now);
  const doubled = agedRankScalar(2_000, { since, weight: 2 }, now);
  assert.ok(doubled < unweighted);
  assert.equal(doubled, 0);   // 24h at weight 2 = the same erosion as 48h at weight 1
});

test('aging: a clock behind "since" (skew) is clamped to zero elapsed, not negative', () => {
  const since = '2026-08-25T12:00:00.000Z';
  const now = Date.parse(since) - 3_600_000;
  assert.equal(agedRankScalar(500, { since }, now), 500);
});

