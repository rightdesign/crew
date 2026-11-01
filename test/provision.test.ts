import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { loadConfig } from '../src/config.ts';
import { renderShipBlock } from '../src/connect-wizard.ts';
import { managedRuntimeWarnings } from '../src/doctor-checks.ts';
import {
  runProvision, provisionOptionsFrom, applyManagedDefaultsToDoc, isManagedShipKind, tokensFromEnv, envKey, parseEvents,
  type ProvisionDeps, type ProvisionOptions, type InstallState, type RunResult,
} from '../src/provision.ts';

const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
const ev = (...es: Array<Record<string, unknown>>) => es.map((e) => JSON.stringify(e)).join('\n') + '\n';

const base = (over: Partial<ProvisionOptions> = {}): ProvisionOptions => ({
  key: 'sk_test', routes: ['acme'], forgeHosts: [], tokens: {}, json: true, dryRun: false, choices: [], ...over,
});

interface Fake { managed: string[][]; deps: ProvisionDeps; calls: Array<{ args: string[]; env?: Record<string, string>; input?: string }>; state: InstallState; enabled: Set<string>; settings: Record<string, string | number> }
function fake(o: { connect?: RunResult; state?: Partial<InstallState>; stored?: Record<string, string>; enabled?: string[]; crew?: (args: string[]) => RunResult | undefined } = {}): Fake {
  const state: InstallState = { mechanism: 'systemd', unitsStale: false, running: true, lingering: true, ...o.state };
  const calls: Fake['calls'] = [];
  const enabled = new Set(o.enabled ?? ['acme/issues']);
  const stored = { ...(o.stored ?? {}) };
  const settings: Record<string, string | number> = {};
  const managed: string[][] = [];
  const deps: ProvisionDeps = {
    crew(args, opts) {
      calls.push({ args, env: opts?.env, input: opts?.input });
      const custom = o.crew?.(args);
      if (custom) return custom;
      if (args[0] === 'connect') return o.connect ?? ok(ev({ event: 'ship_row', action: 'matched' }, { event: 'done', route: 'acme/issues', wroteConfig: false }));
      if (args[0] === 'install') { state.unitsStale = false; state.running = true; state.lingering = true; return ok(); }
      if (args[0] === 'forge') { stored[args[2]!] = (opts?.input ?? '').trim(); return ok(); }
      return ok();
    },
    configFile: () => '/home/x/.config/crew/crew.yaml',
    enableRoute: (r) => { if (enabled.has(r)) return false; enabled.add(r); return true; },
    installState: () => ({ ...state }),
    setShipSetting: (k, v) => { settings[k] = v; return true; },
    applyManagedDefaults: () => { const w = ['ship.runner', 'ship.sandbox.cacheVolume']; managed.push(w); return w; },
    storedToken: (h) => stored[h] ?? null,
    defaultShipName: () => 'host-1',
  };
  return { deps, calls, state, enabled, settings, managed };
}

const run = (o: ProvisionOptions, f: Fake) => {
  const out: string[] = [];
  return runProvision(o, f.deps, (l) => out.push(l), (l) => out.push(l)).then((r) => ({ ...r, out }));
};

test('a fully provisioned host reports "already provisioned" and changes nothing (CREW-2792)', async () => {
  const f = fake();
  const r = await run(base(), f);
  assert.equal(r.code, 0);
  assert.equal(r.summary.state, 'already provisioned');
  assert.equal(r.summary.changed, false);
  assert.deepEqual(f.calls.map((c) => c.args[0]), ['connect']);
});

test('a first run connects, enables the route, installs and reports provisioned (CREW-2792)', async () => {
  const f = fake({ enabled: [], state: { unitsStale: true, running: false, lingering: false }, connect: ok(ev({ event: 'ship_row', action: 'created' }, { event: 'done', route: 'acme/issues', wroteConfig: true })) });
  const r = await run(base(), f);
  assert.equal(r.code, 0);
  assert.equal(r.summary.state, 'provisioned');
  assert.deepEqual(f.calls.map((c) => c.args[0]), ['connect', 'install']);
  assert.ok(f.enabled.has('acme/issues'));
  assert.deepEqual(r.summary.daemon, { mechanism: 'systemd', running: true, lingering: true });
  const last = parseEvents(r.out.join('')).at(-1)!;
  assert.equal(last.event, 'done');
});

test('the key goes to connect in the environment, never argv (CREW-2792)', async () => {
  const f = fake();
  await run(base({ key: 'sk_secret' }), f);
  const c = f.calls[0]!;
  assert.equal(c.env?.CREW_CONNECT_KEY, 'sk_secret');
  assert.ok(!c.args.some((a) => a.includes('sk_secret')));
  assert.ok(c.args.includes('--json') && c.args.includes('--no-wizard'));
  assert.deepEqual(c.args.slice(c.args.indexOf('--ship-name'), c.args.indexOf('--ship-name') + 2), ['--ship-name', 'host-1']);
});

test('forge tokens: stored when absent, rotated when different, untouched when equal; via stdin only (CREW-2792)', async () => {
  const opts = base({ forgeHosts: ['github.com', 'gitlab.example', 'git.corp'], tokens: { 'github.com': 'new', 'gitlab.example': 'same', 'git.corp': 't3' } });
  const f = fake({ stored: { 'github.com': 'old', 'gitlab.example': 'same' } });
  const r = await run(opts, f);
  assert.deepEqual(r.summary.forges, [
    { host: 'github.com', action: 'rotated' }, { host: 'gitlab.example', action: 'unchanged' }, { host: 'git.corp', action: 'stored' },
  ]);
  const forge = f.calls.filter((c) => c.args[0] === 'forge');
  assert.deepEqual(forge.map((c) => c.args.slice(0, 3)), [['forge', 'rotate', 'github.com'], ['forge', 'set', 'git.corp']]);
  assert.ok(forge.every((c) => c.args.includes('--token-stdin') && !c.args.includes('new')));
  assert.equal(r.summary.state, 'provisioned');
  // Second run: now everything matches.
  const again = await run(opts, f);
  assert.equal(again.summary.state, 'already provisioned');
});

test('a connect that needs a decision passes its events through and exits 3 (CREW-2792)', async () => {
  const choice = ev({ event: 'choice', key: 'project', options: [] });
  const f = fake({ connect: { status: 3, stdout: choice, stderr: '' } });
  const r = await run(base(), f);
  assert.equal(r.code, 3);
  assert.match(r.out.join(''), /"event":"choice"/);
  assert.deepEqual(f.calls.map((c) => c.args[0]), ['connect']);
});

test('missing key, routes or forge token are problems with exit 2 and run nothing (CREW-2792)', async () => {
  for (const [o, re] of [
    [base({ key: undefined }), /no connect key/], [base({ routes: [] }), /no routes/],
    [base({ forgeHosts: ['github.com'], tokens: {} }), /no token for forge github\.com/],
  ] as const) {
    const f = fake();
    const r = await run(o, f);
    assert.equal(r.code, 2);
    assert.match(r.out.join(''), re);
    assert.equal(f.calls.length, 0);
  }
});

test('a daemon that is not up after install fails the run (CREW-2792)', async () => {
  const f = fake({ state: { running: false }, crew: (a) => (a[0] === 'install' ? ok() : undefined) });
  const r = await run(base(), f);
  assert.equal(r.code, 1);
  assert.equal(r.summary.state, 'failed');
});

test('a failed install stops the run with exit 1 (CREW-2792)', async () => {
  const f = fake({ state: { unitsStale: true }, crew: (a) => (a[0] === 'install' ? { status: 1, stdout: '', stderr: 'boom' } : undefined) });
  assert.equal((await run(base(), f)).code, 1);
});

test('--dry-run connects in dry-run mode and touches nothing else (CREW-2792)', async () => {
  const f = fake({ state: { unitsStale: true, running: false } });
  const r = await run(base({ dryRun: true, forgeHosts: ['github.com'], tokens: { 'github.com': 't' } }), f);
  assert.equal(r.code, 0);
  assert.equal(r.summary.state, 'dry-run');
  assert.deepEqual(f.calls.map((c) => c.args[0]), ['connect']);
  assert.ok(f.calls[0]!.args.includes('--dry-run'));
});

test('options come from flags first, then the environment (CREW-2792)', () => {
  const env = { CREW_CONNECT_KEY: 'envkey', CREW_PROVISION_ROUTES: 'a/x, b', CREW_SHIP_NAME: 'envship', CREW_FORGE_TOKEN: 'tok' };
  const o = provisionOptionsFrom(['provision', '--route', 'flag/one', '--route=flag/two', '--json'], env);
  assert.deepEqual(o.routes, ['flag/one', 'flag/two']);
  assert.equal(o.key, 'envkey');
  assert.equal(o.shipName, 'envship');
  assert.deepEqual(o.forgeHosts, ['github.com']);
  assert.deepEqual(o.tokens, { 'github.com': 'tok' });
  assert.equal(o.json, true);
  const fromEnv = provisionOptionsFrom(['provision', '--key', 'flagkey'], env);
  assert.deepEqual(fromEnv.routes, ['a/x', 'b']);
  assert.equal(fromEnv.key, 'flagkey');
  const noForge = provisionOptionsFrom(['provision'], { CREW_CONNECT_KEY: 'k' });
  assert.deepEqual(noForge.forgeHosts, []);
});

test('per-host token variables beat the shared one (CREW-2792)', () => {
  assert.equal(envKey('git.corp-x.com'), 'GIT_CORP_X_COM');
  assert.deepEqual(
    tokensFromEnv(['github.com', 'git.corp'], { CREW_FORGE_TOKEN: 'shared', CREW_FORGE_TOKEN_GIT_CORP: 'corp' }),
    { 'github.com': 'shared', 'git.corp': 'corp' },
  );
});

test('--ship-kind and --instance-class reach connect, and relay host and agent cap land in crew.yaml (CREW-2882)', async () => {
  const f = fake();
  const r = await run(base({ shipKind: 'pooled_instance', instanceClass: 'c7.large', relayHost: 'crewd@relay.example', maxConcurrentAgents: 3 }), f);
  const c = f.calls[0]!;
  assert.deepEqual(c.args.slice(c.args.indexOf('--ship-kind'), c.args.indexOf('--ship-kind') + 2), ['--ship-kind', 'pooled_instance']);
  assert.deepEqual(c.args.slice(c.args.indexOf('--instance-class'), c.args.indexOf('--instance-class') + 2), ['--instance-class', 'c7.large']);
  assert.deepEqual(f.settings, { relayHost: 'crewd@relay.example', maxConcurrentAgents: 3 });
  assert.equal(r.summary.state, 'provisioned');
});

test('each route connects with its own workspace key, and no key reaches argv or the summary (CREW-2893)', async () => {
  const f = fake({ enabled: ['acme/issues', 'beta/work'] });
  const r = await run(base({ key: undefined, keys: { acme: 'sk_acme', beta: 'sk_beta' }, routes: ['acme/issues', 'beta/work'] }), f);
  assert.equal(r.code, 0);
  const connects = f.calls.filter((c) => c.args[0] === 'connect');
  assert.deepEqual(connects.map((c) => c.env?.CREW_CONNECT_KEY), ['sk_acme', 'sk_beta']);
  const everything = JSON.stringify([f.calls.map((c) => c.args), r.summary]);
  assert.ok(!everything.includes('sk_acme') && !everything.includes('sk_beta'));
  assert.ok(!r.out.join('').includes('sk_'));
});

test('a route without its own key falls back to the shared key; with neither it fails (CREW-2893)', async () => {
  const f = fake();
  const r = await run(base({ key: 'sk_shared', keys: { other: 'sk_other' } }), f);
  assert.equal(r.code, 0);
  assert.equal(f.calls[0]!.env?.CREW_CONNECT_KEY, 'sk_shared');
  const g = fake();
  const bad = await run(base({ key: undefined, keys: { other: 'sk_other' } }), g);
  assert.equal(bad.code, 2);
  assert.equal(g.calls.length, 0);
});

test('CREW_CONNECT_KEY_<WORKSPACE> variables become per-workspace keys; by hand with only CREW_CONNECT_KEY nothing changes (CREW-2893)', () => {
  const env = { CREW_CONNECT_KEY_MY_WS: 'k1', CREW_CONNECT_KEY_OTHER: 'k2', CREW_PROVISION_ROUTES: 'my-ws/x other' };
  const o = provisionOptionsFrom(['provision'], env);
  assert.deepEqual(o.keys, { 'my-ws': 'k1', other: 'k2' });
  assert.equal(o.key, undefined);
  const plain = provisionOptionsFrom(['provision'], { CREW_CONNECT_KEY: 'k', CREW_PROVISION_ROUTES: 'a' });
  assert.deepEqual(plain.keys, {});
  assert.equal(plain.key, 'k');
});

test('a managed ship kind gets the sandbox defaults without any flag; a developer machine gets none (CREW-2910)', async () => {
  for (const kind of ['pooled_instance', 'managed_instance']) {
    const f = fake();
    const r = await run(base({ shipKind: kind }), f);
    assert.equal(f.managed.length, 1, kind);
    assert.equal(r.summary.changed, true);
  }
  const plain = fake();
  await run(base(), plain);
  assert.equal(plain.managed.length, 0);
  assert.equal(plain.settings.runner, undefined);
});

test('--runner host on a managed ship skips the defaults and logs the explicit choice (CREW-2910)', async () => {
  const f = fake();
  const r = await run(base({ shipKind: 'managed_instance', runner: 'host' }), f);
  assert.equal(f.managed.length, 0);
  assert.equal(f.settings.runner, 'host');
  assert.ok(r.out.join('').includes('--runner host'));
});

test('--runner is parsed from argv (CREW-2910)', () => {
  assert.equal(provisionOptionsFrom(['--runner', 'host'], {}).runner, 'host');
  assert.equal(provisionOptionsFrom(['--runner=sandbox'], {}).runner, 'sandbox');
  assert.equal(provisionOptionsFrom(['--runner', 'bogus'], {}).runner, undefined);
});

test('applyManagedDefaultsToDoc sets runner, cache volume and claude toolchain auth, leaving existing values alone (CREW-2910)', () => {
  const doc = parseDocument('ship:\n  name: x\n  toolchains:\n    a: {harness: claude}\n    b: {harness: codex}\n    c: {harness: claude, auth: inherit}\n');
  assert.deepEqual(applyManagedDefaultsToDoc(doc), ['ship.runner', 'ship.sandbox.cacheVolume', 'ship.toolchains.a.auth', 'ship.toolchains.claude.auth']);
  const js = doc.toJS().ship;
  assert.equal(js.runner, 'sandbox');
  assert.equal(js.sandbox.cacheVolume, 'crew-cache');
  assert.equal(js.toolchains.a.auth, 'workspace');
  assert.equal(js.toolchains.b.auth, undefined);
  assert.equal(js.toolchains.c.auth, 'inherit');
  assert.deepEqual(applyManagedDefaultsToDoc(doc), []);
  const fresh = parseDocument('ship:\n  name: m1\n  platform: linux\n  agent:\n    bin: /opt/claude\n    model: m-x\n');
  assert.deepEqual(applyManagedDefaultsToDoc(fresh), ['ship.runner', 'ship.sandbox.cacheVolume', 'ship.toolchains.claude.auth']);
  assert.deepEqual(fresh.toJS().ship.toolchains.claude, { harness: 'claude', bin: '/opt/claude', model: 'm-x', auth: 'workspace' });
  const host = parseDocument('ship:\n  runner: host\n');
  applyManagedDefaultsToDoc(host);
  assert.equal(host.toJS().ship.runner, 'host');
  assert.ok(isManagedShipKind('pooled_instance') && !isManagedShipKind('developer_machine'));
});

test('a provisioned managed ship yaml loads, and doctor is quiet about it; runner: host loads and warns (CREW-2910)', () => {
  const route = '\nroutes:\n  - route: issues/issues\n    enabled: false\n';
  const render = (edit?: (d: ReturnType<typeof parseDocument>) => void): string => {
    const doc = parseDocument(renderShipBlock({ name: 'm1', platform: 'linux', agentBin: '/opt/claude', hostPassengers: false }));
    applyManagedDefaultsToDoc(doc);
    edit?.(doc);
    return String(doc) + route;
  };
  const cfg = loadConfig('/nonexistent', 'crew.yaml', { text: render() });
  assert.equal(cfg.ship.runner, 'sandbox');
  assert.equal(cfg.ship.sandbox?.cacheVolume, 'crew-cache');
  const claude = cfg.ship.toolchains?.find((t) => t.name === 'claude');
  assert.equal(claude?.auth, 'workspace');
  assert.equal(claude?.bin, '/opt/claude');
  assert.deepEqual(managedRuntimeWarnings('pooled_instance', cfg.ship), []);
  const host = loadConfig('/nonexistent', 'crew.yaml', { text: render((d) => d.setIn(['ship', 'runner'], 'host')) });
  assert.equal(host.ship.runner, 'host');
  assert.equal(managedRuntimeWarnings('managed_instance', host.ship).length, 1);
});
