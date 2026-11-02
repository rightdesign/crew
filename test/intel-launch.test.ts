import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsCodeBridge } from '../src/intel.ts';
import { adapterFor, type ToolchainSpec } from '../src/toolchain.ts';

const code = { command: '/usr/bin/node', args: ['/crew/bin/crew', 'intel', 'bridge', 'ws/proj', '7', '--state-dir', '/state'] };
const spec = (harness: string) => ({ harness, args: [], env: {}, auth: 'subscription' } as unknown as ToolchainSpec);
const mcp = { url: 'https://t.example/api/mcp', keyVar: 'CREW_API_KEY' };

test('claude registers code as a stdio server beside the tracker', () => {
  const inv = adapterFor('claude').invocation(spec('claude'), { role: 'dev', model: 'm', mcp, code });
  const cfg = JSON.parse(inv.args[inv.args.indexOf('--mcp-config') + 1] ?? '{}') as { mcpServers: Record<string, Record<string, unknown>> };
  assert.deepEqual(Object.keys(cfg.mcpServers), ['tablation', 'code']);
  assert.deepEqual(cfg.mcpServers.code, { type: 'stdio', command: code.command, args: code.args });
});

test('codex registers code with command and args overrides', () => {
  const inv = adapterFor('codex').invocation(spec('codex'), { role: 'dev', model: 'm', mcp, code });
  assert.ok(inv.args.includes(`mcp_servers.code.command=${JSON.stringify(code.command)}`));
  assert.ok(inv.args.includes(`mcp_servers.code.args=[${code.args.map((a) => JSON.stringify(a)).join(', ')}]`));
});

test('gemini names the per-run settings file in the environment', () => {
  assert.equal(adapterFor('gemini').runEnv(spec('gemini'), { code: { ...code, settingsFile: '/state/g.json' } }).GEMINI_CLI_SYSTEM_SETTINGS_PATH, '/state/g.json');
});

test('without a bridge nothing changes for any harness', () => {
  for (const h of ['claude', 'codex'] as const) {
    const a = adapterFor(h).invocation(spec(h), { role: 'dev', model: 'm', mcp }).args;
    assert.ok(!a.join(' ').includes('mcp_servers.code') && !a.join(' ').includes('"code"'));
  }
  assert.equal(adapterFor('gemini').runEnv(spec('gemini')).GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined);
});

test('a bridge is wanted for a command or the serena flavor, not for nothing or typescript-lsp', () => {
  assert.equal(wantsCodeBridge('scripts/dev-intel.sh'), true);
  assert.equal(wantsCodeBridge('serena'), true);
  assert.equal(wantsCodeBridge(undefined), false);
  assert.equal(wantsCodeBridge('  '), false);
  assert.equal(wantsCodeBridge('typescript-lsp'), false);
});
