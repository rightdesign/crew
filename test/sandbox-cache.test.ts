import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  SandboxCache, parseRemote, mirrorRelPath, cloneScript, cacheSettingsOf, makeCachePass, sandboxCacheKey,
  CACHE_REFRESH_INTERVAL_MS, OPENSHELL_ATTACHABLE_LABEL, type CacheExec, type CacheSettings,
} from '../src/sandbox-cache.ts';
import { parseShipSandbox } from '../src/config.ts';

const SETTINGS: CacheSettings = { engine: 'docker', volume: 'crew-cache', workspace: 'ws', helperImage: 'alpine/git', depsLockfile: 'pnpm-lock.yaml' };
const REPO = { host: 'forge.test', path: 'acme/widgets' };

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/**
 * A stand-in for the container engine: `volume` verbs are recorded, and a
 * `run` executes the helper script on the host with `/cache` swapped for a
 * temp directory and the forge URL redirected to a local repository.
 */
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'crew-sbcache-'));
  const volume = join(root, 'volume');
  mkdirSync(volume);
  const remote = join(root, 'remote', 'acme', 'widgets.git');
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const work = join(root, 'work');
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' });
  const commit = (msg: string) => {
    execFileSync('git', ['-C', work, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg]);
    execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore' });
  };
  commit('one');
  const calls: string[][] = [];
  let volumeExists = false;
  const failRun = new Set<string>();
  const exec: CacheExec = async (_bin, args, o) => {
    calls.push(args);
    if (args[0] === 'volume') {
      if (args[1] === 'inspect' && !volumeExists) throw new Error('no such volume');
      if (args[1] === 'create') volumeExists = true;
      if (args[1] === 'rm') volumeExists = false;
      return { stdout: '', stderr: '' };
    }
    const i = args.indexOf('-c');
    const script = args[i + 1]!.replaceAll('/cache', volume);
    const rest = args.slice(i + 2);
    if (rest.some((a) => failRun.has(a))) throw Object.assign(new Error('boom'), { stderr: 'fatal: could not read from remote' });
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const out = execFileSync('sh', ['-c', script, ...rest], {
      encoding: 'utf8',
      env: {
        ...o?.env, PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${join(root, 'remote')}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://forge.test/',
      },
    });
    return { stdout: out, stderr: '' };
  };
  return { root, volume, remote, commit, calls, exec, failRun, cache: new SandboxCache(SETTINGS, exec), mirror: join(volume, mirrorRelPath(REPO)) };
}

test('parseRemote reads https, ssh:// and scp-style origins; mirrors are keyed by host and path', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/widgets.git'), { host: 'github.com', path: 'acme/widgets' });
  assert.deepEqual(parseRemote('https://user@GitHub.com/acme/widgets.git'), { host: 'github.com', path: 'acme/widgets' });
  assert.deepEqual(parseRemote('ssh://git@git.example.org:2222/grp/sub/repo'), { host: 'git.example.org', path: 'grp/sub/repo' });
  assert.equal(parseRemote('/local/path'), null);
  assert.equal(mirrorRelPath({ host: 'github.com', path: 'acme/widgets' }), 'mirrors/github.com/acme/widgets.git');
});

test('the volume is created once, with the OpenShell attachable labels and crew ownership labels', async () => {
  const r = rig();
  await r.cache.ensureVolume();
  await r.cache.ensureVolume();
  const creates = r.calls.filter((a) => a[0] === 'volume' && a[1] === 'create');
  assert.equal(creates.length, 1);
  const flat = creates[0]!.join(' ');
  assert.ok(flat.includes(OPENSHELL_ATTACHABLE_LABEL));
  assert.ok(flat.includes('openshell.ai/sandbox-attachable-workspace=ws'));
  assert.ok(flat.includes('crew.kind=cache'));
});

test('a refresh mirrors a new repository, then fetches what the forge gained, and a --shared clone works from it', async () => {
  const r = rig();
  const [first] = await r.cache.refresh([{ ...REPO, token: 'tok-secret' }]);
  assert.equal(first!.ok, true, first!.detail);
  assert.ok(existsSync(join(r.mirror, 'crew-last-refresh')));
  assert.equal(sh(r.mirror, 'log', '-1', '--format=%s', 'main'), 'one');

  r.commit('two');
  await r.cache.refresh([REPO]);
  assert.equal(sh(r.mirror, 'log', '-1', '--format=%s', 'main'), 'two');

  const clone = join(r.root, 'run');
  execFileSync('sh', ['-c', cloneScript({
    mirrorDir: r.volume, repo: REPO, workDir: clone, origin: 'git@forge.test:acme/widgets.git', branch: 'crew-run-1', lockfile: 'pnpm-lock.yaml',
  })]);
  assert.equal(sh(clone, 'log', '-1', '--format=%s'), 'two');
  assert.equal(sh(clone, 'remote', 'get-url', 'origin'), 'git@forge.test:acme/widgets.git');
  assert.equal(sh(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'crew-run-1');
  assert.ok(readFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), 'utf8').includes(r.mirror), 'the mirror is an alternate');

  for (const a of r.calls) assert.ok(!a.join(' ').includes('tok-secret'), 'the token never reaches argv');
});

test('a clone made before a refresh stays whole when the refresh moves and deletes refs', async () => {
  const r = rig();
  await r.cache.refresh([REPO]);
  const clone = join(r.root, 'run');
  execFileSync('sh', ['-c', cloneScript({ mirrorDir: r.volume, repo: REPO, workDir: clone, origin: 'o', branch: 'b', lockfile: 'x' })]);
  const before = sh(clone, 'rev-parse', 'HEAD');
  // The forge rewrites main to an unrelated commit; the old objects must survive in the mirror.
  execFileSync('git', ['-C', r.root + '/work', 'checkout', '-q', '--orphan', 'other']);
  execFileSync('git', ['-C', r.root + '/work', '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'rewritten']);
  execFileSync('git', ['-C', r.root + '/work', 'push', '-q', '-f', 'origin', 'HEAD:main'], { stdio: 'ignore' });
  await r.cache.refresh([REPO]);
  assert.equal(sh(clone, 'rev-parse', 'HEAD'), before);
  execFileSync('git', ['-C', clone, 'fsck', '--connectivity-only'], { stdio: 'ignore' });
});

test('one repository failing does not stop the next, and the failure is reported', async () => {
  const r = rig();
  const bad = { host: 'forge.test', path: 'acme/bad' };
  r.failRun.add(mirrorRelPath(bad));
  const out = await r.cache.refresh([bad, REPO]);
  assert.deepEqual(out.map((o) => o.ok), [false, true]);
  assert.match(out[0]!.detail!, /could not read from remote/);
});

test('list reports the last refresh, prune drops unserved mirrors, reset recreates the volume', async () => {
  const r = rig();
  const other = { host: 'forge.test', path: 'acme/widgets' };
  await r.cache.refresh([other]);
  const listed = await r.cache.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]!.repo, REPO);
  assert.match(listed[0]!.lastRefresh!, /^\d{4}-\d\d-\d\dT/);

  assert.deepEqual(await r.cache.prune([REPO]), []);
  const dropped = await r.cache.prune([]);
  assert.deepEqual(dropped, [REPO]);
  assert.ok(!existsSync(r.mirror));

  await r.cache.reset();
  const verbs = r.calls.filter((a) => a[0] === 'volume').map((a) => a[1]);
  assert.deepEqual(verbs.slice(-3), ['rm', 'inspect', 'create']);
});

test('the pass refreshes under the checkout lock, throttles, raises on failure and clears on success', async () => {
  const r = rig();
  let t = 1_000_000;
  const events: string[] = [];
  const bad = { host: 'forge.test', path: 'acme/bad' };
  r.failRun.add(mirrorRelPath(bad));
  const pass = makeCachePass({
    cache: r.cache, volume: 'crew-cache', now: () => t,
    repos: () => [{ ...bad, dir: '/d/bad' }, { ...REPO, dir: '/d/widgets' }],
    lock: (dir) => { events.push(`lock ${dir}`); return () => events.push(`unlock ${dir}`); },
    fail: (key, msg) => { events.push(`fail ${key}`); assert.match(msg, /previous mirror/); },
    ok: (key) => events.push(`ok ${key}`),
  });
  await pass();
  assert.deepEqual(events, [
    'lock /d/bad', 'unlock /d/bad', 'lock /d/widgets', 'unlock /d/widgets',
    `fail ${sandboxCacheKey('crew-cache', bad)}`, `ok ${sandboxCacheKey('crew-cache', REPO)}`,
  ]);
  events.length = 0;
  t += CACHE_REFRESH_INTERVAL_MS - 1;
  assert.deepEqual(await pass(), [], 'inside the interval nothing runs');
  assert.deepEqual(events, []);
  t += 2;
  assert.equal((await pass()).length, 2);
});

test('ship.sandbox accepts the cache keys and cacheSettingsOf is null without a volume', () => {
  assert.equal(cacheSettingsOf({}), null);
  const parsed = parseShipSandbox({ cacheVolume: 'v', engine: 'podman', depsCommand: 'pnpm install --frozen-lockfile', image: 'img' });
  const s = cacheSettingsOf(parsed)!;
  assert.equal(s.engine, 'podman');
  assert.equal(s.depsImage, 'img');
  assert.equal(s.helperImage, 'alpine/git:latest');
});

const hasSha = (() => { try { execFileSync('sha256sum', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a dependency tree is built once per lockfile hash and copied into the run checkout', { skip: !hasSha }, async () => {
  const r = rig();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(r.root, 'work', 'pnpm-lock.yaml'), 'lock v1\n');
  execFileSync('git', ['-C', r.root + '/work', 'add', '.']);
  r.commit('lock');
  const cache = new SandboxCache({ ...SETTINGS, depsImage: 'toolchain', depsCommand: 'mkdir -p apps/a/node_modules/x && echo hi > apps/a/node_modules/x/f' }, r.exec);
  const [out] = await cache.refresh([REPO]);
  assert.equal(out!.ok, true, out!.detail);
  const trees = join(r.volume, 'cache/deps/forge.test/acme/widgets');
  const hashes = execFileSync('ls', [trees], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(hashes.length, 1);
  await cache.refresh([REPO]);
  assert.equal(r.calls.filter((a) => a.includes('toolchain')).length, 2, 'the builder runs per pass but finds the tree and does nothing');
  assert.equal(execFileSync('ls', [trees], { encoding: 'utf8' }).trim().split('\n').length, 1);

  const clone = join(r.root, 'run');
  execFileSync('sh', ['-c', cloneScript({ mirrorDir: r.volume, repo: REPO, workDir: clone, origin: 'o', branch: 'b', lockfile: 'pnpm-lock.yaml' })]);
  assert.equal(readFileSync(join(clone, 'apps/a/node_modules/x/f'), 'utf8').trim(), 'hi');
});
