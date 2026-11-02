import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { dropFileMtime, pointedAtEnv, pointedAtFile, prepareDropFile, readPointedAt } from '../src/periscope-pointed.ts';
import { newestWorktreeMtime } from '../src/periscope-idle.ts';
import { periscopesForStatus, writePeriscopeSidecar } from '../src/periscope-state.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

/** A real linked worktree, as `periscope up` cuts one. */
function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'pointed-'));
  const main = join(root, 'main');
  git(root, 'init', '-q', main);
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'b', wt);
  return wt;
}

test('prepareDropFile creates an empty file, excludes .crew/ from git, and is idempotent', () => {
  const wt = worktree();
  assert.equal(prepareDropFile(wt), pointedAtFile(wt));
  assert.equal(readFileSync(pointedAtFile(wt), 'utf8'), '');
  appendFileSync(pointedAtFile(wt), '{"path":"a.ts","line":1,"at":"2026-11-01T00:00:00Z"}\n');
  prepareDropFile(wt);
  assert.match(readFileSync(pointedAtFile(wt), 'utf8'), /a\.ts/, 'an existing file is left alone');
  assert.equal(git(wt, 'status', '--porcelain').trim(), '', 'git sees nothing from .crew/');
  const ex = git(wt, 'rev-parse', '--git-path', 'info/exclude').trim();
  const text = readFileSync(resolve(wt, ex), 'utf8');
  assert.equal(text.split('\n').filter((l) => l === '.crew/').length, 1);
});

test('pointedAtEnv names the absolute drop file', () => {
  assert.deepEqual(pointedAtEnv('/w/x'), { CREW_PERISCOPE: '1', CREW_POINTED_AT_FILE: '/w/x/.crew/pointed-at.jsonl' });
});

test('readPointedAt returns the newest well-formed line and skips torn or foreign ones', () => {
  const wt = worktree();
  assert.equal(readPointedAt(wt), null);
  prepareDropFile(wt);
  assert.equal(readPointedAt(wt), null);
  writeFileSync(pointedAtFile(wt), [
    '{"path":"a.ts","line":3,"at":"2026-11-01T00:00:00Z"}',
    '{"path":"b.tsx","line":9,"column":2,"component":"Nav","at":"2026-11-01T00:01:00Z","url":"http://x/y"}',
    '{"path":"c.ts","line":0,"at":"z"}',
    '{"path":"d.ts","li',
  ].join('\n'));
  assert.deepEqual(readPointedAt(wt), { path: 'b.tsx', line: 9, column: 2, component: 'Nav', at: '2026-11-01T00:01:00Z', url: 'http://x/y' });
});

test('a new line in the drop file counts as worktree activity even though .crew/ is git-excluded', () => {
  const wt = worktree();
  prepareDropFile(wt);
  const old = new Date('2020-01-01T00:00:00Z');
  for (const f of ['.git', 'README']) if (existsSync(join(wt, f)) && f !== '.git') utimesSync(join(wt, f), old, old);
  const before = newestWorktreeMtime(wt);
  const later = new Date(Date.now() + 60_000);
  utimesSync(pointedAtFile(wt), later, later);
  assert.equal(dropFileMtime(wt), later.getTime());
  assert.ok(newestWorktreeMtime(wt)! >= later.getTime());
  assert.ok(before === null || before < later.getTime());
});

test('periscopesForStatus exposes the newest pointedAt', async () => {
  const wt = worktree();
  prepareDropFile(wt);
  appendFileSync(pointedAtFile(wt), '{"path":"a.ts","line":5,"at":"2026-11-01T00:00:00Z"}\n');
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  writePeriscopeSidecar(dir, {
    ticket: 'TABL-1', ticketRecordId: 'r1', periscopeRecordId: 'p1', repo: 'x', worktree: wt, branch: 'b', url: 'http://localhost:4000',
    host: 'localhost', state: 'live', isolated: false, startedAt: 'a', lastActivityAt: 'a', expiresAt: 'a',
  });
  const [s] = await periscopesForStatus(dir, async () => true);
  assert.equal(s!.pointedAt?.path, 'a.ts');
});
