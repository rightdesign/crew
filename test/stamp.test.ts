import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planStamp, applyStamp, applyExternalClosures } from '../src/stamp.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { Ticket } from '../src/tracker.ts';
import type { ClosureCheck } from '../src/git.ts';

const T = (issue_id: string, status = 'verified'): Ticket =>
  ({ id: issue_id, issue_id, status, updated_at: '2026-08-23T00:00:00Z' }) as Ticket;

function repoWith(subjects: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-stamp-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'a'), '0'); g('add', '.'); g('commit', '-qm', 'base');
  const from = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  subjects.forEach((s, i) => {
    writeFileSync(join(dir, `f${i}`), 'x'); g('add', '.'); g('commit', '-qm', s);
  });
  const to = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, from, to };
}

const emitter = (lines: string[]) => new Emitter({ route: 'c', console: (l) => lines.push(l), cycleId: 'C' });

test('only tickets named in the released range are stamped', () => {
  const { dir, from, to } = repoWith(['did a thing (ISSUE-1)', 'and another (ISSUE-2)']);
  const plan = planStamp(dir, [T('ISSUE-1'), T('ISSUE-2'), T('ISSUE-3')], DEFAULT_CONTRACT, from, to);
  assert.deepEqual(plan.map((p) => p.ticket.issue_id), ['ISSUE-1', 'ISSUE-2']);
});

test('a ticket merged on an earlier cycle is still carried by THIS release', () => {
  // Its deploy failed last time; it must not sit at verified with live work.
  const { dir, from, to } = repoWith(['shipped earlier (ISSUE-9)', 'this cycle (ISSUE-10)']);
  const plan = planStamp(dir, [T('ISSUE-9'), T('ISSUE-10')], DEFAULT_CONTRACT, from, to);
  assert.equal(plan.length, 2);
});

test('only verified tickets are candidates', () => {
  const { dir, from, to } = repoWith(['work (ISSUE-1)']);
  const plan = planStamp(dir, [T('ISSUE-1', 'in_progress')], DEFAULT_CONTRACT, from, to);
  assert.deepEqual(plan, []);
});

test('a substring key is not stamped by another ticket\'s commit', () => {
  const { dir, from, to } = repoWith(['work (ISSUE-1234)']);
  const plan = planStamp(dir, [T('ISSUE-123')], DEFAULT_CONTRACT, from, to);
  assert.deepEqual(plan, []);
});

test('an unseeded repo stamps nothing rather than everything', () => {
  const { dir, to } = repoWith(['work (ISSUE-1)']);
  assert.deepEqual(planStamp(dir, [T('ISSUE-1')], DEFAULT_CONTRACT, null, to), []);
});

test('a tracker failure on one ticket does not abandon the rest, or fail the release', async () => {
  const lines: string[] = [];
  const calls: string[] = [];
  const tracker = {
    updateTicket: async (id: string) => {
      calls.push(id);
      if (id === 'ISSUE-2') throw new Error('503 from the tracker');
      return {} as Ticket;
    },
  } as unknown as Parameters<typeof applyStamp>[0];
  const plan = [T('ISSUE-1'), T('ISSUE-2'), T('ISSUE-3')].map((t) => ({ ticket: t, reason: 'r' }));
  const n = await applyStamp(tracker, plan, '1.3.0', DEFAULT_CONTRACT, emitter(lines), false);
  assert.deepEqual(calls, ['ISSUE-1', 'ISSUE-2', 'ISSUE-3']);   // kept going
  assert.equal(n, 2);
  assert.ok(lines.some((l) => /ISSUE-2.*could not stamp/.test(l)));
});

test('a stamp with a known sha writes commit_sha/merged_at alongside status', async () => {
  const calls: { id: string; patch: Record<string, unknown> }[] = [];
  const tracker = {
    updateTicket: async (id: string, patch: Record<string, unknown>) => {
      calls.push({ id, patch });
      return {} as Ticket;
    },
  } as unknown as Parameters<typeof applyStamp>[0];
  const plan = [{ ticket: T('ISSUE-1'), reason: 'merged by this release', sha: 'deadbeef' }];
  const n = await applyStamp(tracker, plan, '1.3.0', DEFAULT_CONTRACT, emitter([]), false);
  assert.equal(n, 1);
  assert.equal(calls[0]!.patch.commit_sha, 'deadbeef');
  assert.ok(typeof calls[0]!.patch.merged_at === 'string');
  assert.equal(calls[0]!.patch.released_version, '1.3.0');
});

test('a stamp with no known sha writes status/version only', async () => {
  const calls: { id: string; patch: Record<string, unknown> }[] = [];
  const tracker = {
    updateTicket: async (id: string, patch: Record<string, unknown>) => {
      calls.push({ id, patch });
      return {} as Ticket;
    },
  } as unknown as Parameters<typeof applyStamp>[0];
  const plan = [{ ticket: T('ISSUE-1'), reason: 'named in a..b' }];
  await applyStamp(tracker, plan, '1.3.0', DEFAULT_CONTRACT, emitter([]), false);
  assert.equal(calls[0]!.patch.commit_sha, undefined);
  assert.equal(calls[0]!.patch.merged_at, undefined);
});

test('a dry run stamps nothing but reports what it would', async () => {
  const lines: string[] = [];
  let called = false;
  const tracker = { updateTicket: async () => { called = true; return {} as Ticket; } } as unknown as Parameters<typeof applyStamp>[0];
  const n = await applyStamp(tracker, [{ ticket: T('ISSUE-1'), reason: 'r' }], '1.3.0', DEFAULT_CONTRACT, emitter(lines), true);
  assert.equal(called, false);
  assert.equal(n, 1);
  assert.ok(lines.some((l) => /would stamp -> closed_deployed \(1\.3\.0\)/.test(l)));
});

test('a no-op merge is still stamped, though no commit names it', () => {
  // A branch already contained in the integration branch writes no commit, so
  // the released range never mentions it. The run merged it all the same, and
  // its work IS live — ISSUE-292 sat at `verified` after shipping in v0.58.4
  // because only the commit scan was consulted.
  const { dir, from, to } = repoWith(['Release v1.0.0']);
  const plan = planStamp(
    dir, [T('ISSUE-292'), T('ISSUE-500')], DEFAULT_CONTRACT, from, to,
    new Map([['ISSUE-292', 'abc123']]),   // ISSUE-500 was neither merged nor named
  );
  assert.deepEqual(plan.map((p) => p.ticket.issue_id), ['ISSUE-292']);
  assert.equal(plan[0]!.reason, 'merged by this release');
  assert.equal(plan[0]!.sha, 'abc123');
});

test('a ticket merged by this run but as a no-op carries no sha', () => {
  // A no-op merge writes no commit (release-run.ts's mergeOne), so there is
  // nothing to name — the map entry is present with an undefined sha.
  const { dir, from, to } = repoWith(['Release v1.0.0']);
  const plan = planStamp(
    dir, [T('ISSUE-292')], DEFAULT_CONTRACT, from, to,
    new Map([['ISSUE-292', undefined]]),
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.sha, undefined);
});

test('a ticket named in the range but not merged by this run resolves its own sha', () => {
  const { dir, from, to } = repoWith(['unrelated', 'shipped earlier (ISSUE-9)']);
  const plan = planStamp(dir, [T('ISSUE-9')], DEFAULT_CONTRACT, from, to);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.reason, `named in ${from.slice(0, 8)}..${to.slice(0, 8)}`);
  assert.match(plan[0]!.sha ?? '', /^[0-9a-f]{40}$/);
});

const closure = (state: ClosureCheck['state'], mergedAt?: string): ClosureCheck =>
  ({ state, confidence: 'definitive', mergedAt, detail: 'd' });

test('a merged external closure with a sha stamps commit_sha/merged_at', async () => {
  const lines: string[] = [];
  const calls: { id: string; patch: Record<string, unknown> }[] = [];
  const tracker = {
    updateTicket: async (id: string, patch: Record<string, unknown>) => {
      calls.push({ id, patch });
      return {} as Ticket;
    },
  } as unknown as Parameters<typeof applyExternalClosures>[0];
  const n = await applyExternalClosures(
    tracker, [{ ticket: T('ISSUE-517'), closure: closure('merged', 'deadbeef') }], emitter(lines), false,
  );
  assert.equal(n, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'ISSUE-517');
  assert.equal(calls[0]!.patch.commit_sha, 'deadbeef');
  assert.ok(typeof calls[0]!.patch.merged_at === 'string');
});

test('a merged external closure with no resolved sha is not stamped', async () => {
  const lines: string[] = [];
  let called = false;
  const tracker = {
    updateTicket: async () => { called = true; return {} as Ticket; },
  } as unknown as Parameters<typeof applyExternalClosures>[0];
  const n = await applyExternalClosures(
    tracker, [{ ticket: T('ISSUE-517'), closure: closure('merged', undefined) }], emitter(lines), false,
  );
  assert.equal(n, 0);
  assert.equal(called, false);
});

test('an open or unknown external closure is not stamped', async () => {
  const lines: string[] = [];
  let called = false;
  const tracker = {
    updateTicket: async () => { called = true; return {} as Ticket; },
  } as unknown as Parameters<typeof applyExternalClosures>[0];
  const n = await applyExternalClosures(
    tracker,
    [{ ticket: T('ISSUE-1'), closure: closure('open') }, { ticket: T('ISSUE-2'), closure: closure('unknown') }],
    emitter(lines), false,
  );
  assert.equal(n, 0);
  assert.equal(called, false);
});

test('a dry run for external closures stamps nothing but reports what it would', async () => {
  const lines: string[] = [];
  let called = false;
  const tracker = {
    updateTicket: async () => { called = true; return {} as Ticket; },
  } as unknown as Parameters<typeof applyExternalClosures>[0];
  const n = await applyExternalClosures(
    tracker, [{ ticket: T('ISSUE-517'), closure: closure('merged', 'deadbeef') }], emitter(lines), true,
  );
  assert.equal(called, false);
  assert.equal(n, 1);
  assert.ok(lines.some((l) => /would stamp commit_sha \(deadbeef\)/.test(l)));
});

test('a tracker failure on one external closure does not abandon the rest', async () => {
  const lines: string[] = [];
  const calls: string[] = [];
  const tracker = {
    updateTicket: async (id: string) => {
      calls.push(id);
      if (id === 'ISSUE-2') throw new Error('503 from the tracker');
      return {} as Ticket;
    },
  } as unknown as Parameters<typeof applyExternalClosures>[0];
  const n = await applyExternalClosures(
    tracker,
    [
      { ticket: T('ISSUE-1'), closure: closure('merged', 'aaa') },
      { ticket: T('ISSUE-2'), closure: closure('merged', 'bbb') },
      { ticket: T('ISSUE-3'), closure: closure('merged', 'ccc') },
    ],
    emitter(lines), false,
  );
  assert.deepEqual(calls, ['ISSUE-1', 'ISSUE-2', 'ISSUE-3']);
  assert.equal(n, 2);
  assert.ok(lines.some((l) => /ISSUE-2.*could not stamp commit_sha/.test(l)));
});
