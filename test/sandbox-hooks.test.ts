import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxHookGaps } from '../src/sandbox-hooks.ts';
import { repoFindings } from '../src/doctor-problems.ts';

const o = { route: 'w/p', repo: 'app', image: 'crew-sandbox-app:abc', declares: true, hooks: { setup: 'pnpm install', test: 'swift test', build: 'pnpm build' } };

test('binaries the image carries raise nothing, and each is asked of the image once', () => {
  const asked: string[] = [];
  const gaps = sandboxHookGaps({ ...o, hasBinary: (_i, b) => { asked.push(b); return true; } });
  assert.deepEqual(gaps, []);
  assert.deepEqual(asked, ['pnpm', 'swift']);
});

test('a binary the image lacks is one gap naming the image and the declaration to fix', () => {
  const gaps = sandboxHookGaps({ ...o, hasBinary: (_i, b) => b !== 'swift' });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.hook, 'test');
  assert.match(gaps[0]!.message, /crew-sandbox-app:abc/);
  assert.match(gaps[0]!.message, /sandbox\.packages/);
  assert.doesNotMatch(gaps[0]!.message, /extraPath/);
});

test('an image that is not built yet is not asked', () => {
  assert.deepEqual(sandboxHookGaps({ ...o, image: null, hasBinary: () => { throw new Error('asked'); } }), []);
});

test('repoFindings on a sandbox ship ignores the host PATH and reports the image gaps', () => {
  const base = { route: 'w/p', repo: 'app', dir: '/x', notes: [], base: { message: '', failed: false, skipRest: false }, hooks: o.hooks, onPath: () => false };
  assert.equal(repoFindings({ ...base, sandboxGaps: [] }).problems.length, 0);
  const f = repoFindings({ ...base, sandboxGaps: sandboxHookGaps({ ...o, hasBinary: () => false }) });
  assert.equal(f.problems.filter((p) => p.kind === 'hook_missing').length, 3);
});
