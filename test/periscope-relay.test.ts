import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bindAddrFor, previewSshArgsFor, startPreviewTunnel, generateTunnelSlug, relayBaseUrlFor, type SpawnFn } from '../src/tunnel.ts';
import {
  openPreviewTunnel, forwardTarget, isPreviewTunnel, stopRecordedTunnel, runPeriscopeTunnelPass, PREVIEW_TUNNEL_SETTLE_MS,
  periscopeTunnelKey, staleTunnelKeys, type PreviewRelay, type TunnelPassDeps,
} from '../src/periscope-relay.ts';
import { runPeriscopeUp, runPeriscopeDown, parsePeriscopeUpArgs, type PeriscopeDeps, type PeriscopeDownDeps, type PeriscopeUpArgs, type PeriscopeRowInfo } from '../src/periscope-cmd.ts';
import { runPeriscopeResume, type ResumeDeps } from '../src/periscope-resume.ts';
import { runPeriscopeIdlePass, type IdleDeps } from '../src/periscope-idle.ts';
import { readPeriscopeSidecars, writePeriscopeSidecar, updatePeriscopeSidecar, periscopesForStatus, type PeriscopeSidecar } from '../src/periscope-state.ts';
import { handlePeriscopes, type PeriscopeHosting } from '../src/periscope-control.ts';
import type { PeriscopeRow } from '../src/tracker.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';

const WS = '11111111-2222-3333-4444-555555555555';
const SLUG = 'abcdefghij12';
const KEY = 'sk_secret-key';

class FakeChild extends EventEmitter {
  pid = 777;
  unref() {}
  kill() {}
}

// --- the ssh argv ---------------------------------------------------------------------------

test('bindAddrFor(preview) is the periscope slug and the key, with no secret segment', () => {
  assert.equal(bindAddrFor({ workspaceId: WS, slug: SLUG, apiKey: KEY, mcpSecret: 'deadbeef' }, 'preview'), `workspace-${WS}-slug-${SLUG}-path-preview-key-${KEY}`);
});

test('previewSshArgsFor forwards the proxy under -path-preview with the same options as the passenger tunnel', () => {
  const args = previewSshArgsFor({
    relayHost: 'crewd@ships.tablation.dev', relayPort: 2222, workspaceId: WS, slug: SLUG, apiKey: KEY,
    privateKeyPath: '/keys/id', targetHost: 'localhost', targetPort: 42001,
  });
  assert.deepEqual(args, [
    '-N', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'IdentitiesOnly=yes', '-i', '/keys/id', '-p', '2222',
    '-R', `workspace-${WS}-slug-${SLUG}-path-preview-key-${KEY}:0:localhost:42001`,
    'crewd@ships.tablation.dev',
  ]);
});

test('startPreviewTunnel spawns detached-style via the injected spawn, unrefs, and reports an exit', () => {
  const child = new FakeChild();
  const calls: string[][] = [];
  const spawnFn: SpawnFn = (_cmd, args) => { calls.push(args); return child as unknown as ChildProcess; };
  const t = startPreviewTunnel({
    relayHost: 'h', relayPort: 22, workspaceId: WS, slug: SLUG, apiKey: KEY, privateKeyPath: '/k', targetHost: 'localhost', targetPort: 1, spawnFn,
  });
  assert.equal(t.pid, 777);
  assert.equal(t.exited(), false);
  child.emit('exit', 255);
  assert.equal(t.exited(), true);
  assert.equal(calls.length, 1);
});

test('forwardTarget reads host and port, bare IPv6 included', () => {
  assert.deepEqual(forwardTarget('http://localhost:42001/'), { host: 'localhost', port: 42001 });
  assert.deepEqual(forwardTarget('http://[::1]:42001/'), { host: '::1', port: 42001 });
});

// --- opening a tunnel -----------------------------------------------------------------------

function openDeps(over: { exited?: boolean; pid?: number | undefined } = {}) {
  const log: string[] = [];
  return {
    log,
    deps: {
      start: (t: { host: string; port: number }) => { log.push(`start ${t.host}:${t.port}`); return { pid: 'pid' in over ? over.pid : 321, exited: () => over.exited ?? false }; },
      sleep: async (ms: number) => { log.push(`sleep ${ms}`); },
      kill: (pid: number) => { log.push(`kill ${pid}`); },
    },
  };
}

test('openPreviewTunnel settles ok when the child is still up after the settle time', async () => {
  const o = openDeps();
  assert.deepEqual(await openPreviewTunnel(o.deps, 'http://localhost:42001'), { ok: true, pid: 321 });
  assert.deepEqual(o.log, ['start localhost:42001', `sleep ${PREVIEW_TUNNEL_SETTLE_MS}`]);
});

test('openPreviewTunnel reports a relay that closed the tunnel (no preview kind)', async () => {
  const r = await openPreviewTunnel(openDeps({ exited: true }).deps, 'http://localhost:42001');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /`preview` tunnel kind/);
});

test('openPreviewTunnel: ssh that cannot start is a failure, not a throw', async () => {
  assert.equal((await openPreviewTunnel(openDeps({ pid: undefined }).deps, 'http://localhost:1')).ok, false);
  const throwing = { ...openDeps().deps, start: () => { throw new Error('ENOENT'); } };
  assert.match(((await openPreviewTunnel(throwing, 'http://localhost:1')) as { reason: string }).reason, /ENOENT/);
});

// --- pid safety -----------------------------------------------------------------------------

test('a recorded pid is signalled only while it is still that periscope\'s preview ssh', () => {
  const cmd = `ssh -N -R workspace-${WS}-slug-${SLUG}-path-preview-key-${KEY}:0:localhost:1 host`;
  assert.equal(isPreviewTunnel(5, SLUG, () => cmd), true);
  assert.equal(isPreviewTunnel(5, 'zzzzzzzzzzzz', () => cmd), false);
  assert.equal(isPreviewTunnel(5, SLUG, () => 'node server.js'), false);
  assert.equal(isPreviewTunnel(5, SLUG, () => undefined), false);
  const killed: number[] = [];
  assert.equal(stopRecordedTunnel({ slug: SLUG, tunnelPid: 5 }, { commandOf: () => cmd, kill: (p) => killed.push(p) }), true);
  assert.equal(stopRecordedTunnel({ slug: SLUG, tunnelPid: 6 }, { commandOf: () => 'sleep 100', kill: (p) => killed.push(p) }), false);
  assert.equal(stopRecordedTunnel({}, { kill: (p) => killed.push(p) }), false);
  assert.deepEqual(killed, [5]);
});

// --- periscope up ---------------------------------------------------------------------------

const ARGS: PeriscopeUpArgs = { repo: 'crew', topic: 'look', isolate: false, json: false };

function relay(over: Partial<PreviewRelay> & { outcome?: 'ok' | 'refused' } = {}) {
  const log: string[] = [];
  const r: PreviewRelay = {
    newSlug: () => { log.push('slug'); return SLUG; },
    publicUrl: (s) => `https://${s}.ships.tablation.dev`,
    open: async (s, local) => {
      log.push(`open ${s} ${local}`);
      return over.outcome === 'refused' ? { ok: false, reason: 'the relay closed it' } : { ok: true, pid: 901 };
    },
    stop: (pid, s) => { log.push(`stop ${pid} ${s}`); },
    ...over,
  };
  return { r, log };
}

function upHarness(rl: PreviewRelay | undefined, over: Partial<PeriscopeDeps> = {}) {
  const rows: Record<string, unknown>[] = [];
  const sidecars: PeriscopeSidecar[] = [];
  const comments: string[] = [];
  const said: string[] = [];
  const envs: Record<string, Record<string, string>> = {};
  const deps: PeriscopeDeps = {
    previewHook: 'x', hasPeriscopesTable: true, liveCount: async () => 0, caps: { max: 3, idleMinutes: 120 },
    baseProblem: () => undefined, askTopic: async () => undefined,
    fileDraft: async () => ({ id: 'rec1', tag: 'CREW-900', issueId: 'ISSUE-900' }),
    cutWorktree: () => ({ path: '/w/crew-900', branch: 'crew-900' }),
    prepare: async () => ({ code: 0, output: '' }),
    runHook: async (name, _c, env) => {
      envs[name] = env;
      if (name === 'preview') return { code: 0, output: 'http://localhost:40900\n' };
      return null;
    },
    prepareDropFile: () => {},
    startProxy: async () => 'http://localhost:42900',
    relay: rl,
    createRow: async (f) => { rows.push(f); return { id: 'per1' }; },
    recordLocal: (sc) => { sidecars.push(sc); },
    comment: async (_i, b) => { comments.push(b); },
    teardown: async () => {}, closeDraft: async () => {},
    now: () => new Date('2026-11-06T12:00:00Z'), host: 'localhost',
    say: (e, m) => { said.push(`${e}: ${m}`); },
    ...over,
  };
  return { deps, rows, sidecars, comments, said, envs };
}

test('up with a relay: records the public URL, hands the hook CREW_PREVIEW_URL, forwards the proxy not the dev server', async () => {
  const rl = relay();
  const h = upHarness(rl.r);
  const res = await runPeriscopeUp(h.deps, ARGS);
  assert.equal(res.url, `https://${SLUG}.ships.tablation.dev`);
  assert.equal(h.rows[0]!.url, res.url);
  assert.match(h.comments[0]!, new RegExp(`Periscope is up: https://${SLUG}\\.ships\\.tablation\\.dev`));
  assert.equal(h.envs.preview!.CREW_PREVIEW_URL, res.url);
  assert.deepEqual(rl.log, ['slug', `open ${SLUG} http://localhost:42900`]);
  const sc = h.sidecars[0]!;
  assert.equal(sc.url, res.url);
  assert.equal(sc.localUrl, 'http://localhost:42900');
  assert.equal(sc.slug, SLUG);
  assert.equal(sc.tunnelPid, 901);
  assert.equal(sc.tunnelSettled, true);
});

test('up: the slug is minted before the hooks run', async () => {
  const order: string[] = [];
  const rl = relay({ newSlug: () => { order.push('slug'); return SLUG; } });
  const h = upHarness(rl.r, { runHook: async (name) => { order.push(name); return name === 'preview' ? { code: 0, output: 'http://localhost:40900' } : null; } });
  await runPeriscopeUp(h.deps, ARGS);
  assert.ok(order.indexOf('slug') < order.indexOf('ports'));
});

test('up against a relay without the preview kind: succeeds on the LAN URL and says it is not relayed', async () => {
  const rl = relay({ outcome: 'refused' });
  const h = upHarness(rl.r);
  const res = await runPeriscopeUp(h.deps, ARGS);
  assert.equal(res.url, 'http://localhost:42900');
  assert.equal(h.rows[0]!.url, 'http://localhost:42900');
  assert.ok(h.said.some((l) => /^warning: the preview is not relayed: the relay closed it/.test(l)), h.said.join('\n'));
  const sc = h.sidecars[0]!;
  assert.equal(sc.slug, undefined);
  assert.equal(sc.tunnelPid, undefined);
  assert.equal(sc.localUrl, undefined);
});

test('up with the setting off, or with --no-relay: no slug, no tunnel, no CREW_PREVIEW_URL', async () => {
  const off = upHarness(undefined);
  assert.equal((await runPeriscopeUp(off.deps, ARGS)).url, 'http://localhost:42900');
  assert.equal(off.envs.preview!.CREW_PREVIEW_URL, undefined);
  assert.equal(off.sidecars[0]!.slug, undefined);

  const rl = relay();
  const flagged = upHarness(rl.r);
  assert.equal((await runPeriscopeUp(flagged.deps, { ...ARGS, noRelay: true })).url, 'http://localhost:42900');
  assert.deepEqual(rl.log, []);
  assert.equal(flagged.envs.preview!.CREW_PREVIEW_URL, undefined);
});

test('up without a proxy does not relay (the tunnel forwards the proxy)', async () => {
  const rl = relay();
  const h = upHarness(rl.r, { startProxy: undefined });
  assert.equal((await runPeriscopeUp(h.deps, ARGS)).url, 'http://localhost:40900');
  assert.deepEqual(rl.log, []);
});

test('up that fails after the tunnel opened stops the tunnel', async () => {
  const rl = relay();
  const h = upHarness(rl.r, { createRow: async () => { throw new Error('tracker down'); } });
  await assert.rejects(runPeriscopeUp(h.deps, ARGS), /recording the Periscopes row failed/);
  assert.ok(rl.log.includes(`stop 901 ${SLUG}`));
});

test('--no-relay parses', () => {
  const flags = { isolate: false, json: false };
  assert.equal(parsePeriscopeUpArgs(['periscope', 'up', 'crew'], { ...flags, noRelay: true }).noRelay, true);
  assert.equal(parsePeriscopeUpArgs(['periscope', 'up', 'crew'], flags).noRelay, undefined);
});

// --- periscope down -------------------------------------------------------------------------

const ROW: PeriscopeRowInfo = {
  id: 'per1', ticketRecordId: 'rec1', ticket: 'CREW-900', number: '900', repo: 'crew', state: 'live',
  url: `https://${SLUG}.ships.tablation.dev`, worktree: '/w/crew-900', branch: 'crew-900', lastActivityAt: null,
};

test('down stops the tunnel before the proxy and server, in every ending', async () => {
  for (const mode of ['keep', 'discard'] as const) {
    const calls: string[] = [];
    const deps: PeriscopeDownDeps = {
      rowsForTicket: async () => [ROW], hasChanges: () => true, commitAll: () => {}, push: () => ({ sha: 'a', remote: 'origin' }),
      changedFiles: () => [], readTicket: async () => ({ description: 'd', hasProject: true, hasRepo: true }),
      updateTicket: async () => {}, postPushed: async () => {},
      stopTunnel: (id) => { calls.push(`tunnel ${id}`); return 1; },
      stopServer: async () => { calls.push('server'); return 1; },
      removeWorktree: () => {}, setRowState: async () => {}, say: () => {},
    };
    await runPeriscopeDown(deps, { number: '900', mode, allowEmpty: false, json: false });
    assert.deepEqual(calls, ['tunnel rec1', 'server'], mode);
  }
});

test('down still ends the periscope when the tunnel will not stop', async () => {
  const calls: string[] = [];
  const deps: PeriscopeDownDeps = {
    rowsForTicket: async () => [ROW], hasChanges: () => true, commitAll: () => {}, push: () => ({ sha: 'a', remote: 'origin' }),
    changedFiles: () => [], readTicket: async () => ({ description: 'd', hasProject: true, hasRepo: true }),
    updateTicket: async () => {}, postPushed: async () => {},
    stopTunnel: () => { throw new Error('EPERM'); },
    stopServer: async () => 0, removeWorktree: () => {}, setRowState: async (_i, s) => { calls.push(s); }, say: () => {},
  };
  await runPeriscopeDown(deps, { number: '900', mode: 'discard', allowEmpty: false, json: false });
  assert.deepEqual(calls, ['discarded']);
});

// --- resume ---------------------------------------------------------------------------------

function resumeHarness(outcome: 'ok' | 'refused', slug: string | null = SLUG) {
  const rl = relay({ outcome });
  const records: Array<Partial<PeriscopeSidecar>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const said: string[] = [];
  const hookEnv: Array<Record<string, string>> = [];
  const deps: ResumeDeps = {
    find: async () => ({ tag: 'CREW-9', row: { id: 'r1', issue_id: 'rec', worktree: '/w/crew-9', branch: 'crew-9', host: 'localhost', isolated: false } }),
    worktreeExists: () => true,
    startProxy: async () => 'http://localhost:42009',
    relay: { ...rl.r, slugFor: () => slug ?? undefined, record: (_id, p) => { records.push(p); } },
    caps: { idleMinutes: 30 },
    runHook: async (name, _c, env) => { if (name === 'preview') { hookEnv.push(env); return { code: 0, output: 'http://localhost:40009\n' }; } return null; },
    update: async (_id, f) => { updates.push(f); },
    clearItem: () => {}, now: () => new Date('2026-11-06T12:00:00Z'), say: (e, m) => { said.push(`${e}: ${m}`); },
  };
  return { deps, records, updates, said, rl, hookEnv };
}

test('resume brings back the same URL under the slug from the sidecar', async () => {
  const h = resumeHarness('ok');
  const res = await runPeriscopeResume(h.deps, '9');
  assert.equal(res.url, `https://${SLUG}.ships.tablation.dev`);
  assert.equal(h.hookEnv[0]!.CREW_PREVIEW_URL, res.url);
  assert.equal(h.updates[0]!.url, res.url);
  assert.deepEqual(h.rl.log, [`open ${SLUG} http://localhost:42009`]);
  assert.equal(h.records[0]!.tunnelPid, 901);
  assert.equal(h.records[0]!.tunnelStopped, undefined);
  assert.ok('tunnelStopped' in h.records[0]!);
});

test('resume against a relay that refuses the tunnel falls back to the LAN URL and leaves the tunnel stopped', async () => {
  const h = resumeHarness('refused');
  const res = await runPeriscopeResume(h.deps, '9');
  assert.equal(res.url, 'http://localhost:42009');
  assert.equal(h.records[0]!.tunnelStopped, true);
  assert.ok(h.said.some((l) => /not relayed/.test(l)));
});

test('resume of a periscope that was never relayed does nothing with the relay', async () => {
  const h = resumeHarness('ok', null);
  assert.equal((await runPeriscopeResume(h.deps, '9')).url, 'http://localhost:42009');
  assert.deepEqual(h.rl.log, []);
  assert.deepEqual(h.records, []);
});

// --- idle pass ------------------------------------------------------------------------------

test('the idle pass stops the tunnel with the server', async () => {
  const T0 = Date.parse('2026-11-06T00:00:00Z');
  const row: PeriscopeRow = { id: 'r1', issue_id: 'rec', worktree: '/w/crew-9', last_activity_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 120 * 60_000).toISOString() };
  const log: string[] = [];
  const deps: IdleDeps = {
    idleMinutes: 120, now: () => new Date(T0 + 130 * 60_000), listLive: async () => [row], mtimeOf: () => null,
    update: async () => {}, ticketOf: async () => ({ tag: 'CREW-9', number: '9', repo: 'crew' }),
    stopTunnel: (r) => { log.push(`tunnel ${r.id}`); },
    stopServer: async () => { log.push('server'); },
    raise: async () => {}, clear: () => {}, openKeys: () => [], warn: () => {},
  };
  await runPeriscopeIdlePass(deps);
  assert.deepEqual(log, ['tunnel r1', 'server']);
});

// --- sidecar --------------------------------------------------------------------------------

function sidecar(over: Partial<PeriscopeSidecar> = {}): PeriscopeSidecar {
  return {
    ticket: 'CREW-9', ticketRecordId: 'rec', periscopeRecordId: 'per', repo: 'crew', route: 'ws/issues', worktree: '/w/crew-9', branch: 'crew-9',
    url: `https://${SLUG}.ships.tablation.dev`, host: 'localhost', state: 'live', isolated: false,
    startedAt: 'a', lastActivityAt: 'b', expiresAt: 'c', slug: SLUG, localUrl: 'http://localhost:42009', tunnelPid: 50, tunnelSettled: true, ...over,
  };
}

test('updatePeriscopeSidecar merges a patch and drops keys patched to undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-sc-'));
  writePeriscopeSidecar(dir, sidecar());
  updatePeriscopeSidecar(dir, 'rec', { tunnelPid: undefined, tunnelStopped: true });
  const sc = readPeriscopeSidecars(dir)[0]!;
  assert.equal(sc.tunnelPid, undefined);
  assert.equal('tunnelPid' in sc, false);
  assert.equal(sc.tunnelStopped, true);
  assert.equal(sc.slug, SLUG);
  assert.equal(updatePeriscopeSidecar(dir, 'nope', { tunnelStopped: true }), undefined);
});

test('status probes the proxy port of a relayed periscope, not the public URL\'s 443', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-sc-'));
  writePeriscopeSidecar(dir, sidecar());
  const probed: number[] = [];
  const [s] = await periscopesForStatus(dir, async (p) => { probed.push(p); return true; });
  assert.deepEqual(probed, [42009]);
  assert.equal(s!.serving, true);
});

// --- the daemon's tunnel pass ---------------------------------------------------------------

function passHarness(scs: PeriscopeSidecar[], alive: (sc: PeriscopeSidecar) => boolean) {
  const log: string[] = [];
  const items: ShipAttentionItem[] = [];
  const state = new Map(scs.map((s) => [s.ticketRecordId, { ...s }]));
  const deps: TunnelPassDeps = {
    sidecars: () => [...state.values()],
    isAlive: alive,
    respawn: (sc) => { log.push(`respawn ${sc.ticket}`); return 600; },
    patch: (id, p) => { log.push(`patch ${JSON.stringify(p)}`); state.set(id, { ...state.get(id)!, ...p }); },
    raise: async (i) => { items.push(i); },
    clear: (k) => { log.push(`clear ${k}`); },
    now: () => new Date('2026-11-06T12:00:00Z'),
    warn: (m) => log.push(`warn ${m}`),
  };
  return { deps, log, items, state };
}

test('a settled tunnel that died later is restarted, with no attention item', async () => {
  const h = passHarness([sidecar()], () => false);
  assert.deepEqual(await runPeriscopeTunnelPass(h.deps), { respawned: 1 });
  assert.deepEqual(h.log.slice(0, 1), ['respawn CREW-9']);
  assert.equal(h.state.get('rec')!.tunnelPid, 600);
  assert.equal(h.state.get('rec')!.tunnelSettled, false);
  assert.equal(h.state.get('rec')!.tunnelQuickExits, 0);
  assert.deepEqual(h.items, []);
});

test('a live tunnel is left alone and marked settled once', async () => {
  const h = passHarness([sidecar({ tunnelSettled: false })], () => true);
  assert.deepEqual(await runPeriscopeTunnelPass(h.deps), { respawned: 0 });
  assert.equal(h.state.get('rec')!.tunnelSettled, true);
  assert.ok(h.log.includes(`clear ${periscopeTunnelKey('CREW-9')}`));
});

test('a tunnel that keeps dying before it settles raises tunnel_rejected at the second pass', async () => {
  const h = passHarness([sidecar({ tunnelSettled: false })], () => false);
  await runPeriscopeTunnelPass(h.deps);
  assert.deepEqual(h.items, []);
  await runPeriscopeTunnelPass(h.deps);
  const raised: ShipAttentionItem[] = [...h.items];
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.kind, 'tunnel_rejected');
  assert.match(raised[0]!.message, /CREW-9/);
});

test('unrelayed and deliberately stopped periscopes are skipped', async () => {
  const h = passHarness([sidecar({ slug: undefined, ticketRecordId: 'a' }), sidecar({ tunnelStopped: true, ticketRecordId: 'b' })], () => false);
  assert.deepEqual(await runPeriscopeTunnelPass(h.deps), { respawned: 0 });
  assert.deepEqual(h.log, []);
});

test('one periscope that throws does not stop the others', async () => {
  const h = passHarness([sidecar({ ticketRecordId: 'a', ticket: 'CREW-1' }), sidecar({ ticketRecordId: 'b', ticket: 'CREW-2' })], () => false);
  h.deps.respawn = (sc) => { if (sc.ticket === 'CREW-1') throw new Error('no key'); return 5; };
  assert.deepEqual(await runPeriscopeTunnelPass(h.deps), { respawned: 1 });
  assert.ok(h.log.some((l) => /CREW-1: no key/.test(l)));
});

// --- control API ----------------------------------------------------------------------------

test('the 409 for a missing previewHost is dropped when previews are relayed, and --host is then omitted', async () => {
  const runs: string[][] = [];
  const h: PeriscopeHosting = {
    routes: [{ route: 'ws/issues', workspaceId: 'ws1', hostPeriscopes: true }],
    relayPreviews: true, maxPeriscopes: 3,
    run: async (args) => { runs.push(args); return { code: 0, stdout: args[1] === 'list' ? '[]' : '{"event":"done"}\n', stderr: '' }; },
    verifyIn: async () => 'ok',
  };
  const r = await handlePeriscopes(h, { method: 'POST', path: '/periscopes', query: new URLSearchParams(), token: 't', body: { route: 'ws/issues', repo: 'app', topic: 'x' }, wantsStream: false });
  assert.equal(r.status, 200);
  const up = runs.find((a) => a[1] === 'up')!;
  assert.ok(!up.includes('--host'));
  const without = await handlePeriscopes({ ...h, relayPreviews: false }, { method: 'POST', path: '/periscopes', query: new URLSearchParams(), token: 't', body: { route: 'ws/issues', repo: 'app', topic: 'x' }, wantsStream: false });
  assert.equal(without.status, 409);
});

test('relayBaseUrlFor and generateTunnelSlug give the 12-character public origin', () => {
  const slug = generateTunnelSlug();
  assert.match(slug, /^[a-z0-9]{12}$/);
  assert.equal(relayBaseUrlFor(slug, 'crewd@ships.tablation.dev', 443), `https://${slug}.ships.tablation.dev`);
});

test('staleTunnelKeys() returns the item of a periscope with no watched tunnel, and keeps a watched one (CREW-3239)', () => {
  const sc = (ticket: string, extra: Partial<PeriscopeSidecar> = {}): PeriscopeSidecar => ({ ticket, slug: SLUG, ...extra } as PeriscopeSidecar);
  const keys = [periscopeTunnelKey('CREW-1'), periscopeTunnelKey('CREW-2'), periscopeTunnelKey('CREW-3'), periscopeTunnelKey('CREW-4'), 'tunnel_rejected:ws-a'];
  const sidecars = [sc('CREW-1'), sc('CREW-2', { tunnelStopped: true }), sc('CREW-4', { slug: undefined })];
  assert.deepEqual(staleTunnelKeys(keys, sidecars), [periscopeTunnelKey('CREW-2'), periscopeTunnelKey('CREW-3'), periscopeTunnelKey('CREW-4')]);
});
