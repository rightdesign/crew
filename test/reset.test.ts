import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Route } from '../src/config.ts';
import { ensureRepoCheckout, setCloneRecorder } from '../src/git.ts';
import {
  runReset, recordClonedCheckout, readClonedCheckouts, clonedCheckoutsFile, resetIncomplete, describeResetStep,
  type ResetEffects, type ResetStep,
} from '../src/reset.ts';

const route = (name: string): Route => ({ route: name, baseUrl: 'https://example.test' }) as Route;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-reset-'));
  const stateDir = join(root, 'state');
  const configFile = join(root, 'crew.yaml');
  mkdirSync(join(stateDir, 'resolved', 'w'), { recursive: true });
  mkdirSync(join(stateDir, 'keys', 'w'), { recursive: true });
  writeFileSync(join(stateDir, 'resolved', 'w', 'p.json'), '{}');
  writeFileSync(join(stateDir, 'keys', 'w', 'p.env'), 'CREW_API_KEY=x\n');
  writeFileSync(join(stateDir, '.poll-watermark'), 'x');
  writeFileSync(join(stateDir, '.crew-paused'), '');
  writeFileSync(join(stateDir, 'reload-requested'), 'x');
  writeFileSync(join(stateDir, 'crew.log'), 'history stays');
  writeFileSync(configFile, 'ship: {}\n');
  return { root, stateDir, configFile };
}

function effects(calls: string[], over: Partial<ResetEffects> = {}): ResetEffects {
  return {
    uninstallUnits: (dry) => { calls.push(`uninstall:${dry}`); return ['unit com.example.run']; },
    removePair: (url, dry) => { calls.push(`pair:${url}:${dry}`); return [`claude ${url}`]; },
    revokeSeatKeys: async (r, dry) => { calls.push(`revoke:${r.route}:${dry}`); return [{ line: 'dev: agent key revoked', ok: true }]; },
    credential: async (r) => ({ stored: true, clear: async () => { calls.push(`clear:${r.route}`); } }),
    inspectCheckout: () => ({ dirty: [], linkedWorktrees: [] }),
    ...over,
  };
}

const opts = (f: ReturnType<typeof fixture>, over = {}) => ({
  routes: [route('w/p')], stateDir: f.stateDir, configFile: f.configFile, dryRun: false, removeCheckouts: false, ...over,
});

test('reset runs the steps in the ticket order and deletes crew.yaml last', async () => {
  const f = fixture();
  const calls: string[] = [];
  const steps = await runReset(opts(f), effects(calls));
  assert.deepEqual(calls, ['uninstall:false', 'pair:https://example.test:false', 'revoke:w/p:false', 'clear:w/p']);
  assert.deepEqual([...new Set(steps.map((s) => s.step))], ['scheduler', 'pair', 'seat-keys', 'credential', 'state', 'config']);
  assert.equal(steps.at(-1)?.step, 'config');
  assert.equal(existsSync(f.configFile), false);
  assert.equal(existsSync(join(f.stateDir, 'resolved')), false);
  assert.equal(existsSync(join(f.stateDir, 'keys')), false);
  assert.equal(existsSync(join(f.stateDir, '.poll-watermark')), false);
  assert.equal(existsSync(join(f.stateDir, '.crew-paused')), false);
  assert.equal(existsSync(join(f.stateDir, 'reload-requested')), false);
  assert.equal(readFileSync(join(f.stateDir, 'crew.log'), 'utf8'), 'history stays');
  assert.equal(resetIncomplete(steps), false);
});

test('--dry-run prints the plan and changes nothing', async () => {
  const f = fixture();
  const calls: string[] = [];
  const steps = await runReset(opts(f, { dryRun: true }), effects(calls));
  assert.ok(!calls.some((c) => c.startsWith('clear:')));
  assert.ok(calls.includes('uninstall:true') && calls.includes('revoke:w/p:true'));
  assert.ok(steps.every((s) => s.action === 'would-remove'));
  assert.equal(existsSync(f.configFile), true);
  assert.equal(existsSync(join(f.stateDir, 'resolved', 'w', 'p.json')), true);
  assert.match(describeResetStep(steps[0]!), /would remove/);
});

test('a failed seat-key revoke is reported, the rest still runs, and the result is incomplete', async () => {
  const f = fixture();
  const steps = await runReset(opts(f), effects([], {
    revokeSeatKeys: async () => [{ line: 'qa: could not revoke the agent key (no key id) — left in the keychain', ok: false }],
  }));
  assert.equal(steps.find((s) => s.step === 'seat-keys')?.action, 'failed');
  assert.equal(existsSync(f.configFile), false);
  assert.equal(resetIncomplete(steps), true);
});

test('a missing credential or a keychain error does not stop the reset', async () => {
  const f = fixture();
  const steps = await runReset(opts(f, { routes: [route('w/p'), route('w/q')] }), effects([], {
    credential: async (r) => {
      if (r.route === 'w/q') throw new Error('keychain locked');
      return { stored: false, clear: async () => {} };
    },
  }));
  const creds = steps.filter((s) => s.step === 'credential');
  assert.deepEqual(creds.map((s) => s.action), ['absent', 'failed']);
  assert.equal(existsSync(f.configFile), false);
});

test('--remove-checkouts deletes recorded clones, keeps one with local changes and names it, and ignores unrecorded ones', async () => {
  const f = fixture();
  const clean = join(f.root, 'clean'); const dirty = join(f.root, 'dirty'); const attached = join(f.root, 'attached');
  const withTree = join(f.root, 'withtree');
  for (const d of [clean, dirty, attached, withTree]) mkdirSync(d);
  recordClonedCheckout(f.stateDir, clean);
  recordClonedCheckout(f.stateDir, dirty);
  recordClonedCheckout(f.stateDir, withTree);
  recordClonedCheckout(f.stateDir, join(f.root, 'gone'));
  const steps = await runReset(opts(f, { removeCheckouts: true }), effects([], {
    inspectCheckout: (d) => ({ dirty: d === dirty ? ['src/a.ts'] : [], linkedWorktrees: d === withTree ? [`${d}-x`] : [] }),
  }));
  const by = (d: string) => steps.find((s) => s.step === 'checkout' && s.target === d);
  assert.equal(by(clean)?.action, 'removed');
  assert.equal(existsSync(clean), false);
  assert.equal(by(dirty)?.action, 'kept');
  assert.match(by(dirty)?.detail ?? '', /src\/a\.ts/);
  assert.equal(existsSync(dirty), true);
  assert.equal(by(withTree)?.action, 'kept');
  assert.equal(existsSync(withTree), true);
  assert.equal(by(attached), undefined);
  assert.equal(existsSync(attached), true);
  assert.equal(by(join(f.root, 'gone'))?.action, 'absent');
  assert.equal(resetIncomplete(steps), true);
});

test('without --remove-checkouts no checkout is touched', async () => {
  const f = fixture();
  const d = join(f.root, 'clone'); mkdirSync(d);
  recordClonedCheckout(f.stateDir, d);
  const steps = await runReset(opts(f), effects([]));
  assert.equal(steps.some((s) => s.step === 'checkout'), false);
  assert.equal(existsSync(d), true);
});

test('a second reset on a clean machine succeeds and reports nothing to remove', async () => {
  const f = fixture();
  await runReset(opts(f), effects([]));
  const again: ResetStep[] = await runReset(opts(f), effects([], { credential: async () => ({ stored: false, clear: async () => {} }) }));
  assert.equal(resetIncomplete(again), false);
  assert.equal(again.find((s) => s.step === 'config')?.action, 'absent');
});

test('the clone recorder logs a real clone, but never an existing checkout or a failed clone', () => {
  const f = fixture();
  const origin = join(f.root, 'origin'); mkdirSync(origin);
  execFileSync('git', ['init', '-q', origin]);
  execFileSync('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const prev = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${origin}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'git@github.com:owner/repo.git';
  setCloneRecorder((d) => recordClonedCheckout(f.stateDir, d));
  try {
    const cloned = join(f.root, 'cloned');
    assert.equal(ensureRepoCheckout(cloned, 'owner/repo'), true);
    assert.equal(ensureRepoCheckout(cloned, 'owner/repo'), false);
    const attached = join(f.root, 'attached');
    execFileSync('git', ['init', '-q', attached]);
    assert.equal(ensureRepoCheckout(attached, 'owner/repo'), false);
    assert.throws(() => ensureRepoCheckout(join(f.root, 'nope'), 'owner/other'));
    assert.deepEqual(readClonedCheckouts(f.stateDir), [cloned]);
    assert.equal(existsSync(clonedCheckoutsFile(f.stateDir)), true);
  } finally {
    setCloneRecorder(undefined);
    for (const [k, v] of [['GIT_CONFIG_COUNT', prev.c], ['GIT_CONFIG_KEY_0', prev.k], ['GIT_CONFIG_VALUE_0', prev.v]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
