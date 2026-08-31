import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  loadConfig, findRoute, configuredMembers, reposOf, shipWorktreePrefixFor, ticketsByRepo, ConfigError,
  resolvedPathFor, mergeRouteRelease, defaultRepoDir, dirForRepo,
} from '../src/config.ts';

function withConfig(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cfg-'));
  const file = join(dir, 'crew.yaml');
  writeFileSync(file, yaml);
  return { dir, file };
}

function writeResolved(stateDir: string, route: string, data: unknown) {
  const path = resolvedPathFor(stateDir, route);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  return path;
}

const RESOLVED = `
    resolved:
      workspaceId: ws-1
      models: { issues: i, comments: c, crew: m }
      seats: { dev: dev-1, qa: qa-1 }
      operator: op-1
      holds: [{ id: pair-1, role: live session }]`;

const ONE = `
ship:
  agent: { bin: /bin/true }
routes:
  - route: issues/dev-crew
    dir: /tmp/proj
    worktreePrefix: proj-issue-
    baseUrl: https://example.test/
${RESOLVED}
`;

const TWO = `${ONE}  - route: issues/tablation-js
    enabled: true
    dir: /tmp/other
    worktreePrefix: js-issue-
    baseUrl: https://example.test
${RESOLVED}
`;

test('a ship holds many routes', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes.length, 2);
  assert.deepEqual(cfg.routes.map((r) => r.route), ['issues/dev-crew', 'issues/tablation-js']);
});

test('ship-level settings are shared; route settings are not', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.ship.agent.model, 'claude-sonnet-5');
  assert.equal(cfg.routes[0]!.worktreePrefix, 'proj-issue-');
  assert.equal(cfg.routes[1]!.worktreePrefix, 'js-issue-');
});

test('the platform this ship IS is detected; routes no longer declare one', () => {
  const { dir, file } = withConfig(ONE);
  const cfg = loadConfig(dir, file);
  assert.ok(['macos', 'linux', 'windows'].includes(cfg.ship.platform));
  assert.ok(!('platform' in cfg.routes[0]!));
});

test('a route that still declares platform is refused — it moved to the repo\'s own .crew.yaml', () => {
  const { dir, file } = withConfig(ONE.replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    platform: unix'));
  assert.throws(() => loadConfig(dir, file), /unknown routes\[0\] key: platform/);
});

test('a malformed route is dropped, not fatal, when another route on the same ship is fine', () => {
  const broken = TWO.replace('worktreePrefix: js-issue-', 'worktreePrefix: js-issue-\n    platform: unix');
  const { dir, file } = withConfig(broken);
  const cfg = loadConfig(dir, file);
  assert.deepEqual(cfg.routes.map((r) => r.route), ['issues/dev-crew']);
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0]!, /route "issues\/tablation-js" dropped/);
  assert.match(cfg.warnings[0]!, /unknown routes\[1\] key: platform/);
});

test('every route malformed is still fatal — there is nothing left for this ship to run', () => {
  const broken = TWO
    .replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    platform: unix')
    .replace('worktreePrefix: js-issue-', 'worktreePrefix: js-issue-\n    platform: unix');
  const { dir, file } = withConfig(broken);
  assert.throws(() => loadConfig(dir, file), /unknown routes\[0\] key: platform/);
});

test('baseUrl defaults to the hosted tracker when neither route nor ship says otherwise', () => {
  const noBaseUrl = ONE.replace(/^\s*baseUrl:.*\n/m, '');
  const { dir, file } = withConfig(noBaseUrl);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.baseUrl, 'https://app.tablation.com');
});

test('apiKey falls back to the ship\'s, since one key can be valid for several workspaces', () => {
  const noApiKey = ONE.replace('ship:\n  agent:', 'ship:\n  apiKey: ship-key\n  agent:');
  const { dir, file } = withConfig(noApiKey);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.apiKey, 'ship-key');
});

test('a route\'s own apiKey wins over the ship\'s', () => {
  const both = ONE.replace('ship:\n  agent:', 'ship:\n  apiKey: ship-key\n  agent:')
    .replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    apiKey: route-key');
  const { dir, file } = withConfig(both);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.apiKey, 'route-key');
});

test('userAgent defaults to a Cloudflare-safe value naming this checkout\'s version', () => {
  const { dir, file } = withConfig(ONE);
  const cfg = loadConfig(dir, file);
  assert.match(cfg.ship.userAgent, /^Mozilla\/5\.0 CrewAgent\//);
});

test('a route is addressed by its workspace/project string', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(findRoute(cfg, 'issues/tablation-js').dir, '/tmp/other');
  assert.throws(() => findRoute(cfg, 'nope/nope'), /no route "nope\/nope"/);
});

test('with several routes and no name, the single enabled one is implied', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(findRoute(cfg).route, 'issues/tablation-js'); // the only one enabled
});

test('ambiguity is refused rather than guessed', () => {
  const both = TWO.replace('  - route: issues/dev-crew\n', '  - route: issues/dev-crew\n    enabled: true\n');
  const { dir, file } = withConfig(both);
  assert.throws(() => findRoute(loadConfig(dir, file)), /name one: issues\/dev-crew, issues\/tablation-js/);
});

test('duplicate routes are refused — a route addresses itself', () => {
  const dup = TWO.replace('route: issues/tablation-js', 'route: issues/dev-crew');
  const { dir, file } = withConfig(dup);
  assert.throws(() => loadConfig(dir, file), /duplicate route "issues\/dev-crew"/);
});

test('a route must be "workspace/project" — not a bare name, not more than one slash', () => {
  const { dir, file } = withConfig(ONE.replace('route: issues/dev-crew', 'route: issues'));
  assert.throws(() => loadConfig(dir, file), /route must be "workspace\/project"/);
});

test('the interlock is per route and opt-in', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.enabled, false);
  assert.equal(cfg.routes[1]!.enabled, true);
});

test('every missing setting is reported at once, named by route index', () => {
  const { dir, file } = withConfig('ship: {}\nroutes:\n  - route: issues/x\n');
  assert.throws(() => loadConfig(dir, file), (e: Error) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /routes\[0\]\.dir/);
    return true;
  });
});

test('worktreePrefix is optional — a route that says nothing gets no ship-level override', () => {
  const noPrefix = TWO.replace(/^\s*worktreePrefix:.*\n/m, '');
  const { dir, file } = withConfig(noPrefix);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.worktreePrefix, undefined);
});

test('promptsDir defaults to <crewHome>/prompts/default when a route says nothing', () => {
  const { dir, file } = withConfig(ONE);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.promptsDir, join(dir, 'prompts', 'default'));
});

test('a bare promptSet name resolves under <crewHome>/prompts/, not the route\'s own dir', () => {
  const withPreset = ONE.replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    promptSet: dev-qa');
  const { dir, file } = withConfig(withPreset);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.promptsDir, join(dir, 'prompts', 'dev-qa'));
});

test('a promptSet that looks like a path is expanded relative to this route\'s own config, like apiKeyFile', () => {
  const withPath = ONE.replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    promptSet: ./my-policy');
  const { dir, file } = withConfig(withPath);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.promptsDir, join(dir, 'my-policy'));
});

test('a promptSet starting with ~ expands against the home directory, same as other path settings', () => {
  const withHome = ONE.replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    promptSet: ~/my-crew-policy');
  const { dir, file } = withConfig(withHome);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.promptsDir, join(homedir(), 'my-crew-policy'));
});

test('a config with no routes is refused', () => {
  const { dir, file } = withConfig('ship: {}\n');
  assert.throws(() => loadConfig(dir, file), /routes \(at least one\)/);
});

test('weight is optional — undefined means pure aging (ISSUE-383)', () => {
  const { dir, file } = withConfig(ONE);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.weight, undefined);
});

test('weight scales the aging rate when a route sets one', () => {
  const weighted = ONE.replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    weight: 3');
  const { dir, file } = withConfig(weighted);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.routes[0]!.weight, 3);
});

test('weight cannot be 0 or negative — that would silently starve, which is what enabled:false is honest about', () => {
  const zero = ONE.replace('worktreePrefix: proj-issue-', 'worktreePrefix: proj-issue-\n    weight: 0');
  const { dir, file } = withConfig(zero);
  assert.throws(() => loadConfig(dir, file), /routes\[0\]\.weight must be a positive number/);
});

test('configuredMembers reads the resolved ids, not authored ones', () => {
  const { dir, file } = withConfig(ONE);
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.deepEqual(configuredMembers(r), [
    { id: 'dev-1', role: 'Dev', kind: 'seat' },
    { id: 'qa-1', role: 'QA', kind: 'seat' },
    { id: 'op-1', role: 'Operator', kind: 'hold' },
    { id: 'pair-1', role: 'live session', kind: 'hold' },
  ]);
});

test('configuredMembers classifies a resolved pair seat as a HOLD, not a seat — a ticket it works must stay off-limits to the polled seats', () => {
  const withPair = `
ship:
  agent: { bin: /bin/true }
routes:
  - route: issues/dev-crew
    dir: /tmp/proj
    worktreePrefix: proj-issue-
    baseUrl: https://example.test/
    resolved:
      workspaceId: ws-1
      models: { issues: i, comments: c, crew: m }
      seats: { dev: dev-1, pair: pair-seat-1 }
      operator: op-1
      holds: []
`;
  const { dir, file } = withConfig(withPair);
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.deepEqual(configuredMembers(r), [
    { id: 'dev-1', role: 'Dev', kind: 'seat' },
    { id: 'pair-seat-1', role: 'Pair', kind: 'hold' },
    { id: 'op-1', role: 'Operator', kind: 'hold' },
  ]);
});

test('an unresolved route says to run crew connect', () => {
  const noIds = ONE.slice(0, ONE.indexOf('    resolved:'));
  const { dir, file } = withConfig(noIds);
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.throws(() => configuredMembers(r), /run `crew connect`/);
});

test('resolved ids are read from the state tree, not just from an authored `resolved:` block', () => {
  const noIds = ONE.slice(0, ONE.indexOf('    resolved:'));
  const { dir, file } = withConfig(noIds);
  writeResolved(join(dir, 'state'), 'issues/dev-crew', {
    workspaceId: 'ws-1', models: { issues: 'i', comments: 'c', crew: 'm' },
    seats: {}, operator: 'op-1', holds: [],
  });
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.equal(r.resolved?.workspaceId, 'ws-1');
  assert.equal(r.resolved?.operator, 'op-1');
});

test('a state-tree resolved file wins over an authored `resolved:` block, when both exist', () => {
  const { dir, file } = withConfig(ONE);
  writeResolved(join(dir, 'state'), 'issues/dev-crew', {
    workspaceId: 'from-state-file', models: { issues: 'i', comments: 'c', crew: 'm' },
    seats: {}, operator: 'op-1', holds: [],
  });
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.equal(r.resolved?.workspaceId, 'from-state-file');
});

test('a contract in the state-tree resolved file is read the same way as ids', () => {
  const noIds = ONE.slice(0, ONE.indexOf('    resolved:'));
  const { dir, file } = withConfig(noIds);
  writeResolved(join(dir, 'state'), 'issues/dev-crew', {
    workspaceId: 'ws-1', models: { issues: 'i', comments: 'c', crew: 'm' },
    seats: {}, operator: 'op-1', holds: [],
    contract: { statuses: { resolved: ['verified', 'closed_deployed', 'closed_completed'] } },
  });
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.deepEqual(r.contract?.statuses?.resolved, ['verified', 'closed_deployed', 'closed_completed']);
});

test('a state-tree contract wins over an authored `contract:` block in crew.yaml, when both exist', () => {
  const withInline = `
ship:
  agent: { bin: /bin/true }
routes:
  - route: issues/dev-crew
    dir: /tmp/proj
    baseUrl: https://example.test/
    contract:
      statuses: { resolved: [from-yaml] }
${RESOLVED}
`;
  const { dir, file } = withConfig(withInline);
  writeResolved(join(dir, 'state'), 'issues/dev-crew', {
    workspaceId: 'ws-1', models: { issues: 'i', comments: 'c', crew: 'm' },
    seats: {}, operator: 'op-1', holds: [],
    contract: { statuses: { resolved: ['from-state'] } },
  });
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.deepEqual(r.contract?.statuses?.resolved, ['from-state']);
});

test('an authored `contract:` block still applies when no state-tree contract exists', () => {
  const withInline = `
ship:
  agent: { bin: /bin/true }
routes:
  - route: issues/dev-crew
    dir: /tmp/proj
    baseUrl: https://example.test/
    contract:
      statuses: { resolved: [from-yaml] }
${RESOLVED}
`;
  const { dir, file } = withConfig(withInline);
  writeResolved(join(dir, 'state'), 'issues/dev-crew', {
    workspaceId: 'ws-1', models: { issues: 'i', comments: 'c', crew: 'm' },
    seats: {}, operator: 'op-1', holds: [],
  });
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.deepEqual(r.contract?.statuses?.resolved, ['from-yaml']);
});

test('a malformed resolved-ids state file is a config error, not a silent fallback', () => {
  const { dir, file } = withConfig(ONE);
  const path = resolvedPathFor(join(dir, 'state'), 'issues/dev-crew');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ not json');
  assert.throws(() => loadConfig(dir, file), /not valid JSON/);
});

test('a route names one area of development, distinct from the Tablation project', () => {
  const withArea = ONE.replace('    dir: /tmp/proj\n', '    dir: /tmp/proj\n    area: Tablation\n');
  const { dir, file } = withConfig(withArea);
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.equal(r.route, 'issues/dev-crew');
  assert.equal(r.area, 'Tablation');    // a row of the Projects table inside the project
});

test('an unsliced tracker needs no area, and gets the whole queue', () => {
  const { dir, file } = withConfig(ONE);
  const r = findRoute(loadConfig(dir, file), 'issues/dev-crew');
  assert.equal(r.area, undefined);
  assert.equal(r.resolved?.areaId, undefined);
});

test('the shipped example config still parses', () => {
  // The loader rejects unknown keys, so a renamed or removed setting turns the
  // example into a file that cannot be used — and the example is the only
  // thing a fresh install has to copy from. Failing here is the point.
  const example = join(import.meta.dirname, '..', 'crew.example.yaml');
  const cfg = loadConfig(process.cwd(), example);
  assert.equal(cfg.routes.length, 1);
  // Shipped disarmed: copying it must not start writing to someone's board.
  assert.equal(cfg.routes[0]!.enabled, false);
});

test('reposOf covers every checkout, not just the route dir', () => {
  // Release, merge and sync are REPOSITORY operations. Treating `dir` as "the"
  // directory meant only the first repo on a board was ever released — the
  // others were configured, referenced by tickets, and silently never shipped.
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/multi',
    '    apiKey: k',
    '    worktreePrefix: m-',
    '    baseUrl: https://example.com',
    '    repos:',
    '      alpha: /tmp/alpha',
    '      beta: /tmp/beta',
    '  - route: w/single',
    '    apiKey: k',
    '    worktreePrefix: s-',
    '    baseUrl: https://example.com',
    '    dir: /tmp/only',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));

  assert.deepEqual(reposOf(findRoute(cfg, 'w/multi')).map((r) => r.name), ['alpha', 'beta']);
  // A single-repo route still yields exactly one target, so callers never
  // need to special-case it — named for its own checkout directory, not the
  // route string (which would put a "/" in a repo name).
  assert.deepEqual(reposOf(findRoute(cfg, 'w/single')), [{ name: 'only', dir: '/tmp/only' }]);

  // A multi-repo route's worktreePrefix fits none of its repos in
  // particular, so it must not apply to any of them — each falls through to
  // its own `.crew.yaml` prefix or its checkout name (ISSUE-398). Only a
  // single-repo route has one unambiguous checkout for the value to
  // describe.
  assert.equal(shipWorktreePrefixFor(findRoute(cfg, 'w/multi')), undefined);
  assert.equal(shipWorktreePrefixFor(findRoute(cfg, 'w/single')), 's-');
});

test('an omitted repos: map derives every tracker-known repo from the base-path convention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: acme/proj',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    dir: /tmp/whatever',
    '    resolved:',
    '      workspaceId: ws', '      operator: op-1',
    '      models: { issues: i, comments: c, crew: m }',
    '      repoNames: { r-a: alpha, r-b: beta }',
    '      repoRemotes: { r-a: acme/alpha, r-b: acme/beta }',
  ].join('\n'));
  const r = findRoute(loadConfig(dir, join(dir, 'crew.yaml')), 'acme/proj');
  const targets = reposOf(r);
  assert.deepEqual(targets.map((t) => t.name).sort(), ['alpha', 'beta']);
  const alpha = targets.find((t) => t.name === 'alpha')!;
  assert.equal(alpha.dir, defaultRepoDir(homedir() + '/Crew', 'acme', 'alpha'));
  assert.equal(alpha.remote, 'acme/alpha');
});

test('reposBasePath defaults to ~/Crew, and a route override wins over a ship-level one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    '  reposBasePath: /ship/base',
    'routes:',
    '  - route: acme/default', '    apiKey: k', '    baseUrl: https://example.com', '    dir: /tmp/x',
    '  - route: acme/override', '    apiKey: k', '    baseUrl: https://example.com', '    dir: /tmp/x',
    '    reposBasePath: /route/base',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));
  assert.equal(findRoute(cfg, 'acme/default').reposBasePath, '/ship/base');
  assert.equal(findRoute(cfg, 'acme/override').reposBasePath, '/route/base');
});

test('a non-empty repos: map is still a closed enumeration — an unlisted tracker repo stays out, for multi-ship division of labor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: acme/proj',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    repos:',
    '      alpha: /tmp/alpha',
    '    resolved:',
    '      workspaceId: ws', '      operator: op-1',
    '      models: { issues: i, comments: c, crew: m }',
    '      repoNames: { r-a: alpha, r-b: beta }',
  ].join('\n'));
  const r = findRoute(loadConfig(dir, join(dir, 'crew.yaml')), 'acme/proj');
  assert.deepEqual(reposOf(r), [{ name: 'alpha', dir: '/tmp/alpha' }]);
  assert.equal(dirForRepo(r, 'r-b'), null);
});

test('a repos: entry may be an object naming its own dir plus hook/label/release overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/multi',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    hooks: { test: "route test", build: "route build" }',
    '    repos:',
    '      frontend: /tmp/frontend',
    '      backend:',
    '        dir: /tmp/backend',
    '        hooks: { test: "backend test" }',
    '        labels: { test: "pytest" }',
    '        release: { versionFiles: [pyproject.toml] }',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));
  const route = findRoute(cfg, 'w/multi');

  assert.deepEqual(reposOf(route).map((r) => ({ name: r.name, dir: r.dir })), [
    { name: 'frontend', dir: '/tmp/frontend' },
    { name: 'backend', dir: '/tmp/backend' },
  ]);
  assert.equal(route.repoOverrides.frontend, undefined);
  assert.deepEqual(route.repoOverrides.backend, {
    hooks: { test: 'backend test' },
    labels: { test: 'pytest' },
    release: {
      mode: undefined, ci: undefined, verify: undefined, versioning: undefined,
      versionFiles: ['pyproject.toml'], changelog: undefined, tag: undefined, tagPattern: undefined,
    },
  });
  // The route-wide fallback is untouched — resolvedRepos()/releasePhase() are
  // what merge an override with it, not loadConfig() itself.
  assert.equal(route.hooks.test, 'route test');
  assert.equal(route.hooks.build, 'route build');
});

test('route-level release.mode (and ci/verify/versioning/tag) parse as a ship-level fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/single',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    dir: /tmp/only',
    '    release:',
    '      mode: ci_auto',
    '      ci: { provider: github, ref: .github/workflows/release.yml }',
    '      verify: { match: version, timeoutSeconds: 900, intervalSeconds: 30 }',
    '      versioning: none',
    '      tag: "v{version}"',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));
  const release = findRoute(cfg, 'w/single').release;

  assert.equal(release.mode, 'ci_auto');
  assert.deepEqual(release.ci, { provider: 'github', ref: '.github/workflows/release.yml' });
  assert.deepEqual(release.verify, { match: 'version', timeoutSeconds: 900, intervalSeconds: 30 });
  assert.equal(release.versioning, 'none');
  assert.equal(release.tag, 'v{version}');
});

test('release.mode is validated against the same enum a repo\'s own .crew.yaml uses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/single',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    dir: /tmp/only',
    '    release:',
    '      mode: yolo',
  ].join('\n'));
  assert.throws(() => loadConfig(dir, join(dir, 'crew.yaml')), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match((e as Error).message, /release\.mode must be one of local\|integrate\|ci_manual\|ci_auto\|external \(got "yolo"\)/);
    return true;
  });
});

test('route-level branch.base parses and is exposed on the route — it used to be accepted and silently discarded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/single',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    dir: /tmp/only',
    '    branch:',
    '      base: master',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));
  assert.deepEqual(findRoute(cfg, 'w/single').branch, { base: 'master', name: undefined, push: undefined, remote: undefined });
});

test('a repo\'s own repos: <name>: branch: override is distinct from the route-wide one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/multi',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    branch:',
    '      base: master',
    '    repos:',
    '      a:',
    '        dir: /tmp/a',
    '      b:',
    '        dir: /tmp/b',
    '        branch:',
    '          base: trunk',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));
  const route = findRoute(cfg, 'w/multi');
  assert.deepEqual(route.branch, { base: 'master', name: undefined, push: undefined, remote: undefined });
  assert.equal(route.repoOverrides['a'], undefined, 'repo a declared no override — nothing to shadow the route-wide one with');
  assert.deepEqual(route.repoOverrides['b']!.branch, { base: 'trunk', name: undefined, push: undefined, remote: undefined });
});

test('branch.base is left completely undefined when nothing at all declares one — no invented "main" default at this layer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/single',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    dir: /tmp/only',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));
  assert.equal(findRoute(cfg, 'w/single').branch, undefined);
});

test('an unknown branch: key is refused, the same as an unknown release: key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/single',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    dir: /tmp/only',
    '    branch:',
    '      bogus: nope',
  ].join('\n'));
  assert.throws(() => loadConfig(dir, join(dir, 'crew.yaml')), /unknown routes\[0\]\.branch key: bogus/);
});

test('mergeRouteRelease: an override naming only mode still inherits the route\'s other release fields', () => {
  const route = {
    mode: 'local' as const, ci: { provider: 'none' as const, ref: undefined },
    verify: { match: 'commit' as const, timeoutSeconds: 600, intervalSeconds: 15 },
    versioning: 'auto' as const, versionFiles: ['package.json'], changelog: 'CHANGELOG.md',
    tag: 'v{version}', tagPattern: 'v*',
  };
  const merged = mergeRouteRelease(route, { mode: 'ci_auto' });
  assert.equal(merged.mode, 'ci_auto');
  assert.deepEqual(merged.ci, { provider: 'none', ref: undefined });
  assert.deepEqual(merged.verify, { match: 'commit', timeoutSeconds: 600, intervalSeconds: 15 });
  assert.equal(merged.versionFiles?.[0], 'package.json');
  assert.equal(merged.changelog, 'CHANGELOG.md');
});

test('mergeRouteRelease: no route-wide release and no override yields every field undefined', () => {
  const merged = mergeRouteRelease({});
  assert.deepEqual(merged, {
    mode: undefined, ci: undefined, verify: undefined, versioning: undefined,
    versionFiles: undefined, changelog: undefined, tag: undefined, tagPattern: undefined,
  });
});

test('an object-shaped repos: entry with no dir is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/multi',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    repos:',
    '      backend:',
    '        hooks: { test: "backend test" }',
  ].join('\n'));
  assert.throws(() => loadConfig(dir, join(dir, 'crew.yaml')), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match((e as Error).message, /repos\.backend\.dir is required/);
    return true;
  });
});

test('an object-shaped repos: entry rejects an unknown key, same as a route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/multi',
    '    apiKey: k',
    '    baseUrl: https://example.com',
    '    repos:',
    '      backend:',
    '        dir: /tmp/backend',
    '        platform: unix',
  ].join('\n'));
  assert.throws(() => loadConfig(dir, join(dir, 'crew.yaml')), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match((e as Error).message, /unknown routes\[0\]\.repos\.backend key: platform/);
    return true;
  });
});

test('tickets are partitioned by repo, and unplaceable ones are surfaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'routes:',
    '  - route: w/multi', '    apiKey: k',
    '    worktreePrefix: m-', '    baseUrl: https://example.com',
    '    repos:', '      alpha: /tmp/alpha', '      beta: /tmp/beta',
    '    resolved:',
    '      workspaceId: w-1',
    '      operator: op-1',
    '      models:',
    '        issues: m-i', '        comments: m-c', '        crew: m-w',
    '      repoNames:',
    '        "r-a": alpha', '        "r-b": beta',
  ].join('\n'));
  const r = findRoute(loadConfig(dir, join(dir, 'crew.yaml')), 'w/multi');

  const { byRepo, unplaceable } = ticketsByRepo(r, [
    { issue_id: 'A', repo_id: 'r-a' },
    { issue_id: 'B', repo_id: 'r-b' },
    { issue_id: 'C', repo_id: null },        // names no repo
    { issue_id: 'D', repo_id: 'r-gone' },    // names one this ship has no checkout of
  ]);
  assert.deepEqual(byRepo.get('alpha')!.map((t) => t.issue_id), ['A']);
  assert.deepEqual(byRepo.get('beta')!.map((t) => t.issue_id), ['B']);
  // Not silently dropped and not guessed into a repo: merging a branch into
  // the wrong repository is worse than refusing to place the ticket.
  assert.deepEqual(unplaceable.map((u) => u.ticket.issue_id), ['C', 'D']);
});

// ISSUE-351. These were one undifferentiated list, reported with one sentence
// — "names no repository" — true of only the first of them. A ticket for a
// repository another ship serves is not a problem at all, and warning about
// it every cycle is how the release phase's real warnings get ignored.
test('an unplaceable ticket says WHY it could not be placed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cfg-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: ship', '  agent:', '    bin: /bin/true',
    'routes:',
    '  - route: w/multi', '    enabled: true',
    '    repos:', `      alpha: ${dir}`,
    '    worktreePrefix: wt-', '    baseUrl: https://b.example',
    '    apiKey: k',
    '    resolved:',
    '      workspaceId: ws', '      operator: op-1',
    '      models:',
    '        issues: m-i', '        comments: m-c', '        crew: m-w',
    '      repoNames:',
    '        "r-a": alpha', '        "r-b": beta',
  ].join('\n'));
  const r = findRoute(loadConfig(dir, join(dir, 'crew.yaml')), 'w/multi');

  const { unplaceable } = ticketsByRepo(r, [
    { issue_id: 'C', repo_id: null },       // names none — a board problem
    { issue_id: 'D', repo_id: 'r-gone' },   // not in repoNames — stale config
    { issue_id: 'E', repo_id: 'r-b' },      // known repo, no checkout here
  ]);
  assert.deepEqual(
    unplaceable.map((u) => [u.ticket.issue_id, u.reason]),
    [['C', 'no-repo'], ['D', 'unknown-repo'], ['E', 'not-served-here']],
  );
  // The repo's name comes back with it, so the report can name what is
  // waiting rather than only how many.
  assert.equal(unplaceable.find((u) => u.ticket.issue_id === 'E')!.repo, 'beta');
});
