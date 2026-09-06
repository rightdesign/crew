import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeDevice, pollForDeviceToken, DeviceAuthExpired, DeviceAuthDenied,
  type DeviceAuthorization,
} from '../src/device-auth.ts';

/** Queues one Response per call to a given pathname, in order — unlike connect.test.ts's mockFetch (keyed once per path), polling hits the SAME path repeatedly with a different answer each time. */
function mockFetchSequence(responses: Record<string, Array<{ status: number; body: unknown }>>) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    const queue = responses[url.pathname];
    if (!queue || queue.length === 0) {
      return new Response(JSON.stringify({ message: 'no more mocked responses' }), { status: 500 });
    }
    const next = queue.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, calls };
}

const AUTH: DeviceAuthorization = {
  deviceCode: 'device-code-1',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://example.test/device',
  verificationUriComplete: 'https://example.test/device?user_code=WDJB-MJHT',
  expiresIn: 60,
  interval: 0, // 0 so the test doesn't actually wait between polls
};

test('authorizeDevice posts to /auth/device/authorize with no Authorization header — this call has no key yet', async (t) => {
  const { restore, calls } = mockFetchSequence({
    '/api/auth/device/authorize': [{ status: 200, body: AUTH }],
  });
  t.after(restore);

  const originalFetch = globalThis.fetch;
  let sawAuthHeader = false;
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.has('Authorization')) sawAuthHeader = true;
    return originalFetch(input, init);
  }) as typeof fetch;

  const result = await authorizeDevice('https://example.test', 'crew-test', 'crew on my-laptop');
  assert.deepEqual(result, AUTH);
  assert.deepEqual(calls, ['/api/auth/device/authorize']);
  assert.equal(sawAuthHeader, false);
});

test('pollForDeviceToken keeps polling through authorization_pending until the browser approves', async (t) => {
  const result = {
    apiKey: { id: 'key-1', name: 'Device login', keyPrefix: 'sk_abc', key: 'sk_abc123', createdAt: '2026-09-06T00:00:00Z' },
    workspace: { id: 'ws-1', slug: 'acme', name: 'Acme' },
    identity: { id: 'id-1', name: 'Alice', email: 'alice@example.com' },
  };
  const { restore, calls } = mockFetchSequence({
    '/api/auth/device/token': [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: result },
    ],
  });
  t.after(restore);

  let waitingCount = 0;
  const got = await pollForDeviceToken('https://example.test', 'crew-test', AUTH, () => { waitingCount++; });
  assert.deepEqual(got, result);
  assert.equal(calls.length, 3);
  assert.equal(waitingCount, 2);
});

test('pollForDeviceToken throws DeviceAuthExpired on expired_token, without retrying further', async (t) => {
  const { restore, calls } = mockFetchSequence({
    '/api/auth/device/token': [{ status: 400, body: { error: 'expired_token' } }],
  });
  t.after(restore);

  await assert.rejects(
    () => pollForDeviceToken('https://example.test', 'crew-test', AUTH),
    DeviceAuthExpired,
  );
  assert.equal(calls.length, 1);
});

test('pollForDeviceToken throws DeviceAuthDenied when the browser denies it', async (t) => {
  const { restore } = mockFetchSequence({
    '/api/auth/device/token': [{ status: 400, body: { error: 'access_denied' } }],
  });
  t.after(restore);

  await assert.rejects(
    () => pollForDeviceToken('https://example.test', 'crew-test', AUTH),
    DeviceAuthDenied,
  );
});

test('pollForDeviceToken treats slow_down as "keep polling", not a failure', async (t) => {
  const result = {
    apiKey: { id: 'key-1', name: 'Device login', keyPrefix: 'sk_abc', key: 'sk_abc123', createdAt: '2026-09-06T00:00:00Z' },
    workspace: { id: 'ws-1', slug: 'acme', name: 'Acme' },
    identity: { id: 'id-1', name: 'Alice', email: 'alice@example.com' },
  };
  const { restore, calls } = mockFetchSequence({
    '/api/auth/device/token': [
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: result },
    ],
  });
  t.after(restore);

  const got = await pollForDeviceToken('https://example.test', 'crew-test', AUTH);
  assert.deepEqual(got, result);
  assert.equal(calls.length, 2);
});
