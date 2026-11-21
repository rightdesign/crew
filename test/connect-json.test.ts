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

interface Mock { server: Server; url: string; posts: string[]; auths: string[]; close(): Promise<void> }

/** A tracker with one workspace; `projects` names the Issues-shaped projects it holds. */
async function mockTracker(o: { projects: string[]; role?: string; holds?: Array<{ id: string; name: string; email?: string }>; installable?: boolean; workspaces?: string[] }): Promise<Mock> {
  const posts: string[] = [];
  const auths: string[] = [];
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
      auths.push(String(req.headers.authorization ?? ''));
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
      // Seats are matched by Agent reference, so connect needs the persona rows (CREW-3448).
      if (path === '/data-models/agents') return send(200, { id: 'agents-model' });
      if (path === '/data-models/agents-model/records') return send(200, ['Developer', 'Design', 'QA', 'Triage', 'Pair'].map((n) => ({ id: `agent-${n}`, name: n })));
      if (/:Issues\/events$/.test(path)) return send(200, []);
      if (/:(Ships|Crew)$/.test(path)) return send(200, { fields: [] });
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
    server, posts, auths, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => { server.close(() => r()); }),
  };
}

interface Run { code: number | null; events: Array<Record<string, any>>; stdout: string; stderr: string; dir: string }

/**
 * How the child's key store behaves (CREW-3468). The store a connect writes to depends on the host:
 * macOS shells out to `security`, Linux to `secret-tool` (when a session bus looks reachable, else
 * crew uses its own file store). A test that leaves that to the platform passes on one and fails on
 * the other, so every run forces an outcome with stub binaries for BOTH tools and a session bus
 * address that makes the Linux one count as reachable:
 *   refuses: every read finds nothing and every write fails, so connect falls back to a key file;
 *   accepts: a flat file under HOME holds what was written and hands it back.
 */
type KeyStore = 'refuses' | 'accepts';

function writeStoreStubs(stubs: string, dir: string, store: KeyStore): void {
  const stash = join(dir, 'fake-store.json');
  const files: Record<string, string> = store === 'refuses'
    ? {
      security: '#!/bin/sh\nexit 44\n',
      // `store` drains stdin first: a client writing the session JSON to a store that exited without
      // reading gets EPIPE, which kills the child on Linux (the real secret-tool reads it). Other
      // subcommands send nothing and never close stdin, so draining there would hang.
      'secret-tool': '#!/bin/sh\n[ "$1" = store ] && cat >/dev/null\necho "Cannot autolaunch D-Bus" >&2\nexit 1\n',
    }
    : {
      security: `#!/bin/sh
case "$1" in
  find-generic-password) [ -f "${stash}" ] || exit 44; cat "${stash}" ;;
  add-generic-password) while [ $# -gt 0 ]; do [ "$1" = -w ] && { printf '%s' "$2" > "${stash}"; exit 0; }; shift; done; exit 1 ;;
  delete-generic-password) rm -f "${stash}" ;;
esac
`,
      'secret-tool': `#!/bin/sh
case "$1" in
  lookup) [ -f "${stash}" ] || exit 1; cat "${stash}" ;;
  store) cat > "${stash}" ;;
  clear) rm -f "${stash}" ;;
esac
`,
    };
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(stubs, name), body);
    chmodSync(join(stubs, name), 0o755);
  }
}

/** `crew connect` as a child process with no TTY and an empty HOME, so no config exists. */
async function runConnect(args: string[], dir = mkdtempSync(join(tmpdir(), 'crew-json-')), pathEnv = process.env.PATH ?? '', store: KeyStore = 'refuses', extraEnv: Record<string, string> = {}): Promise<Run> {
  const fakeClaude = join(dir, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\nexit 1\n');
  chmodSync(fakeClaude, 0o755);
  // Stub key-store binaries first on PATH (CREW-2524, CREW-3468). @tablation/client shells out to
  // the real macOS `security` with no timeout; against a throwaway HOME on a Mac with a locked or
  // prompting login keychain it blocks forever at 0% CPU. They sit in their own directory so they
  // do not put the fake `claude` on PATH.
  const stubs = join(dir, 'stubs');
  mkdirSync(stubs, { recursive: true });
  writeStoreStubs(stubs, dir, store);
  // Likewise `docker` (CREW-2544): a wedged Docker Desktop daemon blocks `docker info`; tests assume none.
  writeFileSync(join(stubs, 'docker'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(stubs, 'docker'), 0o755);
  const child = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'connect', ...args.map((a) => a.replace('$CLAUDE', fakeClaude))], {
    env: { PATH: `${stubs}:${pathEnv}`, HOME: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-crew-test-bus', CREW_CONFIG: join(dir, 'crew.yaml'), NODE_NO_WARNINGS: '1', ...extraEnv },
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
    assert.ok(r.events.some((e) => e.event === 'warning' || /could not store the key/.test(r.stderr)), 'a refused store is warned about');
  } finally { await m.close(); }
});

test('connect with a key store that accepts the key: crew.yaml names no key file, and a later command resolves the key (CREW-3468)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    const args = ['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 'test-ship', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'];
    const r = await runConnect(args, dir, undefined, 'accepts');
    assert.equal(r.code, 0, r.stderr);
    const yaml = readFileSync(join(dir, 'crew.yaml'), 'utf8');
    assert.doesNotMatch(yaml, /apiKeyFile|apiKeyVar/);
    // The key really is in the store, not merely absent from the file.
    const stash = join(dir, 'fake-store.json');
    assert.ok(existsSync(stash), 'the stub store received the key');
    assert.match(readFileSync(stash, 'utf8'), /"apiKey":"k1"/);
    const later = await runConnect(['--base-url', m.url, '--json', '--no-wizard', '--dry-run', '--no-mcp'], dir, undefined, 'accepts');
    assert.equal(later.code, 0, later.stderr);
    assert.equal(later.events[0]!.event, 'signed_in');
    assert.equal(later.events[0]!.session, 'config');
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

test('--dry-run on an empty Crew table reports would-create instead of stopping; the real run creates the row (CREW-2573)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'], holds: [] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    const args = ['ws', '--key', 'k1', '--base-url', m.url, '--json', '--ship-name', 's', '--agent-bin', '$CLAUDE', '--no-mcp', '--dir', '/tmp/crew-json-checkout'];
    const dry = await runConnect([...args, '--no-wizard', '--dry-run'], dir);
    assert.equal(dry.code, 0, dry.stderr);
    const opRow = dry.events.find((e) => e.event === 'operator_row')!;
    assert.equal(opRow.action, 'would-create');
    assert.equal(opRow.name, 'Me');
    assert.equal(opRow.email, 'me@x.test');
    assert.equal(opRow.id, undefined);
    assert.ok(!dry.events.some((e) => e.event === 'problem' && e.stage === 'operator'), dry.stdout);
    assert.ok(!m.posts.some((p) => p.includes('/records')), m.posts.join(','));
    const real = await runConnect(args, dir);
    assert.equal(real.code, 0, real.stderr);
    assert.equal(real.events.find((e) => e.event === 'operator_row')!.action, 'created');
  } finally { await m.close(); }
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

// ---- CREW-3912: which key a `crew connect <workspace>` run uses ------------------------------

const CFG_KEY = 'cfg-route-key';
const sessionJson = (apiKey: string) => JSON.stringify({ apiKey, workspaceId: 'w1', identityId: 'me1', createdAt: '2026-11-21T00:00:00.000Z' });

/** A crew.yaml whose one route, `ws/issues`, carries the given key lines and (optionally) its own server. */
function writeRouteConfig(dir: string, keyLines: string, baseUrl?: string): void {
  writeFileSync(join(dir, 'crew.yaml'),
    `ship:\n  name: x\n  platform: macos\n  agent:\n    bin: /bin/claude\nroutes:\n  - route: ws/issues\n    repos: {}\n${baseUrl ? `    baseUrl: "${baseUrl}"\n` : ''}${keyLines}`);
}
const connectArgs = (target: string, url: string, extra: string[] = []) =>
  [target, '--base-url', url, '--json', '--no-wizard', '--no-mcp', '--ship-name', 's', '--agent-bin', '$CLAUDE', '--dir', '/tmp/crew-json-checkout', ...extra];
const sentKey = (m: Mock, key: string) => m.auths.some((a) => a.includes(key));

test('a named workspace no configured route is in starts a device approval and never sends the route key (CREW-3912)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'], workspaces: ['ws', 'other'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    writeRouteConfig(dir, `    apiKey: "${CFG_KEY}"\n`);
    const r = await runConnect(connectArgs('other', m.url), dir);
    assert.equal(names(r)[0], 'device_code', r.stderr);
    assert.ok(!sentKey(m, CFG_KEY), 'the configured key never reached the server');
  } finally { await m.close(); }
});

test('a named workspace this machine already holds a credential for uses it, with no device approval (CREW-3912)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'], workspaces: ['ws', 'other'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    writeRouteConfig(dir, `    apiKey: "${CFG_KEY}"\n`);
    writeFileSync(join(dir, 'fake-store.json'), sessionJson('held-key'));
    const r = await runConnect(connectArgs('other', m.url), dir, undefined, 'accepts');
    assert.ok(!names(r).includes('device_code'), r.stderr);
    assert.ok(sentKey(m, 'held-key'), 'the held credential was used');
    assert.ok(!sentKey(m, CFG_KEY));
  } finally { await m.close(); }
});

for (const [label, keyLines, store, env, expected] of [
  ['inline', `    apiKey: "${CFG_KEY}"\n`, 'refuses', {}, new RegExp(`apiKey: "${CFG_KEY}"`)],
  ['key file', '    apiKeyFile: "KEYFILE"\n    apiKeyVar: MY_VAR\n', 'refuses', {}, /apiKeyFile: "[^"]*sibling\.env"\n\s+apiKeyVar: MY_VAR/],
  ['environment', '', 'refuses', { CREW_API_KEY: CFG_KEY }, null],
  ['keychain', '', 'accepts', {}, null],
] as const) {
  test(`another project in a routed workspace reuses the sibling's ${label} key and names it the same way (CREW-3912)`, { timeout: 60000 }, async () => {
    const m = await mockTracker({ projects: ['issues', 'other'] });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
      const keyFile = join(dir, 'sibling.env');
      writeFileSync(keyFile, `MY_VAR=${CFG_KEY}\n`);
      writeRouteConfig(dir, keyLines.replace('KEYFILE', keyFile), m.url);
      if (store === 'accepts') writeFileSync(join(dir, 'fake-store.json'), sessionJson(CFG_KEY));
      const r = await runConnect(connectArgs('ws/other', m.url), dir, undefined, store, env);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!names(r).includes('device_code'));
      assert.ok(sentKey(m, CFG_KEY), 'the sibling key was used');
      const block = r.stderr.slice(r.stderr.indexOf('- route: ws/other'));
      assert.match(block, /- route: ws\/other/);
      if (expected) assert.match(block, expected);
      else assert.doesNotMatch(block, /apiKey/);
    } finally { await m.close(); }
  });
}

test('a --base-url no configured route uses never receives a configured key (CREW-3912)', { timeout: 60000 }, async () => {
  const m = await mockTracker({ projects: ['issues'] });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
    writeRouteConfig(dir, `    apiKey: "${CFG_KEY}"\n`, 'http://127.0.0.1:9');
    const r = await runConnect(connectArgs('ws', m.url), dir);
    assert.equal(names(r)[0], 'device_code', r.stderr);
    assert.ok(!sentKey(m, CFG_KEY));
  } finally { await m.close(); }
});

test('--key and CREW_CONNECT_KEY still win over a configured route key (CREW-3912)', { timeout: 60000 }, async () => {
  for (const viaEnv of [false, true]) {
    const m = await mockTracker({ projects: ['issues', 'other'] });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'crew-json-'));
      writeRouteConfig(dir, `    apiKey: "${CFG_KEY}"\n`, m.url);
      const r = await runConnect(connectArgs('ws/other', m.url, viaEnv ? [] : ['--key', 'given-key']), dir, undefined, 'refuses', viaEnv ? { CREW_CONNECT_KEY: 'given-key' } : {});
      assert.ok(!names(r).includes('device_code'), r.stderr);
      assert.ok(sentKey(m, 'given-key'));
      assert.ok(!sentKey(m, CFG_KEY));
    } finally { await m.close(); }
  }
});
