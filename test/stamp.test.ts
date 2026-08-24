import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planStamp, applyStamp } from '../src/stamp.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { Ticket } from '../src/tracker.ts';

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

const emitter = (lines: string[]) => new Emitter({ connection: 'c', console: (l) => lines.push(l), cycleId: 'C' });

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
    ['ISSUE-292'],   // ISSUE-500 was neither merged nor named
  );
  assert.deepEqual(plan.map((p) => p.ticket.issue_id), ['ISSUE-292']);
  assert.equal(plan[0]!.reason, 'merged by this release');
});
