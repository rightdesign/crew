import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaleWriteError } from '@tablation/client';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { planConflictBounce, applyConflictBounce, refreshBranch, type ConflictWriter, type ConflictLog } from '../src/conflict.ts';
import { planBuildFailureBounce, applyBuildFailureBounce } from '../src/build-failure.ts';
import type { Ticket, RunnerEvent } from '../src/tracker.ts';

const C = DEFAULT_CONTRACT;
const SEAT = 'release-seat';
const lines: string[] = [];
const log: ConflictLog = { emit: (m) => { lines.push(m); }, warn: (m) => { lines.push(m); } };

/** A board row that enforces `expectedUpdatedAt` like the real one, and bumps it on every write. */
function board(initial: Record<string, unknown> = {}) {
  let n = 0;
  const row: Record<string, unknown> = {
    id: 'row-1', issue_id: 'ISSUE-9', status: C.statuses.verified, assignee_id: null, updated_at: 't0', ...initial,
  };
  const events: Array<{ type?: string; extra?: Record<string, unknown> }> = [];
  const w: ConflictWriter = {
    updateTicket: async (_id, patch, expected) => {
      if (expected !== undefined && expected !== row.updated_at) throw new StaleWriteError({});
      Object.assign(row, patch, { updated_at: `t${++n}` });
      return row;
    },
    ticket: async () => ({ ...row }) as unknown as Ticket,
    postEvent: async (_id, _b, _m, type, extra) => { events.push({ type, extra }); },
  };
  const read = () => ({ ...row }) as unknown as Ticket;
  /** The release's claim and unclaim, as cli.ts wires them (it does not carry the stamp here, so the retry must cope). */
  const claimAndUnclaim = async () => {
    await w.updateTicket('row-1', { assignee_id: SEAT });
    await w.updateTicket('row-1', { assignee_id: null });
  };
  return { row, events, w, read, claimAndUnclaim };
}

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crew-cs-')));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'f.txt'), 'original\n');
  g(dir, 'add', '.'); g(dir, 'commit', '-qm', 'base');
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), 'crew-cs-wt-'))), 'issue-9');
  g(dir, 'worktree', 'add', '-q', '-b', 'issue-9', wt);
  writeFileSync(join(wt, 'f.txt'), 'branch\n');
  g(wt, 'commit', '-qam', 'branch');
  const moveBase = (text = 'base') => { writeFileSync(join(dir, 'f.txt'), `${text}\n`); g(dir, 'commit', '-qam', `base ${text}`); };
  return { dir, wt, g, moveBase };
}

test('a claim and unclaim in the same cycle do not stop the hand-back', async () => {
  const { dir, moveBase } = repo(); moveBase();
  const b = board(); const read = b.read();
  await b.claimAndUnclaim();
  const out = await applyConflictBounce(b.w, planConflictBounce(dir, read, 'issue-9', 'main', ['f.txt'], []), C, SEAT, log, false);
  assert.equal(out.kind, 'handed-back');
  assert.equal(b.row.status, C.statuses.building);
  assert.equal(b.row.assignee_id, null);
  const handed = b.events.filter((e) => e.type === 'conflict_handed_back');
  assert.equal(handed.length, 1);
  assert.ok(handed[0]!.extra?.base_sha && (handed[0]!.extra.paths as string[]).includes('f.txt'));
});

test('a second conflict after a hand-back escalates, and a gate culprit is handed back, despite the claim', async () => {
  const { dir, moveBase } = repo(); moveBase();
  const b = board(); const read = b.read();
  await b.claimAndUnclaim();
  const prior: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'conflict_handed_back', occurred_at: '2026-01-01T00:00:00Z' },
    { record_id: 'row-1', event_type: 'pushed', occurred_at: '2026-01-02T00:00:00Z' },
  ];
  const esc = await applyConflictBounce(b.w, planConflictBounce(dir, read, 'issue-9', 'main', ['f.txt'], prior), C, SEAT, log, false);
  assert.equal(esc.kind, 'escalated');
  assert.equal(b.row.status, C.statuses.needsHuman);

  const g = board(); const gRead = g.read();
  await g.claimAndUnclaim();
  const bounce = planBuildFailureBounce('/nonexistent', { ticket: gRead, branch: 'issue-9', hook: 'build', tail: 'boom', how: 'files' }, 'main', 'origin');
  assert.equal((await applyBuildFailureBounce(g.w, bounce, C, SEAT, log, false)).kind, 'handed-back');
  assert.equal(g.row.status, C.statuses.building);
});

test('an unrelated column touched after the read does not stop the hand-back', async () => {
  const { dir, moveBase } = repo(); moveBase();
  const b = board(); const read = b.read();
  await b.w.updateTicket('row-1', { description: 'edited' });
  const out = await applyConflictBounce(b.w, planConflictBounce(dir, read, 'issue-9', 'main', ['f.txt'], []), C, SEAT, log, false);
  assert.equal(out.kind, 'handed-back');
});

test('a status, assignee or hold change by someone else leaves the ticket alone and says what changed', async () => {
  const { dir, moveBase } = repo(); moveBase();
  for (const [patch, text] of [
    [{ status: C.statuses.deployed }, /status/],
    [{ assignee_id: 'someone-else' }, /assignee/],
    [{ [C.columns.heldBy]: 'other-ship' }, /held by/],
  ] as const) {
    lines.length = 0;
    const b = board(); const read = b.read();
    await b.w.updateTicket('row-1', patch);
    const before = { ...b.row };
    const out = await applyConflictBounce(b.w, planConflictBounce(dir, read, 'issue-9', 'main', ['f.txt'], []), C, SEAT, log, false);
    assert.equal(out.kind, 'stale');
    assert.deepEqual(b.row, before);
    assert.ok(lines.some((l) => text.test(l)), lines.join('\n'));
  }
});

test('refreshBranch replaces its own earlier unfinished merge with the current base tip, and spares other work', async () => {
  const { dir, wt, g, moveBase } = repo();
  moveBase('one');
  assert.deepEqual(refreshBranch(wt, 'main').paths, ['f.txt']);   // leaves the conflict in place
  moveBase('two');
  const r = refreshBranch(wt, 'main');
  assert.deepEqual(r.paths, ['f.txt']);
  assert.equal(r.why, undefined);
  assert.match(g(wt, 'log', '-1', '--format=%s', 'MERGE_HEAD').toString(), /base two/);
  assert.match(readFileSync(join(wt, 'f.txt'), 'utf8'), /<<<<<<</);

  // Any other uncommitted work is left untouched.
  writeFileSync(join(wt, 'mine.txt'), 'wip\n');
  const r2 = refreshBranch(wt, 'main');
  assert.equal(r2.why, 'the worktree has uncommitted changes');
  assert.equal(readFileSync(join(wt, 'mine.txt'), 'utf8'), 'wip\n');
  void dir;
});
