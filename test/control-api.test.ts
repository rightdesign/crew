import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import {
  ControlAuth, crewJson, decodeCursor, readTail, schedulerHandler, startControlServer, type ControlDeps, type RunningControlServer,
} from '../src/control-api.ts';
import { State } from '../src/state.ts';

const SHIP_KEY = 'sk_ship';

// Short root: a unix socket path is limited to ~100 bytes.
function stateDir(): string {
  return mkdtempSync(join(tmpdir(), 'ca-'));
}

function fakeFetch(table: Record<string, Record<string, number>>, calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    const ws = new URL(String(url)).searchParams.get('workspaceId') ?? '';
    calls.push(`${token}@${ws}`);
    const status = table[token]?.[ws] ?? 401;
    return new Response('{}', { status, headers: { 'content-type': status === 200 ? 'application/json' : 'text/plain' } });
  }) as typeof fetch;
}

function auth(table: Record<string, Record<string, number>>, calls: string[] = [], now = () => 0) {
  return new ControlAuth({ baseUrl: 'https://t.example', workspaceIds: ['ws1', 'ws2'], shipKeys: () => [SHIP_KEY], fetch: fakeFetch(table, calls), now });
}

test('auth: the ship key is accepted without a round trip', async () => {
  const calls: string[] = [];
  assert.equal(await auth({}, calls).verify(SHIP_KEY), 'ok');
  assert.deepEqual(calls, []);
});

test('auth: seat key of a served workspace ok; revoked 401; other workspace 403; outage unavailable and uncached', async () => {
  const calls: string[] = [];
  const a = auth({ seat: { ws1: 403, ws2: 200 }, foreign: { ws1: 403, ws2: 403 } }, calls);
  assert.equal(await a.verify('seat'), 'ok');
  assert.equal(await a.verify('revoked'), 'unauthorized');
  assert.equal(await a.verify('foreign'), 'forbidden');
  assert.equal(await a.verify(''), 'unauthorized');
  const down = new ControlAuth({
    baseUrl: 'https://t.example', workspaceIds: ['ws1'], shipKeys: () => [],
    fetch: (async () => { throw new Error('down'); }) as typeof fetch,
  });
  assert.equal(await down.verify('x'), 'unavailable');
});

test('auth: a verdict is cached briefly, then asked again', async () => {
  const calls: string[] = [];
  let t = 0;
  const a = auth({ seat: { ws1: 200 } }, calls, () => t);
  await a.verify('seat'); await a.verify('seat');
  assert.equal(calls.length, 1);
  t = 61_000;
  await a.verify('seat');
  assert.equal(calls.length, 2);
});

test('auth: a 200 that is not JSON is not accepted', async () => {
  const a = new ControlAuth({
    baseUrl: 'https://t.example', workspaceIds: ['ws1'], shipKeys: () => [],
    fetch: (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
  });
  assert.equal(await a.verify('x'), 'unavailable');
});

test('tail: no cursor returns the last lines; a cursor returns only what was appended', () => {
  const dir = stateDir();
  const f = join(dir, 'events.jsonl');
  writeFileSync(f, 'a\nb\nc\n');
  const first = readTail(f, { tail: 2, rotated: true });
  assert.deepEqual(first.lines, ['b', 'c']);
  appendFileSync(f, 'd\npartial');
  const next = readTail(f, { after: first.cursor, rotated: true });
  assert.deepEqual(next.lines, ['d']); // the unterminated line waits
  appendFileSync(f, '\n');
  assert.deepEqual(readTail(f, { after: next.cursor, rotated: true }).lines, ['partial']);
});

test('tail: a rotated log is read to its end, then the live file', () => {
  const dir = stateDir();
  const f = join(dir, 'events.jsonl');
  writeFileSync(f, 'a\nb\n');
  const c0 = readTail(f, { tail: 0, rotated: true }).cursor;
  appendFileSync(f, 'c\n');
  renameSync(f, join(dir, 'events.20261101T000000Z.jsonl'));
  writeFileSync(f, 'd\ne\n');
  const r1 = readTail(f, { after: c0, rotated: true });
  assert.deepEqual(r1.lines, ['c']);
  const r2 = readTail(f, { after: r1.cursor, rotated: true });
  assert.deepEqual(r2.lines, ['d', 'e']);
  assert.equal(r2.reset, false);
});

test('tail: an unknown file identity or truncation restarts and says so', () => {
  const dir = stateDir();
  const f = join(dir, 'events.jsonl');
  writeFileSync(f, 'a\nb\n');
  const stale = readTail(f, { tail: 0, rotated: true }).cursor;
  rmSync(f);
  writeFileSync(f, 'x\n');
  const r = readTail(f, { after: stale, rotated: true });
  assert.deepEqual(r.lines, ['x']);
  assert.equal(r.reset, true);
  assert.equal(decodeCursor('garbage!'), null);
});

interface Harness { dir: string; srv: RunningControlServer; state: State; calls: string[]; get(path: string, key?: string | null): Promise<{ status: number; json: any }>; post(path: string, body?: unknown, key?: string): Promise<{ status: number; json: any }> }

async function harness(over: Partial<ControlDeps> = {}): Promise<Harness> {
  const dir = stateDir();
  const state = new State(dir);
  const calls: string[] = [];
  const srv = (await startControlServer({
    stateDir: dir, state,
    auth: auth({ seat: { ws1: 200 }, foreign: { ws1: 403, ws2: 403 } }),
    status: async () => ({ ok: true, doc: { version: 1, crew: { paused: state.isPaused() } } }),
    doctor: async () => ({ ok: true, doc: { problems: [] } }),
    scheduler: schedulerHandler({ startCommand: ['svc', 'start'], stopCommand: ['svc', 'stop'] }, (c) => { calls.push(JSON.stringify(c)); }),
    ...over,
  }))!;
  assert.ok(srv);
  const call = (method: string, path: string, key: string | null | undefined, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ socketPath: srv.path, method, path, headers: { ...(key === null ? {} : { Authorization: `Bearer ${key ?? SHIP_KEY}` }), 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { dir, srv, state, calls, get: (p, k) => call('GET', p, k), post: (p, b, k) => call('POST', p, k, b) };
}

test('server: status carries the CLI document plus daemon liveness and pause sentinels', async () => {
  const h = await harness();
  try {
    const r = await h.get('/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 1);
    assert.equal(r.json.daemon.alive, true);
    assert.deepEqual(r.json.pause, { crew: false, release: false, roles: { dev: false, design: false, qa: false } });
  } finally { await h.srv.close(); }
  assert.equal(existsSync(h.srv.path), false);
});

test('server: no token or a revoked key is 401, a key for an unserved workspace is 403, even on unknown paths', async () => {
  const h = await harness();
  try {
    assert.equal((await h.get('/status', null)).status, 401);
    assert.equal((await h.get('/nope', null)).status, 401);
    assert.equal((await h.get('/status', 'revoked')).status, 401);
    assert.equal((await h.get('/status', 'foreign')).status, 403);
    assert.equal((await h.get('/status', 'seat')).status, 200);
    assert.equal((await h.get('/nope')).status, 404);
  } finally { await h.srv.close(); }
});

test('server: pause through the API is visible to State and to the next status', async () => {
  const h = await harness();
  try {
    assert.equal((await h.post('/pause', {})).status, 200);
    assert.equal(h.state.isPaused(), true);
    assert.equal((await h.post('/pause', { role: 'qa' })).status, 200);
    assert.equal(h.state.isRolePaused('qa'), true);
    assert.equal((await h.post('/release/pause')).status, 200);
    assert.equal(h.state.isReleasePaused(), true);
    assert.equal((await h.get('/status')).json.pause.crew, true);
    await h.post('/resume', {}); await h.post('/resume', { role: 'qa' }); await h.post('/release/resume');
    assert.equal(h.state.isPaused() || h.state.isRolePaused('qa') || h.state.isReleasePaused(), false);
    assert.equal((await h.post('/pause', { role: 'pair' })).status, 400);
    assert.equal((await h.post('/pause', { role: '../x' })).status, 400);
    assert.equal((await h.get('/pause')).status, 405);
  } finally { await h.srv.close(); }
});

test('server: events tail is incremental and a long-poll is released by a write', async () => {
  const h = await harness();
  try {
    const f = join(h.dir, 'events.jsonl');
    writeFileSync(f, '{"n":1}\n{"n":2}\n');
    const first = await h.get('/events?tail=1');
    assert.deepEqual(first.json.lines, ['{"n":2}']);
    const pending = h.get(`/events?after=${first.json.cursor}&wait=10`);
    await new Promise((r) => setTimeout(r, 150));
    appendFileSync(f, '{"n":3}\n');
    const got = await pending;
    assert.deepEqual(got.json.lines, ['{"n":3}']);
    assert.equal((await h.get('/events?after=bad')).status, 400);
  } finally { await h.srv.close(); }
});

test('server: streams listing and per-run tail; names cannot escape the streams directory', async () => {
  const h = await harness();
  try {
    mkdirSync(join(h.dir, 'streams'));
    writeFileSync(join(h.dir, 'streams', 'run1.jsonl'), 'x\ny\n');
    writeFileSync(join(h.dir, 'secret.jsonl'), 'nope\n');
    assert.deepEqual((await h.get('/streams')).json, { streams: [] });
    assert.deepEqual((await h.get('/streams/run1?tail=5')).json.lines, ['x', 'y']);
    assert.equal((await h.get('/streams/missing')).status, 404);
    assert.equal((await h.get('/streams/..%2Fsecret')).status, 400);
    assert.equal((await h.get('/streams/run1.jsonl.pid')).status, 400);
  } finally { await h.srv.close(); }
});

test('server: scheduler actions answer 202 and run the planned commands; no service manager is 409', async () => {
  const h = await harness();
  try {
    assert.equal((await h.post('/scheduler/restart')).status, 202);
    assert.equal((await h.post('/scheduler/stop')).status, 202);
    assert.deepEqual(h.calls, ['[["svc","stop"],["svc","start"]]', '[["svc","stop"]]']);
    assert.equal((await h.post('/scheduler/explode')).status, 404);
  } finally { await h.srv.close(); }
  const none = await harness({ scheduler: schedulerHandler({ startCommand: null, stopCommand: null }) });
  try { assert.equal((await none.post('/scheduler/start')).status, 409); } finally { await none.srv.close(); }
});

test('server: doctor is served read-only; a failure to produce either document is 502', async () => {
  const h = await harness({ doctor: async () => ({ ok: false, reason: 'exited', detail: 'exit code 1; stderr: bad config' }) });
  try {
    const r = await h.get('/doctor');
    assert.equal(r.status, 502);
    assert.equal(r.json.reason, 'exited');
    assert.match(r.json.detail, /bad config/);
    assert.equal((await h.post('/doctor')).status, 405);
  } finally { await h.srv.close(); }
});

test('server: a socket path too long for a unix socket does not start and does not throw', async () => {
  const dir = join(stateDir(), 'x'.repeat(120));
  const logs: string[] = [];
  const srv = await startControlServer({ stateDir: dir, state: new State(stateDir()), auth: auth({}), status: async () => ({ ok: false, reason: 'bad_output', detail: 'x' }), doctor: async () => ({ ok: false, reason: 'bad_output', detail: 'x' }), scheduler: schedulerHandler({ startCommand: null, stopCommand: null }), log: (m) => logs.push(m) });
  assert.equal(srv, null);
  assert.match(logs[0]!, /too long/);
});

test('GET /diagnostics: needs the bearer token and serves the bundle', async () => {
  const dir = stateDir();
  const st = new State(dir);
  const mk = async (diagnostics?: ControlDeps['diagnostics']) => (await startControlServer({
    stateDir: dir, state: st, auth: auth({}), status: async () => ({ ok: true, doc: {} }), doctor: async () => ({ ok: true, doc: {} }), diagnostics,
    scheduler: () => ({ accepted: false, detail: '' }),
  }))!;
  const srv = await mk(async () => ({ sections: { tunnel: { ok: true, data: {} } } }));
  try {
    const call = (hdr: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve) => {
      const r = request({ socketPath: srv.path, path: '/diagnostics', headers: hdr }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.end();
    });
    assert.equal((await call({})).status, 401);
    const ok = await call({ Authorization: `Bearer ${SHIP_KEY}` });
    assert.equal(ok.status, 200);
    assert.ok(JSON.parse(ok.body).sections.tunnel.ok);
  } finally { await srv.close(); }
});

test('server: /status 502 carries reason and detail, logs one warn line; success names the route (CREW-3276)', async () => {
  const logs: string[] = [];
  const h = await harness({ status: async () => ({ ok: false, reason: 'exited', detail: 'exit code 2; stderr: no such route' }), log: (m) => logs.push(m) });
  try {
    const r = await h.get('/status');
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: 'could not produce the status document', reason: 'exited', detail: 'exit code 2; stderr: no such route' });
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /exited/);
  } finally { await h.srv.close(); }
  const ok = await harness({ route: 'main' });
  try { assert.equal((await ok.get('/status')).json.route, 'main'); } finally { await ok.srv.close(); }
});

test('crewJson(): timeout, non-zero exit and bad output say why; a JSON object wins over exit code (CREW-3276)', async () => {
  const argv1 = process.argv[1];
  const dir = mkdtempSync(join(tmpdir(), 'crewjson-'));
  const script = (name: string, body: string) => { const f = join(dir, name); writeFileSync(f, body); return f; };
  try {
    process.argv[1] = script('slow.mjs', 'setTimeout(() => {}, 5000);');
    const t = await crewJson([], 300);
    assert.equal(t.ok, false);
    if (!t.ok) assert.equal(t.reason, 'timed_out');
    process.argv[1] = script('fail.mjs', 'console.error("boom sk_secret123 Bearer abc"); process.exit(3);');
    const x = await crewJson([]);
    assert.equal(x.ok, false);
    if (!x.ok) { assert.equal(x.reason, 'exited'); assert.match(x.detail, /exit code 3/); assert.match(x.detail, /boom/); assert.ok(!/secret123|abc/.test(x.detail)); }
    process.argv[1] = script('junk.mjs', 'console.log("not json");');
    const b = await crewJson([]);
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.reason, 'bad_output');
    process.argv[1] = script('blocker.mjs', 'console.log(JSON.stringify({ problems: 1 })); process.exit(1);');
    assert.deepEqual(await crewJson([]), { ok: true, doc: { problems: 1 } });
  } finally { process.argv[1] = argv1!; rmSync(dir, { recursive: true, force: true }); }
});
