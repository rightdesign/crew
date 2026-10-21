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
  buildFailureComment, BUILD_FAILURE_MARKER,
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

test('over release.isolateFailures.maxCandidates the release fails as before', async () => {
  const { dir, repo } = release({ loud: false, extra: 'release:\n  isolateFailures: { maxCandidates: 2 }\n' });
  const out = await run(dir, repo);
  assert.equal(out.buildCulprits, undefined);
  assert.equal(out.stopped, 'build failed');
  assert.ok(out.hookFailure);
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
  assert.match(buildFailureComment(bounce), /git merge origin\/main/);
  const stale = { ...w, updateTicket: async () => { throw new StaleWriteError({}); } };
  assert.equal((await applyBuildFailureBounce(stale, bounce, DEFAULT_CONTRACT, 'm', silent, false)).kind, 'stale');
  assert.equal((await applyBuildFailureBounce(w, bounce, DEFAULT_CONTRACT, 'm', silent, true)).kind, 'handed-back');
  assert.equal(patches.length, 1);
});
