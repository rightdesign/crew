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
