import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepoConfig, RepoConfigError } from '../src/repo-config.ts';
import {
  planSandbox, readWarmFiles, buildSandboxImage, sandboxBuildTick, readSandboxState, sandboxImageFor, sandboxImageStatus,
  sandboxFailedKey, SANDBOX_CLAUDE_VERSION, SANDBOX_CLAUDE_SHA256, claudeInstallCommand, type BuildDeps, type TickDeps,
} from '../src/sandbox-image.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';

const cfg = (extra: string) => parseRepoConfig(`version: 1\nrelease:\n  mode: integrate\n${extra}`, '.crew.yaml');

test('sandbox section parses packages and setup', () => {
  const c = cfg('sandbox:\n  packages: [postgresql-16, git]\n  setup:\n    - npm install -g pnpm\n');
  assert.deepEqual(c.sandbox, { packages: ['postgresql-16', 'git'], setup: ['npm install -g pnpm'], warm: [] });
  assert.equal(cfg('').sandbox, undefined);
});

test('sandbox section rejects unknown keys, bad packages and image plus packages', () => {
  assert.throws(() => cfg('sandbox:\n  bogus: 1\n'), RepoConfigError);
  assert.throws(() => cfg('sandbox:\n  packages: ["git; rm -rf /"]\n'), /not a package name/);
  assert.throws(() => cfg('sandbox:\n  image: x:1\n  packages: [git]\n'), /alternatives/);
  assert.equal(cfg('sandbox:\n  image: ghcr.io/o/r:1\n  setup: [make]\n').sandbox?.image, 'ghcr.io/o/r:1');
});

test('tags are stable for one declaration and change with it', () => {
  const a = planSandbox('synthesis', { packages: ['git'], setup: ['echo a'] });
  assert.equal(a.tag, planSandbox('synthesis', { packages: ['git'], setup: ['echo a'] }).tag);
  const b = planSandbox('synthesis', { packages: ['git'], setup: ['echo b'] });
  assert.notEqual(a.tag, b.tag);
  // Only the repo layer moves; base and crew layers are shared.
  assert.equal(a.layers[0]!.tag, b.layers[0]!.tag);
  assert.equal(a.layers[1]!.tag, b.layers[1]!.tag);
  assert.match(a.layers[2]!.dockerfile, /RUN \["\/bin\/bash", "-c", "set -euo pipefail; echo a"\]/);
  assert.match(a.layers[1]!.dockerfile, /XDG_CACHE_HOME=\/opt\/crew\/cache/);
});

function harness(failTag?: string) {
  const stateDir = mkdtempSync(join(tmpdir(), 'sbx-'));
  const present = new Set<string>();
  const builds: string[] = [];
  const removed: string[] = [];
  const attention: ShipAttentionItem[] = [];
  const cleared: string[] = [];
  const deps: TickDeps & BuildDeps = {
    stateDir,
    run: async (args) => {
      const tag = args[args.indexOf('--tag') + 1]!;
      assert.ok(existsSync(args[args.indexOf('--file') + 1]!), 'Dockerfile written before the build');
      builds.push(tag);
      if (tag === failTag) return 1;
      present.add(tag);
      return 0;
    },
    hasImage: (t) => present.has(t),
    removeImage: (t) => { removed.push(t); present.delete(t); },
    raise: (i) => attention.push(i),
    clear: (k) => cleared.push(k),
    log: () => {},
  };
  return { stateDir, deps, builds, removed, attention, cleared, present };
}

test('first build makes three layers; the same declaration is then reused', async () => {
  const h = harness();
  const plan = planSandbox('r', { packages: [], setup: ['true'] });
  const out = await buildSandboxImage(plan, h.deps);
  assert.equal(out.kind, 'built');
  assert.equal(h.builds.length, 3);
  assert.equal(sandboxImageFor(readSandboxState(h.stateDir), 'r'), plan.tag);
  assert.equal((await buildSandboxImage(plan, h.deps)).kind, 'reused');
  assert.equal(h.builds.length, 3);
});

test('a changed repo declaration rebuilds only the repo layer and prunes beyond two tags', async () => {
  const h = harness();
  for (const step of ['one', 'two', 'three']) {
    await buildSandboxImage(planSandbox('r', { packages: [], setup: [step] }), h.deps);
  }
  assert.equal(h.builds.length, 3 + 1 + 1);
  const st = readSandboxState(h.stateDir).r!;
  assert.equal(st.tags.length, 2);
  assert.equal(h.removed.length, 1);
});

test('a failed build keeps the previous tag, records the log and raises attention', async () => {
  const good = planSandbox('r', { packages: [], setup: ['ok'] });
  const bad = planSandbox('r', { packages: [], setup: ['boom'] });
  const h = harness(bad.tag);
  await sandboxBuildTick([{ name: 'r', decl: { packages: [], setup: ['ok'] } }], h.deps);
  assert.equal(await sandboxBuildTick([{ name: 'r', decl: { packages: [], setup: ['boom'] } }], h.deps), 'r');
  const state = readSandboxState(h.stateDir);
  assert.equal(sandboxImageFor(state, 'r'), good.tag);
  assert.equal(state.r!.failure?.tag, bad.tag);
  assert.equal(h.attention.length, 1);
  assert.equal(h.attention[0]!.key, sandboxFailedKey('r'));
  assert.ok(h.attention[0]!.message.includes(state.r!.failure!.logPath));
  assert.equal(sandboxImageStatus(state, bad).status, 'failed');
  // Within the retry window the same broken declaration is left alone; a forced build tries again.
  const before = h.builds.length;
  assert.equal(await sandboxBuildTick([{ name: 'r', decl: { packages: [], setup: ['boom'] } }], h.deps), null);
  assert.equal(h.builds.length, before);
  await sandboxBuildTick([{ name: 'r', decl: { packages: [], setup: ['boom'] } }], h.deps, true);
  assert.equal(h.builds.length, before + 1);
});

test('status is missing, then ok, then stale when the declaration moves', async () => {
  const h = harness();
  const p1 = planSandbox('r', { packages: [], setup: ['a'] });
  assert.equal(sandboxImageStatus(readSandboxState(h.stateDir), p1).status, 'missing');
  await buildSandboxImage(p1, h.deps);
  assert.equal(sandboxImageStatus(readSandboxState(h.stateDir), p1).status, 'ok');
  assert.equal(sandboxImageStatus(readSandboxState(h.stateDir), planSandbox('r', { packages: [], setup: ['b'] })).status, 'stale');
});

test('sandbox.warm parses and rejects paths that escape the repo', () => {
  assert.deepEqual(cfg('sandbox:\n  warm: [pnpm-lock.yaml, apps/*/package.json]\n').sandbox?.warm, ['pnpm-lock.yaml', 'apps/*/package.json']);
  assert.throws(() => cfg('sandbox:\n  warm: ["../x"]\n'), /sandbox\.warm/);
  assert.throws(() => cfg('sandbox:\n  warm: ["/etc/passwd"]\n'), /sandbox\.warm/);
});

test('readWarmFiles reads matching files from the committed ref, not the working tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'apps/a'), { recursive: true });
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lock1');
  writeFileSync(join(dir, 'apps/a/package.json'), '{}');
  writeFileSync(join(dir, 'apps/a/other.txt'), 'no');
  git('add', '.'); git('commit', '-q', '-m', 'x');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'dirty');
  const got = readWarmFiles(dir, 'main', ['pnpm-lock.yaml', 'apps/*/package.json', 'missing.yaml']);
  assert.deepEqual(got, { 'pnpm-lock.yaml': 'lock1', 'apps/a/package.json': '{}' });
});

test('warm files are copied into the repo layer, change its tag, and are written nested into the context', async () => {
  const decl = { packages: [], setup: ['pnpm fetch'], warm: ['pnpm-lock.yaml'] };
  const a = planSandbox('r', decl, { 'pnpm-lock.yaml': 'one', 'apps/a/package.json': '{}' });
  const b = planSandbox('r', decl, { 'pnpm-lock.yaml': 'two', 'apps/a/package.json': '{}' });
  assert.notEqual(a.tag, b.tag);
  assert.equal(a.layers[1]!.tag, b.layers[1]!.tag);
  const df = a.layers[2]!.dockerfile;
  assert.match(df, /COPY --chown=1000:1000 warm\/ \/tmp\/crew-warm\//);
  assert.ok(df.indexOf('WORKDIR /tmp/crew-warm') < df.indexOf('pnpm fetch'));
  assert.match(df, /rm -rf \/tmp\/crew-warm/);
  assert.equal(planSandbox('r', decl).layers[2]!.dockerfile.includes('crew-warm'), false);
  const h = harness();
  let seen = '';
  h.deps.run = async (args) => {
    const ctx = args[args.indexOf('--file') + 1]!.replace(/Dockerfile$/, '');
    if (args.includes(a.tag)) seen = readFileSync(join(ctx, 'warm/apps/a/package.json'), 'utf8');
    h.present.add(args[args.indexOf('--tag') + 1]!);
    return 0;
  };
  await buildSandboxImage(a, h.deps);
  assert.equal(seen, '{}');
});

test('the crew layer bakes in the pinned Claude Code, checksum-verified, with the autoupdater off', () => {
  const crew = planSandbox('synthesis', { packages: [], setup: [] }).layers[1]!.dockerfile;
  assert.match(crew, new RegExp(`claude-code-releases/${SANDBOX_CLAUDE_VERSION.replace(/\./g, '\\.')}/`));
  assert.match(crew, /sha256sum -c -/);
  assert.match(crew, /DISABLE_AUTOUPDATER=1/);
  assert.match(crew, new RegExp(`io\\.crew\\.sandbox\\.claude=\"${SANDBOX_CLAUDE_VERSION.replace(/\./g, '\\.')}\"`));
  assert.doesNotMatch(claudeInstallCommand(), /latest/);
  for (const { sha256 } of Object.values(SANDBOX_CLAUDE_SHA256)) assert.match(sha256, /^[0-9a-f]{64}$/);
});

test('changing the Claude pin changes every tag; the version is recorded with the built tag', async () => {
  const plan = planSandbox('synthesis', { packages: [], setup: [] });
  assert.equal(plan.claude, SANDBOX_CLAUDE_VERSION);
  const h = harness();
  await buildSandboxImage(plan, h.deps);
  assert.equal(readSandboxState(h.stateDir).synthesis!.tags[0]!.claude, SANDBOX_CLAUDE_VERSION);
  assert.match(sandboxImageStatus(readSandboxState(h.stateDir), plan).detail, new RegExp(`claude ${SANDBOX_CLAUDE_VERSION}`));
});
