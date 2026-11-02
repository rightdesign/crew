import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { STATUS_LOST, STATUS_TOOL, STATUS_WAITING, attachFilePath, createBridge, readAttachFile, writeAttachFile } from '../src/intel-bridge.ts';

/** An in-process upstream offering one tool, wired to a fresh client per connect. */
function upstreamFactory() {
  const state = { alive: true, connects: 0, transports: [] as InMemoryTransport[] };
  const connectUpstream = async (): Promise<Client> => {
    state.connects += 1;
    const server = new Server({ name: 'serena', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'find_symbol', description: 'find', inputSchema: { type: 'object', properties: {} } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: 'text', text: `found ${JSON.stringify(r.params.arguments)}` }] }));
    const [c, s] = InMemoryTransport.createLinkedPair();
    state.transports.push(s);
    await server.connect(s);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(c);
    return client;
  };
  return { state, connectUpstream };
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const attachFile = attachFilePath(dir, 'ws/proj', 'ISSUE-1');
  const up = upstreamFactory();
  const bridge = createBridge({ attachFile, pollMs: 20, connectUpstream: up.connectUpstream });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.start(b);
  const client = new Client({ name: 'harness', version: '0' }, { capabilities: {} });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed += 1; });
  await client.connect(a);
  const publish = async (url = 'http://127.0.0.1:1/mcp') => writeAttachFile(attachFile, url);
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f(), 'condition not reached'); };
  return { dir, bridge, client, up, publish, until, changes: () => changed, done: async () => { await bridge.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('before the attach file exists the only tool is code_status and it says the worktree is not cut', async () => {
  const h = await harness();
  try {
    assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name), [STATUS_TOOL]);
    const r = await h.client.callTool({ name: STATUS_TOOL, arguments: {} });
    assert.equal((r.content as Array<{ text: string }>)[0]?.text, STATUS_WAITING);
    assert.equal(h.up.state.connects, 0);
  } finally { await h.done(); }
});

test('when the attach file appears the bridge attaches, notifies once, and forwards list and call', async () => {
  const h = await harness();
  try {
    await h.publish();
    await h.until(() => h.bridge.attached());
    await h.until(() => h.changes() >= 1);
    assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name), ['find_symbol']);
    const r = await h.client.callTool({ name: 'find_symbol', arguments: { name: 'X' } });
    assert.equal((r.content as Array<{ text: string }>)[0]?.text, 'found {"name":"X"}');
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(h.changes(), 1);
    assert.equal(h.up.state.connects, 1);
  } finally { await h.done(); }
});

test('losing the upstream answers with the status text instead of an error, and re-attaches when it returns', async () => {
  const h = await harness();
  try {
    await h.publish();
    await h.until(() => h.bridge.attached());
    await h.up.state.transports[0]?.close();
    const r = await h.client.callTool({ name: 'find_symbol', arguments: {} });
    assert.equal(r.isError, undefined);
    assert.equal((r.content as Array<{ text: string }>)[0]?.text, STATUS_LOST);
    assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name), [STATUS_TOOL]);
    // The attach file is still there, so the poll connects again.
    await h.until(() => h.bridge.attached());
    assert.ok(h.up.state.connects >= 2);
    assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name), ['find_symbol']);
  } finally { await h.done(); }
});

test('readAttachFile ignores a missing file and a non-URL line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  try {
    assert.equal(readAttachFile(join(dir, 'nope')), undefined);
    writeFileSync(join(dir, 'u'), 'not a url\n');
    assert.equal(readAttachFile(join(dir, 'u')), undefined);
    writeFileSync(join(dir, 'u'), 'http://127.0.0.1:9/mcp\n');
    assert.equal(readAttachFile(join(dir, 'u')), 'http://127.0.0.1:9/mcp');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
