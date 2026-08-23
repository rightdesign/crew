import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  satisfies, hostPlatform, eligibleShips, explain,
  isShipPlatform, isPlatformRequirement, PLATFORM_REQUIREMENTS, SHIP_PLATFORMS,
} from '../src/platform.ts';

test('unix is satisfied by macOS or Linux, but never Windows', () => {
  assert.ok(satisfies('macos', 'unix'));
  assert.ok(satisfies('linux', 'unix'));
  assert.ok(!satisfies('windows', 'unix'));
});

test('a narrower requirement than the family it belongs to (Xcode case)', () => {
  // A macOS-only project is NOT runnable on Linux, even though both are unix.
  assert.ok(satisfies('macos', 'macos'));
  assert.ok(!satisfies('linux', 'macos'));
});

test('any is satisfied by every ship', () => {
  for (const s of SHIP_PLATFORMS) assert.ok(satisfies(s, 'any'));
});

test('every requirement is satisfiable by at least one ship', () => {
  for (const r of PLATFORM_REQUIREMENTS) {
    assert.ok(eligibleShips(r).length > 0, `${r} is satisfied by nothing`);
  }
});

test('a concrete requirement is satisfied by exactly its own host', () => {
  for (const s of SHIP_PLATFORMS) {
    assert.deepEqual(eligibleShips(s), [s]);
  }
});

test('node platforms map into the ship vocabulary', () => {
  assert.equal(hostPlatform('darwin'), 'macos');
  assert.equal(hostPlatform('win32'), 'windows');
  assert.equal(hostPlatform('linux'), 'linux');
  assert.equal(hostPlatform('freebsd'), 'linux'); // other POSIX hosts behave alike
});

test('guards reject values from the wrong vocabulary', () => {
  assert.ok(isShipPlatform('macos'));
  assert.ok(!isShipPlatform('unix'));   // a family is not a host
  assert.ok(!isShipPlatform('any'));
  assert.ok(isPlatformRequirement('unix'));
  assert.ok(isPlatformRequirement('macos'));
  assert.ok(!isPlatformRequirement('darwin'));
});

test('a refusal explains what would satisfy it', () => {
  assert.match(explain('linux', 'macos'), /this ship is linux, but the project requires macos/);
  assert.match(explain('linux', 'macos'), /satisfied by: macos/);
  assert.match(explain('linux', 'unix'), /this ship is linux, and the project requires unix/);
});
