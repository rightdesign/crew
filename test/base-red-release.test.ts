import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease } from '../src/release-run.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import { describeRelease, recoveredFailureHeadlines } from '../src/notify.ts';
import { applyFailureAlert, applyFailureRecovery, ticketQuotingFailure, type FailureAlertWriter } from '../src/failure-alert.ts';
import { restoreVerifiedIfUnchanged, unansweredBuildFailure } from '../src/build-failure.ts';
import { enforceHandoff, type HandoffWriter } from '../src/handoff-guard.ts';
import { settleNoopRun, readNoopRuns, type NoopTracker, type SettleNoopOptions } from '../src/noop-runs.ts';
import type { RunnerEvent, Ticket } from '../src/tracker.ts';

// CREW-3774: a build hook that fails on the base alone must not blame, or bounce, a verified branch.

const T = (issue_id: string): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z' }) as Ticket;
const emitter = () => new Emitter({ route: 'c', console: () => {}, cycleId: 'C' });
const silent = { emit: () => {}, warn: () => {} };

const RED = 'AUDIT: GHSA-xxxx-yyyy-zzzz is a newly published advisory for effect';

/** main whose build hook is red unless `fix.txt` exists, plus verified branches issue-1..N; the ones named in `fixers` add fix.txt. */
function redBase(n: number, fixers: number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-red-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  g('add', '.'); g('commit', '-qm', 'base'); g('tag', '-a', 'v1.0.0', '-m', 'r');
  for (let i = 1; i <= n; i++) {
    g('checkout', '-qb', `issue-${i}`);
    writeFileSync(join(dir, `f${i}.txt`), 'ok');
    if (fixers.includes(i)) writeFileSync(join(dir, 'fix.txt'), 'fixed');
    g('add', '.'); g('commit', '-qm', `built ${i}\n\nChangelog: ISSUE-${i} did a thing\nBump: patch`);
    g('checkout', '-q', 'main');
  }
  const yaml = `version: 1\nhooks:\n  test: exit 0\n  build: |\n    test -f fix.txt || { echo "${RED}"; exit 1; }\n  deploy: exit 0\n`;
  const repo = resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir);
  return { dir, repo, tickets: Array.from({ length: n }, (_, i) => T(`ISSUE-${i + 1}`)) };
}
const go = (r: ReturnType<typeof redBase>) =>
  runRelease({ cwd: r.dir, repo: r.repo, contract: DEFAULT_CONTRACT, tickets: r.tickets, emit: emitter(), dryRun: false });

/** An in-memory board for the alert: files and comments, no network. */
function board() {
  const open: Ticket[] = [];
  const filed: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const w: FailureAlertWriter & { updateTicket: (id: string, p: Record<string, unknown>) => Promise<unknown> } = {
    fileTicket: async (f) => {
      filed.push(f);
      const t = { id: `alert-${filed.length}`, issue_id: `ISSUE-${900 + filed.length}`, title: f.title as string, status: 'new', updated_at: 'u' } as Ticket;
      open.push(t);
      return t;
    },
    postEvent: async (_id, body) => { notes.push(body); },
    updateTicket: async (id, p) => { Object.assign(open.find((t) => t.id === id)!, p); return {}; },
  };
  return { open, filed, notes, w };
}

test('a build that fails on the base alone: no culprit, both tickets stay verified, one alert', async () => {
  const r = redBase(2);
  const out = await go(r);
  assert.equal(out.stopped, 'build failed');
  assert.equal(out.buildCulprits, undefined, 'no build_failed hand-back or release_culprit is produced');
  assert.equal(out.deployed, false);
  assert.match(out.isolation ?? '', /fails on the base alone/);
  assert.match(out.isolation ?? '', /stays verified/);
  const news = describeRelease(out, 'c')!;
  assert.equal(news.level, 'fail');
  const b = board();
  await applyFailureAlert(b.w, news, 'c', b.open, 'seat', silent, false, {}, { tail: out.hookFailure!.tail, contract: DEFAULT_CONTRACT });
  assert.equal(b.filed.length, 1);
});

test('a second cycle on the same base opens no further alert', async () => {
  const r = redBase(2);
  const b = board();
  for (let cycle = 0; cycle < 3; cycle++) {
    const out = await go(r);
    assert.equal(out.buildCulprits, undefined);
    await applyFailureAlert(b.w, describeRelease(out, 'c')!, 'c', b.open, 'seat', silent, false);
  }
  assert.equal(b.filed.length, 1, 'one alert, then comments on it');
  assert.equal(b.notes.filter((x) => /Still failing/.test(x)).length, 2);
});

test('a verified branch that makes the hook pass ships with the others that pass beside it, and the alert closes', async () => {
  const r = redBase(3, [2]);
  const b = board();
  b.open.push({ id: 'alert-0', issue_id: 'ISSUE-899', title: 'c: build FAILED', status: 'new', updated_at: 'u' } as Ticket);
  const out = await go(r);
  assert.equal(out.deployed, true);
  assert.equal(out.buildCulprits, undefined);
  assert.deepEqual(out.merged.map((m) => m.ticket.issue_id).sort(), ['ISSUE-1', 'ISSUE-2', 'ISSUE-3']);
  const res = await applyFailureRecovery(b.w, recoveredFailureHeadlines(out, 'c'), b.open, DEFAULT_CONTRACT, 'seat', 'c released', silent, false);
  assert.deepEqual(res.closed, ['ISSUE-899']);
  assert.equal(b.open[0]!.status, 'closed_completed');
});

test('an open ticket already quoting the failure keeps the alert out of the dev lane', async () => {
  const fixing = {
    id: 'fix-1', issue_id: 'ISSUE-3771', title: 'Audit gate passes again', status: 'in_progress', updated_at: 'u',
    description: `The audit now prints:\n\n${RED}\nerror: audit gate failed with 1 advisory\n\nand the build stops there.`,
  } as Ticket;
  const tail = `${RED}\nerror: audit gate failed with 1 advisory`;
  assert.equal(ticketQuotingFailure([fixing], tail, DEFAULT_CONTRACT)?.id, 'fix-1');
  assert.equal(ticketQuotingFailure([{ ...fixing, status: 'new' }], tail, DEFAULT_CONTRACT), undefined, 'not yet accepted is not being worked');
  assert.equal(ticketQuotingFailure([{ ...fixing, description: 'unrelated' }], tail, DEFAULT_CONTRACT), undefined);

  const b = board();
  await applyFailureAlert(b.w, { level: 'fail', headline: 'c: build FAILED', detail: 'x' }, 'c', [fixing], 'seat', silent, false, {}, { tail, contract: DEFAULT_CONTRACT });
  assert.deepEqual(b.filed[0]!.blocked_by, ['fix-1'], 'the alert waits on the fix, so no lane is offered it');
  assert.match(b.filed[0]!.description as string, /ISSUE-3771 already quotes this failure/);
  // Without a ticket working on it, the alert stands alone.
  const c = board();
  await applyFailureAlert(c.w, { level: 'fail', headline: 'c: build FAILED', detail: 'x' }, 'c', [], 'seat', silent, false, {}, { tail, contract: DEFAULT_CONTRACT });
  assert.equal('blocked_by' in c.filed[0]!, false);
});

const ev = (type: string, record: string, at: string, message = ''): RunnerEvent => ({ record_id: record, event_type: type, occurred_at: at, message });
const SHA = 'a'.repeat(40);

function eventsWriter(events: RunnerEvent[]) {
  const patches: Array<Record<string, unknown>> = [];
  const posted: Array<[string, string?]> = [];
  const w = {
    updateTicket: async (_id: string, p: Record<string, unknown>) => { patches.push(p); return {}; },
    postEvent: async (_id: string, body: string, _m: string, type?: string) => { posted.push([body, type]); },
    events: async (type: string) => events.filter((e) => e.event_type === type),
  };
  return { w, patches, posted };
}
const ticket = (): Ticket => ({ id: 'rec', issue_id: 'CREW-9', status: 'in_progress', assignee_id: 'dev', updated_at: 'u0' }) as Ticket;
const history = [
  ev('pushed', 'rec', '2026-11-19T10:00:00Z', `pushed ${SHA} to origin/crew-9`),
  ev('build_failed', 'rec', '2026-11-19T11:00:00Z'),
];

test('an unchanged branch answering a build_failed hand-back goes back to verified', async () => {
  assert.equal(unansweredBuildFailure(ticket(), history), true);
  const e = eventsWriter(history);
  assert.equal(await restoreVerifiedIfUnchanged(e.w, ticket(), SHA, DEFAULT_CONTRACT, 'seat', { column: 'held_by_ship_id' }), true);
  assert.deepEqual(e.patches, [{ status: 'verified', assignee_id: null, held_by_ship_id: null }]);
  assert.equal(e.posted[0]![1], 'build_failed_unchanged');
});

test('a changed branch, or one pushed since the hand-back, is not restored', async () => {
  const e = eventsWriter(history);
  assert.equal(await restoreVerifiedIfUnchanged(e.w, ticket(), 'b'.repeat(40), DEFAULT_CONTRACT, 'seat'), false);
  const pushedSince = [...history, ev('pushed', 'rec', '2026-11-19T12:00:00Z', `pushed ${'b'.repeat(40)} to origin/crew-9`)];
  const f = eventsWriter(pushedSince);
  assert.equal(unansweredBuildFailure(ticket(), pushedSince), false);
  assert.equal(await restoreVerifiedIfUnchanged(f.w, ticket(), 'b'.repeat(40), DEFAULT_CONTRACT, 'seat'), false);
  assert.deepEqual([...e.patches, ...f.patches], []);
});

test('a no-op run on a build_failed hand-back restores verified and does not count toward the no-change park', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'noop-'));
  const before = ticket();
  const e = eventsWriter(history);
  const writes: Array<Record<string, unknown>> = [];
  const raised: unknown[] = [];
  const tracker: NoopTracker = {
    ticket: async () => before, comments: async () => [], updateTicket: async (_i, p) => { writes.push(p); },
    postEvent: async () => {}, claimAffinity: async () => undefined,
  };
  const opts: SettleNoopOptions = {
    tracker, stateDir, role: 'dev', ticketId: 'rec', before, tipBefore: 'o|', tipAfter: 'o|', runStart: '2026-11-19T12:00:00Z',
    memberId: 'dev', operatorId: 'op', columns: { status: 'status', assignee: 'assignee_id' },
    statuses: { building: 'in_progress', needsHuman: 'needs_info' }, repeats: 1,
    restoreVerified: (after) => restoreVerifiedIfUnchanged(e.w, after, SHA, DEFAULT_CONTRACT, 'dev'),
    raise: (i) => { raised.push(i); }, clear: () => {},
  };
  assert.equal(await settleNoopRun(opts), 'progress');
  assert.deepEqual(e.patches, [{ status: 'verified', assignee_id: null }]);
  assert.deepEqual(readNoopRuns(stateDir), {}, 'no no-change count recorded');
  assert.deepEqual([writes, raised], [[], []], 'repeats: 1 would otherwise have parked it');
});

test('the hand-off guard restores verified instead of checking a no-commit answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hg-'));
  const dir = join(root, 'repo');
  const bare = join(root, 'origin.git');
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'a'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base');
  sh(root, 'init', '-q', '--bare', bare);
  sh(dir, 'remote', 'add', 'origin', bare); sh(dir, 'push', '-q', 'origin', 'main');
  const wt = join(root, 'repo-crew-9');
  sh(dir, 'worktree', 'add', '-q', wt, '-b', 'crew-9');
  writeFileSync(join(wt, 'b.txt'), 'b'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'work');
  sh(wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  const tip = sh(wt, 'rev-parse', 'HEAD');
  const events = [
    ev('pushed', 'row-9', '2026-11-19T10:00:00Z', `pushed ${tip} to origin/crew-9`),
    ev('build_failed', 'row-9', '2026-11-19T11:00:00Z'),
  ];
  const patches: Array<Record<string, unknown>> = [];
  const notes: Array<string | undefined> = [];
  const t = { id: 'row-9', issue_id: 'ISSUE-9', issue_tag: 'CREW-9', project_issue_prefix: 'CREW', status: 'fixed', updated_at: 'u' } as Ticket;
  const w: HandoffWriter = {
    ticket: async () => t,
    updateTicket: async (_i, p) => { patches.push(p); return {}; },
    postEvent: async (_i, _b, _m, type) => { notes.push(type); },
    events: async (type) => events.filter((x) => x.event_type === type),
  };
  const out = await enforceHandoff({
    writer: w, contract: DEFAULT_CONTRACT, ticketId: 'row-9', role: 'dev', dir, cfg: resolveRepoConfig(null, undefined, dir),
    seatId: 'seat-dev', shipName: 'Studio', hold: { column: 'held_by_ship_id', shipId: 'ship-A' }, log: silent,
  });
  assert.equal(out.kind, 'restored');
  assert.deepEqual(patches, [{ status: 'verified', assignee_id: null, held_by_ship_id: null }]);
  assert.deepEqual(notes, ['build_failed_unchanged'], 'no pushed event, no acceptance bounce');
});
