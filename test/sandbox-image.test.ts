import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepoConfig, RepoConfigError } from '../src/repo-config.ts';
import {
  planSandbox, buildSandboxImage, sandboxBuildTick, readSandboxState, sandboxImageFor, sandboxImageStatus,
  sandboxFailedKey, type BuildDeps, type TickDeps,
} from '../src/sandbox-image.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';

const cfg = (extra: string) => parseRepoConfig(`version: 1\nrelease:\n  mode: integrate\n${extra}`, '.crew.yaml');

test('sandbox section parses packages and setup', () => {
  const c = cfg('sandbox:\n  packages: [postgresql-16, git]\n  setup:\n    - npm install -g pnpm\n');
  assert.deepEqual(c.sandbox, { packages: ['postgresql-16', 'git'], setup: ['npm install -g pnpm'] });
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
