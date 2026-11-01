import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipIdentityJson } from '../src/ship-status.ts';

test('carries id, kind, instance class and relay URL', () => {
  assert.deepEqual(
    shipIdentityJson({ id: 's1', kind: 'managed', instance_class: 'small', relay_url: 'https://r.example' }),
    { id: 's1', kind: 'managed', instanceClass: 'small', relayUrl: 'https://r.example' },
  );
});

test('a ship whose tunnel is down shows relayUrl null', () => {
  assert.equal(shipIdentityJson({ id: 's1', kind: 'managed', instance_class: 'small', relay_url: null }).relayUrl, null);
});

test('a row without the runtime columns yields null keys, not omitted ones', () => {
  const out = shipIdentityJson({ id: 's2' });
  assert.deepEqual(out, { id: 's2', kind: null, instanceClass: null, relayUrl: null });
  assert.ok('kind' in out && 'instanceClass' in out && 'relayUrl' in out);
});
