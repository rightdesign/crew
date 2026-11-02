import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { codeToolsParagraph, probeIntel } from '../src/intel.ts';

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const service = (calls: string[] = []): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
  const m = JSON.parse(String(init?.body)) as { method: string; id?: number };
  calls.push(m.method);
  if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: {} }, { 'mcp-session-id': 's1' });
  if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'find_symbol' }, { name: 'outline' }] } });
  return new Response(null, { status: 202 });
}) as typeof fetch;

const hook0 = (url: string) => ({ runHook: async () => ({ code: 0, output: `${url}\n` }) });
const hook = (code: number, output: string) => ({ runHook: async () => ({ code, output }) });

test('a hook whose URL answers is ready, with the advertised tools', async () => {
  const calls: string[] = [];
  const o = await probeIntel({ ...hook(0, 'starting\nhttp://127.0.0.1:50123/mcp\n'), fetch: service(calls) }, {}, 5);
  assert.deepEqual(o, { state: 'ready', url: 'http://127.0.0.1:50123/mcp', tools: ['find_symbol', 'outline'] });
  assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('an SSE reply is read', async () => {
  const f = (async (_u: unknown, init?: RequestInit) => {
    const m = JSON.parse(String(init?.body)) as { method: string; id?: number };
    const result = m.method === 'tools/list' ? { tools: [{ name: 'a' }] } : {};
    return m.method === 'notifications/initialized'
      ? new Response(null, { status: 202 })
      : new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const o = await probeIntel({ ...hook(0, 'http://localhost:1/mcp'), fetch: f }, {}, 5);
  assert.equal(o.state === 'ready' && o.tools[0], 'a');
});

test('no hook is absent', async () => {
  assert.deepEqual(await probeIntel({ runHook: async () => null }, {}, 5), { state: 'absent' });
});

test('failures are reasons, never throws', async () => {
  const nonZero = await probeIntel(hook(3, 'boom'), {}, 5);
  assert.deepEqual(nonZero, { state: 'failed', reason: 'the intel hook exited 3: boom' });
  const noUrl = await probeIntel(hook(0, 'started ok'), {}, 5);
  assert.deepEqual(noUrl, { state: 'failed', reason: 'the intel hook printed no URL as its last line' });
  const threw = await probeIntel({ runHook: async () => { throw new Error('spawn failed'); } }, {}, 5);
  assert.equal(threw.state, 'failed');
});

test('a URL that never answers times out after the startup budget', async () => {
  let t = 0;
  let attempts = 0;
  const o = await probeIntel({
    ...hook(0, 'http://127.0.0.1:9/mcp'),
    fetch: (async () => { attempts++; throw new Error('ECONNREFUSED'); }) as typeof fetch,
    sleep: async (ms) => { t += ms; },
    now: () => t,
  }, {}, 2);
  assert.equal(o.state, 'failed');
  assert.match(o.state === 'failed' ? o.reason : '', /did not answer an MCP initialize within 2s \(ECONNREFUSED\)/);
  assert.ok(attempts >= 3);
});

test('a service that accepts the connection and never replies fails by the startup budget', async () => {
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const started = Date.now();
  try {
    const o = await probeIntel(hook0(`http://127.0.0.1:${port}/mcp`), {}, 1);
    assert.equal(o.state, 'failed');
    assert.match(o.state === 'failed' ? o.reason : '', /did not answer an MCP initialize within 1s/);
    assert.ok(Date.now() - started < 4000, 'returned near the deadline, not hung');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the paragraph covers ready, absent and failed', () => {
  const ready = codeToolsParagraph({ state: 'ready', url: 'http://x', tools: ['find_symbol'] });
  assert.match(ready, /`code` MCP server/);
  assert.match(ready, /find symbols by name; references to a symbol; a symbol's definition; a file's symbol outline/);
  assert.match(ready, /`find_symbol`/);
  assert.equal(codeToolsParagraph({ state: 'absent' }), 'No symbol service is available for this repository.');
  assert.match(codeToolsParagraph({ state: 'failed', reason: 'no URL' }), /did not start \(no URL\)/);
});

import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { checkHookSyntax } from '../src/repos-check.ts';

test('a .crew.yaml with hooks.intel loads, and the syntax check sees a broken one', () => {
  const cfg = resolveRepoConfig(parseRepoConfig('version: 1\nrelease:\n  mode: integrate\nhooks:\n  intel: ./intel.sh\n', '.crew.yaml'), undefined, '/w/x');
  assert.equal(cfg.hooks.intel, './intel.sh');
  assert.equal(checkHookSyntax('if then fi (', 'bash').status, 'error');
});
