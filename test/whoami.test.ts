import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhoami, formatWhoami } from '../src/whoami.ts';
import type { Route } from '../src/config.ts';

const route = (name: string, extra: Partial<Route> = {}) => ({
  route: name, baseUrl: 'https://t.example', apiKey: 'sk_test',
  resolved: { workspaceId: 'ws1', operator: 'crew1' },
  ...extra,
}) as unknown as Route;

const reply = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('whoami reports identity, role, operator and credential source', async () => {
  const seen: string[] = [];
  const report = await buildWhoami([route('a/b')], {
    fetch: (async (u: string, init: RequestInit) => {
      seen.push(`${u} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ id: 'u1', email: 'x@y.z', name: 'X', role: 'WORKSPACE_ADMIN' }));
    }) as unknown as typeof fetch,
    operatorName: async () => 'Brad C.',
  });
  assert.deepEqual(seen, ['https://t.example/api/auth/me?workspaceId=ws1 Bearer sk_test']);
  assert.deepEqual(report, [{
    route: 'a/b', ok: true, credential: 'inline',
    identity: { id: 'u1', email: 'x@y.z', name: 'X' }, role: 'WORKSPACE_ADMIN',
    operator: { id: 'crew1', name: 'Brad C.' },
  }]);
  assert.match(formatWhoami(report), /signed in as: X <x@y.z> \(u1\)/);
  assert.doesNotMatch(JSON.stringify(report), /sk_test/);
});

test('a 401 gives a one-line reason and does not hide other routes', async () => {
  let n = 0;
  const report = await buildWhoami([route('bad'), route('ok')], {
    fetch: (async () => (n++ === 0 ? new Response('{}', { status: 401 }) : new Response('{"id":"u"}'))) as unknown as typeof fetch,
  });
  assert.equal(report[0]!.ok, false);
  assert.match((report[0] as { error: string }).error, /HTTP 401/);
  assert.equal(report[1]!.ok, true);
});

test('an operator-name failure leaves the operator unnamed', async () => {
  const [r] = await buildWhoami([route('a/b')], { fetch: reply(200, { id: 'u' }), operatorName: async () => { throw new Error('x'); } });
  assert.ok(r?.ok);
  assert.equal(r.operator.name, null);
});
