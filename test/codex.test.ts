import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  codexAdapter, codexSandboxFor, commandTarget, mapCodexLine, extractCodexResult, extractCodexTurnTokens, CODEX_BILLING_VARS_TO_UNSET,
} from '../src/adapters/codex.ts';
import { adapterFor, resolveSeat, profileFor, isHarness, type ToolchainSpec } from '../src/toolchain.ts';
import { planAgentRun, spawnAgent, scrubbedEnv } from '../src/agent.ts';
import { Emitter } from '../src/events.ts';
import { pairInstallerFor } from '../src/pair-install.ts';

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex-stream.mjs');
const URL = 'https://app.example.test/api/mcp';

const spec = (over: Partial<ToolchainSpec> = {}): ToolchainSpec => ({
  name: 'codex', harness: 'codex', bin: 'codex', model: 'gpt-5-codex', tiers: codexAdapter.defaultTiers, args: [], env: {}, maxThinkingTokens: 0, ...over,
});
const argvFor = (role: 'dev' | 'qa' | 'triage', s = spec(), mcp = true) =>
  codexAdapter.invocation(s, { role, model: s.model, mcp: mcp ? { url: URL, keyVar: 'CREW_API_KEY' } : undefined });

test('codex is a registered harness', () => {
  assert.ok(isHarness('codex'));
  assert.equal(adapterFor('codex'), codexAdapter);
});

test('capability levels map onto sandbox modes', () => {
  assert.equal(codexSandboxFor(profileFor('triage')), 'read-only');
  // Not workspace-write: it keeps .git read-only, so no worktree and no commit (see codexSandboxFor).
  assert.equal(codexSandboxFor(profileFor('qa')), 'danger-full-access');
  assert.equal(codexSandboxFor(profileFor('dev')), 'danger-full-access');
  assert.equal(codexSandboxFor(profileFor('design')), 'danger-full-access');
});

test('argv: exec --json, sandbox, model, no approvals, prompt on stdin', () => {
  const { bin, args } = argvFor('dev');
  assert.equal(bin, 'codex');
  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5-codex');
  assert.ok(args.includes('approval_policy="never"'));
  assert.equal(args.at(-1), '-');
  assert.equal(argvFor('triage').args[argvFor('triage').args.indexOf('--sandbox') + 1], 'read-only');
});

test('argv: the tracker MCP is a per-run override naming the key variable, never the key', () => {
  const { args } = argvFor('dev');
  assert.ok(args.includes(`mcp_servers.tablation.url=${JSON.stringify(URL)}`));
  assert.ok(args.includes('mcp_servers.tablation.bearer_token_env_var="CREW_API_KEY"'));
  // Without this Codex auto-rejects every MCP call under approval_policy="never".
  assert.ok(args.includes('mcp_servers.tablation.default_tools_approval_mode="approve"'));
  assert.ok(!argvFor('dev', spec(), false).args.some((a) => a.includes('mcp_servers')));
});

test('argv: extra args come before the stdin marker; a launcher wraps the command', () => {
  const { args } = argvFor('dev', spec({ args: ['--add-dir', '/x'] }));
  assert.deepEqual(args.slice(-3), ['--add-dir', '/x', '-']);
  const wrapped = codexAdapter.invocation(spec({ launcher: '/opt/ori' }), { role: 'dev', model: 'm' });
  assert.equal(wrapped.bin, '/opt/ori');
  assert.equal(wrapped.args[0], 'codex');
});

test('a tier\'s reasoning becomes model_reasoning_effort; an unknown value is ignored', () => {
  const deep = resolveSeat({ agent: { bin: 'x', model: 'm' }, toolchains: [spec()], toolchain: 'codex' } as any, undefined, 'dev', { tier: 'deep' });
  assert.equal(deep.toolchain.reasoningEffort, 'high');
  assert.ok(argvFor('dev', deep.toolchain).args.includes('model_reasoning_effort="high"'));
  assert.equal(codexAdapter.applyReasoning!(spec(), '4096').reasoningEffort, undefined);
  assert.ok(!argvFor('dev').args.some((a) => a.startsWith('model_reasoning_effort')));
});

test('model ownership: OpenAI ids only', () => {
  assert.ok(codexAdapter.ownsModel('gpt-5-codex'));
  assert.ok(codexAdapter.ownsModel('o3'));
  assert.ok(!codexAdapter.ownsModel('claude-sonnet-5'));
});

test('billing variables are scrubbed, and a toolchain env set after the scrub survives', () => {
  const env = scrubbedEnv({ OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'u', PATH: '/bin' }, 'codex');
  for (const v of CODEX_BILLING_VARS_TO_UNSET) assert.equal(env[v], undefined);
  assert.equal(env.PATH, '/bin');
  assert.deepEqual(codexAdapter.runEnv(spec({ env: { OPENAI_API_KEY: 'explicit' } })), { OPENAI_API_KEY: 'explicit' });
});

test('the capability matrix names what Codex cannot enforce', () => {
  const text = codexAdapter.limitations.join('\n');
  assert.match(text, /push/);
  assert.match(text, /per-tool/);
  assert.match(text, /design canvas/);
});

test('stream mapping: reasoning, message, command, file change, MCP call, search', () => {
  const item = (i: object) => mapCodexLine({ type: 'item.completed', item: i });
  assert.deepEqual(item({ type: 'reasoning', text: 'hm' }), [{ kind: 'thought', text: 'hm' }]);
  assert.deepEqual(item({ type: 'agent_message', text: 'hi' }), [{ kind: 'text', text: 'hi' }]);
  assert.deepEqual(item({ type: 'command_execution', command: 'git status' }), [{ kind: 'tool', tool: 'command', target: 'git' }]);
  assert.deepEqual(item({ type: 'file_change', changes: [{ path: 'a.ts' }] }), [{ kind: 'tool', tool: 'file_change', target: 'a.ts' }]);
  assert.deepEqual(item({ type: 'mcp_tool_call', server: 'tablation', tool: 'records_controller_list' }), [{ kind: 'tool', tool: 'mcp__tablation__records_controller_list' }]);
  assert.deepEqual(item({ type: 'web_search', query: 'q' }), [{ kind: 'tool', tool: 'web_search', target: 'q' }]);
  assert.deepEqual(item({ type: 'todo_list' }), []);
  assert.deepEqual(mapCodexLine({ type: 'item.started', item: { type: 'agent_message', text: 'x' } }), []);
  assert.deepEqual(mapCodexLine({ type: 'turn.started' }), []);
  assert.deepEqual(mapCodexLine(null), []);
});

test('commandTarget unwraps a shell -lc wrapper', () => {
  assert.equal(commandTarget('/bin/zsh -lc "git status"'), 'git');
  assert.equal(commandTarget("bash -c 'ls -la'"), 'ls');
  assert.equal(commandTarget('pnpm test'), 'pnpm');
  assert.equal(commandTarget(undefined), undefined);
});

test('result extraction: session id and the turn\'s usage, cached input as cacheRead, no cost', () => {
  assert.deepEqual(extractCodexResult({ type: 'thread.started', thread_id: 't1' }), { sessionId: 't1' });
  const r = extractCodexResult({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: 2 } });
  assert.deepEqual(r, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 });
  assert.equal(extractCodexResult({ type: 'turn.started' }), undefined);
  assert.equal(extractCodexTurnTokens({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }), 12);
  assert.equal(extractCodexTurnTokens({ type: 'item.completed' }), undefined);
});

test('MCP registration in Codex config: ensure, inspect, replace, keep other entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-mcp-'));
  mkdirSync(join(home, '.codex'));
  const cfg = join(home, '.codex', 'config.toml');
  writeFileSync(cfg, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const o = { bin: process.execPath, url: URL, key: '', home };
  assert.equal(codexAdapter.inspectMcp(o).state, 'missing');
  assert.match(codexAdapter.ensureMcp(o), /registered the tablation MCP server/);
  const text = readFileSync(cfg, 'utf8');
  assert.match(text, /\[mcp_servers\.other\]/);
  assert.match(text, /bearer_token_env_var = "CREW_API_KEY"/);
  assert.ok(!/sk_/.test(text));
  assert.equal(codexAdapter.inspectMcp(o).state, 'registered');
  assert.match(codexAdapter.ensureMcp(o), /already registered/);
  assert.equal(codexAdapter.inspectMcp({ ...o, url: 'https://other.test/api/mcp' }).state, 'different');
  assert.match(codexAdapter.ensureMcp({ ...o, url: 'https://other.test/api/mcp' }), /left Codex's/);
  assert.match(codexAdapter.ensureMcp({ ...o, url: 'https://other.test/api/mcp', replace: true }), /registered/);
  assert.equal(codexAdapter.inspectMcp({ ...o, bin: '/nonexistent/codex', url: 'https://other.test/api/mcp' }).state, 'no-binary');
});

test('disconnect path: the Codex installer removes the entry and block it added', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-pair-'));
  const inst = pairInstallerFor('codex');
  inst.installPair({ url: URL, home });
  assert.ok(inst.verifyPair({ url: URL, home }).ok);
  inst.removePair({ url: URL, home });
  assert.ok(!existsSync(join(home, '.codex', 'config.toml')));
  assert.ok(!existsSync(join(home, '.codex', 'AGENTS.md')));
});

test('a recorded run end to end: cycles, session, tokens and identity', async () => {
  const state = mkdtempSync(join(tmpdir(), 'crew-state-'));
  const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
  const personas = join(home, 'prompts', 'personas');
  mkdirSync(personas, { recursive: true });
  writeFileSync(join(personas, 'common.md'), 'SHARED\n');
  for (const r of ['dev', 'design', 'qa', 'triage', 'pair']) writeFileSync(join(personas, `lane-${r}.md`), `BRIEF ${r}\n`);
  const route = { route: 'test/proj', dir: state, promptsDir: join(home, 'prompts'), toolchain: 'codex' } as any;
  const ship = { agent: { bin: 'x', model: 'claude-sonnet-5' }, toolchains: [spec()], userAgent: 'crew-test' } as any;
  const plan = planAgentRun({ role: 'dev', route, ship, stateDir: state, roster: 'R', environment: 'E', cycle: 'c1', ticket: 'ISSUE-7' });
  assert.equal(plan.harness, 'codex');
  assert.equal(plan.provider, 'openai');
  assert.equal(plan.args[0], 'exec');
  plan.bin = process.execPath;
  plan.args = [FAKE_CODEX];
  const emit = new Emitter({ route: 'proj', cycleId: 'c1', console: () => {} });
  emit.enter('agent', 'dev');
  assert.equal((await spawnAgent(plan, emit)).code, 0);
  const meta = JSON.parse(readFileSync(`${plan.streamPath}.meta.json`, 'utf8'));
  assert.equal(meta.harness, 'codex');
  assert.equal(meta.provider, 'openai');
  assert.equal(meta.sessionId, '01a128c0-1b5e-7fd3-9c5f-2a0b4b4e9d11');
  assert.equal(meta.totalCostUsd, null);
  const events = readFileSync(plan.eventsPath!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const cycles = events.filter((e) => e.data?.kind === 'cycle').map((e) => e.data.text);
  // One assistant turn in the recording: its visible text is the cycle.
  assert.deepEqual(cycles, ['The record is CREW-1529, "Per-repo toolchain override on a route\'s `repos:` entry".']);
  const tools = events.filter((e) => e.data?.kind === 'tool').map((e) => `${e.data.tool} ${e.data.target ?? ''}`.trim());
  assert.deepEqual(tools, ['command git', 'mcp__tablation__records_controller_list']);
});
