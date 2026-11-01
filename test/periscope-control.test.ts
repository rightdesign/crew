import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { ControlAuth, startControlServer } from '../src/control-api.ts';
import { cliMessage, handlePeriscopes, type CliResult, type PeriscopeHosting, type PeriscopeRequest } from '../src/periscope-control.ts';
import { State } from '../src/state.ts';

const ROUTES = [
  { route: 'ws/issues', workspaceId: 'ws1', hostPeriscopes: true },
  { route: 'other/issues', workspaceId: 'ws2', hostPeriscopes: false },
];

interface Fake { h: PeriscopeHosting; runs: string[][] }

function fake(o: { live?: number; up?: CliResult; down?: CliResult; members?: Record<string, string[]>; routes?: PeriscopeHosting['routes']; previewHost?: string | null; lines?: string[] } = {}): Fake {
  const runs: string[][] = [];
  const h: PeriscopeHosting = {
    routes: o.routes ?? ROUTES,
    previewHost: o.previewHost === null ? undefined : (o.previewHost ?? 'ship.lan'),
    maxPeriscopes: 2,
    run: async (args, onLine) => {
      runs.push(args);
      if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(Array.from({ length: o.live ?? 0 }, (_, i) => ({ ticket: `CREW-${i}` }))), stderr: '' };
      for (const l of o.lines ?? []) onLine(l);
      return (args[1] === 'up' ? o.up : o.down) ?? { code: 0, stdout: `${JSON.stringify({ event: 'done', ticket: 'CREW-9', url: 'http://ship.lan:5173' })}\n`, stderr: '' };
    },
    verifyIn: async (token, ws) => ((o.members ?? { member: ['ws1', 'ws2'] })[token] ?? []).includes(ws) ? 'ok' : 'forbidden',
  };
  return { h, runs };
}

const req = (over: Partial<PeriscopeRequest>): PeriscopeRequest => ({
  method: 'POST', path: '/periscopes', query: new URLSearchParams(), token: 'member', body: {}, wantsStream: false, ...over,
});
const upBody = { route: 'ws/issues', repo: 'app', topic: 'Compact rows', requestedBy: 'mem-1' };

test('flag off: every periscope path answers 404 as if absent, and nothing runs', async () => {
  const none = fake({ routes: ROUTES.map((r) => ({ ...r, hostPeriscopes: false })) });
  for (const [method, path] of [['POST', '/periscopes'], ['GET', '/periscopes'], ['POST', '/periscopes/12/down']] as const) {
    const r = await handlePeriscopes(none.h, req({ method, path, body: upBody }));
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal((await handlePeriscopes(undefined, req({}))).status, 404);
  assert.deepEqual(none.runs, []);
  // A route that does not host answers 404 even on a ship that hosts elsewhere.
  const f = fake();
  assert.equal((await handlePeriscopes(f.h, req({ body: { ...upBody, route: 'other/issues' } }))).status, 404);
  assert.deepEqual(f.runs, []);
});

test('up: a member opens a periscope; the command carries the preview host, topic and requester', async () => {
  const f = fake();
  const r = await handlePeriscopes(f.h, req({ body: { ...upBody, isolate: true } }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { event: 'done', ticket: 'CREW-9', url: 'http://ship.lan:5173' });
  const up = f.runs.find((a) => a[1] === 'up')!;
  assert.deepEqual(up, ['periscope', 'up', 'ws/issues', 'app', '--topic', 'Compact rows', '--host', 'ship.lan', '--requested-by', 'mem-1', '--isolate', '--no-open', '--json']);
});

test('up: a key outside the route workspace is refused 403 and nothing runs', async () => {
  const f = fake({ members: { member: ['ws1'], stranger: ['ws2'] } });
  const r = await handlePeriscopes(f.h, req({ token: 'stranger', body: upBody }));
  assert.equal(r.status, 403);
  assert.deepEqual(f.runs, []);
});

test('up: over the cap answers 409 and never starts the command', async () => {
  const f = fake({ live: 2 });
  const r = await handlePeriscopes(f.h, req({ body: upBody }));
  assert.equal(r.status, 409);
  assert.match(String((r.body as { error: string }).error), /maxPeriscopes is 2/);
  assert.equal(f.runs.some((a) => a[1] === 'up'), false);
});

test('up: bad bodies are 400 and a value that looks like a flag is refused', async () => {
  const f = fake();
  const bad = async (body: Record<string, unknown> | null) => (await handlePeriscopes(f.h, req({ body }))).status;
  assert.equal(await bad(null), 400);
  assert.equal(await bad({ ...upBody, repo: undefined }), 400);
  assert.equal(await bad({ ...upBody, topic: '--json' }), 400);
  assert.equal(await bad({ ...upBody, topic: 'a\nb' }), 400);
  assert.equal(await bad({ ...upBody, isolate: 'yes' }), 400);
  assert.equal(await bad({ ...upBody, route: undefined }), 200, 'a single hosting route is the default');
  assert.equal((await handlePeriscopes(fake({ previewHost: null }).h, req({ body: upBody }))).status, 409);
});

test('up: a CLI refusal comes back as its message; with two hosting routes the route is required', async () => {
  const f = fake({ up: { code: 1, stdout: '', stderr: '{"event":"setup","message":"x"}\ncrew periscope: no route serves a repository named "app"\n' } });
  const r = await handlePeriscopes(f.h, req({ body: upBody }));
  assert.equal(r.status, 422);
  assert.deepEqual(r.body, { error: 'no route serves a repository named "app"' });
  const two = fake({ routes: ROUTES.map((x) => ({ ...x, hostPeriscopes: true })) });
  assert.equal((await handlePeriscopes(two.h, req({ body: { ...upBody, route: undefined } }))).status, 400);
});

test('down: keep and discard map to the flag; a bad outcome or ticket is 400; no such periscope is 404', async () => {
  const f = fake();
  for (const outcome of ['keep', 'discard']) {
    const r = await handlePeriscopes(f.h, req({ path: '/periscopes/CREW-12/down', body: { route: 'ws/issues', outcome, allowEmpty: outcome === 'keep' } }));
    assert.equal(r.status, 200);
  }
  assert.deepEqual(f.runs[0], ['periscope', 'down', 'ws/issues', 'CREW-12', '--keep', '--allow-empty', '--json']);
  assert.deepEqual(f.runs[1], ['periscope', 'down', 'ws/issues', 'CREW-12', '--discard', '--json']);
  assert.equal((await handlePeriscopes(f.h, req({ path: '/periscopes/12/down', body: { outcome: 'maybe' } }))).status, 400);
  assert.equal((await handlePeriscopes(f.h, req({ path: '/periscopes/--x/down', body: { outcome: 'keep' } }))).status, 400);
  const gone = fake({ down: { code: 1, stdout: '', stderr: 'crew periscope: no periscope for ticket 12 on this ship\n' } });
  assert.equal((await handlePeriscopes(gone.h, req({ path: '/periscopes/12/down', body: { outcome: 'keep' } }))).status, 404);
  assert.equal((await handlePeriscopes(f.h, req({ method: 'GET', path: '/periscopes/12/down' }))).status, 405);
});

test('list: the live rows, tagged with their route; a caller outside the workspace sees none, or a 403 when naming it', async () => {
  const f = fake({ live: 1, routes: ROUTES.map((r) => ({ ...r, hostPeriscopes: true })), members: { member: ['ws1', 'ws2'], one: ['ws1'] } });
  const all = await handlePeriscopes(f.h, req({ method: 'GET' }));
  assert.deepEqual(all.body, { periscopes: [{ route: 'ws/issues', ticket: 'CREW-0' }, { route: 'other/issues', ticket: 'CREW-0' }] });
  const one = await handlePeriscopes(f.h, req({ method: 'GET', token: 'one' }));
  assert.deepEqual(one.body, { periscopes: [{ route: 'ws/issues', ticket: 'CREW-0' }] });
  const named = await handlePeriscopes(f.h, req({ method: 'GET', token: 'one', query: new URLSearchParams('route=other/issues') }));
  assert.equal(named.status, 403);
});

test('stream: progress events are relayed, then done; a failure ends with an error event', async () => {
  const ok = fake({ lines: ['{"event":"setup","message":"setting up the worktree"}', 'not json'] });
  const r = await handlePeriscopes(ok.h, req({ body: upBody, wantsStream: true }));
  assert.ok(r.stream);
  const seen: unknown[] = [];
  await r.stream!((e) => seen.push(e));
  assert.deepEqual(seen.map((e) => (e as { event: string }).event), ['setup', 'done']);
  const bad = fake({ up: { code: 1, stdout: '', stderr: 'crew periscope: boom\n' } });
  const s = await handlePeriscopes(bad.h, req({ body: upBody, wantsStream: true }));
  const out: unknown[] = [];
  await s.stream!((e) => out.push(e));
  assert.deepEqual(out, [{ event: 'error', status: 422, message: 'boom' }]);
});

test('cliMessage takes the plain last line over progress events', () => {
  assert.equal(cliMessage({ code: 1, stdout: '', stderr: '{"event":"a"}\ncrew periscope: nope\n{"event":"b"}\n' }), 'nope');
});

test('server: periscope paths need the bearer token, 404 with the flag off, and stream NDJSON over the socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'));
  const state = new State(dir);
  const f = fake({ lines: ['{"event":"setup","message":"hi"}'] });
  const auth = new ControlAuth({
    baseUrl: 'https://t.example', workspaceIds: ['ws1'], shipKeys: () => ['sk_ship'],
    fetch: (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  const srv = (await startControlServer({
    stateDir: dir, state, auth, status: async () => ({}), doctor: async () => ({}),
    scheduler: () => ({ accepted: false, detail: '' }),
    periscopes: { ...f.h, verifyIn: (t, ws) => auth.verifyIn(t, ws) },
  }))!;
  const call = (method: string, path: string, key: string | null, body?: unknown, accept?: string) => new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
    const r = request({ socketPath: srv.path, method, path, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(accept ? { Accept: accept } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), text: b }));
    });
    r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal((await call('GET', '/periscopes', null)).status, 401);
    assert.equal((await call('GET', '/periscopes', 'sk_ship')).status, 200);
    const plain = await call('POST', '/periscopes', 'sk_ship', upBody);
    assert.equal(plain.status, 200);
    assert.equal(JSON.parse(plain.text).ticket, 'CREW-9');
    const streamed = await call('POST', '/periscopes', 'sk_ship', upBody, 'application/x-ndjson');
    assert.equal(streamed.type, 'application/x-ndjson');
    assert.deepEqual(streamed.text.trim().split('\n').map((l) => JSON.parse(l).event), ['setup', 'done']);
  } finally { await srv.close(); }
});

test('mcp: up runs with --serve-mcp, merges the registration into the answer, and a failed registration leaves the periscope up', async () => {
  const f = fake();
  const seen: string[] = [];
  f.h.mcp = {
    onUp: async (r, done) => { seen.push(`up ${r.route} ${String(done.ticket)}`); return { mcpEndpointId: 'ep-1' }; },
    onDown: async (r) => { seen.push(`down ${r.route}`); },
  };
  const up = await handlePeriscopes(f.h, req({ body: upBody }));
  assert.equal(up.status, 200);
  assert.deepEqual(up.body, { event: 'done', ticket: 'CREW-9', url: 'http://ship.lan:5173', mcpEndpointId: 'ep-1' });
  assert.ok(f.runs.find((a) => a[1] === 'up')!.includes('--serve-mcp'));
  const down = await handlePeriscopes(f.h, req({ path: '/periscopes/9/down', body: { route: 'ws/issues', outcome: 'discard' } }));
  assert.equal(down.status, 200);
  assert.deepEqual(seen, ['up ws/issues CREW-9', 'down ws/issues']);

  // Without the hook the command is the same as before this ticket.
  const plain = fake();
  await handlePeriscopes(plain.h, req({ body: upBody }));
  assert.ok(!plain.runs.find((a) => a[1] === 'up')!.includes('--serve-mcp'));

  // A command that failed registers nothing.
  const bad = fake({ up: { code: 1, stdout: '', stderr: 'crew periscope: boom\n' } });
  bad.h.mcp = { onUp: async () => { seen.push('should not run'); return {}; }, onDown: async () => {} };
  assert.equal((await handlePeriscopes(bad.h, req({ body: upBody }))).status, 422);
  assert.ok(!seen.includes('should not run'));
});

test('mcp: the control server hands /periscopes/<ticket>/mcp to the handler before the tracker-key check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctl-'));
  const seen: string[] = [];
  const srv = (await startControlServer({
    stateDir: dir, state: new State(dir), auth: { verify: async () => 'unauthorized' }, status: async () => ({}), doctor: async () => ({}),
    scheduler: () => ({ accepted: false, detail: '' }),
    periscopeMcp: async (_req, res, ticket) => { seen.push(ticket); res.writeHead(204).end(); },
  }))!;
  const call = (path: string) => new Promise<number>((resolve, reject) => {
    const r = request({ socketPath: srv.path, method: 'POST', path }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    r.on('error', reject); r.end('{}');
  });
  try {
    assert.equal(await call('/periscopes/CREW-12/mcp'), 204, 'no bearer needed: the periscope secret is the credential');
    assert.deepEqual(seen, ['CREW-12']);
    assert.equal(await call('/periscopes/CREW-12/down'), 401, 'every other path still needs a key');
  } finally { await srv.close(); }
  // Not configured: a plain 404, no tracker check involved.
  const dir2 = mkdtempSync(join(tmpdir(), 'ctl-'));
  const srv2 = (await startControlServer({
    stateDir: dir2, state: new State(dir2), auth: { verify: async () => 'unauthorized' }, status: async () => ({}), doctor: async () => ({}),
    scheduler: () => ({ accepted: false, detail: '' }),
  }))!;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const r = request({ socketPath: srv2.path, method: 'POST', path: '/periscopes/CREW-12/mcp' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      r.on('error', reject); r.end('{}');
    });
    assert.equal(status, 404);
  } finally { await srv2.close(); }
});
