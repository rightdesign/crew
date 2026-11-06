import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periscopeSummary, previewHostProblem } from '../src/periscopes.ts';

const cfg = (over: { hosts?: boolean; previewHost?: string; relay?: boolean } = {}) => ({
  routes: [{ route: 'ws/proj', enabled: true, hostPeriscopes: over.hosts ?? false }],
  ship: { maxPeriscopes: 3, periscopeIdleMinutes: 120, previewHost: over.previewHost, relayPreviews: over.relay },
}) as unknown as Parameters<typeof periscopeSummary>[0];

test('periscopeSummary reports off, on, and a missing host', () => {
  assert.match(periscopeSummary(cfg()), /^off /);
  assert.match(periscopeSummary(cfg({ hosts: true, previewHost: 'h.local' })), /ON for ws\/proj \(host h\.local, max 3, idle 120 min\)/);
  assert.match(periscopeSummary(cfg({ hosts: true })), /NOT SET/);
});

test('previewHostProblem flags a missing or unresolvable host only when periscopes are hosted', async () => {
  assert.equal(await previewHostProblem(cfg(), async () => { throw new Error('x'); }), undefined);
  assert.match((await previewHostProblem(cfg({ hosts: true })))!, /not set/);
  assert.match((await previewHostProblem(cfg({ hosts: true, previewHost: 'nope.invalid' }), async () => { throw new Error('ENOTFOUND'); }))!, /does not resolve/);
  assert.equal(await previewHostProblem(cfg({ hosts: true, previewHost: 'ok.local' }), async () => ({})), undefined);
});

test('relayed previews need no previewHost (CREW-3059)', async () => {
  assert.equal(await previewHostProblem(cfg({ hosts: true, relay: true })), undefined);
  assert.match(periscopeSummary(cfg({ hosts: true, relay: true })), /previews relayed/);
});
