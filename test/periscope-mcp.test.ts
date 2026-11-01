import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPeriscope, globToRegExp, handlePeriscopeMcp, resolveInWorktree, PathRefusal, type PeriscopeMcpDeps } from '../src/periscope-mcp.ts';
import {
  listPeriscopeEndpoints, mintPeriscopeSecret, periscopeEndpointUrl, readPeriscopeSecret, registerPeriscopeEndpoint, removeEndedPeriscopeEndpoints,
  removePeriscopeSecret,
} from '../src/periscope-endpoints.ts';
import type { PeriscopeSidecar } from '../src/periscope-state.ts';

const scratch = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function worktree(): string {
  const dir = scratch('periscope-mcp-wt-');
  execFileSync('git', ['init', '-q', '-b', 'crew-12', dir]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/app.ts'), 'export const one = 1;\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function sidecar(dir: string, over: Partial<PeriscopeSidecar> = {}): PeriscopeSidecar {
  return {
    ticket: 'CREW-12', ticketRecordId: 'rec-12', periscopeRecordId: 'per-12', repo: 'app', route: 'ws/issues', worktree: dir, branch: 'crew-12',
    url: 'http://ship.lan:5173', host: 'ship.lan', state: 'live', isolated: false,
    startedAt: '2026-11-01T00:00:00Z', lastActivityAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-01T02:00:00Z', ...over,
  };
}

test('resolveInWorktree: inside is fine, outside, .git and escaping symlinks are refused', async () => {
  const dir = worktree();
  const outside = scratch('periscope-mcp-out-');
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  symlinkSync(outside, join(dir, 'escape'));
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));

  assert.equal(await resolveInWorktree(dir, 'src/app.ts'), join(dir, 'src/app.ts'));
  assert.equal(await resolveInWorktree(dir, join(dir, 'src/app.ts')), join(dir, 'src/app.ts'));
  // A file that does not exist yet, in a directory that does not either.
  assert.equal(await resolveInWorktree(dir, 'new/deep/file.ts'), join(dir, 'new/deep/file.ts'));
  for (const bad of ['../x', '/etc/passwd', 'src/../../x', 'escape/new.txt', 'escape', 'link.txt', '.git/config', 'src/../.git/HEAD', '']) {
    await assert.rejects(resolveInWorktree(dir, bad), PathRefusal, bad);
  }
});

test('resolveInWorktree: a dangling symlink is followed, not treated as a missing file', async () => {
  const dir = worktree();
  const outside = scratch('periscope-mcp-out-');
  // Targets that do not exist yet: a write through the link would create them.
  symlinkSync(join(outside, 'newfile'), join(dir, 'evil'));
  symlinkSync(join(dir, '.git', 'hooks', 'pre-commit'), join(dir, 'hook-link'));
  symlinkSync(join(outside, 'gone', 'deep.txt'), join(dir, 'evil-deep'));
  // Chain: an in-tree dangling link that points at another dangling link outside.
  symlinkSync(join(outside, 'chain'), join(dir, 'hop2'));
  symlinkSync(join(dir, 'hop2'), join(dir, 'hop1'));
  // A cycle must be refused rather than loop.
  symlinkSync(join(dir, 'loop-b'), join(dir, 'loop-a'));
  symlinkSync(join(dir, 'loop-a'), join(dir, 'loop-b'));
  for (const bad of ['evil', 'hook-link', 'evil-deep', 'hop1', 'loop-a']) {
    await assert.rejects(resolveInWorktree(dir, bad), PathRefusal, bad);
  }
  // A dangling link that stays inside the worktree is still fine.
  symlinkSync(join(dir, 'src', 'later.ts'), join(dir, 'inside'));
  assert.equal(await resolveInWorktree(dir, 'inside'), join(dir, 'src', 'later.ts'));
});

test('globToRegExp: * stays in a directory, ** crosses them', () => {
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('src/a.ts'));
  assert.ok(globToRegExp('**/*.ts').test('a.ts'));
  assert.ok(globToRegExp('**/*.ts').test('src/deep/a.ts'));
  assert.ok(globToRegExp('src/?.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('a.ts').test('aXts'));
});

test('findPeriscope: by tag or number, tag prefix must agree', () => {
  const list = [sidecar('/x'), sidecar('/y', { ticket: 'TABL-7', ticketRecordId: 'rec-7' })];
  assert.equal(findPeriscope(list, 'CREW-12')?.ticketRecordId, 'rec-12');
  assert.equal(findPeriscope(list, 'crew-12')?.ticketRecordId, 'rec-12');
  assert.equal(findPeriscope(list, '12')?.ticketRecordId, 'rec-12');
  assert.equal(findPeriscope(list, 'TABL-12'), undefined);
  assert.equal(findPeriscope(list, '99'), undefined);
  assert.equal(findPeriscope(list, '../etc'), undefined);
});

interface Harness { base: string; stateDir: string; dir: string; secret: string; touched: string[]; hooks: string[]; server: Server }

async function harness(t: { after(fn: () => void): void }, o: { isolated?: boolean; declared?: string[] } = {}): Promise<Harness> {
  const dir = worktree();
  const stateDir = scratch('periscope-mcp-state-');
  const sc = sidecar(dir, { isolated: o.isolated === true });
  const secret = mintPeriscopeSecret(stateDir, sc.ticketRecordId);
  const touched: string[] = [];
  const hooks: string[] = [];
  const declared = o.declared ?? ['test', 'ports'];
  const deps: PeriscopeMcpDeps = {
    stateDir,
    find: (seg) => findPeriscope([sc], seg),
    runHook: async (_sc, name, env) => {
      hooks.push(`${name}:${env.CREW_TICKET}:${env.CREW_BRANCH}`);
      if (!declared.includes(name)) return null;
      return name === 'ports' ? { code: 0, output: 'PORT=4100\n' } : { code: name === 'test' && env.PORT === '4100' ? 0 : 3, output: `ran ${name} PORT=${env.PORT ?? ''}` };
    },
    touch: async (s) => { touched.push(s.ticket); },
  };
  const server = createServer((req, res) => {
    const m = /^\/periscopes\/([^/]+)\/mcp$/.exec(req.url ?? '');
    if (!m) { res.writeHead(404).end(); return; }
    void handlePeriscopeMcp(deps, req, res, m[1]!);
  });
  await new Promise<void>((r) => server.listen(0, r));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stateDir, dir, secret, touched, hooks, server };
}

const parse = (text: string): { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: { message: string } } => {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
};

async function rpc(h: Harness, method: string, params: unknown, opts: { secret?: string | null; ticket?: string } = {}) {
  const secret = opts.secret === undefined ? h.secret : opts.secret;
  const res = await fetch(`${h.base}/periscopes/${opts.ticket ?? 'CREW-12'}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, text: await res.text() };
}

async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await rpc(h, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, r.text);
  const body = parse(r.text);
  assert.ok(!body.error, body.error?.message);
  return { text: body.result?.content?.[0]?.text ?? '', isError: body.result?.isError === true };
}

test('the tool list: the Passenger reads plus the scoped writes, no push, checkout or shell', async (t) => {
  const h = await harness(t);
  const names = (parse((await rpc(h, 'tools/list', {})).text).result?.tools ?? []).map((x) => x.name).sort();
  assert.deepEqual(names, [
    'create_directory', 'delete_file', 'edit_file', 'git_commit', 'git_diff', 'git_status', 'list_directory', 'read_file', 'run_hook', 'search_files', 'write_file',
  ]);
  for (const forbidden of ['git_push', 'git_checkout', 'exec', 'shell', 'bash', 'run_command']) assert.ok(!names.includes(forbidden));
});

test('read, edit, write, search, delete and commit inside the worktree', async (t) => {
  const h = await harness(t);
  assert.equal((await call(h, 'read_file', { path: 'src/app.ts' })).text, 'export const one = 1;\n');
  assert.match((await call(h, 'list_directory', { path: '.' })).text, /\[DIR\]\s+src/);
  assert.ok(!(await call(h, 'list_directory', { path: '.' })).text.includes('.git\n'));
  assert.equal((await call(h, 'search_files', { pattern: '**/*.ts' })).text, 'src/app.ts');

  await call(h, 'edit_file', { path: 'src/app.ts', oldString: 'one = 1', newString: 'one = 11' });
  assert.equal(readFileSync(join(h.dir, 'src/app.ts'), 'utf8'), 'export const one = 11;\n');
  const miss = await call(h, 'edit_file', { path: 'src/app.ts', oldString: 'nothing here', newString: 'x' });
  assert.ok(miss.isError);

  await call(h, 'write_file', { path: 'docs/new.md', content: '# hi\n' });
  assert.equal(readFileSync(join(h.dir, 'docs/new.md'), 'utf8'), '# hi\n');
  assert.match((await call(h, 'git_status', {})).text, /new\.md/);
  assert.match((await call(h, 'git_diff', {})).text, /one = 11/);

  assert.match((await call(h, 'git_commit', { message: 'Compact rows' })).text, /Committed [0-9a-f]+ on crew-12/);
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: h.dir, encoding: 'utf8' }).trim(), 'Compact rows');
  assert.ok((await call(h, 'git_commit', { message: 'again' })).isError, 'nothing left to commit');

  await call(h, 'delete_file', { path: 'docs/new.md' });
  assert.equal(existsSync(join(h.dir, 'docs/new.md')), false);
  assert.ok((await call(h, 'delete_file', { path: 'src' })).isError, 'a directory is not deleted');
});

test('paths outside the worktree, symlink escapes and .git are refused for every file tool', async (t) => {
  const h = await harness(t);
  const outside = scratch('periscope-mcp-out-');
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  symlinkSync(outside, join(h.dir, 'escape'));
  symlinkSync(join(outside, 'secret.txt'), join(h.dir, 'link.txt'));
  const cases: [string, Record<string, unknown>][] = [
    ['read_file', { path: '../../etc/passwd' }],
    ['read_file', { path: join(outside, 'secret.txt') }],
    ['read_file', { path: 'link.txt' }],
    ['list_directory', { path: 'escape' }],
    ['write_file', { path: 'escape/pwn.txt', content: 'x' }],
    ['write_file', { path: '../pwn.txt', content: 'x' }],
    ['write_file', { path: '.git/hooks/pre-commit', content: 'x' }],
    ['edit_file', { path: 'link.txt', oldString: 'nope', newString: 'x' }],
    ['create_directory', { path: 'escape/sub' }],
    ['delete_file', { path: join(outside, 'secret.txt') }],
    ['delete_file', { path: 'escape/secret.txt' }],
    ['git_diff', { path: '../x' }],
  ];
  for (const [name, args] of cases) assert.ok((await call(h, name, args)).isError, `${name} ${JSON.stringify(args)}`);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'nope');
  assert.equal(existsSync(join(outside, 'pwn.txt')), false);
  assert.equal(existsSync(join(outside, 'sub')), false);
  // Deleting a symlink removes the link, never what it points at.
  await call(h, 'delete_file', { path: 'link.txt' });
  assert.equal(existsSync(join(h.dir, 'link.txt')), false);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'nope');
});

test('run_hook: declared hooks run with the periscope environment; undeclared and isolate-on-a-plain-row are refused', async (t) => {
  const h = await harness(t);
  const ok = await call(h, 'run_hook', { name: 'test' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /^exit 0\nran test PORT=4100/, 'ports output is part of the hook environment');
  assert.ok(h.hooks.includes('test:CREW-12:crew-12'));

  const undeclared = await call(h, 'run_hook', { name: 'build' });
  assert.ok(undeclared.isError);
  assert.match(undeclared.text, /declares no `build` hook/);

  const iso = await call(h, 'run_hook', { name: 'isolate' });
  assert.ok(iso.isError);
  assert.match(iso.text, /only for a periscope opened with --isolate/);
  assert.equal(h.hooks.some((x) => x.startsWith('isolate:')), false, 'the hook was never run');

  // A name outside the allowed list never reaches the runner.
  const bad = await rpc(h, 'tools/call', { name: 'run_hook', arguments: { name: 'setup' } });
  const body = parse(bad.text);
  assert.ok(body.error || body.result?.isError, bad.text);
  assert.equal(h.hooks.some((x) => x.startsWith('setup:')), false);
});

test('run_hook isolate is allowed for an isolated row', async (t) => {
  const h = await harness(t, { isolated: true, declared: ['isolate', 'ports', 'test'] });
  const r = await call(h, 'run_hook', { name: 'isolate' });
  assert.match(r.text, /ran isolate/);
});

test('auth: no secret, a wrong secret, another periscope\'s secret and an ended periscope all answer the same 404', async (t) => {
  const h = await harness(t);
  const other = mintPeriscopeSecret(h.stateDir, 'rec-other');
  assert.equal((await rpc(h, 'tools/list', {}, { secret: null })).status, 404);
  assert.equal((await rpc(h, 'tools/list', {}, { secret: 'wrong' })).status, 404);
  assert.equal((await rpc(h, 'tools/list', {}, { secret: other })).status, 404);
  assert.equal((await rpc(h, 'tools/list', {}, { ticket: '99' })).status, 404);
  assert.equal((await rpc(h, 'tools/list', {})).status, 200);
  const bodies = new Set([
    (await rpc(h, 'tools/list', {}, { secret: null })).text,
    (await rpc(h, 'tools/list', {}, { secret: other })).text,
    (await rpc(h, 'tools/list', {}, { ticket: '99' })).text,
  ]);
  assert.equal(bodies.size, 1, 'nothing distinguishes the three refusals');

  // Down removes the secret: the same request now answers 404.
  removePeriscopeSecret(h.stateDir, 'rec-12');
  assert.equal((await rpc(h, 'tools/list', {})).status, 404);
  assert.equal(readPeriscopeSecret(h.stateDir, 'rec-12'), undefined);
});

test('activity: a tool call is recorded, a listing is not', async (t) => {
  const h = await harness(t);
  await rpc(h, 'tools/list', {});
  assert.deepEqual(h.touched, []);
  await call(h, 'git_status', {});
  assert.deepEqual(h.touched, ['CREW-12']);
});

test('a GET is not an MCP call', async (t) => {
  const h = await harness(t);
  const res = await fetch(`${h.base}/periscopes/CREW-12/mcp`, { headers: { Authorization: `Bearer ${h.secret}` } });
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function fakeTracker() {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let n = 0;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const id = url.split('/mcp-endpoints/')[1];
    calls.push(`${method} ${id ?? ''}`.trim());
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST') { const row = { id: `ep-${++n}`, ...JSON.parse(String(init?.body)) }; rows.set(row.id, row); return ok(row, 201); }
    if (method === 'PATCH' && id && rows.has(id)) { rows.set(id, { ...rows.get(id), ...JSON.parse(String(init?.body)) }); return ok(rows.get(id)); }
    if (method === 'DELETE' && id) { rows.delete(id); return new Response(null, { status: 204 }); }
    return new Response('{}', { status: 404 });
  };
  return { rows, calls, fetchFn };
}

test('registration: the endpoint carries the relay URL, path and secret; down removes it; a second up refreshes it', async () => {
  const stateDir = scratch('periscope-mcp-state-');
  const tr = fakeTracker();
  const d = {
    stateDir, shipName: 'Studio', warn: () => {}, now: () => new Date('2026-11-01T00:00:00Z'),
    apiFor: () => ({ baseUrl: 'https://app.example', apiKey: 'k', fetchFn: tr.fetchFn }),
  };
  const p = { ticket: 'CREW-12', ticketRecordId: 'rec-12', route: 'ws/issues', workspaceId: 'ws1', relayUrl: 'https://abc.ships.example' };

  // No secret, no endpoint: it would point at a path that answers 404.
  const none = await registerPeriscopeEndpoint(d, p);
  assert.equal(none.ok, false);
  assert.equal(tr.rows.size, 0);

  const secret = mintPeriscopeSecret(stateDir, 'rec-12');
  const out = await registerPeriscopeEndpoint(d, p);
  assert.deepEqual(out, { ok: true, endpointId: 'ep-1', url: 'https://abc.ships.example/control/periscopes/CREW-12/mcp' });
  const row = tr.rows.get('ep-1')!;
  assert.equal(row.url, periscopeEndpointUrl('https://abc.ships.example/', 'CREW-12'));
  assert.equal(row.label, 'Periscope: Studio CREW-12');
  assert.equal(row.authorizationHeader, `Bearer ${secret}`);
  assert.equal(listPeriscopeEndpoints(stateDir).length, 1);

  // Registered again (reconcile, or a resumed up): patched, not duplicated.
  assert.equal((await registerPeriscopeEndpoint(d, p)).ok, true);
  assert.equal(tr.rows.size, 1);

  // Still live: nothing removed.
  assert.equal(await removeEndedPeriscopeEndpoints(d), 0);
  assert.equal(tr.rows.size, 1);

  // Down (from the control API or a terminal) removes the secret; the next reconcile deletes the endpoint.
  removePeriscopeSecret(stateDir, 'rec-12');
  assert.equal(await removeEndedPeriscopeEndpoints(d), 1);
  assert.equal(tr.rows.size, 0);
  assert.deepEqual(listPeriscopeEndpoints(stateDir), []);
});

test('registration: a failed delete keeps the record for the next cycle', async () => {
  const stateDir = scratch('periscope-mcp-state-');
  const tr = fakeTracker();
  let failDelete = true;
  const fetchFn = async (url: string, init?: RequestInit) => (init?.method === 'DELETE' && failDelete ? new Response('boom', { status: 500 }) : tr.fetchFn(url, init));
  const warnings: string[] = [];
  const d = { stateDir, shipName: 'Studio', warn: (m: string) => warnings.push(m), apiFor: () => ({ baseUrl: 'https://app.example', apiKey: 'k', fetchFn }) };
  mintPeriscopeSecret(stateDir, 'rec-12');
  await registerPeriscopeEndpoint(d, { ticket: 'CREW-12', ticketRecordId: 'rec-12', route: 'r', workspaceId: 'ws1', relayUrl: 'https://abc.ships.example' });
  removePeriscopeSecret(stateDir, 'rec-12');
  assert.equal(await removeEndedPeriscopeEndpoints(d), 0);
  assert.equal(listPeriscopeEndpoints(stateDir).length, 1);
  assert.equal(warnings.length, 1);
  failDelete = false;
  assert.equal(await removeEndedPeriscopeEndpoints(d), 1);
  assert.deepEqual(listPeriscopeEndpoints(stateDir), []);
});

test('the secret file is private and never part of the periscope sidecar', () => {
  const stateDir = scratch('periscope-mcp-state-');
  mintPeriscopeSecret(stateDir, 'rec-12');
  const file = join(stateDir, 'periscope-mcp', 'rec-12.json');
  assert.equal(execFileSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', file] : ['-c', '%a', file], { encoding: 'utf8' }).trim(), '600');
  assert.equal(existsSync(join(stateDir, 'periscopes')), false, 'minting a secret writes no sidecar');
});
