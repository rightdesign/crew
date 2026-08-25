import { test } from 'node:test';
import assert from 'node:assert/strict';
import { since } from '../src/fleet.ts';

test('since renders the coarsest unit that reads naturally', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  assert.equal(since('2026-08-25T11:45:00.000Z', now), '15m');
  assert.equal(since('2026-08-25T09:00:00.000Z', now), '3h');
  assert.equal(since('2026-08-20T12:00:00.000Z', now), '5d');
});

test('since never goes negative on clock skew', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  assert.equal(since('2026-08-25T12:00:05.000Z', now), '0m');
});
