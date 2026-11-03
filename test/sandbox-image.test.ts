import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepoConfig, RepoConfigError } from '../src/repo-config.ts';
import {
  planSandbox, readWarmFiles, buildSandboxImage, sandboxBuildTick, readSandboxState, sandboxImageFor, sandboxImageStatus,
  sandboxFailedKey, shipSandboxRef, sandboxImageForRun, SHIP_SANDBOX_KEY, SANDBOX_BASE_IMAGE, SANDBOX_CLAUDE_VERSION, SANDBOX_CLAUDE_SHA256, claudeInstallCommand, APT_HTTPS_COMMAND, readHostCaBundle, type BuildDeps, type TickDeps,
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

test('a serena declaration adds the pinned bridge to the crew layer and indexes the warm tree; without it the crew layer is unchanged', () => {
  const plain = planSandbox('r', { packages: [], setup: ['true'], warm: ['a.ts'] }, { 'a.ts': 'x' });
  const intel = planSandbox('r', { packages: [], setup: ['true'], warm: ['a.ts'], intel: 'serena' }, { 'a.ts': 'x' });
  assert.equal(plain.layers[1]!.dockerfile, planSandbox('r', { packages: [], setup: [] }).layers[1]!.dockerfile);
  assert.doesNotMatch(plain.layers[1]!.dockerfile, /serena/);
  assert.doesNotMatch(plain.layers[2]!.dockerfile, /serena/);
  assert.notEqual(intel.layers[1]!.tag, plain.layers[1]!.tag);
  assert.match(intel.layers[1]!.dockerfile, /uv==\d+\.\d+\.\d+/);
  assert.match(intel.layers[1]!.dockerfile, /serena-agent==\d+\.\d+\.\d+/);
  assert.match(intel.layers[1]!.dockerfile, /CREW_SERENA_LANGUAGE_SERVERS=\/opt\/crew\/serena\/language_servers/);
  assert.match(intel.layers[2]!.dockerfile, /serena project index \/tmp\/crew-warm/);
  // Serena generates its own default config; a hand-written partial one fails indexing (no `projects` key).
  assert.doesNotMatch(intel.layers[2]!.dockerfile, /serena_config\.yml/);
  // The Python and TypeScript language servers run on node.
  assert.match(intel.layers[1]!.dockerfile, /apt-get install[^\n]* nodejs/);
  const repo = intel.layers[2]!.dockerfile;
  assert.ok(repo.indexOf('serena project index') < repo.indexOf('rm -rf /tmp/crew-warm'));
  // No warm tree, nothing to index.
  assert.doesNotMatch(planSandbox('r', { packages: [], setup: [], intel: 'serena' }).layers[2]!.dockerfile, /project index/);
});

test('CREW-2956: the ship plans its own crew-layer image; a declaring repository builds on the same crew layer, neither is the bare base', () => {
  const ship = shipSandboxRef();
  const shipPlan = planSandbox(ship.name, ship.decl);
  const declared = planSandbox('synthesis', { packages: ['git'], setup: ['echo a'] });
  assert.notEqual(shipPlan.tag, declared.tag);
  for (const p of [shipPlan, declared]) assert.ok(!p.tag.includes(SANDBOX_BASE_IMAGE) && p.tag.startsWith('crew-sandbox/'));
  assert.equal(shipPlan.layers[1]!.name, 'crew');
  assert.equal(shipPlan.layers[1]!.tag, declared.layers[1]!.tag, 'one shared crew layer');
  assert.match(shipPlan.layers[1]!.dockerfile, /git/);
  assert.match(shipPlan.layers[1]!.dockerfile, /\/opt\/crew\/bin\/claude|claude/);
});

test('CREW-2956: a run uses the repository layer when it declares and has built one, else the ship layer', () => {
  const built = (tag: string) => ({ tags: [{ tag, builtAt: 'x' }] });
  const state = { [SHIP_SANDBOX_KEY]: built('ship:1'), synthesis: built('repo:1') };
  assert.equal(sandboxImageForRun(state, 'synthesis', true), 'repo:1');
  assert.equal(sandboxImageForRun(state, 'synthesis', false), 'ship:1', 'a removed declaration falls back to the ship layer');
  assert.equal(sandboxImageForRun(state, 'crew', false), 'ship:1');
  assert.equal(sandboxImageForRun({ [SHIP_SANDBOX_KEY]: built('ship:1') }, 'synthesis', true), 'ship:1', 'declared but not built yet');
  assert.equal(sandboxImageForRun({}, 'crew', false), null);
});

test('apt sources are rewritten to https before the first apt-get update, so a 443-only host builds', () => {
  const plan = planSandbox('r', { packages: ['jq'], setup: [] });
  const crew = plan.layers[1]!.dockerfile;
  assert.ok(crew.includes(JSON.stringify(APT_HTTPS_COMMAND).slice(1, -1)));
  assert.ok(crew.indexOf('ubuntu.sources') < crew.indexOf('apt-get update'));
  const repo = plan.layers[2]!.dockerfile;
  assert.ok(repo.indexOf('ubuntu.sources') < repo.indexOf('apt-get update'));
  // Nothing the layers download is plain http.
  assert.doesNotMatch(crew.replace(/sed -i[^\n]*/, ''), /http:\/\//);
});

test('the apt https rewrite leaves no http:// in the amd64 or arm64 ubuntu.sources', () => {
  const expr = /sed -i -E '([^']*)'/.exec(APT_HTTPS_COMMAND)![1]!;
  const samples = [
    'URIs: http://archive.ubuntu.com/ubuntu/\nURIs: http://security.ubuntu.com/ubuntu/\n',
    'URIs: http://ports.ubuntu.com/ubuntu-ports/\nURIs: http://us-east-1.ec2.archive.ubuntu.com/ubuntu/\n',
  ];
  for (const sample of samples) {
    const out = execFileSync('sed', ['-E', expr], { input: sample }).toString();
    assert.doesNotMatch(out, /http:\/\//);
    assert.match(out, /^URIs: https:\/\/[a-z0-9.-]+\.ubuntu\.com\//m);
  }
});

test('the crew layer seeds a trust store before its first https apt-get update (CREW-2995)', () => {
  const crew = planSandbox('r', { packages: [], setup: [] }).layers[1]!;
  assert.ok(crew.dockerfile.includes('COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt'));
  assert.ok(crew.dockerfile.indexOf('COPY ca-certificates.crt') < crew.dockerfile.indexOf('ubuntu.sources'));
  assert.ok(crew.dockerfile.indexOf('COPY ca-certificates.crt') < crew.dockerfile.indexOf('apt-get update'));
  assert.equal(crew.caBundleFile, 'ca-certificates.crt');
  assert.equal(crew.files['ca-certificates.crt'], undefined, 'the host bundle stays out of the tag hash');
});

test('a build writes the host CA bundle into the crew layer context only', async () => {
  const h = harness();
  const seen: Record<string, string | null> = {};
  const inner = h.deps.run;
  h.deps.caBundle = () => 'PEM-BUNDLE';
  h.deps.run = async (args, log) => {
    const ctxFile = join(args[args.indexOf('--file') + 1]!, '..', 'ca-certificates.crt');
    seen[args[args.indexOf('--tag') + 1]!.split(':')[0]!] = existsSync(ctxFile) ? readFileSync(ctxFile, 'utf8') : null;
    return inner(args, log);
  };
  await buildSandboxImage(planSandbox('r', { packages: [], setup: [] }), h.deps);
  assert.equal(seen['crew-sandbox-crew'], 'PEM-BUNDLE');
  assert.equal(seen['crew-sandbox-base'], null);
});

test('readHostCaBundle takes the first readable location and is empty when none is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-'));
  writeFileSync(join(dir, 'b.crt'), 'PEM');
  assert.equal(readHostCaBundle([join(dir, 'missing'), join(dir, 'b.crt')]), 'PEM');
  assert.equal(readHostCaBundle([join(dir, 'missing')]), '');
});
