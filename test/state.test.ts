import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State, EPOCH } from '../src/state.ts';

const fresh = () => new State(mkdtempSync(join(tmpdir(), 'crew-state-')));

test('before the first poll, everything is new', () => {
  assert.equal(fresh().watermark(), EPOCH);
});

test('the watermark advances to the newest thing SEEN, never to the clock', () => {
  const s = fresh();
  const next = s.advanceWatermark([
    { created_at: '2026-08-01T00:00:00Z' },
    { created_at: '2026-08-03T00:00:00Z' },
    { updated_at: '2026-08-02T00:00:00Z' },
  ]);
  assert.equal(next, '2026-08-03T00:00:00Z');
  assert.equal(s.watermark(), '2026-08-03T00:00:00Z');
  // Using the clock here would skip anything written between fetch and write.
  assert.ok(next < new Date().toISOString());
});

test('an empty cycle leaves the watermark where it was', () => {
  const s = fresh();
  s.setWatermark('2026-08-01T00:00:00Z');
  assert.equal(s.advanceWatermark([]), '2026-08-01T00:00:00Z');
});

test('a corrupt or empty watermark file reads as the epoch, not as a crash', () => {
  const s = fresh();
  s.setWatermark('   ');
  assert.equal(s.watermark(), EPOCH);
});

test('pausing the crew and pausing one role are separate', () => {
  const s = fresh();
  assert.equal(s.isPaused(), false);
  s.pause('dev');
  assert.equal(s.isPaused(), false);            // the crew is not paused
  assert.equal(s.isRolePaused('dev'), true);
  assert.equal(s.isRolePaused('qa'), false);
  assert.deepEqual([...s.pausedRoles(['dev', 'qa', 'design'])], ['dev']);
  s.resume('dev');
  assert.equal(s.isRolePaused('dev'), false);
  s.pause();
  assert.equal(s.isPaused(), true);
  s.resume();
  assert.equal(s.isPaused(), false);
});

test('resuming something that was never paused is not an error', () => {
  const s = fresh();
  s.resume();
  s.resume('qa');
  assert.equal(s.isPaused(), false);
});

test('the release-block counter is what makes a persistent refusal loud', () => {
  const r = fresh().release('proj');
  assert.equal(r.blockedCount(), 0);
  assert.equal(r.noteBlocked(), 1);   // one blocked cycle is normal
  assert.equal(r.noteBlocked(), 2);   // two is the alarm
  r.clearBlocked();
  assert.equal(r.blockedCount(), 0);
});

test('release state is per connection, not per ship', () => {
  // A ship serves several boards and releases each repo independently. These
  // were single global files, so one repo's failed deploy suppressed releases
  // on every other board, and a dirty tree in one checkout counted blocked
  // cycles for all of them.
  const s = fresh();
  const a = s.release('alpha');
  const b = s.release('beta');

  a.noteDeployFailed('deadbeef');
  a.noteBlocked();
  assert.equal(a.deployFailedSha(), 'deadbeef');
  assert.equal(b.deployFailedSha(), null, 'beta must not inherit alpha\'s failure');
  assert.equal(b.blockedCount(), 0);

  b.noteDeployFailed('cafe');
  assert.equal(a.deployFailedSha(), 'deadbeef', 'and alpha must not be overwritten');
  a.clearDeployFailed();
  assert.equal(b.deployFailedSha(), 'cafe', 'clearing one must not clear the other');
});

test('a connection name that is not a safe filename still gets its own state', () => {
  const s = fresh();
  const odd = s.release('my repo/v2');
  odd.noteDeployFailed('abc');
  assert.equal(odd.deployFailedSha(), 'abc');
  // ...and does not collide with a different name that sanitises the same way
  // being read back as the same thing by accident.
  assert.equal(s.release('other').deployFailedSha(), null);
});

test('a second run is refused while the first holds the lock', () => {
  const s = fresh();
  const first = s.acquire('crew');
  assert.equal(first.ok, true);
  const second = s.acquire('crew');
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.heldBy, process.pid);
  if (first.ok) first.release();
  assert.equal(s.acquire('crew').ok, true);   // released
});

test('a lock naming a dead pid is stale and taken over', () => {
  // A run killed mid-cycle must not wedge the crew until someone notices.
  const s = fresh();
  writeFileSync(join(s.dir, '.crew.lock'), '999999\n');   // a pid that cannot be alive
  assert.equal(s.acquire('crew').ok, true);
});

test('locks are per name, so a release does not block a run', () => {
  const s = fresh();
  assert.equal(s.acquire('release').ok, true);
  assert.equal(s.acquire('crew').ok, true);
});

// ---------------------------------------------------------------------------
// acquireN / acquireRun (ISSUE-381)
// ---------------------------------------------------------------------------

test('acquireN takes whichever numbered slot is free', () => {
  const s = fresh();
  const first = s.acquireN('slot', 2);
  assert.equal(first.ok, true);
  const second = s.acquireN('slot', 2);
  assert.equal(second.ok, true);
  const third = s.acquireN('slot', 2);
  assert.equal(third.ok, false);
  if (!third.ok) assert.deepEqual(third.heldBy, [process.pid, process.pid]);
  if (second.ok) second.release();
  assert.equal(s.acquireN('slot', 2).ok, true);   // slot 2 freed up
});

test('acquireRun refuses a SECOND session of the same role even with slots free', () => {
  const s = fresh();
  const first = s.acquireRun('dev', 5);
  assert.equal(first.ok, true);
  const second = s.acquireRun('dev', 5);
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /dev is already running \(pid \d+\)/);
});

test('acquireRun lets two DIFFERENT roles run at once, up to the limit', () => {
  const s = fresh();
  assert.equal(s.acquireRun('dev', 2).ok, true);
  assert.equal(s.acquireRun('qa', 2).ok, true);
  const third = s.acquireRun('design', 2);
  assert.equal(third.ok, false);
  if (!third.ok) assert.match(third.reason, /at capacity — 2 agent\(s\) already running/);
});

test('acquireRun releasing gives back BOTH the role lock and the slot', () => {
  const s = fresh();
  const dev = s.acquireRun('dev', 1);
  assert.equal(dev.ok, true);
  if (dev.ok) dev.release();
  // Same role, same single slot — both must be free again.
  assert.equal(s.acquireRun('dev', 1).ok, true);
});

test('acquireRun gives the slot back when the role lock is held, not just the reverse', () => {
  // A role locked elsewhere must not also burn a capacity slot: taking the
  // role lock and then failing on capacity has to release the role lock too.
  const s = fresh();
  const heldRole = s.acquire('crew-role-dev');
  assert.equal(heldRole.ok, true);
  const attempt = s.acquireRun('dev', 1);
  assert.equal(attempt.ok, false);
  // The slot was never actually taken by the failed attempt.
  assert.equal(s.acquireN('crew-slot', 1).ok, true);
});

// ---------------------------------------------------------------------------
// fairness (ISSUE-382)
// ---------------------------------------------------------------------------

test('fairness: winning or running dry both clear the streak', () => {
  const f = fresh().fairness('proj');
  f.record(3, 'ISSUE-1', false);
  f.record(3, 'ISSUE-1', false);
  assert.equal(f.streak(), 2);
  assert.equal(f.waiting()?.ticket, 'ISSUE-1');
  assert.equal(f.waiting()?.streak, 2);

  f.record(2, 'ISSUE-1', true);   // this connection won this cycle
  assert.equal(f.streak(), 0);
  assert.equal(f.waiting(), undefined);

  f.record(1, 'ISSUE-2', false);
  f.record(0, undefined, false);   // ran dry — nothing left waiting
  assert.equal(f.streak(), 0);
  assert.equal(f.waiting(), undefined);
});

test('fairness: a new top ticket resets the per-ticket streak, not the connection streak', () => {
  const f = fresh().fairness('proj');
  f.record(2, 'ISSUE-1', false);
  f.record(2, 'ISSUE-1', false);
  assert.equal(f.waiting()?.streak, 2);

  // ISSUE-1 got picked up by a person, or a higher-priority ticket landed —
  // either way a DIFFERENT ticket is now at the front of the queue.
  f.record(2, 'ISSUE-2', false);
  assert.equal(f.streak(), 3, 'the connection is still being passed over');
  assert.equal(f.waiting()?.ticket, 'ISSUE-2');
  assert.equal(f.waiting()?.streak, 1, 'but the new front-of-queue ticket starts fresh');
});

test('fairness state is per connection, not per ship', () => {
  const s = fresh();
  s.fairness('alpha').record(5, 'ISSUE-1', false);
  assert.equal(s.fairness('alpha').streak(), 1);
  assert.equal(s.fairness('beta').streak(), 0, 'beta must not inherit alpha\'s streak');
});

test('fairness: an unsafe connection name still gets its own state', () => {
  const s = fresh();
  s.fairness('my repo/v2').record(1, 'ISSUE-9', false);
  assert.equal(s.fairness('my repo/v2').waiting()?.ticket, 'ISSUE-9');
  assert.equal(s.fairness('other').waiting(), undefined);
});
