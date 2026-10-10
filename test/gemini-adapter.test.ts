import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adapterFor, isHarness, type ToolchainSpec } from '../src/toolchain.ts';
import { geminiAdapter, createGeminiStreamMapper, geminiGrantFor, BILLING_VARS_TO_UNSET } from '../src/adapters/gemini.ts';
import { profileFor } from '../src/capability.ts';

const SPEC: ToolchainSpec = { name: 'gemini', harness: 'gemini', bin: 'gemini', model: 'gemini-2.5-pro', tiers: {}, args: ['--x'], env: { A: '1' }, maxThinkingTokens: 0 };
const URL = 'https://example.test/api/mcp';

test('gemini is a registered harness serving google models', () => {
  assert.ok(isHarness('gemini'));
  assert.equal(adapterFor('gemini'), geminiAdapter);
  assert.equal(geminiAdapter.provider(SPEC), 'google');
  assert.ok(geminiAdapter.ownsModel('gemini-2.5-flash'));
  assert.ok(!geminiAdapter.ownsModel('claude-sonnet-5-5'));
});

test('argv: non-interactive, structured output, model, grant, then extras', () => {
  const { bin, args } = geminiAdapter.invocation(SPEC, { role: 'dev', model: 'gemini-2.5-flash' });
  assert.equal(bin, 'gemini');
  assert.deepEqual(args, ['-p', '', '--model', 'gemini-2.5-flash', '--output-format', 'stream-json', '--approval-mode', 'yolo', '--x']);
});

test('argv honors a launcher', () => {
  const r = geminiAdapter.invocation({ ...SPEC, launcher: 'sandbox', launcherBin: '/opt/sandbox' }, { role: 'dev', model: 'm' });
  assert.equal(r.bin, '/opt/sandbox');
  assert.equal(r.args[0], 'gemini');
});

test('capability matrix: read < write < edit, design tools unavailable', () => {
  const read = geminiGrantFor(profileFor('triage'));
  const write = geminiGrantFor(profileFor('qa'));
  const edit = geminiGrantFor(profileFor('dev'));
  assert.equal(read.approvalMode, 'default');
  assert.ok(!read.allowed.includes('write_file'));
  assert.ok(write.allowed.includes('write_file') && write.allowed.includes('run_shell_command'));
  assert.ok(!write.allowed.includes('replace'));
  assert.deepEqual(edit, { approvalMode: 'yolo', allowed: [] });
  assert.deepEqual(geminiGrantFor(profileFor('design')), edit);
  assert.ok(geminiAdapter.limitations.some((l) => l.includes('design tools')));
});

test('env scrub covers Google billing variables', () => {
  for (const v of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI']) assert.ok(BILLING_VARS_TO_UNSET.includes(v));
  assert.deepEqual(geminiAdapter.runEnv(SPEC), { A: '1' });
});

test('fixture stream maps to events and a result', () => {
  const fixture = join(import.meta.dirname, 'fixtures', 'fake-gemini-stream.mjs');
  const r = spawnSync('node', [fixture], { input: 'prompt', encoding: 'utf8' });
  const events = [];
  let result = {};
  const mapper = createGeminiStreamMapper();
  for (const raw of r.stdout.split('\n')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    result = { ...result, ...geminiAdapter.extractResult(parsed) };
    events.push(...mapper.map(parsed));
  }
  events.push(...mapper.flush());
  assert.deepEqual(events, [
    { kind: 'text', text: 'Looking at the repo. ' },
    { kind: 'tool', tool: 'run_shell_command', target: 'ls' },
    { kind: 'tool', tool: 'read_file', target: 'src/a.ts' },
    { kind: 'text', text: 'All done.' },
  ]);
  assert.deepEqual(result, { sessionId: 'gem-sess-1', inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 });
  assert.equal(geminiAdapter.extractTurnTokens({ type: 'message' }), undefined);
});

test('stream mapper: fragments coalesce to one text per turn, flushed by tool_use, non-delta message, result and end', () => {
  const frag = (content: string) => ({ type: 'message', role: 'assistant', content, delta: true });
  const m = createGeminiStreamMapper();
  const out = [
    ...m.map(frag('a')), ...m.map(frag('b')),
    ...m.map({ type: 'tool_use', tool_name: 'read_file', parameters: { file_path: 'x' } }),
    ...m.map(frag('c')),
    ...m.map({ type: 'message', role: 'user', content: 'u' }),
    ...m.map(frag('d')), ...m.map(frag('e')),
    ...m.map({ type: 'result', stats: {} }),
    ...m.map(frag('tail')),
    ...m.flush(),
  ];
  assert.deepEqual(out, [
    { kind: 'text', text: 'ab' },
    { kind: 'tool', tool: 'read_file', target: 'x' },
    { kind: 'text', text: 'c' },
    { kind: 'text', text: 'de' },
    { kind: 'text', text: 'tail' },
  ]);
  assert.deepEqual(m.flush(), []);
});

test('MCP registration: ensure, inspect, idempotent, foreign entries kept, differing entry left alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-gem-'));
  const cfg = join(home, '.gemini', 'settings.json');
  const o = { bin: 'gemini', url: URL, key: '', home };
  assert.deepEqual(geminiAdapter.inspectMcp(o), { state: 'missing' });
  mkdirSync(join(home, '.gemini'));
  writeFileSync(cfg, JSON.stringify({ theme: 'dark', mcpServers: { other: { httpUrl: 'x' } } }));
  assert.match(geminiAdapter.ensureMcp(o), /registered/);
  const j = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(j.theme, 'dark');
  assert.deepEqual(j.mcpServers.other, { httpUrl: 'x' });
  assert.deepEqual(j.mcpServers.tablation, { httpUrl: URL, headers: { Authorization: 'Bearer $CREW_API_KEY' } });
  assert.deepEqual(geminiAdapter.inspectMcp(o), { state: 'registered', url: URL });
  assert.match(geminiAdapter.ensureMcp(o), /already registered/);
  const other = { ...o, url: 'https://elsewhere/api/mcp' };
  assert.equal(geminiAdapter.inspectMcp(other).state, 'different');
  assert.match(geminiAdapter.ensureMcp(other), /left .* alone/);
  assert.match(geminiAdapter.ensureMcp({ ...other, replace: true }), /registered/);
  assert.equal(geminiAdapter.inspectMcp(other).state, 'registered');
});
