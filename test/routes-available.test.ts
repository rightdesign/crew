import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutesAvailable, formatRoutesAvailable } from '../src/routes-available.ts';
import type { Route } from '../src/config.ts';

const route = (name: string, baseUrl: string, apiKey: string) => ({ route: name, baseUrl, apiKey }) as unknown as Route;
const hostOf = (u: string) => new URL(u).host;
const app = (path: string, slug: string, version: { major: number; minor: number } | null = null) => ({
  workspace: { path, slug: path.split(':').pop(), name: path.toUpperCase(), role: 'MEMBER' },
  project: { slug, name: slug }, interfaceVersion: version,
});

function stub(apps: Record<string, unknown>, calls: Array<{ url: string; method?: string; auth: string }> = []) {
  return (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization!;
    calls.push({ url, method: init.method, auth });
    if (url.endsWith('/auth/me')) return new Response('{"email":"a@b.c"}');
    const host = new URL(url).host;
    const v = apps[host + '|' + auth];
    if (v === 401) return new Response('{}', { status: 401 });
    if (v === 404) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(v ?? []));
  }) as unknown as typeof fetch;
}

test('lists only unrouted apps, ignoring case, with accepted and needsSignIn', async () => {
  const routes = [route('Acme/issues', 'https://t.example', 'k1')];
  const calls: Array<{ url: string; method?: string; auth: string }> = [];
  const [h] = await buildRoutesAvailable(routes, {
    hostOf, holdsCredential: async (_h, a) => a === 'held',
    fetch: stub({ 't.example|Bearer k1': [
      app('acme', 'issues'), app('acme', 'requests'), app('held', 'issues'), app('other', 'issues', { major: 9, minor: 0 }),
      app('prim:sec', 'issues', { major: 1, minor: 0 }),
    ] }, calls),
  });
  assert.ok(h && 'routes' in h);
  assert.equal(h.identity.email, 'a@b.c');
  assert.deepEqual(h.routes.map((r) => [r.route, r.accepted, r.needsSignIn]), [
    ['acme/requests', true, false], ['held/issues', true, false], ['other/issues', false, true], ['prim:sec/issues', true, true],
  ]);
  assert.ok(calls.every((c) => !c.method || c.method === 'GET'));
});

test('a 404 host is unsupported; a second answering host keeps the exit healthy; a rejected key falls through', async () => {
  const routes = [
    route('a/x', 'https://old.example', 'k0'), route('b/x', 'https://t.example', 'bad'), route('c/x', 'https://t.example', 'good'),
  ];
  const report = await buildRoutesAvailable(routes, {
    hostOf, holdsCredential: async () => false,
    fetch: stub({ 'old.example|Bearer k0': 404, 't.example|Bearer bad': 401, 't.example|Bearer good': [app('d', 'issues')] }),
  });
  assert.deepEqual(report[0], { host: 'old.example', error: report[0] && 'error' in report[0] ? report[0].error : '', reason: 'unsupported' });
  assert.ok('routes' in report[1]!);
  assert.deepEqual((report[1] as { routes: unknown[] }).routes.length, 1);
});

test('formats an empty and a populated list', () => {
  assert.match(formatRoutesAvailable([], false), /crew connect` is the first-run path/);
  const text = formatRoutesAvailable([{ host: 'h', identity: { email: null }, routes: [{
    route: 'd/issues', workspace: { address: 'd', name: 'D', role: 'MEMBER' }, project: { slug: 'issues', name: 'Issues' }, accepted: false, needsSignIn: true,
  }] }], true);
  assert.match(text, /needs a newer crew/);
  assert.match(text, /crew connect <route>/);
});
