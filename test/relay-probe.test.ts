import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRelayProbe, probeRelayControl } from '../src/relay-probe.ts';

test('probeRelayControl() GETs <url>/control/status with the ship key and reports latency (CREW-2803)', async () => {
  let seen: { url: string; auth: string } | undefined;
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen = { url, auth: (init.headers as Record<string, string>).Authorization! };
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch; // a stub; only url and headers are read
  const p = await probeRelayControl('https://s.example.com/', 'sk_x', 'UA', fetchFn);
  assert.equal(seen!.url, 'https://s.example.com/control/status');
  assert.equal(seen!.auth, 'Bearer sk_x');
  assert.equal(p.ok, true);
  assert.match(describeRelayProbe('https://s.example.com', p), /^relay control:\s+OK .* \(200, \d+ ms\)$/);
});

test('probeRelayControl() reports an HTTP failure and a network failure without the key (CREW-2803)', async () => {
  const bad = (async () => new Response('no', { status: 502 })) as unknown as typeof fetch;
  const p = await probeRelayControl('https://s.example.com', 'sk_secret', 'UA', bad);
  assert.deepEqual(p, { ok: false, status: 502, error: 'HTTP 502' });
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const q = await probeRelayControl('https://s.example.com', 'sk_secret', 'UA', down);
  assert.equal(q.ok, false);
  assert.ok(!describeRelayProbe('https://s.example.com', q).includes('sk_secret'));
});
