import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  SandboxCache, parseRemote, mirrorRelPath, intelRelDir, cloneScript, describe as describeExec, cacheSettingsOf, makeCachePass, sandboxCacheKey, unmirroredRepos,
  CACHE_REFRESH_INTERVAL_MS, OPENSHELL_ATTACHABLE_LABEL, SANDBOX_WORKSPACE, type CacheExec, type CacheSettings,
} from '../src/sandbox-cache.ts';
import { parseShipSandbox } from '../src/config.ts';

// cloneScript writes `safe.directory` to the global git config; keep that off the developer's real one.
process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'crew-gitcfg-')), 'gitconfig');

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
    const outMount = args.find((x, j) => args[j - 1] === '-v' && x.endsWith(':/out'));
    let script = args[i + 1]!.replaceAll('/cache', volume);
    if (outMount) script = script.replaceAll('/out', outMount.slice(0, -':/out'.length));
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
    fail: (key, msg, at) => { events.push(`fail ${key}`); assert.match(msg, /previous mirror/); assert.equal(at, new Date(t).toISOString()); },
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

test('materialize writes the base tip in place, skips an unchanged tip and removes files the tip dropped', async () => {
  const r = rig();
  const addFile = (name: string, body: string) => {
    mkdirSync(join(r.root, 'work', name.includes('/') ? name.split('/')[0]! : '.'), { recursive: true });
    writeFileSync(join(r.root, 'work', name), body);
    execFileSync('git', ['-C', r.root + '/work', 'add', '-A']);
  };
  addFile('a.txt', 'one');
  addFile('dir/b.txt', 'bee');
  execFileSync('git', ['-C', r.root + '/work', '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'files']);
  execFileSync('git', ['-C', r.root + '/work', 'push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore' });
  await r.cache.refresh([REPO]);

  const parent = join(r.root, 'area', 'ws');
  mkdirSync(parent, { recursive: true });
  const first = await r.cache.materialize(REPO, 'main', parent, 'widgets');
  assert.equal(first.changed, true);
  assert.equal(first.tip, sh(r.mirror, 'rev-parse', 'main'));
  assert.equal(readFileSync(join(parent, 'widgets', 'dir', 'b.txt'), 'utf8'), 'bee');
  assert.ok(!existsSync(join(parent, 'widgets', '.git')), 'a read-only tree, not a clone');
  const inode = statSync(join(parent, 'widgets')).ino;

  assert.equal((await r.cache.materialize(REPO, 'main', parent, 'widgets')).changed, false);

  writeFileSync(join(r.root, 'work', 'a.txt'), 'uno');
  execFileSync('git', ['-C', r.root + '/work', 'rm', '-q', 'dir/b.txt']);
  execFileSync('git', ['-C', r.root + '/work', 'add', '-A']);
  execFileSync('git', ['-C', r.root + '/work', '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'edit']);
  execFileSync('git', ['-C', r.root + '/work', 'push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore' });
  await r.cache.refresh([REPO]);
  const second = await r.cache.materialize(REPO, 'main', parent, 'widgets');
  assert.equal(second.changed, true);
  assert.equal(readFileSync(join(parent, 'widgets', 'a.txt'), 'utf8'), 'uno');
  assert.ok(!existsSync(join(parent, 'widgets', 'dir', 'b.txt')), 'the dropped file is gone');
  assert.equal(statSync(join(parent, 'widgets')).ino, inode, 'the directory a container mounts is never swapped');
});

test('materialize fails clearly when the mirror lacks the base branch', async () => {
  const r = rig();
  await r.cache.refresh([REPO]);
  await assert.rejects(r.cache.materialize(REPO, 'nope', join(r.root, 'area'), 'widgets'), /no branch nope/);
});

/** A `serena` on PATH that records each index and writes one cache file per tracked file; its config names the project folder. */
function fakeSerena(root: string): { calls: string; restore: () => void } {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(root, 'serena-calls');
  writeFileSync(join(bin, 'serena'), `#!/bin/sh
echo "$@" >> ${calls}
folder=$(sed -n 's/^project_serena_folder_location: "\\(.*\\)"$/\\1/p' "$SERENA_HOME/serena_config.yml")
mkdir -p "$folder/cache" && git -C "$3" ls-files > "$folder/cache/files.txt"
`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  return { calls, restore: () => { process.env.PATH = prev; } };
}

test('a repository with an intel image gets its default-branch index on the volume, re-indexed only when the tip moves', async () => {
  const r = rig();
  const fake = fakeSerena(r.root);
  try {
    const repo = { ...REPO, intelImage: 'crew-sandbox:widgets' };
    const [first] = await r.cache.refresh([repo]);
    assert.equal(first!.ok, true, first!.detail);
    const dir = join(r.volume, intelRelDir(REPO));
    const tip = sh(r.mirror, 'rev-parse', 'HEAD');
    assert.equal(readFileSync(join(dir, 'indexed-commit'), 'utf8').trim(), tip);
    assert.ok(existsSync(join(dir, 'cache', 'files.txt')));
    assert.equal(readFileSync(fake.calls, 'utf8').trim().split('\n').length, 1);

    await r.cache.refresh([repo]);
    assert.equal(readFileSync(fake.calls, 'utf8').trim().split('\n').length, 1, 'same tip: no second index');

    r.commit('two');
    await r.cache.refresh([repo]);
    assert.equal(readFileSync(fake.calls, 'utf8').trim().split('\n').length, 2);
    assert.equal(readFileSync(join(dir, 'indexed-commit'), 'utf8').trim(), sh(r.mirror, 'rev-parse', 'HEAD'));

    const [row] = await r.cache.list();
    assert.equal(row!.intel?.commit, sh(r.mirror, 'rev-parse', 'HEAD'));
    await r.cache.prune([]);
    assert.ok(!existsSync(dir), 'pruning the mirror removes its index');
  } finally { fake.restore(); }
});

test('a repository without an intel image has no index on the volume', async () => {
  const r = rig();
  await r.cache.refresh([REPO]);
  assert.ok(!existsSync(join(r.volume, 'intel')));
  assert.equal((await r.cache.list())[0]!.intel, undefined);
});

test('a failing index reports it, keeps the previous index and leaves the mirror current', async () => {
  const r = rig();
  const fake = fakeSerena(r.root);
  try {
    const repo = { ...REPO, intelImage: 'img' };
    await r.cache.refresh([repo]);
    const before = readFileSync(join(r.volume, intelRelDir(REPO), 'indexed-commit'), 'utf8');
    writeFileSync(join(r.root, 'bin', 'serena'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    r.commit('three');
    const [out] = await r.cache.refresh([repo]);
    assert.equal(out!.ok, false);
    assert.match(out!.detail!, /^intel index:/);
    assert.equal(readFileSync(join(r.volume, intelRelDir(REPO), 'indexed-commit'), 'utf8'), before);
    assert.equal(sh(r.mirror, 'rev-parse', 'HEAD'), sh(r.root + '/work', 'rev-parse', 'HEAD'));
  } finally { fake.restore(); }
});

test('unmirroredRepos lists served repositories missing from the volume, once each (CREW-2961)', () => {
  const other = { host: 'forge.test', path: 'acme/other' };
  const mirrors = [{ repo: REPO, lastRefresh: 'x' }];
  assert.deepEqual(unmirroredRepos([REPO, other, other], mirrors), ['forge.test/acme/other']);
  assert.deepEqual(unmirroredRepos([REPO], mirrors), []);
});

test('a refresh with no token names the missing token rather than git\'s prompt error (CREW-2961)', async () => {
  const r = rig();
  r.failRun.add(mirrorRelPath(REPO));
  const [out] = await r.cache.refresh([{ ...REPO, token: null }]);
  assert.equal(out!.ok, false);
  assert.match(out!.detail ?? '', /no readable forge token for forge\.test/);
  const [withTok] = await r.cache.refresh([{ ...REPO, token: 't' }]);
  assert.doesNotMatch(withTok!.detail ?? '', /no readable forge token/);
});

test('CREW-2966: the cache volume workspace defaults to the workspace sandboxes are created in', () => {
  assert.equal(cacheSettingsOf({ cacheVolume: 'crew-cache' } as never)?.workspace, 'default');
  assert.equal(SANDBOX_WORKSPACE, 'default');
});

test('CREW-2966: volumeWorkspace reads the label, and is null for an absent volume or label', async () => {
  const answer = (out: string | Error): CacheExec => async () => { if (out instanceof Error) throw out; return { stdout: out, stderr: '' }; };
  assert.equal(await new SandboxCache(SETTINGS, answer('crew\n')).volumeWorkspace(), 'crew');
  assert.equal(await new SandboxCache(SETTINGS, answer('<no value>\n')).volumeWorkspace(), null);
  assert.equal(await new SandboxCache(SETTINGS, answer('\n')).volumeWorkspace(), null);
  assert.equal(await new SandboxCache(SETTINGS, answer(new Error('no such volume'))).volumeWorkspace(), null);
});

test('the clone script reads a mirror git considers owned by someone else (root-written volume)', async () => {
  const r = rig();
  await r.cache.refresh([REPO]);
  const clone = join(r.root, 'run');
  const script = cloneScript({ mirrorDir: r.volume, repo: REPO, workDir: clone, origin: 'o', branch: 'b', lockfile: 'x' });
  // git's test hook for "the repository belongs to another user"; HOME is a fresh dir so only the script's own config counts.
  const home = join(r.root, 'clone-home');
  mkdirSync(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  execFileSync('sh', ['-c', script], { env, stdio: 'ignore' });
  assert.equal(sh(clone, 'log', '-1', '--format=%s'), 'one');
});

test('describe keeps git\'s first fatal line when the tail is only boilerplate', () => {
  const stderr = 'fatal: detected dubious ownership in repository at \'/m\'\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.';
  const out = describeExec({ stderr });
  assert.ok(out.startsWith('fatal: detected dubious ownership'), out);
  assert.ok(out.endsWith('and the repository exists.'));
  assert.equal(describeExec({ stderr: 'a\nb' }), 'a / b');
});
