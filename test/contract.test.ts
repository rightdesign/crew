import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTRACT, resolveContract, validateContract, orderFromChoiceOptions,
} from '../src/contract.ts';
import { rank, effectivePriority, severityRank } from '../src/priority.ts';

test('the documented default is internally consistent', () => {
  assert.deepEqual(validateContract(DEFAULT_CONTRACT), []);
});

test('an override is a diff — anything absent keeps the default', () => {
  const c = resolveContract({ priorityOrder: ['urgent', 'normal'] });
  assert.deepEqual(c.priorityOrder, ['urgent', 'normal']);
  assert.equal(c.columns.status, 'status');              // untouched
  assert.equal(c.statuses.approved, 'accepted');         // untouched
  assert.deepEqual(c.severityOrder, DEFAULT_CONTRACT.severityOrder);
});

test('no override at all is the default', () => {
  assert.deepEqual(resolveContract(), DEFAULT_CONTRACT);
  assert.deepEqual(resolveContract(null), DEFAULT_CONTRACT);
});

test('renaming coordinatingValue carries the rename into repoExemptReportTypes (ISSUE-387)', () => {
  const c = resolveContract({ coordinatingValue: 'epic' });
  assert.deepEqual(c.repoExemptReportTypes, ['epic', 'question', 'investigation']);
});

test('an explicit repoExemptReportTypes overrides the derived default', () => {
  const c = resolveContract({ coordinatingValue: 'epic', repoExemptReportTypes: ['epic'] });
  assert.deepEqual(c.repoExemptReportTypes, ['epic']);
});

test('two routes can disagree about everything and both be right', () => {
  const acme = resolveContract({
    statuses: {
      ...DEFAULT_CONTRACT.statuses,
      approved: 'triaged', building: 'doing', handoff: 'built', verifying: 'checking',
      needsHuman: 'waiting', verified: 'done', deployed: 'shipped', wontFix: 'rejected',
      open: ['new', 'triaged', 'blocked', 'doing', 'waiting', 'built', 'checking', 'done'],
      resolved: ['done', 'shipped', 'rejected'],
    },
    priorityOrder: ['urgent', 'high', 'normal', 'low'],
  });
  assert.deepEqual(validateContract(acme), []);
  // the same ticket ranks differently under each workspace's rules
  const t = { issue_id: 'ISSUE-1', priority: 'urgent', severity: null };
  assert.equal(effectivePriority(t, acme), 0);
  assert.equal(effectivePriority(t, DEFAULT_CONTRACT), 2); // "urgent" is meaningless here
});

test('calling the handoff status resolved is refused, with the reason', () => {
  const bad = resolveContract({
    statuses: { ...DEFAULT_CONTRACT.statuses, resolved: ['verified', 'fixed', 'closed_deployed'] },
  });
  const problems = validateContract(bad);
  assert.ok(problems.some((p) => /handoff .* is listed as resolved/.test(p)));
  assert.ok(problems.some((p) => /build on unverified work/.test(p)));
});

test('every problem is reported at once, not one run at a time', () => {
  const bad = resolveContract({
    statuses: { ...DEFAULT_CONTRACT.statuses, approved: 'nope', building: 'also-nope' },
    priorityOrder: ['a', 'a'],
  });
  const problems = validateContract(bad);
  assert.ok(problems.length >= 3, `expected several, got ${problems.length}`);
  assert.ok(problems.some((p) => /approved \("nope"\) is not listed in statuses\.open/.test(p)));
  assert.ok(problems.some((p) => /building \("also-nope"\)/.test(p)));
  assert.ok(problems.some((p) => /priorityOrder contains duplicates/.test(p)));
});

test('parking into the approved status would be a no-op, and is refused', () => {
  const bad = resolveContract({
    statuses: { ...DEFAULT_CONTRACT.statuses, parked: 'accepted' },
  });
  assert.ok(validateContract(bad).some((p) => /parked and statuses\.approved are the same/.test(p)));
});

test('order comes from the CHOICE field\'s own positions', () => {
  assert.deepEqual(
    orderFromChoiceOptions([{ value: 'p2', position: 2 }, { value: 'p0', position: 0 }, { value: 'p1', position: 1 }]),
    ['p0', 'p1', 'p2'],
  );
  // a missing position sorts first rather than throwing
  assert.deepEqual(orderFromChoiceOptions([{ value: 'b', position: 1 }, { value: 'a' }]), ['a', 'b']);
});

test('an unknown value still ranks mid-pack as a priority and last as a tiebreaker', () => {
  const t = { issue_id: 'ISSUE-1', severity: 'unheard-of', priority: null };
  assert.equal(effectivePriority(t, DEFAULT_CONTRACT), 2);
  assert.equal(severityRank(t, DEFAULT_CONTRACT), 4);
  // and the asymmetry follows the contract's own lengths, not a magic number
  const short = resolveContract({ severityOrder: ['a', 'b'], unknownPriorityRank: 1 });
  assert.equal(effectivePriority(t, short), 1);
  assert.equal(severityRank(t, short), 2);
});

test('ranking under the default is unchanged by all of this', () => {
  const t = { issue_id: 'ISSUE-42', severity: 's2', priority: 'p1' };
  // 3rd element is the ISSUE-385 epic-in-progress tiebreaker; 1 (no epic).
  assert.deepEqual(rank(t), [1, 1, 1, 42]);
  assert.deepEqual(rank(t, DEFAULT_CONTRACT), [1, 1, 1, 42]);
});

test('a workspace with no review step says so, rather than inventing a status', () => {
  assert.equal(DEFAULT_CONTRACT.statuses.reviewing, null);
  assert.deepEqual(validateContract(DEFAULT_CONTRACT), []);
});

test('a workspace that adopts review must actually have the status', () => {
  const missing = resolveContract({ statuses: { ...DEFAULT_CONTRACT.statuses, reviewing: 'in_review' } });
  assert.ok(validateContract(missing).some((p) => /reviewing \("in_review"\) is not listed in statuses\.open/.test(p)));

  const proper = resolveContract({
    statuses: {
      ...DEFAULT_CONTRACT.statuses,
      reviewing: 'in_review',
      open: [...DEFAULT_CONTRACT.statuses.open, 'in_review'],
    },
  });
  assert.deepEqual(validateContract(proper), []);
});

test('a review state counted as resolved is refused — it is unmerged work', () => {
  const bad = resolveContract({
    statuses: {
      ...DEFAULT_CONTRACT.statuses,
      reviewing: 'in_review',
      open: [...DEFAULT_CONTRACT.statuses.open, 'in_review'],
      resolved: [...DEFAULT_CONTRACT.statuses.resolved, 'in_review'],
    },
  });
  assert.ok(validateContract(bad).some((p) => /reviewing .* listed as resolved/.test(p)));
});

test('a closed-without-merging PR has somewhere to go', () => {
  assert.equal(DEFAULT_CONTRACT.statuses.wontFix, 'closed_wont_fix');
  assert.ok(DEFAULT_CONTRACT.statuses.resolved.includes(DEFAULT_CONTRACT.statuses.wontFix));
  const bad = resolveContract({ statuses: { ...DEFAULT_CONTRACT.statuses, wontFix: 'nowhere' } });
  assert.ok(validateContract(bad).some((p) => /wontFix \("nowhere"\) is not listed in statuses\.resolved/.test(p)));
});
