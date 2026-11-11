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

test('decideFleet logs a transient poll failure at warn and any other at error (CREW-3250)', async () => {
  const { decideFleet } = await import('../src/fleet.ts');
  const logged: Array<{ level: string; msg: string; step?: string }> = [];
  const emit = {
    forRoute: () => ({
      warn: (msg: string, x: { step?: string }) => logged.push({ level: 'warn', msg, step: x.step }),
      error: (msg: string, x: { step?: string }) => logged.push({ level: 'error', msg, step: x.step }),
    }),
  };
  const idle = { selection: { selected: undefined, ranks: {} }, actionable: { count: 0 }, attention: [], unroutable: [] };
  const state = { fairness: () => ({ record: () => {} }) };
  const decide = async ({ route }: { route: { route: string } }) => {
    if (route.route === 'blip') throw new Error('fetch failed');
    if (route.route === 'bug') throw new Error('422 Unprocessable');
    return idle;
  };
  const route = (n: string) => ({ route: n, enabled: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = await decideFleet({ routes: ['blip', 'bug', 'fine'].map(route), ship: {}, state, emit, decide, dryRun: true } as any);
  assert.deepEqual(logged.sort((a, b) => a.msg.localeCompare(b.msg)), [
    { level: 'warn', msg: 'blip: fetch failed', step: 'poll' },
    { level: 'error', msg: 'bug: 422 Unprocessable', step: 'poll' },
  ]);
  assert.deepEqual(f.unreachable.sort(), ['blip', 'bug']);
  assert.equal(f.entries.find((e) => e.route.route === 'fine')?.error, undefined);
});
