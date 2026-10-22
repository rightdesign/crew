import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRepoRows, parseAddArgs, parseCloneArgs, planRepoClone, routeNamesOf, configuredRepos, matchRepoName, normalizeRemote, planRepoAdd, planRepoRow, resolveRepoProject, ReposError } from '../src/repos-cmd.ts';
import { parse } from 'yaml';

const BASE = '/cfg';
const resolved = {
  repoNames: { r1: 'synthesis', r2: 'crew' },
  repoRemotes: { r1: 'Acme/synthesis', r2: 'acme/crew' },
};
const empty = `ship:
  name: box
routes:
  # the main board
  - route: acme/product
    enabled: true
  - route: other/thing
    enabled: true
    dir: /other
`;
const route = (text: string, name: string) => (parse(text).routes as Array<Record<string, unknown>>).find((r) => r.route === name)!;

test('normalizeRemote handles scp, ssh, https and bare forms', () => {
  assert.equal(normalizeRemote('git@github.com:Acme/Crew.git'), 'acme/crew');
  assert.equal(normalizeRemote('https://github.com/acme/crew'), 'acme/crew');
  assert.equal(normalizeRemote('ssh://git@github.com/acme/crew.git/'), 'acme/crew');
  assert.equal(normalizeRemote('acme/crew'), 'acme/crew');
  assert.equal(normalizeRemote(''), undefined);
  assert.equal(normalizeRemote('nonsense'), undefined);
});

test('add on an empty route writes dir and keeps comments and other routes', () => {
  const p = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/crew', origin: 'git@github.com:acme/crew.git', resolved });
  assert.equal(p.mode, 'dir');
  assert.equal(p.name, 'crew');
  assert.equal(p.warning, undefined);
  assert.equal(route(p.text, 'acme/product').dir, '/src/crew');
  assert.deepEqual(route(p.text, 'other/thing'), route(empty, 'other/thing'));
  assert.match(p.text, /# the main board/);
  assert.match(p.block, /- route: acme\/product[\s\S]*dir: \/src\/crew/);
});

test('add a second repo converts dir into a repos map', () => {
  const one = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/crew', origin: 'acme/crew', resolved }).text;
  const two = planRepoAdd({ text: one, base: BASE, route: 'acme/product', path: '/src/syn', origin: 'git@github.com:acme/synthesis.git', resolved,
    nameForExisting: (d) => (d === '/src/crew' ? 'crew' : undefined) });
  assert.equal(two.mode, 'repos');
  const r = route(two.text, 'acme/product');
  assert.equal(r.dir, undefined);
  assert.deepEqual(r.repos, { crew: '/src/crew', synthesis: '/src/syn' });
  assert.match(two.text, /# the main board/);
  assert.deepEqual(configuredRepos(two.text, 'acme/product', BASE).map((x) => x.name), ['crew', 'synthesis']);
});

test('add to a route already on repos appends an entry', () => {
  const text = `routes:\n  - route: a/b\n    repos:\n      x: /src/x\n`;
  const p = planRepoAdd({ text, base: BASE, route: 'a/b', path: '/src/y' });
  assert.deepEqual(route(p.text, 'a/b').repos, { x: '/src/x', y: '/src/y' });
});

test('a duplicate path is refused, for dir and for repos', () => {
  assert.throws(() => planRepoAdd({ text: empty, base: BASE, route: 'other/thing', path: '/other' }), ReposError);
  const text = `routes:\n  - route: a/b\n    repos:\n      x: /src/x\n`;
  assert.throws(() => planRepoAdd({ text, base: BASE, route: 'a/b', path: '/src/x' }), /already configured/);
});

test('a name already used by a different path is refused', () => {
  const text = `routes:\n  - route: a/b\n    repos:\n      crew: /src/old\n`;
  assert.throws(() => planRepoAdd({ text, base: BASE, route: 'a/b', path: '/src/crew' }), /already has a repo named "crew"/);
});

test('remote matching: with a Repos row uses its name, without one warns but still adds', () => {
  assert.equal(matchRepoName('git@github.com:ACME/synthesis.git', resolved), 'synthesis');
  const hit = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/checkout-a', origin: 'acme/synthesis', resolved });
  assert.equal(hit.name, 'synthesis');
  assert.equal(hit.warning, undefined);
  const miss = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/new', origin: 'acme/new', resolved });
  assert.equal(miss.name, 'new');
  assert.match(miss.warning ?? '', /no Repos row for remote acme\/new/);
  assert.equal(route(miss.text, 'acme/product').dir, '/src/new');
  const none = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/n2' });
  assert.match(none.warning ?? '', /no origin remote/);
});

test('an unknown route is an error', () => {
  assert.throws(() => planRepoAdd({ text: empty, base: BASE, route: 'nope/none', path: '/x' }), /no route "nope\/none"/);
});

test('an unmatched checkout is flagged for a Repos row; a matched one is not; --name feeds the name', () => {
  const miss = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/new', origin: 'git@github.com:acme/new.git', resolved, name: 'fresh' });
  assert.equal(miss.unmatched, true);
  assert.equal(miss.name, 'fresh');
  const hit = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/x', origin: 'acme/crew', resolved, name: 'ignored' });
  assert.equal(hit.unmatched, false);
  assert.equal(hit.name, 'crew');
});

test('planRepoRow defaults, and prefers the checkout .crew.yaml values', () => {
  assert.deepEqual(planRepoRow({ name: 'n', origin: 'git@github.com:Acme/N.git', projectId: 'p1' }), {
    name: 'n', remote: 'acme/n', platform: 'unix', release_mode: 'local', ci_provider: 'none', enabled: true, project_id: 'p1',
  });
  const row = planRepoRow({ name: 'n', origin: 'acme/n', projectId: 'p1', spec: { platform: 'macos', releaseMode: 'ci_auto', ciProvider: 'github' } });
  assert.equal(row.platform, 'macos');
  assert.equal(row.release_mode, 'ci_auto');
  assert.equal(row.ci_provider, 'github');
  assert.equal(planRepoRow({ name: 'n', origin: 'acme/n', projectId: 'p1', spec: { releaseMode: 'integrate' } }).release_mode, 'local');
  assert.throws(() => planRepoRow({ name: 'n', origin: 'nonsense', projectId: 'p1' }), ReposError);
});

test('resolveRepoProject: --project, route area, a lone project, else an error', () => {
  const two = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
  assert.equal(resolveRepoProject(two, 'beta'), 'b');
  assert.equal(resolveRepoProject(two, 'a'), 'a');
  assert.throws(() => resolveRepoProject(two, 'gamma'), /no Projects row "gamma"/);
  assert.equal(resolveRepoProject(two, undefined, 'route-area'), 'route-area');
  assert.equal(resolveRepoProject([{ id: 'only' }], undefined), 'only');
  assert.throws(() => resolveRepoProject(two, undefined), /--project/);
});

test('routeNamesOf lists the configured routes in order', () => {
  assert.deepEqual(routeNamesOf(empty), ['acme/product', 'other/thing']);
});

test('parseAddArgs: no args means the only route and the current directory', () => {
  assert.deepEqual(parseAddArgs([], ['a/b'], () => false), { route: 'a/b', path: '.' });
});

test('parseAddArgs: route, name and path (the form that used to treat the name as the path)', () => {
  assert.deepEqual(parseAddArgs(['a/b', 'tablation', '.'], ['a/b'], () => true), { route: 'a/b', name: 'tablation', path: '.' });
});

test('parseAddArgs: one trailing arg is a path when it is a directory, else a name', () => {
  assert.deepEqual(parseAddArgs(['a/b', '~/src/x'], ['a/b'], () => true), { route: 'a/b', path: '~/src/x' });
  assert.deepEqual(parseAddArgs(['a/b', 'tablation'], ['a/b'], () => false), { route: 'a/b', name: 'tablation', path: '.' });
});

test('parseAddArgs: an omitted route is only inferred when unambiguous', () => {
  assert.throws(() => parseAddArgs([], ['a/b', 'c/d'], () => false), /name one: a\/b, c\/d/);
  assert.throws(() => parseAddArgs([], [], () => false), /no routes/);
  assert.deepEqual(parseAddArgs(['/tmp/x'], ['a/b'], () => true), { route: 'a/b', path: '/tmp/x' });
});

test('parseAddArgs: a route-shaped first arg that is not configured is an error', () => {
  assert.throws(() => parseAddArgs(['x/y', '.'], ['a/b'], () => false), /no route "x\/y"/);
});

test('planRepoAdd names an unmatched checkout after its remote repo, not its folder', () => {
  const plan = planRepoAdd({ text: empty, base: BASE, route: 'acme/product', path: '/src/checkout-dir', origin: 'git@github.com:acme/widget.git' });
  assert.equal(plan.name, 'widget');
});

test('parseCloneArgs takes an optional route and exactly one name', () => {
  assert.deepEqual(parseCloneArgs(['acme/product', 'crew'], ['acme/product', 'other/thing']), { route: 'acme/product', name: 'crew' });
  assert.deepEqual(parseCloneArgs(['crew'], ['acme/product']), { route: 'acme/product', name: 'crew' });
  assert.throws(() => parseCloneArgs(['crew'], ['a/b', 'c/d']), ReposError);
  assert.throws(() => parseCloneArgs(['nope/x', 'crew'], ['a/b']), ReposError);
  assert.throws(() => parseCloneArgs([], ['a/b']), ReposError);
});

test('clone plans a checkout under the route directory and records it as dir', () => {
  const p = planRepoClone({ text: empty, base: BASE, route: 'acme/product', name: 'Crew', resolved });
  assert.equal(p.remote, 'acme/crew');
  assert.equal(p.name, 'crew');
  assert.equal(p.mode, 'dir');
  assert.match(p.target, /\/Crew\/acme\/crew$/);
  assert.equal(route(p.text, 'acme/product').dir, p.target);
});

test('clone honors --dir and the route reposBasePath', () => {
  assert.equal(planRepoClone({ text: empty, base: BASE, route: 'acme/product', name: 'crew', resolved, dir: '/src/mine' }).target, '/src/mine');
  const text = empty.replace('  - route: acme/product\n', '  - route: acme/product\n    reposBasePath: /work\n');
  assert.equal(planRepoClone({ text, base: BASE, route: 'acme/product', name: 'crew', resolved }).target, '/work/acme/crew');
});

test('a second clone moves the route to repos', () => {
  const first = planRepoClone({ text: empty, base: BASE, route: 'acme/product', name: 'crew', resolved, dir: '/src/crew' });
  const second = planRepoClone({ text: first.text, base: BASE, route: 'acme/product', name: 'synthesis', resolved, dir: '/src/synthesis' });
  assert.equal(second.mode, 'repos');
  assert.deepEqual(route(second.text, 'acme/product').repos, { crew: '/src/crew', synthesis: '/src/synthesis' });
});

test('clone refuses a row with no remote, an unknown row, and an already-attached repo', () => {
  const noRemote = { repoNames: { r1: 'crew' }, repoRemotes: {} };
  assert.throws(() => planRepoClone({ text: empty, base: BASE, route: 'acme/product', name: 'crew', resolved: noRemote }), /no remote to clone from/);
  assert.throws(() => planRepoClone({ text: empty, base: BASE, route: 'acme/product', name: 'ghost', resolved }), /no Repos row named "ghost"/);
  const first = planRepoClone({ text: empty, base: BASE, route: 'acme/product', name: 'crew', resolved, dir: '/src/crew' });
  assert.throws(() => planRepoClone({ text: first.text, base: BASE, route: 'acme/product', name: 'crew', resolved }), /already has a checkout named "crew"/);
});

const listText = `routes:
  - route: acme/product
    enabled: true
    repos:
      crew:
        dir: /src/crew
        hooks:
          test: npm test
      stray: /src/stray
      spec: /src/spec
`;
const listIn = (over: Partial<Parameters<typeof listRepoRows>[0]> = {}) => ({
  text: listText, route: 'acme/product', base: BASE, resolved,
  originOf: (d: string) => ({ '/src/crew': 'git@github.com:acme/crew.git', '/src/stray': 'git@github.com:acme/other.git', '/src/spec': 'git@github.com:acme/spec.git' } as Record<string, string>)[d],
  exists: (d: string) => d !== '/src/stray',
  repoHasHooks: (d: string) => d === '/src/spec',
  ...over,
});

test('listRepoRows lists attached and unattached Repos rows plus unmatched checkouts', () => {
  const rows = listRepoRows(listIn());
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(rows.length, 4);
  assert.deepEqual(by.crew, { name: 'crew', remote: 'acme/crew', repoRowId: 'r2', attached: true, dir: '/src/crew', exists: true, origin: null, matchedRow: 'crew', hooksSource: 'route' });
  assert.deepEqual(by.synthesis, { name: 'synthesis', remote: 'Acme/synthesis', repoRowId: 'r1', attached: false, dir: null, exists: false, origin: null, matchedRow: null, hooksSource: 'none' });
  assert.equal(by.stray!.repoRowId, null);
  assert.equal(by.stray!.exists, false);
  assert.equal(by.stray!.origin, 'git@github.com:acme/other.git');
  assert.equal(by.spec!.hooksSource, 'repo');
});

test('listRepoRows reports an origin that differs from the row remote and a row with no remote', () => {
  const rows = listRepoRows(listIn({
    resolved: { repoNames: { r2: 'crew', r3: 'bare' }, repoRemotes: { r2: 'acme/elsewhere' } },
  }));
  const crew = rows.find((r) => r.name === 'crew')!;
  assert.equal(crew.attached, true); // matched by entry name
  assert.equal(crew.origin, 'git@github.com:acme/crew.git');
  assert.equal(rows.find((r) => r.name === 'bare')!.remote, null);
});
