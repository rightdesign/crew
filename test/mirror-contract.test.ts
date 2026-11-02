import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxCache, type CacheExec, type CacheSettings } from '../src/sandbox-cache.ts';
import { cacheRepoOfTarget, firstReport, lacksCheckout, noCheckoutReleaseNote, releasesFromSandbox, readMirrorContract, resetReported } from '../src/mirror-contract.ts';

const settings: CacheSettings = { engine: 'docker', volume: 'v', workspace: 'w', helperImage: 'img', depsLockfile: 'pnpm-lock.yaml' };
const repo = { host: 'github.com', path: 'o/r' };

/** A fake engine whose mirror holds `files` on its default branch. */
function cacheWith(files: Record<string, string>): { cache: SandboxCache; asked: string[] } {
  const asked: string[] = [];
  const exec: CacheExec = async (_bin, args) => {
    const path = args[args.length - 1]!;
    asked.push(path);
    if (path in files) return { stdout: files[path]!, stderr: '' };
    throw Object.assign(new Error('exit 4'), { code: 4 });
  };
  return { cache: new SandboxCache(settings, exec), asked };
}

test('a sandbox ship lacks a checkout only when the directory is absent', () => {
  const here = mkdtempSync(join(tmpdir(), 'mc-'));
  assert.equal(lacksCheckout({ runner: 'sandbox' }, join(here, 'nope')), true);
  assert.equal(lacksCheckout({ runner: 'sandbox' }, here), false);
  assert.equal(lacksCheckout({ runner: 'host' }, join(here, 'nope')), false);
  assert.equal(lacksCheckout({}, join(here, 'nope')), false);
});

test('the contract is read from the mirror, trying each contract filename', async () => {
  const { cache, asked } = cacheWith({ '.crew.yml': 'version: 1\nrelease:\n  mode: integrate\nhooks:\n  test: npm test\n' });
  const cfg = await readMirrorContract(cache, repo, 'main');
  assert.equal(cfg?.release.mode, 'integrate');
  assert.equal(cfg?.hooks.test, 'npm test');
  assert.deepEqual(asked, ['.crew.yaml', '.crew.yml']);
});

test('a mirror with no contract reads as none', async () => {
  const { cache } = cacheWith({});
  assert.equal(await readMirrorContract(cache, repo, 'main'), null);
});

test('the release note names what happens for each mode, and local names the deploy-hook hand-off', () => {
  assert.match(noCheckoutReleaseNote('r', 'local'), /released by the host that owns the deploy hook/);
  assert.match(noCheckoutReleaseNote('r', null), /release\.mode "local"/);
  assert.match(noCheckoutReleaseNote('r', 'external'), /handed off by a ship with a checkout/);
  assert.equal(releasesFromSandbox('integrate'), true);
  assert.equal(releasesFromSandbox('ci_auto'), true);
  assert.equal(releasesFromSandbox('ci_manual'), true);
  assert.equal(releasesFromSandbox('local'), false);
  assert.equal(releasesFromSandbox('external'), false);
  assert.equal(releasesFromSandbox(null), false);
});

test('firstReport is true once per key', () => {
  resetReported();
  assert.equal(firstReport('a'), true);
  assert.equal(firstReport('a'), false);
  assert.equal(firstReport('b'), true);
});

test('a target with no checkout is mirrored from its Repos row remote and forge host', () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'mc-')), 'nope');
  const t = { name: 'r', dir: gone, remote: 'o/r', forgeHost: 'git.example.com' };
  assert.deepEqual(cacheRepoOfTarget({ runner: 'sandbox' }, t, null), { host: 'git.example.com', path: 'o/r' });
  assert.equal(cacheRepoOfTarget({ runner: 'sandbox' }, { name: 'r', dir: gone }, null), null);
});

test('a checkout\'s origin wins, and a host ship with no checkout is not mirrored', () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'mc-')), 'nope');
  const t = { name: 'r', dir: gone, remote: 'o/r' };
  assert.deepEqual(cacheRepoOfTarget({ runner: 'sandbox' }, t, 'git@github.com:a/b.git'), { host: 'github.com', path: 'a/b' });
  assert.equal(cacheRepoOfTarget({ runner: 'host' }, t, null), null);
});
