import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REMEDY, runSelftest, recordSelftest, readSelftest, doctorSelftestLines, formatResult, type SelftestDeps, type SpawnedRun } from '../src/selftest.ts';
import { shipToolchains } from '../src/toolchain.ts';
import type { Ship } from '../src/config.ts';

const ship = { name: 'box', agent: { bin: 'claude', model: 'claude-sonnet-5-5', maxThinkingTokens: 0 }, extraPath: undefined } as unknown as Ship;
const [toolchain] = shipToolchains(ship);

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const text = (t: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const result = (extra: object = {}) => line({ type: 'result', total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
const run = (o: Partial<SpawnedRun>): SpawnedRun => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });

function go(r: SpawnedRun, over: { apiKey?: string; keyProblem?: string } = {}) {
  const seen: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; args?: string[] } = {};
  const deps: SelftestDeps = { run: async (o) => { Object.assign(seen, { cwd: o.cwd, env: o.env, stdin: o.stdin, args: o.args }); return r; } };
  const p = runSelftest({ ship, toolchain: toolchain!, baseUrl: 'https://t.test', workspaceId: 'ws-1', workspaceName: 'Acme Issues', apiKey: 'sk_key', ...over }, deps);
  return p.then((res) => ({ res, seen }));
}

test('passes when the reply names the workspace, with tokens and cost', async () => {
  const { res, seen } = await go(run({ stdout: text('Acme Issues') + result() }));
  assert.equal(res.ok, true);
  assert.equal(res.workspace, 'Acme Issues');
  assert.equal(res.tokens, 15);
  assert.equal(res.costUsd, 0.0123);
  assert.equal(seen.env?.CREW_API_KEY, 'sk_key');
  assert.match(seen.stdin ?? '', /ws-1/);
  assert.ok(seen.args?.some((a) => a.includes('https://t.test/api/mcp')));
  assert.match(formatResult(res), /PASS/);
});

test('leaves no temp directory behind, pass or fail', async () => {
  const { seen } = await go(run({ stdout: text('Acme Issues') }));
  assert.equal(existsSync(seen.cwd!), false);
  const { seen: s2 } = await go(run({ code: 1 }));
  assert.equal(existsSync(s2.cwd!), false);
});

test('binary not on the scheduler PATH', async () => {
  const { res } = await go(run({ code: null, spawnError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }));
  assert.equal(res.failure, 'binary-not-found');
  assert.match(res.detail, /scheduler PATH/);
});

test('harness exits before answering → login missing', async () => {
  const { res } = await go(run({ code: 1, stderr: 'Not logged in · Please run /login' }));
  assert.equal(res.failure, 'login-missing');
  const silent = (await go(run({ code: 1 }))).res;
  assert.equal(silent.failure, 'login-missing');
});

test('MCP server reported failed in the init line', async () => {
  const { res } = await go(run({ stdout: line({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'tablation', status: 'failed' }] }) + text('I have no tool for that.') }));
  assert.equal(res.failure, 'mcp-unavailable');
});

test('tracker 401/403 to the MCP call → key refused', async () => {
  const stdout =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__tablation__workspaces_controller_find_one', input: {} }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'HTTP 401 Unauthorized' }] } }) +
    text('The call was refused.');
  const { res } = await go(run({ stdout }));
  assert.equal(res.failure, 'key-refused');
});

test('no seat key readable (security exit 36) → keychain locked, nothing launched', async () => {
  let launched = false;
  const res = await runSelftest(
    { ship, toolchain: toolchain!, baseUrl: 'https://t.test', workspaceId: 'w', workspaceName: 'x', keyProblem: 'OS keychain unavailable (security exited 36: User interaction is not allowed.)' },
    { run: async () => { launched = true; return run({}); } },
  );
  assert.equal(res.failure, 'keychain-locked');
  assert.equal(launched, false);
  assert.equal(res.detail, `OS keychain unavailable (security exited 36: User interaction is not allowed.) — ${REMEDY['keychain-locked']}`);
  assert.equal(res.detail.split(REMEDY['keychain-locked']).length - 1, 1);
});

test('no seat key readable (security exit 128) → keychain-error with its own remedy', async () => {
  const res = await runSelftest(
    { ship, toolchain: toolchain!, baseUrl: 'https://t.test', workspaceId: 'w', workspaceName: 'x', keyProblem: 'OS keychain unavailable (security exited 128: User canceled)' },
    { run: async () => run({}) },
  );
  assert.equal(res.failure, 'keychain-error');
  assert.equal(res.detail, `OS keychain unavailable (security exited 128: User canceled) — ${REMEDY['keychain-error']}`);
});

test('timeout and an answer that is not the name', async () => {
  assert.equal((await go(run({ code: null, timedOut: true }))).res.failure, 'timeout');
  assert.equal((await go(run({ stdout: text('Something else') + result() }))).res.failure, 'wrong-answer');
});

test('results are stored per toolchain and doctor reports them without running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-st-'));
  assert.deepEqual(readSelftest(dir), {});
  recordSelftest(dir, [{ toolchain: 'claude', harness: 'claude', model: 'm', ok: false, failure: 'timeout', detail: 'd', ms: 1, ranAt: '2026-10-21T00:00:00.000Z' }]);
  assert.equal(readdirSync(dir).length, 1);
  const lines = doctorSelftestLines(readSelftest(dir), ['claude', 'codex']);
  assert.match(lines[0]!, /FAILED \(timeout\)/);
  assert.match(lines[1]!, /codex: not run/);
});
