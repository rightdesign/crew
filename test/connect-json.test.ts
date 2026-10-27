import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  CHOICE_EXIT_CODE, CONNECT_EVENTS, choiceData, createEmitter, flagWizardAnswers, parseChoices, usesFlagAnswers,
} from '../src/connect-json.ts';
import type { WizardEnv } from '../src/connect-wizard.ts';

const env = (over: Partial<WizardEnv> = {}): WizardEnv => ({
  hostname: 'brads-box', platform: 'macos', pathEnv: '/opt/bin:/usr/bin', nodePath: '/opt/node/bin/node',
  dockerAvailable: true, isExecutable: (p) => ['/opt/bin/claude', '/opt/bin/pnpm', '/elsewhere/claude'].includes(p),
  ...over,
});
const flags = (over = {}) => ({ hostPassengers: false, noWizard: false, ...over });

test('emitter writes one JSON object per line with event and message last, and nothing when --json is off', () => {
  const lines: string[] = [];
  createEmitter(true, (l) => lines.push(l)).emit('seat', 'dev seat created', { role: 'dev', event: 'spoofed' });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith('\n'));
  assert.deepEqual(JSON.parse(lines[0]!), { role: 'dev', event: 'seat', message: 'dev seat created' });
  const off: string[] = [];
  createEmitter(false, (l) => off.push(l)).emit('done', 'x');
  assert.deepEqual(off, []);
});

test('every documented event name is in the registry exactly once', () => {
  assert.equal(new Set(CONNECT_EVENTS).size, CONNECT_EVENTS.length);
  for (const e of ['device_code', 'signed_in', 'workspace_resolved', 'project_options', 'template_missing',
    'template_installed', 'ship_row', 'operator_row', 'seat', 'mcp_registered', 'pair_installed', 'capabilities',
    'agents_synced', 'seat_key', 'choice', 'problem', 'done']) assert.ok((CONNECT_EVENTS as readonly string[]).includes(e), e);
});

test('agents_synced and seat_key come before done in the event registry (CREW-2241)', () => {
  const order = CONNECT_EVENTS as readonly string[];
  assert.ok(order.indexOf('agents_synced') < order.indexOf('done'));
  assert.ok(order.indexOf('seat_key') < order.indexOf('done'));
});

test('parseChoices: repeatable, both spellings, value may contain =, last one wins', () => {
  assert.deepEqual(
    parseChoices(['connect', '--choose', 'project=issues', '--choose=operator=abc', '--choose', 'project=other', '--choose', 'x=a=b', '--choose', 'bad']),
    { project: 'other', operator: 'abc', x: 'a=b' },
  );
});

test('choiceData names the key to answer with', () => {
  assert.deepEqual(choiceData('project', [{ value: 'a', label: 'A' }]), {
    key: 'project', options: [{ value: 'a', label: 'A' }], answer: '--choose project=<value>',
  });
});

test('usesFlagAnswers: --no-wizard always; answer flags only off a terminal', () => {
  assert.equal(usesFlagAnswers(flags({ noWizard: true }), true), true);
  assert.equal(usesFlagAnswers(flags({ shipName: 'x' }), false), true);
  assert.equal(usesFlagAnswers(flags({ shipName: 'x' }), true), false);
  assert.equal(usesFlagAnswers(flags(), false), false);
});

test('flagWizardAnswers: wizard defaults when only some flags are given', () => {
  const r = flagWizardAnswers(flags({ shipName: 'my-ship' }), env());
  assert.deepEqual('answers' in r && r.answers, {
    name: 'my-ship', platform: 'macos', agentBin: '/opt/bin/claude', extraPath: '/opt/node/bin:/opt/bin', hostPassengers: false,
  });
  const d = flagWizardAnswers(flags(), env());
  assert.equal('answers' in d && d.answers.name, 'brads-box');
});

test('flagWizardAnswers: explicit --agent-bin and --extra-path win; a bad binary or no claude is an error, never a prompt', () => {
  const r = flagWizardAnswers(flags({ agentBin: '/elsewhere/claude', extraPath: '/x', hostPassengers: true }), env());
  assert.deepEqual('answers' in r && [r.answers.agentBin, r.answers.extraPath, r.answers.hostPassengers], ['/elsewhere/claude', '/x', true]);
  assert.match('error' in flagWizardAnswers(flags({ agentBin: '/nope' }), env()) ? 'bad' : '', /bad/);
});

test('flagWizardAnswers: no claude anywhere is not an error (CREW-2416): placeholder answer plus the directories searched', () => {
  const none = flagWizardAnswers(flags(), env({ pathEnv: '/usr/bin', home: '/h' }));
  assert.ok('answers' in none);
  assert.equal(none.answers.agentBin, 'claude');
  assert.ok(none.agentBinSearched?.includes('/h/.local/bin'));
  assert.ok(none.agentBinSearched?.includes('/opt/homebrew/bin'));
  assert.ok(none.agentBinSearched?.includes('/usr/bin'));
});

test('flagWizardAnswers: finds claude in ~/.local/bin and extraPath with a minimal PATH (CREW-2416)', () => {
  const isExecutable = (p: string) => p === '/h/.local/bin/claude' || p === '/x/bin/claude';
  const a = flagWizardAnswers(flags(), env({ pathEnv: '/usr/bin:/bin', home: '/h', isExecutable }));
  assert.ok('answers' in a && a.answers.agentBin === '/h/.local/bin/claude' && !a.agentBinSearched);
  const b = flagWizardAnswers(flags({ extraPath: '/x/bin' }), env({ pathEnv: '/usr/bin', home: '/nohome', isExecutable }));
  assert.ok('answers' in b && b.answers.agentBin === '/x/bin/claude');
});

// ---- end to end: the real CLI, no TTY, against a mock tracker -------------------------------

interface Mock { server: Server; url: string; posts: string[]; close(): Promise<void> }

/** A tracker with one workspace; `projects` names the Issues-shaped projects it holds. */
async function mockTracker(o: { projects: string[]; role?: string; holds?: Array<{ id: string; name: string; email?: string }>; installable?: boolean; workspaces?: string[] }): Promise<Mock> {
  const posts: string[] = [];
  let installed = false;
  const projectRows = () => [
    ...o.projects,
    ...(installed ? ['issues'] : []),
  ].map((slug) => ({ id: `p-${slug}`, slug, name: slug.toUpperCase() }));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const path = u.pathname.replace(/^\/api/, '');
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method !== 'GET') posts.push(`${req.method} ${path}`);
      if (path === '/auth/device/authorize') return send(200, { deviceCode: 'dc', userCode: 'ABCD-1234', verificationUri: 'http://v', verificationUriComplete: 'http://v?c=ABCD-1234', expiresIn: 60, interval: 0 });
      if (path === '/auth/device/token') return send(400, { error: 'access_denied' });
      if (path === '/auth/my-workspaces') return send(200, { workspaces: (o.workspaces ?? ['ws']).map((slug) => ({ slug, name: slug.toUpperCase(), role: 'WORKSPACE_ADMIN' })) });
      if (path === '/workspaces/ws') return send(200, { id: 'w1', slug: 'ws', name: 'WS' });
      if (path === '/auth/me') return send(200, { role: o.role ?? 'WORKSPACE_ADMIN', email: 'me@x.test', id: 'me1', name: 'Me' });
      if (path === '/library-templates') return send(200, o.installable ? [{ id: 't1', name: 'Issues', identifier: 'crew.issues' }] : []);
      if (path === '/library-templates/t1/install-preview') return send(200, { hasUnresolvedConflicts: false, dataModels: { conflicts: [] }, fieldTypes: { conflicts: [] } });
      if (path === '/library-templates/t1/install') { installed = true; return send(200, { project: { id: 'p-issues', slug: 'issues', name: 'ISSUES' } }); }
      if (path === '/projects') return send(200, projectRows());
      const proj = path.match(/^\/projects\/(.+)$/);
      if (proj) { const hit = projectRows().find((p) => p.slug === proj[1] || p.id === proj[1]); return hit ? send(200, hit) : send(404, {}); }
      if (path === '/data-models') {
        const p = u.searchParams.get('projectId') ?? '';
        return send(200, ['Issues', 'Comments', 'Crew', 'Ships'].map((n) => ({ id: `${p}:${n}`, name: n })));
      }
      if (/\/data-models\/[^/]+:Issues$/.test(path)) return send(200, { fields: [] });
      if (/:Issues\/events$/.test(path)) return send(200, []);
      if (/:Ships$/.test(path)) return send(200, { fields: [] });
      if (/:Ships\/records$/.test(path)) return req.method === 'POST' ? send(200, { id: 'ship1' }) : send(200, []);
      if (/:Crew\/records$/.test(path)) {
        return req.method === 'POST' ? send(200, { id: `new-${posts.length}` }) : send(200, o.holds ?? [{ id: 'h1', name: 'Me', email: 'me@x.test' }]);
      }
      if (/\/records\//.test(path)) return send(200, {});
      if (path === '/views') return send(200, []);
      return send(404, { path });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    server, posts, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => { server.close(() => r()); }),
  };
}

interface Run { code: number | null; events: Array<Record<string, any>>; stdout: string; stderr: string; dir: string }

/** `crew connect` as a child process with no TTY and an empty HOME, so no config exists. */
async function runConnect(args: string[], dir = mkdtempSync(join(tmpdir(), 'crew-json-')), pathEnv = process.env.PATH ?? ''): Promise<Run> {
  const fakeClaude = join(dir, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\nexit 1\n');
  chmodSync(fakeClaude, 0o755);
  // A stub `security` first on PATH (CREW-2524). @tablation/client shells out to the real macOS
  // `security` to store the key, with no timeout; against a throwaway HOME on a Mac with a
  // locked or prompting login keychain it blocks forever at 0% CPU. "No keychain" is what
  // these tests assume, so make that true: item-not-found on read, failure on write. It sits
  // in its own directory so it does not put the fake `claude` on PATH.
  const stubs = join(dir, 'stubs');
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, 'security'), '#!/bin/sh\nexit 44\n');
  chmodSync(join(stubs, 'security'), 0o755);
  // Likewise `docker` (CREW-2544): a wedged Docker Desktop daemon blocks `docker info`; tests assume none.
  writeFileSync(join(stubs, 'docker'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(stubs, 'docker'), 0o755);
  const child = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'connect', ...args.map((a) => a.replace('$CLAUDE', fakeClaude))], {
    env: { PATH: `${stubs}:${pathEnv}`, HOME: dir, CREW_CONFIG: join(dir, 'crew.yaml'), NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  // node:test's per-test timeout fails the test but leaves the child running, and a live
  // child keeps the whole test process (and the suite) from exiting. Kill it first.
  const watchdog = setTimeout(() => { stderr += '\n[runConnect: child killed after 45s]'; child.kill('SIGKILL'); }, 45000);
  const code = await new Promise<number | null>((r) => child.on('close', r));
  clearTimeout(watchdog);
  const events = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  return { code, events, stdout, stderr, dir };
}

const names = (r: Run) => r.events.map((e) => e.event as string);

test('a full first-run connect with flags and --json, no TTY: events in order, crew.yaml written', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const r = await runConnect([
      'ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 'test-ship', '--agent-bin', '$CLAUDE',
      '--dir', '/tmp/crew-json-checkout',
    ]);
    assert.equal(r.code, 0, r.stderr);
    // stdout carries only JSON event lines (parsed above), never the route block.
    assert.ok(!r.stdout.includes('route:'));
    const n = names(r);
    for (const e of ['signed_in', 'workspace_resolved', 'ship_row', 'operator_row', 'seat', 'mcp_registered', 'done']) {
      assert.ok(n.includes(e), `${e} in ${n.join(',')}`);
    }
    assert.equal(n[n.length - 1], 'done');
    assert.equal(n.filter((e) => e === 'seat').length, 4);
    const ship = r.events.find((e) => e.event === 'ship_row')!;
    assert.equal(ship.action, 'created');
    const done = r.events.find((e) => e.event === 'done')!;
    assert.equal(done.wroteConfig, true);
    assert.equal(done.route, 'ws/issues');
    const yaml = join(r.dir, 'crew.yaml');
    assert.ok(existsSync(yaml));
    assert.match(readFileSync(yaml, 'utf8'), /name: test-ship/);
    assert.match(readFileSync(yaml, 'utf8'), /route: ws\/issues/);
    // The key had no keychain to live in, so it went to a key file the config names.
    assert.match(readFileSync(yaml, 'utf8'), /apiKeyFile/);
  } finally { await m.close(); }
});

test('two qualifying projects: a choice event, exit 3, and --choose answers it on the next run', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['alpha', 'beta'] });
  try {
    const common = ['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 's', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'];
    const first = await runConnect(common);
    assert.equal(first.code, CHOICE_EXIT_CODE, first.stderr);
    assert.ok(names(first).includes('project_options'));
    const choice = first.events.find((e) => e.event === 'choice')!;
    assert.equal(choice.key, 'project');
    assert.deepEqual(choice.options.map((o: { value: string }) => o.value), ['alpha', 'beta']);
    assert.ok(!existsSync(join(first.dir, 'crew.yaml')), 'a stopped run writes no config');
    const second = await runConnect([...common, '--choose', 'project=beta']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.events.find((e) => e.event === 'done')!.route, 'ws/beta');
  } finally { await m.close(); }
});

test('several Crew rows and none matching the key: an operator choice, then --choose operator=<id>', { timeout: 60000 }, async () => {
  const m = await mockTracker({
    projects: ['issues'],
    holds: [{ id: 'h1', name: 'Alice', email: 'a@x.test' }, { id: 'h2', name: 'Bob', email: 'b@x.test' }],
  });
  try {
    const common = ['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 's', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'];
    const first = await runConnect(common);
    assert.equal(first.code, CHOICE_EXIT_CODE, first.stderr);
    const choice = first.events.find((e) => e.event === 'choice')!;
    assert.equal(choice.key, 'operator');
    assert.ok(choice.options.some((o: { value: string }) => o.value === 'new'));
    const second = await runConnect([...common, '--choose', 'operator=h2']);
    assert.equal(second.code, 0, second.stderr);
    const opRow = second.events.find((e) => e.event === 'operator_row')!;
    assert.equal(opRow.id, 'h2');
    assert.equal(opRow.name, 'Bob');
    assert.equal(opRow.email, 'b@x.test');
  } finally { await m.close(); }
});

test('no qualifying project: template_missing, an install-template choice, then template_installed', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: [], installable: true });
  try {
    const common = ['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 's', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'];
    const first = await runConnect(common);
    assert.equal(first.code, CHOICE_EXIT_CODE, first.stderr);
    assert.equal(first.events.find((e) => e.event === 'template_missing')!.canInstall, true);
    assert.equal(first.events.find((e) => e.event === 'choice')!.key, 'install-template');
    assert.deepEqual(m.posts.filter((p) => p.includes('install')), [], 'nothing installed before the answer');
    const second = await runConnect([...common, '--choose', 'install-template=yes']);
    assert.equal(second.code, 0, second.stderr);
    assert.ok(names(second).includes('template_installed'));
  } finally { await m.close(); }
});

test('a member cannot install: template_missing says so and the run ends with a problem, exit 2', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: [], role: 'MEMBER', installable: true });
  try {
    const r = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 's', '--agent-bin', '$CLAUDE', '--no-mcp']);
    assert.equal(r.code, 2);
    assert.equal(r.events.find((e) => e.event === 'template_missing')!.canInstall, false);
    assert.ok(names(r).includes('problem'));
  } finally { await m.close(); }
});

test('device authorization needs no TTY: the code arrives as an event and a denial is a problem event', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const r = await runConnect(['ws', '--base-url', m.url, '--json', '--ship-name', 's', '--agent-bin', '$CLAUDE', '--no-mcp']);
    assert.equal(r.code, 2);
    const code = r.events.find((e) => e.event === 'device_code')!;
    assert.equal(code.userCode, 'ABCD-1234');
    assert.equal(code.verificationUriComplete, 'http://v?c=ABCD-1234');
    assert.equal(code.expiresIn, 60);
    assert.deepEqual(names(r), ['device_code', 'problem']);
  } finally { await m.close(); }
});

test('an unusable --agent-bin is a problem event and exit 2, never a prompt', { timeout: 60000 }, async () => {
  const r = await runConnect(['ws', '--key', 'k1', '--json', '--ship-name', 's', '--agent-bin', '/definitely/not/here']);
  assert.equal(r.code, 2);
  assert.deepEqual(names(r), ['problem']);
});

test('--dry-run with no crew.yaml takes the first-run flag-answers path and writes nothing (CREW-2313)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    const dry = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--no-wizard', '--dry-run', '--agent-bin', '$CLAUDE', '--dir', '/tmp/crew-json-checkout'], dir);
    assert.equal(dry.code, 0, dry.stderr);
    assert.ok(!dry.stderr.includes('no config found'), dry.stderr);
    assert.equal(names(dry)[names(dry).length - 1], 'done');
    assert.equal(dry.events.find((e) => e.event === 'done')!.wroteConfig, false);
    assert.ok(!existsSync(join(dir, 'crew.yaml')));
    assert.ok(!m.posts.some((p) => p.includes('/records')), m.posts.join(','));
    // The same machine then connects for real: the first-run path still writes the file.
    const real = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 'test-ship', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'], dir);
    assert.equal(real.code, 0, real.stderr);
    assert.ok(existsSync(join(dir, 'crew.yaml')));
    // And a dry run on the now-configured machine still works.
    const again = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--no-wizard', '--dry-run', '--no-mcp'], dir);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.events.find((e) => e.event === 'done')!.wroteConfig, false);
  } finally { await m.close(); }
});

test('a claude in ~/.local/bin is found without --agent-bin and written to crew.yaml as an absolute path (CREW-2416)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    mkdirSync(join(dir, '.local/bin'), { recursive: true });
    const bin = join(dir, '.local/bin/claude');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    // A minimal PATH, like a GUI caller's. The search order is PATH, --extra-path,
    // then ~/.local/bin ahead of the Homebrew/system dirs, so a real `claude` in
    // /opt/homebrew/bin or /usr/local/bin on the host cannot win over this one.
    const minimal = '/usr/bin:/bin';
    const dry = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--no-wizard', '--dry-run', '--dir', '/tmp/crew-json-checkout'], dir, minimal);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.events.find((e) => e.event === 'done')!.agentBin, bin);
    const real = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--no-wizard', '--no-mcp', '--dir', '/tmp/crew-json-checkout'], dir, minimal);
    assert.equal(real.code, 0, real.stderr);
    assert.ok(readFileSync(join(dir, 'crew.yaml'), 'utf8').includes(bin));
  } finally { await m.close(); }
});

test('--dry-run with no crew.yaml reaches device authorization before anything else (CREW-2313)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const r = await runConnect(['ws', '--base-url', m.url, '--json', '--no-wizard', '--dry-run', '--agent-bin', '$CLAUDE']);
    assert.equal(names(r)[0], 'device_code');
    assert.ok(!r.stderr.includes('no config found'), r.stderr);
    assert.ok(!existsSync(join(r.dir, 'crew.yaml')));
  } finally { await m.close(); }
});

test('a --key with no workspace named emits signed_in before the workspace choice (CREW-2447)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'], workspaces: ['ws', 'other'] });
  try {
    const r = await runConnect(['--key', 'k1', '--base-url', m.url, '--json', '--no-wizard', '--dry-run', '--agent-bin', '$CLAUDE']);
    assert.equal(r.code, CHOICE_EXIT_CODE, r.stderr);
    assert.deepEqual(names(r), ['signed_in', 'choice']);
    const si = r.events[0]!;
    assert.equal(si.identity.email, 'me@x.test');
    assert.equal(si.session, 'flag');
    assert.deepEqual(si.workspaces.map((w: { slug: string }) => w.slug), ['ws', 'other']);
    assert.equal(r.events[1]!.key, 'workspace');
  } finally { await m.close(); }
});

test('a dry run against a crew.yaml naming one workspace does not ask which (CREW-2447)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'], workspaces: ['ws', 'other'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    const real = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 't', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'], dir);
    assert.equal(real.code, 0, real.stderr);
    // The route's key as `hydrateApiKeys` leaves it for a keychain-backed route: inline on the route.
    const yamlPath = join(dir, 'crew.yaml');
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace(/^(\s*)apiKeyFile:.*\n(\s*apiKeyVar:.*\n)?/m, '$1apiKey: k1\n'));
    const dry = await runConnect(['--base-url', m.url, '--json', '--no-wizard', '--dry-run', '--no-mcp'], dir);
    assert.equal(dry.code, 0, dry.stderr);
    const n = names(dry);
    assert.equal(n[0], 'signed_in');
    assert.ok(!n.includes('choice'), n.join(','));
    assert.ok(n.indexOf('workspace_resolved') > 0);
    assert.equal(dry.events[0]!.session, 'config');
    assert.match(dry.events[0]!.message, /ws/);
    assert.equal(n.filter((e) => e === 'signed_in').length, 1);
  } finally { await m.close(); }
});

test('--json emits a config event: written on a first run, left alone when crew.yaml exists (CREW-2558)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    const first = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--no-wizard', '--ship-name', 'test-ship', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'], dir);
    assert.equal(first.code, 0, first.stderr);
    const wrote = first.events.find((e) => e.event === 'config')!;
    assert.equal(wrote.written, true);
    assert.equal(wrote.path, join(dir, 'crew.yaml'));
    const again = await runConnect(['ws', '--key', 'k1', '--base-url', m.url, '--json', '--no-wizard', '--ship-name', 'test-ship', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'], dir);
    assert.equal(again.code, 0, again.stderr);
    const left = again.events.find((e) => e.event === 'config')!;
    assert.equal(left.written, false);
    assert.equal(left.reason, 'exists');
    assert.equal(left.path, join(dir, 'crew.yaml'));
  } finally { await m.close(); }
});
