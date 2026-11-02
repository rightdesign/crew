import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  authModeOf, signedOutItem, signedOutKey, signedOutMessage, streamShowsRealTurn, streamShowsSignedOut,
} from '../src/signed-out.ts';
import { classify, observe } from '../src/selftest.ts';
import type { ToolchainSpec } from '../src/toolchain.ts';

const stream = (...events: unknown[]): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'signed-out-')), 'run.jsonl');
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
};
const result = (text: string, is_error = true) => ({ type: 'result', subtype: 'success', is_error, result: text, num_turns: 1 });

test('a lone result with the Vertex wording is a sign-out', () => {
  assert.equal(streamShowsSignedOut(stream(result('Failed to authenticate: OAuth session expired and could not be refreshed'))), true);
  assert.equal(streamShowsSignedOut(stream(result('Reauthentication is needed: application default credentials'))), true);
});

test('a lone result with the claude.ai wording is a sign-out', () => {
  assert.equal(streamShowsSignedOut(stream(result('Not logged in · Please run /login'))), true);
  assert.equal(streamShowsSignedOut(stream(result('Invalid API key · Please run /login'))), true);
});

test('a single assistant turn that is the message, with no tool use, is a sign-out', () => {
  const turn = { type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] } };
  assert.equal(streamShowsSignedOut(stream(turn, result('done', false))), true);
});

test('a phrase inside a tool result or a user turn is not a sign-out', () => {
  const tool = { type: 'user', message: { content: [{ type: 'tool_result', content: 'Please run /login — OAuth session expired' }] } };
  const work = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } };
  assert.equal(streamShowsSignedOut(stream(work, tool, work, result('Done.', false))), false);
  assert.equal(streamShowsSignedOut(stream({ type: 'user', message: { content: 'OAuth session expired' } }, result('ok', false))), false);
  assert.equal(streamShowsSignedOut(stream(result('Please run /login', false))), false);
});

test('a real turn is recognized so the item can clear', () => {
  const real = { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the queue.' }] } };
  assert.equal(streamShowsRealTurn(stream(real)), true);
  assert.equal(streamShowsRealTurn(stream(result('OAuth session expired'))), false);
});

test('the remedy follows the toolchain auth mode', () => {
  const vertex = { env: { CLAUDE_CODE_USE_VERTEX: '1' } } as Pick<ToolchainSpec, 'env' | 'auth'>;
  assert.equal(authModeOf(vertex, {}), 'vertex');
  assert.equal(authModeOf({ env: {} }, { ANTHROPIC_API_KEY: 'sk' }), 'api-key');
  assert.equal(authModeOf({ env: {} }, {}), 'login');
  assert.equal(authModeOf({ env: { CLAUDE_CODE_USE_VERTEX: '1' }, auth: 'subscription' }, {}), 'login');
  assert.match(signedOutMessage('claude', 'vertex'), /gcloud auth application-default login/);
  assert.match(signedOutMessage('claude', 'login'), /\/login/);
  const item = signedOutItem('claude', 'vertex');
  assert.equal(item.key, signedOutKey('claude'));
  assert.equal(item.kind, 'signed_out');
  assert.match(item.message, /claude/);
});

test('selftest on a signed-out toolchain fails with the same diagnosis', () => {
  const spec = { name: 'claude', harness: 'claude', bin: 'claude', env: { CLAUDE_CODE_USE_VERTEX: '1' }, args: [], tiers: {}, model: 'm', maxThinkingTokens: 0 } as ToolchainSpec;
  const seen = observe(spec, JSON.stringify(result('Failed to authenticate: OAuth session expired and could not be refreshed')) + '\n');
  const c = classify(spec, { code: 0, stderr: '', stdout: '', timedOut: false } as never, seen);
  assert.equal(c.failure, 'login-missing');
  assert.match(c.detail, /gcloud auth application-default login/);
});

test('a signed-out run releases this ship\'s hold, keeps status, and throws; a healthy run clears the item', async () => {
  const { settleSignOut } = await import('../src/daemon.ts');
  const { SignedOutError } = await import('../src/signed-out.ts');
  const { State } = await import('../src/state.ts');
  const patches: Array<Record<string, unknown>> = [];
  const tracker = {
    claimAffinity: async () => ({ column: 'held_by_ship_id', shipId: 'ship-1' }),
    ticket: async () => ({ id: 't1', updated_at: 'u', held_by_ship_id: 'ship-1', status: 'in_progress' }),
    updateTicket: async (_id: string, patch: Record<string, unknown>) => { patches.push(patch); return {}; },
  };
  const emit = { warn: () => {} };
  const state = new State(mkdtempSync(join(tmpdir(), 'signed-out-state-')));
  const plan = (streamPath: string) => ({ toolchain: 'claude', authMode: 'vertex', streamPath });
  const dead = stream(result('Failed to authenticate: OAuth session expired and could not be refreshed'));
  await assert.rejects(
    settleSignOut(plan(dead) as never, tracker as never, state, 't1', emit as never),
    (e: unknown) => e instanceof SignedOutError && /gcloud auth application-default login/.test((e as Error).message),
  );
  assert.deepEqual(patches, [{ held_by_ship_id: null }]);

  const ok = stream({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } }, result('Done', false));
  await settleSignOut(plan(ok) as never, tracker as never, state, 't1', emit as never);
  assert.equal(patches.length, 1);
});
