import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Route } from '../src/config.ts';
import type { ResetEffects } from '../src/reset.ts';
import { runDeprovision, type DeprovisionDeps, type LiveRunRef } from '../src/deprovision.ts';

const route = (name: string): Route => ({ route: name, baseUrl: 'https://example.test' }) as Route;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-deprov-'));
  const stateDir = join(root, 'state');
  const configFile = join(root, 'crew.yaml');
  mkdirSync(join(stateDir, 'resolved'), { recursive: true });
  mkdirSync(join(stateDir, 'streams'), { recursive: true });
  writeFileSync(join(stateDir, 'events.jsonl'), '{}\n');
  writeFileSync(join(stateDir, 'machine-id'), 'abc');
  writeFileSync(configFile, 'ship: {}\n');
  return { stateDir, configFile };
}

const effects = (calls: string[]): ResetEffects => ({
  uninstallUnits: () => { calls.push('units'); return ['unit run']; },
  removePair: () => [],
  revokeSeatKeys: async () => { calls.push('seat-keys'); return [{ line: 'dev: revoked', ok: true }]; },
  credential: async () => ({ stored: true, clear: async () => { calls.push('credential'); } }),
  hostSessions: async () => [],
  inspectCheckout: () => ({ dirty: [], linkedWorktrees: [] }),
});

const run: LiveRunRef = { role: 'dev', route: 'w/p', pid: 4242, ticketRecordId: 't1', streamPath: '/s/1.jsonl' };

function deps(calls: string[], over: Partial<DeprovisionDeps> = {}): DeprovisionDeps {
  return {
    liveRuns: () => [run],
    killRun: async (r) => { calls.push(`kill:${r.pid}`); },
    recordKill: (r) => { calls.push(`record:${r.pid}`); },
    handBack: async (r) => { calls.push(`handback:${r.ticketRecordId}`); },
    sandboxes: () => ['crew-passenger-aaa'],
    removeSandbox: (n) => { calls.push(`sandbox:${n}`); },
    clearShipRows: async () => { calls.push('ship-rows'); return [{ route: 'w/p', ok: true, detail: 'cleared engaged, tunnel_status, relay_url' }]; },
    forgeHosts: () => ['github.com'],
    eraseForgeToken: (h) => { calls.push(`forge:${h}`); return 'erased'; },
    labeled: () => ({ volumes: ['crew-cache-1'], images: ['crew-repo-1'] }),
    removeVolume: (n) => { calls.push(`volume:${n}`); },
    removeImage: (n) => { calls.push(`image:${n}`); },
    remaining: () => [],
    ...over,
  };
}

const opts = (f: ReturnType<typeof fixture>, over = {}) => ({
  routes: [route('w/p')], stateDir: f.stateDir, configFile: f.configFile, dryRun: false, ...over,
});

test('deprovision wipes in the ticket order: units, runs, rows, keys, forge, caches, state, config', async () => {
  const f = fixture();
  const calls: string[] = [];
  const out = await runDeprovision(opts(f), effects(calls), deps(calls));
  assert.deepEqual(calls, [
    'units', 'kill:4242', 'record:4242', 'handback:t1', 'sandbox:crew-passenger-aaa', 'ship-rows',
    'seat-keys', 'credential', 'forge:github.com', 'volume:crew-cache-1', 'image:crew-repo-1',
  ]);
  assert.equal(out.ok, true);
  assert.equal(existsSync(f.configFile), false);
  assert.deepEqual(readdirSync(f.stateDir), []);
  assert.equal(out.steps.at(-1)?.step, 'config');
});

test('verify: anything the lease wrote that still exists makes the wipe fail and is listed', async () => {
  const f = fixture();
  const out = await runDeprovision(opts(f), effects([]), deps([], { remaining: () => ['docker volume crew-cache-9'] }));
  assert.equal(out.ok, false);
  assert.deepEqual(out.remaining, ['docker volume crew-cache-9']);
});

test('a failed volume removal fails the wipe', async () => {
  const f = fixture();
  const out = await runDeprovision(opts(f), effects([]), deps([], { removeVolume: () => { throw new Error('in use'); } }));
  assert.equal(out.ok, false);
  assert.ok(out.steps.some((s) => s.step === 'cache' && s.action === 'failed' && /in use/.test(s.detail ?? '')));
});

test('a ticket that cannot be told does not stop the wipe, and the kill is still recorded', async () => {
  const f = fixture();
  const calls: string[] = [];
  const out = await runDeprovision(opts(f), effects(calls), deps(calls, { handBack: async () => { throw new Error('offline'); } }));
  assert.equal(out.ok, true);
  assert.ok(calls.includes('record:4242'));
  assert.match(out.steps.find((s) => s.step === 'run')?.detail ?? '', /could not tell its ticket/);
});

test('a token read from the environment is KEPT and fails the wipe', async () => {
  const f = fixture();
  const out = await runDeprovision(opts(f), effects([]), deps([], { eraseForgeToken: () => 'env' }));
  assert.equal(out.ok, false);
});

test('--dry-run touches nothing and reports would-remove', async () => {
  const f = fixture();
  const calls: string[] = [];
  const out = await runDeprovision(opts(f, { dryRun: true }), effects(calls), deps(calls));
  assert.ok(!calls.some((c) => /^(kill|sandbox|volume|image|forge|ship-rows|credential)/.test(c)));
  assert.equal(existsSync(f.configFile), true);
  assert.equal(readdirSync(f.stateDir).length, 4);
  assert.equal(out.ok, true);
});
