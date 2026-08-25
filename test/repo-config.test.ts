import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseRepoConfig, loadRepoConfig, findRepoConfig, resolveRepoConfig,
  validateEffective, hookLabel, RepoConfigError, renderBranchName, slugify,
} from '../src/repo-config.ts';

const MIN = 'version: 1\nhooks:\n  test: pnpm test\n  build: pnpm build\n  deploy: ./ship.sh\n';
const dirWith = (name: string, body: string) => {
  const d = mkdtempSync(join(tmpdir(), 'crew-repo-'));
  writeFileSync(join(d, name), body);
  return d;
};

test('a minimal contract parses with documented defaults', () => {
  const c = parseRepoConfig(MIN, '.crew.yaml');
  assert.equal(c.platform, 'any');
  assert.equal(c.release.mode, 'local');
  assert.equal(c.release.changelog, 'CHANGELOG.md');
  assert.deepEqual(c.release.versionFiles, ['package.json']);
});

test('.crew.json is parsed identically to .crew.yaml', () => {
  const y = parseRepoConfig(MIN, '.crew.yaml');
  const j = parseRepoConfig(JSON.stringify({
    version: 1, hooks: { test: 'pnpm test', build: 'pnpm build', deploy: './ship.sh' },
  }), '.crew.json');
  assert.deepEqual({ ...y, file: '' }, { ...j, file: '' });
});

test('an unknown key is an error — a mistyped hook must never silently not run', () => {
  assert.throws(() => parseRepoConfig('version: 1\nhooks:\n  tests: pnpm test\n', 'f'),
    (e: Error) => {
      assert.ok(e instanceof RepoConfigError);
      assert.match(e.message, /unknown hooks key: tests/);
      assert.match(e.message, /allowed: build, bump, deploy, handoff, isolate, merged, ports, pr, released, setup, test, version/);
      return true;
    });
  assert.throws(() => parseRepoConfig('version: 1\nplatfrom: unix\n', 'f'), /unknown top-level key: platfrom/);
});

test('version is required and must be understood', () => {
  assert.throws(() => parseRepoConfig('hooks: {}\n', 'f'), /version is required/);
  assert.throws(() => parseRepoConfig('version: 99\n', 'f'), /version 99 is not supported/);
});

test('an inconsistent release configuration fails at load, not mid-release', () => {
  assert.throws(() => parseRepoConfig('version: 1\nhooks: {test: t, build: b}\nrelease:\n  mode: ci_auto\n', 'f'),
    /needs release\.ci\.provider/);
  assert.throws(() => parseRepoConfig('version: 1\nhooks: {test: t, build: b}\n', 'f'),
    /"local" needs a hooks\.deploy/);
});

test('an empty or non-string hook is rejected', () => {
  assert.throws(() => parseRepoConfig('version: 1\nhooks:\n  test: ""\n', 'f'), /hooks\.test is empty/);
  assert.throws(() => parseRepoConfig('version: 1\nhooks:\n  test: 42\n', 'f'), /hooks\.test must be a string/);
});

test('the file is found by any of its accepted names', () => {
  for (const n of ['.crew.yaml', '.crew.yml', '.crew.json']) {
    const body = n.endsWith('.json') ? JSON.stringify({ version: 1, hooks: { test: 't', build: 'b', deploy: 'd' } }) : MIN;
    const d = dirWith(n, body);
    assert.ok(findRepoConfig(d)?.endsWith(n));
    assert.equal(loadRepoConfig(d)?.version, 1);
  }
});

test('a repo with no contract is not an error', () => {
  const d = mkdtempSync(join(tmpdir(), 'crew-repo-'));
  assert.equal(findRepoConfig(d), null);
  assert.equal(loadRepoConfig(d), null);
});

test('a repo with no contract is driven entirely by the ship, except platform: that has no ship fallback', () => {
  const eff = resolveRepoConfig(null, {
    hooks: { test: 'make test', build: 'make', deploy: 'make ship' },
  }, '/tmp/x');
  assert.equal(eff.hooks.test, 'make test');
  assert.equal(eff.provenance['hooks.test'], 'ship');
  assert.equal(eff.platform, 'any');
  assert.equal(eff.provenance['platform'], 'default');
  assert.deepEqual(validateEffective(eff), []);
  assert.match(eff.file, /no \.crew\.yaml — configured by this ship/);
});

test('the repo wins per field; platform is repo-only, so there is nothing for it to shadow', () => {
  const repo = parseRepoConfig('version: 1\nplatform: macos\nhooks:\n  test: repo-test\n  build: b\n  deploy: d\n', '.crew.yaml');
  const eff = resolveRepoConfig(repo, {
    hooks: { test: 'ship-test', setup: 'ship-setup' },
  }, '/tmp/x');
  assert.equal(eff.hooks.test, 'repo-test');       // repo wins
  assert.equal(eff.provenance['hooks.test'], 'repo');
  assert.equal(eff.hooks.setup, 'ship-setup');     // ship fills a gap
  assert.equal(eff.provenance['hooks.setup'], 'ship');
  assert.equal(eff.platform, 'macos');
  assert.equal(eff.provenance['platform'], 'repo');
  assert.ok(eff.shadowed.includes('hooks.test'));
  assert.ok(!eff.shadowed.includes('platform'));
  assert.ok(!eff.shadowed.includes('hooks.setup'));
});

test('merged config is validated too — ship settings do not escape the rules', () => {
  const eff = resolveRepoConfig(null, { hooks: { test: 't', build: 'b' } }, '/tmp/x');
  assert.deepEqual(validateEffective(eff), ['release.mode "local" needs a deploy hook']);
  const ci = resolveRepoConfig(null, { hooks: { test: 't', build: 'b' }, release: { mode: 'ci_auto' } as any }, '/tmp/x');
  assert.ok(validateEffective(ci).some((p) => /needs a CI provider/.test(p)));
});

test('hookLabel prefers the readable name over eight lines of shell', () => {
  const c = parseRepoConfig('version: 1\nhooks:\n  test: |\n    a\n    b\n  build: b\n  deploy: d\nlabels:\n  test: the suite\n', 'f');
  assert.equal(hookLabel(c, 'test'), 'the suite');
  assert.equal(hookLabel(c, 'build'), 'b');
});

const CI = `version: 1
hooks:
  test: t
  build: b
  released: curl -sf https://x/health | jq -r .commit
release:
  mode: ci_auto
  ci: { provider: github, ref: .github/workflows/release.yml }
`;

test('a CI release mode requires a released hook — the crew must be able to observe', () => {
  const noHook = CI.replace('  released: curl -sf https://x/health | jq -r .commit\n', '');
  assert.throws(() => parseRepoConfig(noHook, 'f'), (e: Error) => {
    assert.match(e.message, /release\.mode "ci_auto" needs a hooks\.released/);
    assert.match(e.message, /cannot observe a release it did not perform/);
    return true;
  });
});

test('a CI release parses, with verify defaults', () => {
  const c = parseRepoConfig(CI, 'f');
  assert.equal(c.release.mode, 'ci_auto');
  assert.equal(c.release.ci.provider, 'github');
  assert.equal(c.release.verify.match, 'commit');
  assert.equal(c.release.verify.timeoutSeconds, 600);
  assert.equal(c.release.verify.intervalSeconds, 15);
  assert.equal(c.hooks.released, 'curl -sf https://x/health | jq -r .commit');
});

test('verify settings are validated, not merely read', () => {
  assert.throws(() => parseRepoConfig(CI + '  verify: { match: sha }\n', 'f'), /match must be commit\|version/);
  assert.throws(() => parseRepoConfig(CI + '  verify: { timeoutSeconds: 0 }\n', 'f'), /must be a positive number/);
  assert.throws(() => parseRepoConfig(CI + '  verify: { timeoutSeconds: -5 }\n', 'f'), /must be a positive number/);
  // an interval longer than the timeout would never be asked twice
  assert.throws(() => parseRepoConfig(CI + '  verify: { timeoutSeconds: 10, intervalSeconds: 60 }\n', 'f'),
    /exceeds timeoutSeconds/);
});

test('an unknown verify key is caught like any other', () => {
  assert.throws(() => parseRepoConfig(CI + '  verify: { retries: 3 }\n', 'f'), /unknown release\.verify key: retries/);
});

test('a ship-configured CI repo does not escape the released-hook rule', () => {
  const eff = resolveRepoConfig(null, {
    hooks: { test: 't', build: 'b' },
    release: { mode: 'ci_manual', ci: { provider: 'buildkite' } } as any,
  }, '/tmp/x');
  assert.ok(validateEffective(eff).some((p) => /needs a released hook/.test(p)));
});

test('verify settings merge per field like everything else', () => {
  const repo = parseRepoConfig(CI + '  verify: { timeoutSeconds: 1200 }\n', 'f');
  const eff = resolveRepoConfig(repo, {
    release: { verify: { match: 'version', intervalSeconds: 30 } } as any,
  }, '/tmp/x');
  assert.equal(eff.release.verify.timeoutSeconds, 1200);            // repo
  assert.equal(eff.provenance['release.verify.timeoutSeconds'], 'repo');
  assert.equal(eff.release.verify.intervalSeconds, 30);             // ship fills the gap
  assert.equal(eff.provenance['release.verify.intervalSeconds'], 'ship');
  assert.equal(eff.release.verify.match, 'version');                // ship fills the gap
});

test('a repo can own its own versioning entirely', () => {
  const c = parseRepoConfig(`version: 1
hooks:
  test: t
  build: b
  deploy: d
  version: git describe --tags --abbrev=0
  bump: |
    cargo set-version --bump "$CREW_BUMP"
    cargo pkgid | cut -d'#' -f2
`, 'f');
  assert.equal(c.hooks.version, 'git describe --tags --abbrev=0');
  assert.match(c.hooks.bump!, /CREW_BUMP/);
});

test('bump and versionFiles together is an error, not a merge', () => {
  assert.throws(() => parseRepoConfig(`version: 1
hooks: { test: t, build: b, deploy: d, bump: "x" }
release:
  versionFiles: [package.json]
`, 'f'), (e: Error) => {
    assert.match(e.message, /either hooks\.bump or release\.versionFiles, not both/);
    assert.match(e.message, /how they drift apart/);
    return true;
  });
});

test('a repo with neither still gets the npm-shaped default', () => {
  const c = parseRepoConfig(MIN, 'f');
  assert.equal(c.hooks.bump, undefined);
  assert.deepEqual(c.release.versionFiles, ['package.json']);
});

test('a ship configuring versionFiles under a repo bump hook is reported', () => {
  const repo = parseRepoConfig('version: 1\nhooks: { test: t, build: b, deploy: d, bump: "x" }\n', 'f');
  const eff = resolveRepoConfig(repo, { release: { versionFiles: ['pkg/package.json'] } as any }, '/tmp/x');
  assert.ok(validateEffective(eff).some((p) => /bump hook wins and the ship setting is ignored/.test(p)));
});

test('bump and version are ordinary hooks — mistyping them is caught', () => {
  assert.throws(() => parseRepoConfig('version: 1\nhooks: { bumps: x }\n', 'f'), /unknown hooks key: bumps/);
});

test('a repo can opt out of versioning entirely', () => {
  const c = parseRepoConfig(`version: 1
hooks: { test: t, build: b, deploy: d }
release:
  versioning: none
  changelog: false
`, 'f');
  assert.equal(c.release.versioning, 'none');
  assert.equal(c.release.changelog, null);
});

test('opting out while keeping the machinery is refused, not merged', () => {
  assert.throws(() => parseRepoConfig(
    'version: 1\nhooks: { test: t, build: b, deploy: d, bump: x }\nrelease: { versioning: none }\n', 'f'),
    /versioning is "none" but hooks\.bump is defined/);
  assert.throws(() => parseRepoConfig(
    'version: 1\nhooks: { test: t, build: b, deploy: d }\nrelease: { versioning: none, versionFiles: [a] }\n', 'f'),
    /versioning is "none" but release\.versionFiles is set/);
});

test('versioning is validated', () => {
  assert.throws(() => parseRepoConfig(
    'version: 1\nhooks: { test: t, build: b, deploy: d }\nrelease: { versioning: sometimes }\n', 'f'),
    /versioning must be auto\|none/);
});

test('a repo with no changelog is expressed, not faked', () => {
  const c = parseRepoConfig(MIN, 'f');
  assert.equal(c.release.changelog, 'CHANGELOG.md');   // default
  const none = parseRepoConfig(MIN + 'release: { changelog: false }\n', 'f');
  assert.equal(none.release.changelog, null);
});

test('branch naming is a convention, not a constant', () => {
  const c = parseRepoConfig(MIN + 'branch:\n  name: "feature/{key}-{slug}"\n  remote: upstream\n', 'f');
  assert.equal(c.branch.name, 'feature/{key}-{slug}');
  assert.equal(c.branch.push, 'feature/{key}-{slug}');   // defaults to name
  assert.equal(c.branch.remote, 'upstream');
});

test('the default naming is what the crew has always used', () => {
  const c = parseRepoConfig(MIN, 'f');
  assert.deepEqual(c.branch, { base: 'main', name: 'issue-{number}', push: 'issue-{number}', remote: 'origin' });
});

test('a pushed branch may be named differently from the local one', () => {
  const c = parseRepoConfig(MIN + 'branch:\n  name: "issue-{number}"\n  push: "crew/{key}"\n', 'f');
  assert.equal(c.branch.name, 'issue-{number}');
  assert.equal(c.branch.push, 'crew/{key}');
});

test('a template naming no placeholder is refused — every ticket would collide', () => {
  assert.throws(() => parseRepoConfig(MIN + 'branch: { name: "work" }\n', 'f'), (e: Error) => {
    assert.match(e.message, /names no placeholder/);
    assert.match(e.message, /every ticket would get the same branch/);
    return true;
  });
});

test('placeholders render, and titles are slugified safely for a git ref', () => {
  assert.equal(renderBranchName('issue-{number}', { key: 'ISSUE-326' }), 'issue-326');
  assert.equal(renderBranchName('feature/{key}', { key: 'ISSUE-326' }), 'feature/ISSUE-326');
  assert.equal(
    renderBranchName('{role}/{number}-{slug}', { key: 'ISSUE-7', title: 'Fix the "widget" — now!', role: 'dev' }),
    'dev/7-fix-the-widget-now',
  );
  assert.equal(slugify(''), 'work');                       // never an empty ref component
  assert.equal(slugify('---'), 'work');
  assert.ok(!slugify('A'.repeat(200)).includes(' '));
  assert.ok(slugify('A'.repeat(200)).length <= 40);
});

test('opting out of versioning does not require also disabling the default tag', () => {
  const c = parseRepoConfig(
    'version: 1\nhooks: { test: t, build: b, deploy: d }\nrelease: { versioning: none }\n', 'f');
  assert.equal(c.release.versioning, 'none');
  assert.equal(c.release.tag, null);      // the default simply does not apply
});

test('but an EXPLICIT tag alongside versioning: none is a contradiction', () => {
  assert.throws(() => parseRepoConfig(
    'version: 1\nhooks: { test: t, build: b, deploy: d }\nrelease: { versioning: none, tag: "v{version}" }\n', 'f'),
    /there is no version to tag with/);
});

test('a tag template without {version} is refused', () => {
  assert.throws(() => parseRepoConfig(MIN + 'release: { tag: "release" }\n', 'f'),
    /does not include \{version\}/);
});

test('the tag pattern is derived from the template unless stated', () => {
  assert.equal(parseRepoConfig(MIN, 'f').release.tagPattern, 'v*');
  assert.equal(parseRepoConfig(MIN + 'release: { tag: "release-{version}" }\n', 'f').release.tagPattern, 'release-*');
  assert.equal(parseRepoConfig(MIN + 'release: { tagPattern: "rel/*" }\n', 'f').release.tagPattern, 'rel/*');
});

test('worktrees.copy carries gitignored files a fresh worktree cannot have', () => {
  const base = 'version: 1\nrelease:\n  mode: external\n';
  const c = parseRepoConfig(`${base}worktrees:\n  copy:\n    - .env\n    - apps/api/.env\n`, 'f');
  assert.deepEqual(c.worktrees.copy, ['.env', 'apps/api/.env']);
  // Absent is empty, not undefined — every consumer can iterate it.
  assert.deepEqual(parseRepoConfig(base, 'f').worktrees.copy, []);
});

test('worktrees.copy cannot reach outside the repository', () => {
  // It runs on every ticket, unattended. An absolute path or a climb out of
  // the tree would copy something that is not this repo's to copy.
  const base = 'version: 1\nrelease:\n  mode: external\n';
  assert.throws(() => parseRepoConfig(`${base}worktrees:\n  copy: ["/etc/passwd"]\n`, 'f'),
    /must be a path inside the repository/);
  assert.throws(() => parseRepoConfig(`${base}worktrees:\n  copy: ["../../.ssh/id_rsa"]\n`, 'f'),
    /must be a path inside the repository/);
  assert.throws(() => parseRepoConfig(`${base}worktrees:\n  copy: "just a string"\n`, 'f'),
    /must be a list of paths/);
});

test('a ship cannot supply worktrees.copy — it is the repo\'s fact alone', () => {
  const repo = parseRepoConfig('version: 1\nrelease:\n  mode: external\nworktrees:\n  copy: [".env"]\n', 'f');
  const eff = resolveRepoConfig(repo, { hooks: { test: 'x' } }, '/tmp');
  assert.deepEqual(eff.worktrees.copy, ['.env']);
  // ...and with no repo file at all it is empty rather than inherited.
  assert.deepEqual(resolveRepoConfig(null, { hooks: { test: 'x' } }, '/tmp').worktrees.copy, []);
});

test('integrate: merges and versions, with nothing to deploy', () => {
  // ISSUE-345. Before this mode existed the crew's own repo declared
  // `external`, which meant its verified branches were never merged and every
  // Crew ticket had to be closed by hand.
  const c = parseRepoConfig([
    'version: 1',
    'hooks:',
    '  test: node --test',
    '  build: npx tsc --noEmit',
    'release:',
    '  mode: integrate',
    '  versioning: none',
    '  changelog: false',
  ].join('\n'), 'f');
  assert.equal(c.release.mode, 'integrate');

  const eff = resolveRepoConfig(c, undefined, '/tmp');
  // No CI provider and no `released` hook are demanded: there is no pipeline,
  // which is the whole point of the mode.
  assert.deepEqual(validateEffective(eff), []);
});

test('integrate refuses a deploy hook rather than ignoring one', () => {
  // The alternative — silently not running it — would leave an operator
  // believing their deploy hook runs on every release.
  assert.throws(
    () => parseRepoConfig('version: 1\nhooks:\n  deploy: ./ship.sh\nrelease:\n  mode: integrate\n', 'f'),
    /means there is nothing to deploy, but hooks.deploy is defined/,
  );
});

test('the mode list is closed, and names itself in the error', () => {
  assert.throws(
    () => parseRepoConfig('version: 1\nrelease:\n  mode: whenever\n', 'f'),
    /must be one of local\|integrate\|ci_manual\|ci_auto\|external/,
  );
});

// ISSUE-350. `worktreePrefix` lived on the route, which spans several
// repos — so a session working the area's second repo was told to cut its
// worktree under the first repo's name.
test('a repo\'s worktree prefix defaults to its own directory name', () => {
  const c = resolveRepoConfig(null, undefined, '/w/tablation-js');
  assert.equal(c.worktrees.prefix, 'tablation-js-issue-');
  assert.equal(c.provenance['worktrees.prefix'], 'default');
  // A trailing separator must not eat the name.
  assert.equal(resolveRepoConfig(null, undefined, '/w/crew/').worktrees.prefix, 'crew-issue-');
});

test('the ship supplies a worktree prefix, and the repo overrides it', () => {
  const shipOnly = resolveRepoConfig(null, { worktrees: { prefix: 'synthesis-issue-' } }, '/w/crew');
  assert.equal(shipOnly.worktrees.prefix, 'synthesis-issue-');
  assert.equal(shipOnly.provenance['worktrees.prefix'], 'ship');

  const repo = parseRepoConfig(`${MIN}worktrees:\n  prefix: wt-\n`, '.crew.yaml');
  const both = resolveRepoConfig(repo, { worktrees: { prefix: 'synthesis-issue-' } }, '/w/crew');
  assert.equal(both.worktrees.prefix, 'wt-');
  assert.equal(both.provenance['worktrees.prefix'], 'repo');
  // Reported rather than swallowed: a ship setting the repo overrides reads as
  // if it were in use, which is how this went unnoticed on the route.
  assert.ok(both.shadowed.includes('worktrees.prefix'));
});

test('a worktree prefix may not contain a path separator', () => {
  // A worktree is cut beside the checkout; a prefix with a slash puts it
  // somewhere nothing else looks — including `reap`, which kills what it
  // cannot find.
  assert.throws(
    () => parseRepoConfig(`${MIN}worktrees:\n  prefix: wt/issue-\n`, '.crew.yaml'),
    /must not contain a path separator/,
  );
  assert.throws(
    () => parseRepoConfig(`${MIN}worktrees:\n  prefix: ""\n`, '.crew.yaml'),
    /non-empty string/,
  );
});
