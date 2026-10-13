import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepStaleReleaseRoots } from '../src/git.ts';
import { closeReleaseCheckout } from '../src/release-run.ts';

test('closeReleaseCheckout removes the root even when worktree remove throws (CREW-1633)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'crew-tmp-'));
  const root = join(tmp, 'crew-release-abc123');
  mkdirSync(join(root, 'checkout'), { recursive: true });
  const calls: string[] = [];
  const run = (_cwd: string, args: string[]) => {
    calls.push(String(args[0]));
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('boom');
    return '';
  };
  assert.throws(() => closeReleaseCheckout('/nowhere', root, join(root, 'checkout'), 'b', run), /boom/);
  assert.equal(existsSync(root), false);
  assert.deepEqual(calls, ['worktree', 'worktree', 'branch']);
});

test('sweepStaleReleaseRoots removes old empty roots only', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'crew-tmp-'));
  const old = new Date(Date.now() - 3 * 3600_000);
  const mk = (name: string, withCheckout: boolean, mtime?: Date) => {
    const p = join(tmp, name);
    mkdirSync(withCheckout ? join(p, 'checkout') : p, { recursive: true });
    if (mtime) utimesSync(p, mtime, mtime);
  };
  mk('crew-release-oldempty', false, old);
  mk('crew-release-fresh', false);
  mk('crew-release-live', true, old);
  mk('unrelated', false, old);
  assert.deepEqual(sweepStaleReleaseRoots(tmp), ['crew-release-oldempty']);
  assert.equal(existsSync(join(tmp, 'crew-release-fresh')), true);
  assert.equal(existsSync(join(tmp, 'crew-release-live')), true);
  assert.equal(existsSync(join(tmp, 'unrelated')), true);
});
