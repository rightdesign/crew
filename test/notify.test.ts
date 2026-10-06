import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { notify, describeRelease } from '../src/notify.ts';
import { Emitter } from '../src/events.ts';
import type { Route, Ship } from '../src/config.ts';

const lines: string[] = [];
const emitter = () => { lines.length = 0; return new Emitter({ route: 'c', console: (l) => lines.push(l), cycleId: 'C' }); };
const SHIP = { name: 'Test Ship', shell: undefined } as unknown as Ship;
const route = (notifyHook?: string, dir = '/tmp'): Route =>
  ({ route: 'test/proj', dir, hooks: { notify: notifyHook } }) as unknown as Route;

test('a route with no notify hook is silent, not an error', async () => {
  assert.equal(await notify(route(undefined), SHIP, { level: 'ok', headline: 'x' }, emitter()), false);
  assert.deepEqual(lines, []);
});

test('the hook receives the level, headline and detail — and nothing else decides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-notify-'));
  const out = join(dir, 'got.txt');
  const c = route(`printf '%s|%s|%s|%s|%s' "$CREW_LEVEL" "$CREW_HEADLINE" "$CREW_DETAIL" "$CREW_ROUTE" "$CREW_SHIP" > ${out}`, dir);
  await notify(c, SHIP, { level: 'fail', headline: 'it broke', detail: 'badly' }, emitter());
  assert.equal(readFileSync(out, 'utf8'), 'fail|it broke|badly|test/proj|Test Ship');
});

test('a broken notifier warns and never fails the release', async () => {
  // The release already happened by the time this runs. A hook that exits
  // non-zero, or does not exist at all, must not turn a good release bad.
  const emit = emitter();
  assert.equal(await notify(route('exit 3'), SHIP, { level: 'ok', headline: 'x' }, emit), true);
  assert.ok(lines.some((l) => /notify hook exited 3/.test(l)));
});

test('a dry run says what it would send and sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-notify-'));
  const out = join(dir, 'sent.txt');
  await notify(route(`touch ${out}`, dir), SHIP, { level: 'ok', headline: 'shipped 1.2.3' }, emitter(), true);
  assert.equal(existsSync(out), false);
  assert.ok(lines.some((l) => /would notify: \[ok\] shipped 1\.2\.3/.test(l)));
});

test('only outcomes worth interrupting someone for produce a notification', () => {
  const n = (o: Parameters<typeof describeRelease>[0]) => describeRelease(o, 'proj');
  assert.equal(n({ deployed: true, confirmed: true, version: '1.2.3', merged: [1, 2] })?.level, 'ok');
  // Shipped but unconfirmed is not a failure — it may just be slow — and not a
  // clean success either.
  assert.equal(n({ deployed: true, confirmed: false, version: '1.2.3', merged: [1] })?.level, 'warn');
  assert.equal(n({ deployed: false, merged: [], stopped: 'tests failed' })?.level, 'fail');
  assert.equal(n({ deployed: false, merged: [], stopped: 'deploy failed' })?.level, 'fail');
  assert.equal(n({ deployed: false, merged: [], stopped: 'build failed' })?.level, 'fail');
  assert.equal(n({ deployed: false, merged: [], stopped: 'build failed' })?.headline, 'proj: build FAILED');
  // The quiet cases. Most cycles are these, and waking someone for them would
  // train them to ignore the ones that matter.
  assert.equal(n({ deployed: false, merged: [], stopped: 'nothing to release' }), null);
  assert.equal(n({ deployed: false, merged: [], stopped: 'external' }), null);
  assert.equal(n({ alreadyLive: true, merged: [1], stopped: 'already contained in the base branch' }), null);
});

test('a dirty tree or wrong-branch checkout stays quiet for one cycle, then escalates', () => {
  const n = (o: Parameters<typeof describeRelease>[0]) => describeRelease(o, 'proj');
  // One blocked cycle is normal — someone is mid-edit.
  assert.equal(n({ deployed: false, merged: [], stopped: 'working tree has 1 change(s)', blockKind: 'dirty' }), null);
  assert.equal(
    n({ deployed: false, merged: [], stopped: 'working tree has 1 change(s)', blockKind: 'dirty', blockedCycles: 1 }),
    null,
  );
  // Past that, it must be as loud as a build/test/deploy failure — this is
  // ISSUE-174's silent eight-commits-behind-one-untracked-file case.
  const persisting = n({
    deployed: false, merged: [], stopped: 'working tree has 1 change(s): stray.png', blockKind: 'dirty', blockedCycles: 2,
  });
  assert.equal(persisting?.level, 'fail');
  assert.equal(persisting?.headline, 'proj: release blocked — working tree is not clean');
  // The headline must stay stable across cycles (no file names, no counts) so
  // failure-alert.ts's exact-headline dedup comments on one ticket instead of
  // filing a new one every cycle.
  const laterCycle = n({
    deployed: false, merged: [], stopped: 'working tree has 2 change(s): other.png', blockKind: 'dirty', blockedCycles: 9,
  });
  assert.equal(laterCycle?.headline, persisting?.headline);

  const wrongBranch = n({
    deployed: false, merged: [], stopped: "primary checkout is on 'foo', not main", blockKind: 'branch', blockedCycles: 2,
  });
  assert.equal(wrongBranch?.level, 'fail');
  assert.equal(wrongBranch?.headline, 'proj: release blocked — checkout is not on the base branch');
});

test('setup/build/deploy failures carry the hook name and its output tail; the headline stays fixed', () => {
  const hookFailure = { hook: 'setup', label: 'pnpm run setup', tail: 'Error: The datasource.url property is required' };
  const setup = describeRelease({ merged: [], stopped: 'setup failed', hookFailure }, 'r');
  assert.equal(setup?.headline, 'r: release blocked — setup failed');
  assert.match(setup?.detail ?? '', /setup hook failed/);
  assert.match(setup?.detail ?? '', /datasource\.url property is required/);
  assert.match(setup?.detail ?? '', /`pnpm run setup`/);
  const deploy = describeRelease({ merged: [], stopped: 'deploy failed', hookFailure: { ...hookFailure, hook: 'deploy' } }, 'r');
  assert.equal(deploy?.headline, 'r: deploy FAILED');
  assert.match(deploy?.detail ?? '', /datasource\.url/);
  const build = describeRelease({ merged: [], stopped: 'build failed', hookFailure: { ...hookFailure, hook: 'build' } }, 'r');
  assert.match(build?.detail ?? '', /datasource\.url/);
  // No output captured: the plain line, not an empty fence.
  assert.equal(describeRelease({ merged: [], stopped: 'deploy failed' }, 'r')?.detail, 'the version is merged to the base branch but not live — run `crew deploy` to retry; do not re-release');
});
