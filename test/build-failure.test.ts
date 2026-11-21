import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaleWriteError } from '@tablation/client';
import { runRelease } from '../src/release-run.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import {
  failingPaths, culpritByFiles, planBuildFailureBounce, applyBuildFailureBounce,
  buildFailureComment, BUILD_FAILURE_MARKER, failureExcerpt, recordedFailure, priorBuildFailures, failureComparison, priorFailureNote,
} from '../src/build-failure.ts';
import type { Ticket } from '../src/tracker.ts';

const T = (issue_id: string): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z' }) as Ticket;

const silent = { emit: () => {}, warn: () => {} };
const emitter = () => new Emitter({ route: 'c', console: () => {}, cycleId: 'C' });

/**
 * main plus three verified branches, each adding one file; `bad.txt` makes the
 * build hook fail. `loud` makes the failure name the file, as tsc does.
 */
function release(opts: { loud: boolean; extra?: string; badOn?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bf-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  g('add', '.'); g('commit', '-qm', 'base'); g('tag', '-a', 'v1.0.0', '-m', 'r');
  for (const n of ['7', '8', '9']) {
    g('checkout', '-qb', `issue-${n}`);
    const bad = (opts.badOn ?? ['8']).includes(n);
    writeFileSync(join(dir, `f${n}.txt`), bad ? 'BAD' : 'ok');
    g('add', '.'); g('commit', '-qm', `built ${n}\n\nChangelog: ISSUE-${n} did a thing\nBump: patch`);
    g('checkout', '-q', 'main');
  }
  const build = opts.loud
    ? `if grep -q BAD f*.txt; then echo "f8.txt:1:1: error duplicate"; exit 1; fi`
    : `if grep -q BAD f*.txt; then echo "something broke"; exit 1; fi`;
  const yaml = `version: 1\nhooks:\n  test: exit 0\n  build: |\n    ${build}\n  deploy: exit 0\n${opts.extra ?? ''}`;
  const repo = resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir);
  return { dir, repo };
}

const run = (dir: string, repo: ReturnType<typeof release>['repo']) =>
  runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT,
    tickets: [T('ISSUE-7'), T('ISSUE-8'), T('ISSUE-9')], emit: emitter(), dryRun: false,
  });

test('the culprit named by the failing output is handed back and the rest ship', async () => {
  const { dir, repo } = release({ loud: true });
  const out = await run(dir, repo);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how]), [['ISSUE-8', 'files']]);
  assert.equal(out.deployed, true);
  assert.deepEqual(out.merged.map((m) => m.ticket.issue_id).sort(), ['ISSUE-7', 'ISSUE-9']);
  assert.ok(existsSync(join(dir, 'f7.txt')) && existsSync(join(dir, 'f9.txt')));
  assert.ok(!existsSync(join(dir, 'f8.txt')));
  assert.match(out.buildCulprits![0]!.tail, /error duplicate/);
});

test('a failure naming no file is isolated by building each branch alone', async () => {
  const { dir, repo } = release({ loud: false });
  const out = await run(dir, repo);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how]), [['ISSUE-8', 'solo']]);
  assert.equal(out.deployed, true);
  assert.ok(!existsSync(join(dir, 'f8.txt')));
});

test('two culprits are both handed back', async () => {
  const { dir, repo } = release({ loud: false, badOn: ['7', '9'] });
  const out = await run(dir, repo);
  assert.deepEqual(out.buildCulprits?.map((c) => c.ticket.issue_id).sort(), ['ISSUE-7', 'ISSUE-9']);
  assert.equal(out.deployed, true);
  assert.deepEqual(out.merged.map((m) => m.ticket.issue_id), ['ISSUE-8']);
});

test('over release.isolateFailures.maxCandidates the release shrinks to the oldest branches and still finds the culprit', async () => {
  const { dir, repo } = release({ loud: false, extra: 'release:\n  isolateFailures: { maxCandidates: 2 }\n' });
  const out = await run(dir, repo);
  // ISSUE-7 and ISSUE-8 are tried; ISSUE-9 waits for a later cycle.
  assert.deepEqual(out.buildCulprits?.map((c) => c.ticket.issue_id), ['ISSUE-8']);
  assert.deepEqual(out.merged.map((m) => m.ticket.issue_id), ['ISSUE-7']);
  assert.equal(out.deployed, true);
  assert.deepEqual(out.batchDeferral?.deferred.map((t) => t.issue_id), ['ISSUE-9']);
});

test('maxCandidates: 0 turns isolation off', async () => {
  const { dir, repo } = release({ loud: true, extra: 'release:\n  isolateFailures: { maxCandidates: 0 }\n' });
  const out = await run(dir, repo);
  assert.equal(out.stopped, 'build failed');
});

test('a build that passes on every branch alone blames nobody', async () => {
  // fails only when ALL three files are present together
  const { dir, repo } = release({ loud: false, badOn: [] });
  const yaml = `version: 1\nhooks:\n  test: exit 0\n  build: test ! -f f7.txt -o ! -f f8.txt -o ! -f f9.txt\n  deploy: exit 0\n`;
  const r2 = resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir);
  void repo;
  const out = await run(dir, r2);
  assert.equal(out.buildCulprits, undefined);
  assert.equal(out.stopped, 'build failed');
});

const runOnly = (dir: string, repo: ReturnType<typeof release>['repo']) =>
  runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-8')], emit: emitter(), dryRun: false,
  });

test('a lone merged branch that fails the gate is blamed, with no failure alert (CREW-2208)', async () => {
  const { dir, repo } = release({ loud: false });
  const out = await runOnly(dir, repo);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how]), [['ISSUE-8', 'solo']]);
  assert.match(out.buildCulprits![0]!.tail, /something broke/);
  assert.equal(out.hookFailure, undefined);
  assert.equal(out.deployed, false);
  assert.equal(out.stopped, 'nothing to release');
  assert.ok(!existsSync(join(dir, 'f8.txt')));
});

test('a lone branch whose failure names its file is blamed by the files', async () => {
  const { dir, repo } = release({ loud: true });
  const out = await runOnly(dir, repo);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how]), [['ISSUE-8', 'files']]);
  assert.equal(out.hookFailure, undefined);
});

test('a lone branch is still not blamed when isolation is off', async () => {
  const { dir, repo } = release({ loud: true, extra: 'release:\n  isolateFailures: { maxCandidates: 0 }\n' });
  const out = await runOnly(dir, repo);
  assert.equal(out.buildCulprits, undefined);
  assert.equal(out.stopped, 'build failed');
});

test('failingPaths reads tsc, colon-style and test-runner output, relative to the checkout', () => {
  const out = [
    'apps/frontend/src/api.ts(120,3): error TS2300: Duplicate identifier',
    'src/a.ts:4:9 - error',
    '/work/co/src/b.ts:7:1: boom',
    '/elsewhere/c.ts:1:1: no',
    'FAIL src/d.test.ts',
    '  at /work/co/node_modules/x/y.js:1:1',
  ].join('\n');
  assert.deepEqual(
    failingPaths(out, '/work/co').sort(),
    ['apps/frontend/src/api.ts', 'src/a.ts', 'src/b.ts', 'src/d.test.ts'],
  );
});

test('culpritByFiles needs exactly one matching candidate', () => {
  const a = { changed: new Set(['x.ts']) }, b = { changed: new Set(['y.ts']) }, c = { changed: new Set(['x.ts']) };
  assert.equal(culpritByFiles([a, b], ['x.ts']), a);
  assert.equal(culpritByFiles([a, c], ['x.ts']), null);
  assert.equal(culpritByFiles([a, b], ['z.ts']), null);
  assert.equal(culpritByFiles([a, b], []), null);
});

test('the hand-back clears the assignee, posts the tail, and respects a stale write', async () => {
  const patches: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const bounce = planBuildFailureBounce('/nonexistent', {
    ticket: T('ISSUE-8'), branch: 'issue-8', hook: 'build', tail: 'TS2300: Duplicate identifier', how: 'files',
  }, 'main', 'origin');
  const w = {
    updateTicket: async (_id: string, p: Record<string, unknown>) => { patches.push(p); return {}; },
    postEvent: async (_id: string, b: string) => { notes.push(b); },
  };
  // worktree lookup runs git in a missing dir only when one exists; null here
  assert.equal((await applyBuildFailureBounce(w, bounce, DEFAULT_CONTRACT, 'm', silent, false)).kind, 'handed-back');
  assert.deepEqual(patches[0], { status: DEFAULT_CONTRACT.statuses.building, assignee_id: null });
  assert.ok(notes[0]!.startsWith(BUILD_FAILURE_MARKER) && notes[0]!.includes('TS2300'));
  assert.match(buildFailureComment({ ...bounce, how: 'solo' }), /git merge origin\/main/);
  const stale = { ...w, updateTicket: async () => { throw new StaleWriteError({}); } };
  assert.equal((await applyBuildFailureBounce(stale, bounce, DEFAULT_CONTRACT, 'm', silent, false)).kind, 'stale');
  assert.equal((await applyBuildFailureBounce(w, bounce, DEFAULT_CONTRACT, 'm', silent, true)).kind, 'handed-back');
  assert.equal(patches.length, 1);
});

test('a pair culprit names the sibling to merge first (CREW-2777)', () => {
  const bounce = planBuildFailureBounce('/nonexistent', {
    ticket: T('ISSUE-9'), branch: 'issue-9', hook: 'test', tail: 'boom', how: 'pair',
    sibling: { key: 'ISSUE-8', branch: 'issue-8' },
  }, 'main', 'origin');
  const c = buildFailureComment(bounce);
  assert.match(c, /passes the hook alone/);
  assert.match(c, /git merge origin\/issue-8/);
});

test('a second hand-back after a push escalates to a person instead of looping (CREW-2777)', async () => {
  const t = T('ISSUE-10');
  const ev = [
    { record_id: t.id, event_type: 'build_failed', occurred_at: '2026-01-01T00:00:00Z' },
    { record_id: t.id, event_type: 'pushed', occurred_at: '2026-01-02T00:00:00Z' },
  ];
  assert.equal(priorBuildFailures(t, ev), 1);
  assert.equal(priorBuildFailures(t, ev.slice(0, 1)), 0);
  const patches: Array<Record<string, unknown>> = [];
  const w = {
    updateTicket: async (_id: string, p: Record<string, unknown>) => { patches.push(p); return {}; },
    postEvent: async () => {},
  };
  const bounce = planBuildFailureBounce('/nonexistent', { ticket: t, branch: 'issue-10', hook: 'build', tail: 'x', how: 'solo' }, 'main', 'origin');
  const r = await applyBuildFailureBounce(w, bounce, DEFAULT_CONTRACT, 'm', silent, false, { count: 1, operatorId: 'op' });
  assert.equal(r.kind, 'escalated');
  assert.deepEqual(patches[0], { status: DEFAULT_CONTRACT.statuses.needsHuman, assignee_id: 'op' });
});



const bounce = (over: Partial<Parameters<typeof buildFailureComment>[0]> = {}) => ({
  ticket: { id: 't1', issue_id: 'ISSUE-1' } as never, branch: 'b', hook: 'test', tail: 'FAIL src/a.spec.ts\n', how: 'solo' as const,
  base: 'main', remote: 'origin', worktree: null, cwd: '/repo', failingFiles: ['src/a.spec.ts'], inBranch: false, ...over,
});

test('escalation says whether the two failures were the same test (CREW-3220)', () => {
  assert.match(failureComparison(bounce(), 'x\n```\nFAIL src/a.spec.ts\n```'), /Same failure both times: yes/);
  assert.match(failureComparison(bounce(), 'x\n```\nFAIL src/b.spec.ts\n```'), /Same failure both times: \*\*no\*\*.*flake/);
  assert.match(failureComparison(bounce(), undefined), /Unknown/);
});

test('escalation and hand-back say whether the failing files are among the branch changes (CREW-3220)', () => {
  assert.match(failureComparison(bounce(), ''), /among the branch's changes: \*\*no\*\*/);
  assert.match(failureComparison(bounce({ inBranch: true }), ''), /changes: yes/);
  assert.match(buildFailureComment(bounce()), /None of the files the failure names/);
  assert.doesNotMatch(buildFailureComment(bounce({ inBranch: true })), /None of the files/);
});

test('priorFailureNote returns the latest hand-back note for the ticket', () => {
  const ev = [
    { record_id: 't1', event_type: 'build_failed', occurred_at: '1', message: 'old' },
    { record_id: 't1', event_type: 'build_failed', occurred_at: '2', message: 'new' },
    { record_id: 't2', event_type: 'build_failed', occurred_at: '3', message: 'other' },
  ];
  assert.equal(priorFailureNote({ id: 't1' } as never, ev), 'new');
});

const longOutput = (): string => [
  '--- backend lint', 'ok',
  '--- frontend lint', '/repo/src/new.ts:4:9  error  Unknown word "teh"', 'x', '1 problem',
  ...Array.from({ length: 40 }, (_, i) => `PASS suite ${i}`),
  'Tests 40 passed',
].join('\n');

test('the excerpt is built around the line naming the failing file, not the closing lines (CREW-3775)', () => {
  const ex = failureExcerpt(longOutput(), ['src/new.ts'], 15);
  assert.equal(ex.pathCentered, true);
  assert.match(ex.text, /src\/new\.ts:4:9/);
  assert.match(ex.text, /--- frontend lint/);
  assert.match(ex.text, /end of the output/);
  assert.match(ex.text, /Tests 40 passed/);
  assert.ok(ex.text.split('\n').length < 25);
});

test('many matches show the first few and count the rest', () => {
  const out = Array.from({ length: 30 }, (_, i) => `src/a.ts:${i}:1 error\npad\npad\npad\npad\npad\npad\npad`).join('\n');
  assert.match(failureExcerpt(out, ['src/a.ts'], 15).text, /and 27 more lines naming these files/);
});

test('no recognizable path quotes the tail and says the failing step may be earlier', () => {
  const ex = failureExcerpt(longOutput(), [], 15);
  assert.equal(ex.pathCentered, false);
  assert.equal(ex.text.split('\n').length, 15);
  const note = buildFailureComment(bounce({ tail: ex.text, pathCentered: false, failingFiles: [], inBranch: null, how: 'solo' }));
  assert.match(note, /failing step may be earlier/);
});

test('a culprit found by files makes no claim that the branch passes alone', () => {
  const note = buildFailureComment(bounce({ how: 'files', inBranch: true, pathCentered: true }));
  assert.match(note, /names files this branch changed/);
  assert.match(note, /Nothing here shows whether the branch passes/);
  assert.doesNotMatch(note, /builds on its own|semantic conflict/);
  assert.match(note, /run the failing step on `b` itself/);
});

test('two failures naming the same file compare as the same, from the recorded paths', () => {
  const first = buildFailureComment(bounce({ tail: 'unrelated closing lines', how: 'files' }));
  assert.deepEqual(recordedFailure(first)?.paths, ['src/a.spec.ts']);
  const cmp = failureComparison(bounce({ tail: 'also unrelated' }), first);
  assert.match(cmp, /Same failure both times: yes, `src\/a\.spec\.ts`/);
});

test('a repeat on an unchanged tip is handed back once more, a third failure parks', async () => {
  const t = T('ISSUE-11');
  const patches: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const w = {
    updateTicket: async (_id: string, p: Record<string, unknown>) => { patches.push(p); return {}; },
    postEvent: async (_id: string, b: string) => { notes.push(b); },
  };
  const b = planBuildFailureBounce('/nonexistent', { ticket: t, branch: 'issue-11', hook: 'test', tail: 'x', how: 'files', failingFiles: ['src/a.ts'], tip: 'abc' }, 'main', 'origin');
  const firstNote = buildFailureComment(b);
  const second = await applyBuildFailureBounce(w, b, DEFAULT_CONTRACT, 'm', silent, false, { count: 1, operatorId: 'op', previousNote: firstNote });
  assert.equal(second.kind, 'handed-back');
  assert.equal(patches[0]!.status, DEFAULT_CONTRACT.statuses.building);
  assert.match(notes[0]!, /Second hand-back for the same failure/);
  const third = await applyBuildFailureBounce(w, b, DEFAULT_CONTRACT, 'm', silent, false, { count: 2, operatorId: 'op', previousNote: notes[0] });
  assert.equal(third.kind, 'escalated');
  // a changed tip, or a different file, is not an unseen repeat
  const moved = { ...b, tip: 'def' };
  assert.equal((await applyBuildFailureBounce(w, moved, DEFAULT_CONTRACT, 'm', silent, false, { count: 1, operatorId: 'op', previousNote: firstNote })).kind, 'escalated');
});
