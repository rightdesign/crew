import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAgentSuggest, parseAgentHooks, parseAgentStream, classifyFailure, agentInvocation, AgentSuggestError } from '../src/repos-hooks-agent.ts';
import { suggestHooks, selectRecipes, starterRepoConfig, type CheckoutFiles } from '../src/repos-hooks.ts';
import { ReposError } from '../src/repos-cmd.ts';
import type { ToolchainSpec } from '../src/toolchain.ts';

const tree = (files: Record<string, string>): CheckoutFiles => ({
  exists: (r) => r in files || Object.keys(files).some((k) => k.startsWith(`${r}/`)),
  read: (r) => files[r],
  list: (r) => Object.keys(files).filter((k) => k.startsWith(`${r}/`)).map((k) => k.slice(r.length + 1).split('/')[0]!),
});

test('a workflows directory yields the release recipe (default on) and an advisory CI-status recipe', () => {
  const s = suggestHooks(tree({ '.github/workflows/release.yml': 'on: push', '.github/workflows/ci.yaml': '', '.github/workflows/notes.md': '' }));
  assert.deepEqual(s.recipes.map((r) => r.id), ['github-actions-release', 'github-actions-ci-status']);
  const [rel, ci] = s.recipes;
  assert.deepEqual(rel!.evidence, ['.github/workflows/ci.yaml', '.github/workflows/release.yml']);
  assert.equal(rel!.release!.mode, 'ci_auto');
  assert.match(rel!.hooks.released!, /^gh release view --json tagName/);
  assert.ok(rel!.defaultOn && rel!.writable);
  assert.ok(!ci!.defaultOn && !ci!.writable && ci!.check);
  assert.deepEqual(suggestHooks(tree({ 'package.json': '{}' })).recipes, []);
});

test('selectRecipes: none unless named; sniffed hooks win; unknown and advisory ids are errors', () => {
  const pkg = JSON.stringify({ scripts: { test: 't' } });
  const s = suggestHooks(tree({ 'package.json': pkg, '.github/workflows/r.yml': '' }));
  assert.deepEqual(selectRecipes(s, []), { hooks: { test: 'npm test' } });
  const sel = selectRecipes(s, ['github-actions-release']);
  assert.equal(sel.release!.mode, 'ci_auto');
  assert.equal(sel.hooks.test, 'npm test');
  assert.match(sel.hooks.released!, /gh release view/);
  assert.throws(() => selectRecipes(s, ['nope']), ReposError);
  assert.throws(() => selectRecipes(s, ['github-actions-ci-status']), /cannot be written/);
});

test('starterRepoConfig with the release recipe parses and carries ci_auto', () => {
  const text = starterRepoConfig({ test: 'npm test', released: 'gh release view' }, { mode: 'ci_auto', ci: 'github', verifyMatch: 'version' });
  assert.match(text, /mode: ci_auto/);
  assert.match(text, /provider: github/);
  assert.match(text, /released:/);
});

test('parseAgentHooks tolerates fences and drops empty or non-string values', () => {
  const r = parseAgentHooks('Here:\n```json\n{"hooks":{"test":"pnpm test","build":"","bump":3},"notes":["x"]}\n```');
  assert.deepEqual(r, { hooks: { test: 'pnpm test' }, notes: ['x'] });
  assert.throws(() => parseAgentHooks('no json'), (e: unknown) => e instanceof AgentSuggestError && e.reason === 'bad_output');
});

test('parseAgentStream collects relative Read paths and the result', () => {
  const out = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/README.md' } }, { type: 'tool_use', name: 'Grep', input: {} }] } }),
    'garbage',
    JSON.stringify({ type: 'result', is_error: false, result: '{"hooks":{}}' }),
  ].join('\n');
  assert.deepEqual(parseAgentStream(out, '/repo'), { text: '{"hooks":{}}', isError: false, filesRead: ['README.md'] });
});

test('classifyFailure and the harness gate', () => {
  assert.equal(classifyFailure({ code: null, spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }), output: '' }), 'not_installed');
  assert.equal(classifyFailure({ code: 1, output: 'Invalid API key · Please run /login' }), 'not_signed_in');
  assert.equal(classifyFailure({ code: 1, output: 'boom' }), 'failed');
  assert.throws(() => agentInvocation({ harness: 'codex' } as ToolchainSpec, 'm'), (e: unknown) => e instanceof AgentSuggestError && e.reason === 'unsupported_harness');
});

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'crew-agent-'));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'hi');
  const bin = join(root, 'fake-claude');
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\n${script}\n`);
  chmodSync(bin, 0o755);
  const spec = { name: 'claude', harness: 'claude', bin, model: 'm', tiers: {}, args: [], env: {}, maxThinkingTokens: 0 } as ToolchainSpec;
  return { dir, spec, sniff: suggestHooks(tree({})) };
}
const reason = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof AgentSuggestError ? e.reason : 'other'));

test('runAgentSuggest: success reports hooks, files read and differences; checkout untouched', async () => {
  const ev = (o: unknown) => JSON.stringify(o).replace(/'/g, "'\\''");
  const f = fixture(`echo '${ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } })}'\necho '${ev({ type: 'result', is_error: false, result: '{"hooks":{"test":"make check"}}' })}'`);
  const r = await runAgentSuggest(f);
  assert.equal(r.source, 'agent');
  assert.deepEqual(r.hooks, { test: 'make check' });
  assert.deepEqual(r.filesRead, ['README.md']);
  assert.deepEqual(r.differsFromSniff, ['test']);
});

test('runAgentSuggest: signed out, missing binary, modified checkout, cancel', async () => {
  const out = fixture(`echo '{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}'\nexit 1`);
  assert.equal(await reason(runAgentSuggest(out)), 'not_signed_in');
  const missing = fixture('true');
  assert.equal(await reason(runAgentSuggest({ ...missing, spec: { ...missing.spec, bin: '/nonexistent/claude' } })), 'not_installed');
  const dirty = fixture(`echo x > stray.txt\necho '{"type":"result","is_error":false,"result":"{}"}'`);
  assert.equal(await reason(runAgentSuggest(dirty)), 'modified_checkout');
  assert.ok(existsSync(join(dirty.dir, 'stray.txt')));
  const slow = fixture('sleep 30');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  assert.equal(await reason(runAgentSuggest({ ...slow, signal: ac.signal })), 'cancelled');
});

test('parseAgentStream resolves a symlinked checkout so filesRead stays inside it (CREW-2317)', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-sym-'));
  const real = join(root, 'real'); mkdirSync(real);
  const link = join(root, 'link'); symlinkSync(real, link);
  const out = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(realpathSync(real), 'package.json') } }] } });
  assert.deepEqual(parseAgentStream(out, link).filesRead, ['package.json']);
});
