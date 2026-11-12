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

test('probeRelayControl() reports an HTTP failure without the key (CREW-2803)', async () => {
  const bad = (async () => new Response('no', { status: 502 })) as unknown as typeof fetch;
  const p = await probeRelayControl('https://s.example.com', 'sk_secret', 'UA', bad);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.status, 502);
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const q = await probeRelayControl('https://s.example.com', 'sk_secret', 'UA', down);
  assert.equal(q.ok, false);
  assert.ok(!describeRelayProbe('https://s.example.com', q).includes('sk_secret'));
});

const asFetch = (f: (url: string) => Promise<Response>) => f as unknown as typeof fetch; // a stub; only the URL is read
const streamsOk = (url: string) => url.endsWith('/control/streams') ? new Response('{}', { status: 200 }) : null;

test('probeRelayControl() classifies a relay 5xx with no JSON body as the tunnel being down (CREW-3276)', async () => {
  const f = asFetch(async (url) => streamsOk(url) ?? new Response('Bad Gateway', { status: 502 }));
  const p = await probeRelayControl('https://s.example.com', 'sk_x', 'UA', f);
  assert.equal(p.ok, false);
  if (!p.ok) { assert.equal(p.kind, 'tunnel_down'); assert.match(p.remedy!, /crew passengers/); }
  const text = describeRelayProbe('https://s.example.com', p);
  assert.match(text, /fix: run `crew passengers`/);
  // The tunnel can be down at the very first request, too.
  const g = asFetch(async () => new Response('', { status: 503 }));
  const q = await probeRelayControl('https://s.example.com', 'sk_x', 'UA', g);
  if (!q.ok) assert.equal(q.kind, 'tunnel_down'); else assert.fail('expected a failure');
});

test('probeRelayControl() classifies 401/403 as a refused key with the connect remedy (CREW-3276)', async () => {
  for (const status of [401, 403]) {
    const p = await probeRelayControl('https://s.example.com', 'sk_secret', 'UA', asFetch(async () => new Response('{"error":"nope"}', { status })));
    assert.equal(p.ok, false);
    if (!p.ok) { assert.equal(p.kind, 'key_refused'); assert.equal(p.status, status); assert.match(p.remedy!, /crew connect/); }
    assert.ok(!describeRelayProbe('https://s.example.com', p).includes('sk_secret'));
  }
});

test('probeRelayControl() surfaces the ship\'s own reason and detail when it cannot build its status (CREW-3276)', async () => {
  const body = JSON.stringify({ reason: 'exited', detail: 'exit code 1: config error on route primary' });
  const f = asFetch(async (url) => streamsOk(url) ?? new Response(body, { status: 502 }));
  const p = await probeRelayControl('https://s.example.com', 'sk_x', 'UA', f);
  assert.equal(p.ok, false);
  if (!p.ok) {
    assert.equal(p.kind, 'status_failed');
    assert.match(p.error, /exited: exit code 1: config error on route primary/);
    assert.match(p.remedy!, /crew status <route> --json/);
  }
});

test('probeRelayControl() reports a timeout, and gives /control/status a longer limit than liveness (CREW-3276)', async () => {
  const hang = asFetch((url) => new Promise<Response>((_res, rej) => {
    void url;
    setTimeout(() => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 5);
  }));
  const p = await probeRelayControl('https://s.example.com', 'sk_x', 'UA', hang, 50, 50);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.kind, 'timed_out');

  // A status document slower than the liveness limit but inside its own limit passes.
  const slow = asFetch(async (url) => {
    if (url.endsWith('/control/streams')) return new Response('{}', { status: 200 });
    await new Promise((r) => setTimeout(r, 120));
    return new Response('{"route":"primary"}', { status: 200 });
  });
  const ok = await probeRelayControl('https://s.example.com', 'sk_x', 'UA', slow, 50, 2000);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.route, 'primary');
});
