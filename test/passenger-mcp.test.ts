import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createPassengerMcpServer, createPassengerHttpServer } from '../src/passenger-mcp.ts';

const WRITE_SHAPED_TOOL_NAMES = ['write_file', 'edit_file', 'move_file', 'create_directory', 'delete_file'];

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
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = parseMcpResponse(text) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name);
}

test('never exposes a write-shaped tool over the wire, whatever the reference server offers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const names = await listTools(`http://127.0.0.1:${port}`);
  assert.ok(names.length > 0, 'sanity check: some tools were registered');
  for (const writeTool of WRITE_SHAPED_TOOL_NAMES) {
    assert.ok(!names.includes(writeTool), `${writeTool} must never be registered`);
  }
});

test('exposes exactly the read-only surface the ticket calls for', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const names = await listTools(`http://127.0.0.1:${port}`);
  assert.deepEqual(
    names.sort(),
    ['git_blame', 'git_log', 'list_allowed_directories', 'list_directory', 'read_file', 'search_files'].sort(),
  );
});

test('createPassengerMcpServer refuses an empty allowed-directories list', async () => {
  await assert.rejects(createPassengerMcpServer({ allowedDirectories: [] }), /at least one allowed directory/);
});

async function callTool(baseUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
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

test('a real HTTP round trip: read_file, list_directory, search_files, git_log, git_blame', async (t) => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'src'));
  commit(dir, 'src/app.ts', 'export const one = 1;\n', 'add app.ts');
  commit(dir, 'src/app.ts', 'export const one = 1;\nexport const two = 2;\n', 'add two');
  commit(dir, 'README.md', '# hi\n', 'add readme');

  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
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
});

test('read_file rejects a path outside the allowed directories over the wire', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  const outside = mkdtempSync(join(tmpdir(), 'passenger-mcp-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'nope');

  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'read_file', { path: join(outside, 'secret.txt') }),
    /Access denied/,
  );
});

test('git_log on a plain (non-git) directory reports a clear error, not a crash', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'passenger-mcp-'));
  writeFileSync(join(dir, 'plain.txt'), 'hello');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_log', { path: join(dir, 'plain.txt') }),
    /not inside a git repository/,
  );
});

test('git_blame refuses a directory (only single files have blame)', async (t) => {
  const dir = gitRepo();
  commit(dir, 'a.txt', 'a\n', 'add a');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_blame', { path: dir }),
    /requires a file, not a repository root/,
  );
});

test('git_log rejects a `ref` shaped like a git option, instead of letting it turn `git log` into a file-write', async (t) => {
  const dir = gitRepo();
  commit(dir, 'a.txt', 'a\n', 'add a');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const pokeFile = join(dir, 'poke-pwned.txt');
  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_log', { path: join(dir, 'a.txt'), ref: `--output=${pokeFile}` }),
    /ref must not start with "-"/,
  );
  assert.throws(() => execFileSync('test', ['-e', pokeFile]), 'git_log must never have written this file');
});

test('git_blame rejects a `ref` shaped like a git option, the same way git_log does', async (t) => {
  const dir = gitRepo();
  commit(dir, 'a.txt', 'a\n', 'add a');
  const server = createPassengerHttpServer({ allowedDirectories: [dir] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    callTool(`http://127.0.0.1:${port}`, 'git_blame', { path: join(dir, 'a.txt'), ref: '--help' }),
    /ref must not start with "-"/,
  );
});
