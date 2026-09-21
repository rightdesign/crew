import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createPassengerMcpServer, createPassengerHttpServer, type PassengerAuthConfig } from '../src/passenger-mcp.ts';
import { createSyncDaemonServer } from '../src/passenger-sync-daemon.ts';

const WRITE_SHAPED_TOOL_NAMES = ['write_file', 'edit_file', 'move_file', 'create_directory', 'delete_file'];

// Bare host, NO /api suffix (ISSUE-694) — matching the real convention
// every other crew call site follows (agent-log.ts, agent.ts, agents.ts,
// connect.ts, logbook.ts, skills.ts, tracker.ts all
// append /api themselves). Keeping this bare is what makes these tests
// actually exercise validateCredential's own /api-appending, rather than
// papering over it the way the pre-ISSUE-694 fixture did.
const FAKE_TABLATION_BASE = 'https://fake-tablation.test';
const VALID_TOKEN = 'valid-token';
const WORKSPACE_ID = 'ws-under-test';
const AUTH: PassengerAuthConfig = { tablationApiBaseUrl: FAKE_TABLATION_BASE, workspaceId: WORKSPACE_ID };
const AUTH_HEADER = { Authorization: `Bearer ${VALID_TOKEN}` };
const DEFAULT_MEMBERS = new Map([[VALID_TOKEN, WORKSPACE_ID]]);

/**
 * Stands in for Tablation's own `GET /api/auth/me`: 401 for an unrecognized
 * token, 403 for a token whose workspace doesn't match the `workspaceId`
 * query param, 200 otherwise — the same three outcomes `validateCredential`
 * (passenger-mcp.ts) actually branches on. Only intercepts calls to
 * `FAKE_TABLATION_BASE`; every other URL (the test's own calls to the
 * server under test) passes through to the real global `fetch`. Every
 * response sets `content-type: application/json` explicitly — a bare
 * `new Response(jsonString)` defaults to `text/plain`, which would trip
 * `validateCredential`'s own ISSUE-694 content-type defense-in-depth check.
 */
function withMockedAuthEndpoint<T>(fn: () => Promise<T>, memberWorkspaces: Map<string, string> = DEFAULT_MEMBERS): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(FAKE_TABLATION_BASE)) return realFetch(input, init);
    const jsonHeaders = { 'content-type': 'application/json' };
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    const authHeader = headers.get('Authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    const memberOf = memberWorkspaces.get(token);
    if (!memberOf) return new Response(JSON.stringify({ message: 'Invalid or revoked API key' }), { status: 401, headers: jsonHeaders });
    const requestedWorkspace = parsed.searchParams.get('workspaceId');
    if (requestedWorkspace !== memberOf) {
      return new Response(JSON.stringify({ message: 'Not a member of this workspace' }), { status: 403, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ id: 'user-1', workspaceId: memberOf }), { status: 200, headers: jsonHeaders });
  }) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function commit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

/**
 * StreamableHTTPServerTransport can answer a POST either as plain JSON or
 * as a one-shot SSE stream (`event: message\ndata: {...}\n\n`) depending
 * on internals not under this test's control — unwrap either shape to the
 * JSON-RPC envelope underneath.
 */
function parseMcpResponse(text: string): any {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice('data: '.length) : text);
}

async function listTools(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...AUTH_HEADER },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = parseMcpResponse(text) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name);
}

test('never exposes a write-shaped tool over the wire, whatever the reference server offers', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const names = await listTools(`http://127.0.0.1:${port}`);
  assert.ok(names.length > 0, 'sanity check: some tools were registered');
  for (const writeTool of WRITE_SHAPED_TOOL_NAMES) {
    assert.ok(!names.includes(writeTool), `${writeTool} must never be registered`);
  }
}));

test('exposes exactly the read-only surface the ticket calls for', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const names = await listTools(`http://127.0.0.1:${port}`);
  assert.deepEqual(
    names.sort(),
    ['git_blame', 'git_log', 'list_allowed_directories', 'list_directory', 'read_file', 'search_files'].sort(),
  );
}));

test('createPassengerMcpServer refuses an empty allowed-directories list', async () => {
  await assert.rejects(createPassengerMcpServer({ allowedDirectories: [] }), /at least one allowed directory/);
});

async function callTool(baseUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...AUTH_HEADER },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = parseMcpResponse(text) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? 'tool call failed');
  return body.result?.content?.[0]?.text ?? '';
}

test('a real HTTP round trip: read_file, list_directory, search_files, git_log, git_blame', async (t) => withMockedAuthEndpoint(async () => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'src'));
  commit(dir, 'src/app.ts', 'export const one = 1;\n', 'add app.ts');
  commit(dir, 'src/app.ts', 'export const one = 1;\nexport const two = 2;\n', 'add two');
  commit(dir, 'README.md', '# hi\n', 'add readme');

  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const readOut = await callTool(baseUrl, 'read_file', { path: join(dir, 'src/app.ts') });
  assert.equal(readOut, 'export const one = 1;\nexport const two = 2;\n');

  const headOut = await callTool(baseUrl, 'read_file', { path: join(dir, 'src/app.ts'), head: 1 });
  assert.equal(headOut, 'export const one = 1;');

  const listOut = await callTool(baseUrl, 'list_directory', { path: dir });
  assert.match(listOut, /\[DIR\]\s+src/);
  assert.match(listOut, /\[FILE\]\s+README\.md/);

  const searchOut = await callTool(baseUrl, 'search_files', { path: dir, pattern: '**/*.ts' });
  assert.match(searchOut, /app\.ts/);

  const logOut = await callTool(baseUrl, 'git_log', { path: join(dir, 'src/app.ts') });
  const logLines = logOut.split('\n');
  assert.equal(logLines.length, 2, logOut);
  assert.match(logLines[0]!, /add two/);
  assert.match(logLines[1]!, /add app\.ts/);
  assert.ok(!logOut.includes('+export'), 'git_log must never include a diff/patch body');

  const blameOut = await callTool(baseUrl, 'git_blame', { path: join(dir, 'src/app.ts') });
  assert.match(blameOut, /export const one = 1;/);
  assert.match(blameOut, /export const two = 2;/);

  const allowedOut = await callTool(baseUrl, 'list_allowed_directories', {});
  assert.equal(allowedOut, dir);
}));

test('ISSUE-661: a real tools/call pings the sync-daemon /activity route; tools/list does not', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));

  const daemon = createSyncDaemonServer([], 'daemon-secret');
  await new Promise<void>((resolve) => daemon.listen(0, resolve));
  t.after(() => daemon.close());
  const daemonPort = (daemon.address() as AddressInfo).port;
  const daemonAuth = { Authorization: 'Bearer daemon-secret' };
  const activitySnapshot = async () => {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/activity`, { headers: daemonAuth });
    return (await res.json()) as { lastActivityAt: string | null };
  };

  const syncOnInitialize = { url: `http://127.0.0.1:${daemonPort}/sync`, secret: 'daemon-secret' };
  const server = createPassengerHttpServer({ allowedDirectories: [dir], syncOnInitialize }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  assert.equal((await activitySnapshot()).lastActivityAt, null);

  await listTools(`http://127.0.0.1:${port}`);
  assert.equal((await activitySnapshot()).lastActivityAt, null, 'tools/list must not count as tool-call activity');

  await callTool(`http://127.0.0.1:${port}`, 'list_allowed_directories', {});
  // Fire-and-forget: give the outstanding ping a tick to actually land on
  // the daemon before asserting on it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((await activitySnapshot()).lastActivityAt, 'a real tools/call must ping /activity');
}));

test('read_file rejects a path outside the allowed directories over the wire', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const outside = mkdtempSync(join(tmpdir(), 'passenger-mcp-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'nope');

  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'read_file', { path: join(outside, 'secret.txt') }),
    /Access denied/,
  );
}));

test('git_log on a plain (non-git) directory reports a clear error, not a crash', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  writeFileSync(join(dir, 'plain.txt'), 'hello');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_log', { path: join(dir, 'plain.txt') }),
    /not inside a git repository/,
  );
}));

test('git_blame refuses a directory (only single files have blame)', async (t) => withMockedAuthEndpoint(async () => {
  const dir = gitRepo();
  commit(dir, 'a.txt', 'a\n', 'add a');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_blame', { path: dir }),
    /requires a file, not a repository root/,
  );
}));

test('git_log rejects a `ref` shaped like a git option, instead of letting it turn `git log` into a file-write', async (t) => withMockedAuthEndpoint(async () => {
  const dir = gitRepo();
  commit(dir, 'a.txt', 'a\n', 'add a');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const pokeFile = join(dir, 'poke-pwned.txt');
  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_log', { path: join(dir, 'a.txt'), ref: `--output=${pokeFile}` }),
    /ref must not start with "-"/,
  );
  assert.throws(() => execFileSync('test', ['-e', pokeFile]), 'git_log must never have written this file');
}));

test('git_blame rejects a `ref` shaped like a git option, the same way git_log does', async (t) => withMockedAuthEndpoint(async () => {
  const dir = gitRepo();
  commit(dir, 'a.txt', 'a\n', 'add a');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_blame', { path: join(dir, 'a.txt'), ref: '--help' }),
    /ref must not start with "-"/,
  );
}));

test('rejects a request with no Authorization header at all, before touching Tablation', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  const body = await res.json() as { error: { message: string } };
  assert.match(body.error.message, /Missing or malformed Authorization/);
}));

test('rejects an invalid or revoked API key', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  const body = await res.json() as { error: { message: string } };
  assert.match(body.error.message, /Invalid or revoked API key/);
}));

test('calls /api/auth/me, not bare /auth/me (ISSUE-694 security fix — regression guard)', async (t) => {
  const realFetch = globalThis.fetch;
  let calledUrl: string | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(FAKE_TABLATION_BASE)) return realFetch(input, init);
    calledUrl = url;
    return new Response(JSON.stringify({ id: 'user-1', workspaceId: WORKSPACE_ID }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...AUTH_HEADER },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  assert.ok(calledUrl, 'the credential check must actually have been called');
  assert.match(calledUrl!, /\/api\/auth\/me\?/, 'must hit /api/auth/me, not a bare /auth/me that a SPA catch-all could answer');
});

test('SECURITY (ISSUE-694): a 200 response that is not real JSON (e.g. a misrouted SPA catch-all) is rejected, not treated as valid auth', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(FAKE_TABLATION_BASE)) return realFetch(input, init);
    // Simulates exactly what a missing /api prefix would have hit: a 200
    // HTML page, not /auth/me's real JSON response.
    return new Response('<!doctype html><html>...</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer literally-anything-at-all' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  assert.equal(res.status, 502, 'must fail closed, never treat a non-JSON 200 as a successful credential check');
  const body = await res.json() as { error: { message: string } };
  assert.match(body.error.message, /unexpected content-type/);
});

test('rejects a valid key that belongs to a different workspace than this container serves', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer other-workspace-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 403);
  const body = await res.json() as { error: { message: string } };
  assert.match(body.error.message, /Not a member of this workspace/);
}, new Map([['other-workspace-token', 'some-other-workspace']])));

test('accepts the container\'s own mcpSecret as a Bearer token, with no Tablation round trip at all (ISSUE-685)', async (t) => {
  const realFetch = globalThis.fetch;
  let tablationWasCalled = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(FAKE_TABLATION_BASE)) tablationWasCalled = true;
    return realFetch(input, init);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const authWithSecret: PassengerAuthConfig = { ...AUTH, mcpSecret: 'container-identity-secret' };
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, authWithSecret);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer container-identity-secret' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(tablationWasCalled, false, 'a matching mcpSecret must short-circuit before ever calling Tablation');
});

test('a wrong Bearer token still falls through to the real Tablation check when mcpSecret is configured', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const authWithSecret: PassengerAuthConfig = { ...AUTH, mcpSecret: 'container-identity-secret' };
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, authWithSecret);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer not-the-secret-or-a-real-key' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  const body = await res.json() as { error: { message: string } };
  assert.match(body.error.message, /Invalid or revoked API key/);
}));

test('a real API key still works normally when mcpSecret is configured but not what was sent', async (t) => withMockedAuthEndpoint(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const authWithSecret: PassengerAuthConfig = { ...AUTH, mcpSecret: 'container-identity-secret' };
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, authWithSecret);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...AUTH_HEADER },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 200, await res.text());
}));

test('a Tablation lookup failure answers 502, not an uncaught rejection', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(FAKE_TABLATION_BASE)) throw new Error('network down');
    return realFetch(input, init);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] }, AUTH);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...AUTH_HEADER },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 502);
});
