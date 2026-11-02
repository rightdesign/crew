import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { STATUS_STARTING, STATUS_TOOL, createBridge, readAttachFile } from '../src/intel-bridge.ts';
import { sandboxCodeToolsSection, sandboxEnv, writeFilesScript } from '../src/sandbox-brief.ts';
import { envFromHookOutput, parseSandboxBridgeArgs, sandboxStarter } from '../src/sandbox-intel-bridge.ts';
import { SANDBOX_INTEL_DIR, sandboxLspPlugin } from '../src/intel.ts';
import { SANDBOX_BRIDGE_PATH, planSandbox } from '../src/sandbox-image.ts';
import { codeBridgeFor, sandboxLspPluginFor, type PlanOptions } from '../src/agent.ts';
import { renderEnvironment } from '../src/environment.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';

const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text) ?? '';

function upstream() {
  const state = { connects: 0 };
  const connectUpstream = async (): Promise<Client> => {
    state.connects += 1;
    const server = new Server({ name: 'serena', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'find_symbol', description: 'f', inputSchema: { type: 'object', properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'found' }] }));
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(c);
    return client;
  };
  return { state, connectUpstream };
}

async function lazyHarness(start: () => Promise<{ url: string } | { error: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-'));
  const attachFile = join(dir, 'intel', 'url');
  const up = upstream();
  const bridge = createBridge({ attachFile, pollMs: 20, connectUpstream: up.connectUpstream, start });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.start(b);
  const client = new Client({ name: 'h', version: '0' }, { capabilities: {} });
  await client.connect(a);
  return { dir, attachFile, up, bridge, client, done: async () => { await bridge.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the first tools/list starts the service without holding the listing, and the symbol tools replace code_status', async () => {
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = await lazyHarness(async () => { starts += 1; await gate; return { url: 'http://127.0.0.1:9/mcp' }; });
  try {
    assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name), [STATUS_TOOL]);
    assert.equal(text(await h.client.callTool({ name: STATUS_TOOL, arguments: {} })), STATUS_STARTING);
    release();
    for (let i = 0; i < 100 && !h.bridge.attached(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.bridge.attached(), true);
    assert.equal(starts, 1);
    assert.equal(readAttachFile(h.attachFile), 'http://127.0.0.1:9/mcp');
    assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name), ['find_symbol']);
  } finally { await h.done(); }
});

test('a symbol call during the start waits for it and then answers', async () => {
  const h = await lazyHarness(async () => { await new Promise((r) => setTimeout(r, 60)); return { url: 'http://127.0.0.1:9/mcp' }; });
  try {
    assert.equal(text(await h.client.callTool({ name: 'find_symbol', arguments: {} })), 'found');
  } finally { await h.done(); }
});

test('a failed start is reported by code_status, which then retries', async () => {
  let n = 0;
  const h = await lazyHarness(async () => (++n === 1 ? { error: 'serena needs uv on PATH' } : { url: 'http://127.0.0.1:9/mcp' }));
  try {
    await h.client.listTools();
    for (let i = 0; i < 100 && n < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    assert.match(text(await h.client.callTool({ name: STATUS_TOOL, arguments: {} })), /did not start \(serena needs uv on PATH\)/);
    for (let i = 0; i < 100 && !h.bridge.attached(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.bridge.attached(), true);
    assert.equal(n, 2);
  } finally { await h.done(); }
});

test('sandbox args parse with defaults and refuse a missing required flag', () => {
  const a = parseSandboxBridgeArgs(['--attach-file', '/f', '--start', 'serena', '--clone', '/c']);
  assert.deepEqual(a, { attachFile: '/f', start: 'serena', clone: '/c', stateDir: '/sandbox/.crew', ticket: 0, startupSeconds: 90 });
  assert.throws(() => parseSandboxBridgeArgs(['--start', 'x']), /usage/);
  assert.deepEqual(envFromHookOutput('A=1\nnoise\nB="two"\n'), { A: '1', B: 'two' });
});

test('the lazy start runs ports, exports its output to the intel command, and returns the URL it prints', async () => {
  const clone = mkdtempSync(join(tmpdir(), 'clone-'));
  writeFileSync(join(clone, '.crew.yaml'), 'version: 1\nrelease:\n  mode: integrate\nhooks:\n  ports: scripts/ports\n  intel: scripts/intel\n');
  const seen: Array<{ script: string; env: Record<string, string | undefined> }> = [];
  // The service the intel command "started": answers MCP initialize and tools/list.
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = JSON.parse(body || '{}') as { id?: number; method?: string };
      res.setHeader('content-type', 'application/json');
      if (m.method === 'tools/list') res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'find_symbol' }] } }));
      else if (m.id !== undefined) res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
      else res.end();
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  try {
    const start = sandboxStarter(
      { attachFile: join(clone, 'url'), start: 'scripts/intel', clone, stateDir: join(clone, 's'), ticket: 7, startupSeconds: 5 },
      async (script, opts) => {
        seen.push({ script, env: { ...opts.env } });
        return script === 'scripts/ports' ? { code: 0, output: 'SVC_PORT=51234\n', stdout: 'SVC_PORT=51234\n' } : { code: 0, output: `http://127.0.0.1:${port}/mcp\n`, stdout: `http://127.0.0.1:${port}/mcp\n` };
      },
    );
    assert.deepEqual(await start(), { url: `http://127.0.0.1:${port}/mcp` });
    assert.deepEqual(seen.map((s) => s.script), ['scripts/ports', 'scripts/intel']);
    assert.equal(seen[1]?.env.SVC_PORT, '51234');
    const failing = sandboxStarter(
      { attachFile: join(clone, 'url'), start: 'scripts/intel', clone, stateDir: join(clone, 's'), ticket: 7, startupSeconds: 1 },
      async () => ({ code: 3, output: 'boom', stdout: '' }),
    );
    const r = await failing();
    assert.ok('error' in r && /exited 3/.test(r.error));
  } finally { http.close(); rmSync(clone, { recursive: true, force: true }); }
});

// --- codeBridgeFor, the plugin directory, the image, the runner script, the brief ----------

function plan(intel: string | undefined, runner: 'sandbox' | 'host', harness = 'claude') {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  writeFileSync(join(dir, '.crew.yaml'), `version: 1\nrelease:\n  mode: integrate\n${intel ? `hooks:\n  intel: ${intel}\n` : ''}`);
  const route = { route: 'ws/proj', dir, repos: { app: dir }, dirIsCloneBase: false } as never;
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const o = { route, ticket: 'CREW-2922', repo: 'app', stateDir: state, ship: { runner, ...(runner === 'sandbox' ? { sandbox: { workDir: '/sandbox/work' } } : {}) } } as unknown as PlanOptions;
  return { o, route, dir, state, bridge: codeBridgeFor(o, harness), cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); } };
}

test('a sandbox run on a repository declaring intel gets the in-image bridge, with the flavor and the clone', () => {
  const p = plan('serena', 'sandbox');
  try {
    assert.deepEqual(p.bridge, {
      command: 'node',
      args: [SANDBOX_BRIDGE_PATH, '--attach-file', '/sandbox/.crew/intel/url', '--start', 'serena', '--clone', '/sandbox/work', '--state-dir', '/sandbox/.crew', '--ticket', '2922'],
    });
  } finally { p.cleanup(); }
  const c = plan('scripts/dev-intel.sh', 'sandbox');
  try { assert.equal(c.bridge?.args[c.bridge.args.indexOf('--start') + 1], 'scripts/dev-intel.sh'); } finally { c.cleanup(); }
});

test('a sandbox run gets a gemini settings file written into the sandbox, not the host state dir', () => {
  const p = plan('serena', 'sandbox', 'gemini');
  try {
    assert.equal(p.bridge?.settingsFile, `${SANDBOX_INTEL_DIR}/gemini-settings.json`);
    assert.equal(p.bridge?.files?.[0]?.path, p.bridge?.settingsFile);
    assert.equal((JSON.parse(p.bridge!.files![0]!.content) as { mcpServers: { code: { command: string } } }).mcpServers.code.command, 'node');
  } finally { p.cleanup(); }
});

test('no intel, or typescript-lsp, registers no bridge in a sandbox; a host run is unchanged', () => {
  for (const intel of [undefined, 'typescript-lsp']) {
    const p = plan(intel, 'sandbox');
    try { assert.equal(p.bridge, undefined); } finally { p.cleanup(); }
  }
  const h = plan('serena', 'host');
  try {
    assert.equal(h.bridge?.command, process.execPath);
    assert.ok(h.bridge?.args.includes('bridge') && h.bridge.args.includes(h.state));
    assert.equal(h.bridge?.files, undefined);
  } finally { h.cleanup(); }
});

test('typescript-lsp gets its plugin directory written inside the sandbox, server resolved through the clone', () => {
  const p = plan('typescript-lsp', 'sandbox');
  try {
    const lsp = sandboxLspPluginFor(p.route, 'app');
    assert.equal(lsp?.dir, `${SANDBOX_INTEL_DIR}/plugins/typescript-lsp`);
    const paths = lsp!.files.map((f) => f.path).sort();
    assert.deepEqual(paths, [`${lsp!.dir}/.claude-plugin/plugin.json`, `${lsp!.dir}/.lsp.json`]);
    const def = JSON.parse(lsp!.files.find((f) => f.path.endsWith('.lsp.json'))!.content) as Record<string, { command: string }>;
    assert.equal(def['typescript-language-server']?.command, '${CLAUDE_PROJECT_DIR}/node_modules/.bin/typescript-language-server');
    assert.deepEqual(sandboxLspPlugin('typescript-lsp'), lsp);
  } finally { p.cleanup(); }
  const none = plan('serena', 'sandbox');
  try { assert.equal(sandboxLspPluginFor(none.route, 'app'), undefined); } finally { none.cleanup(); }
});

test('the bridge is copied into the crew layer only when a bundle is passed, and the repo without intel keeps its image', () => {
  const decl = { packages: [], setup: [], warm: [] };
  const without = planSandbox('r', decl);
  const withBridge = planSandbox('r', decl, {}, '// bundle');
  const crew = (pl: ReturnType<typeof planSandbox>) => pl.layers.find((l) => l.name === 'crew')!;
  assert.ok(!crew(without).dockerfile.includes('intel-bridge'));
  assert.deepEqual(Object.keys(crew(without).files).sort(), ['credential-helper', 'mcp.json']);
  assert.match(crew(withBridge).dockerfile, new RegExp(`COPY intel-bridge ${SANDBOX_BRIDGE_PATH}`));
  assert.equal(crew(withBridge).files['intel-bridge'], '// bundle');
  assert.notEqual(withBridge.tag, without.tag);
  assert.equal(planSandbox('r', decl).tag, without.tag);
});

test('writeFilesScript recreates each file byte for byte under a shell, whatever the content', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-'));
  try {
    const files = [
      { path: join(root, 'a', 'b', 'x.json'), content: `{"k": "it's \${CLAUDE_PROJECT_DIR} \\ \`q\`"}\n` },
      { path: join(root, 'y'), content: 'plain' },
    ];
    execFileSync('sh', ['-c', writeFilesScript(files)]);
    for (const f of files) assert.equal(readFileSync(f.path, 'utf8'), f.content);
    mkdirSync(join(root, 'z'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the sandbox brief names the code server for a bridge flavor and the LSP tool for typescript-lsp, and nothing otherwise', () => {
  assert.match(sandboxCodeToolsSection('serena').join('\n'), /`code` MCP server[\s\S]*run `setup`\s+before your first lookup/);
  assert.match(sandboxCodeToolsSection('typescript-lsp').join('\n'), /Claude Code harness: the harness's `LSP` tool/);
  assert.deepEqual(sandboxCodeToolsSection(undefined), []);
  const repo = { name: 'app', dir: '/x', config: { hooks: { intel: 'serena' }, branch: { remote: 'origin', base: 'main' } } };
  const env = renderEnvironment({ route: { route: 'ws/p', baseUrl: 'https://t', resolved: undefined } as never, userAgent: 'u', repos: [repo as never], contract: DEFAULT_CONTRACT, ...sandboxEnv({ runner: 'sandbox' }) });
  assert.match(env, /\*\*Code tools\.\*\*/);
});

test('a sandbox run on a serena repository with a forge origin is told where the host-seeded cache is', () => {
  const p = plan('serena', 'sandbox');
  try {
    execFileSync('git', ['-C', p.dir, 'init', '-q']);
    execFileSync('git', ['-C', p.dir, 'remote', 'add', 'origin', 'https://forge.test/acme/widgets.git']);
    const b = codeBridgeFor(p.o, 'claude');
    assert.deepEqual(b?.args.slice(-2), ['--seed-cache', '/cache/intel/forge.test/acme/widgets/cache']);
  } finally { p.cleanup(); }
  const c = plan('scripts/dev-intel.sh', 'sandbox');
  try { assert.ok(!codeBridgeFor(c.o, 'claude')!.args.includes('--seed-cache')); } finally { c.cleanup(); }
});

test('--seed-cache parses', () => {
  assert.equal(parseSandboxBridgeArgs(['--attach-file', '/f', '--start', 'serena', '--clone', '/c', '--seed-cache', '/s']).seedCache, '/s');
});
