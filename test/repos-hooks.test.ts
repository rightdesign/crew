import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { suggestHooks, planRouteHooks, clearRouteHooks, starterRepoConfig, parseHooksArgs, repoDirOf, existingRepoConfig, type CheckoutFiles } from '../src/repos-hooks.ts';
import { ReposError } from '../src/repos-cmd.ts';

const tree = (files: Record<string, string>): CheckoutFiles => ({
  exists: (r) => r in files,
  read: (r) => files[r],
});
const route = (text: string, name: string) => (parse(text).routes as Array<Record<string, any>>).find((r) => r.route === name)!;

test('package.json: scripts and package manager from the lockfile', () => {
  const pkg = JSON.stringify({ version: '1.2.3', scripts: { test: 'x', build: 'y' } });
  const s = suggestHooks(tree({ 'package.json': pkg, 'pnpm-lock.yaml': '' }));
  assert.equal(s.source, 'package.json');
  assert.equal(s.hooks.test, 'pnpm test');
  assert.equal(s.hooks.build, 'pnpm run build');
  assert.match(s.hooks.version!, /package\.json/);
  assert.match(s.hooks.bump!, /CREW_BUMP/);
  assert.equal(suggestHooks(tree({ 'package.json': pkg, 'yarn.lock': '' })).hooks.build, 'yarn build');
  assert.equal(suggestHooks(tree({ 'package.json': pkg })).hooks.test, 'npm test');
});

test('package.json without scripts proposes only what it states', () => {
  const s = suggestHooks(tree({ 'package.json': JSON.stringify({ scripts: { test: 't' } }) }));
  assert.deepEqual(s.hooks, { test: 'npm test' });
});

test('Package.swift, pyproject and Makefile fixtures', () => {
  assert.deepEqual(suggestHooks(tree({ 'Package.swift': '' })).hooks, { test: 'swift test', build: 'swift build' });
  assert.deepEqual(suggestHooks(tree({ 'pyproject.toml': '' })).hooks, { test: 'pytest' });
  assert.deepEqual(suggestHooks(tree({ Makefile: 'build:\n\tcc\ntest: build\n\t./t\n' })).hooks, { test: 'make test', build: 'make build' });
  assert.deepEqual(suggestHooks(tree({ Makefile: 'all:\n\tcc\n' })).hooks, {});
});

test('several ecosystems: first wins, others noted; unreadable proposes nothing', () => {
  const s = suggestHooks(tree({ 'Package.swift': '', Makefile: 'test:\n' }));
  assert.equal(s.source, 'Package.swift');
  assert.match(s.notes[0]!, /Makefile/);
  const none = suggestHooks(tree({ 'package.json': '{not json' }));
  assert.equal(none.source, null);
  assert.deepEqual(none.hooks, {});
  assert.ok(none.notes.length > 0);
});

const cfg = `ship:
  name: box
routes:
  # keep me
  - route: a/b
    dir: /src/x
  - route: c/d
    repos:
      p: /src/p
      q:
        dir: /src/q
        hooks:
          test: "make check"
`;

test('route write on dir: adds hooks and leaves comments and other routes', () => {
  const p = planRouteHooks(cfg, 'a/b', 'x', { test: 'npm test', build: 'npm run build' });
  assert.deepEqual(route(p.text, 'a/b').hooks, { test: 'npm test', build: 'npm run build' });
  assert.deepEqual(route(p.text, 'c/d'), route(cfg, 'c/d'));
  assert.match(p.text, /# keep me/);
});

test('route write on a repos map converts a bare path and never overwrites a set hook', () => {
  const a = planRouteHooks(cfg, 'c/d', 'p', { test: 'pytest' });
  assert.deepEqual(route(a.text, 'c/d').repos.p, { dir: '/src/p', hooks: { test: 'pytest' } });
  const b = planRouteHooks(cfg, 'c/d', 'q', { test: 'npm test', build: 'npm run build' });
  assert.deepEqual(route(b.text, 'c/d').repos.q.hooks, { test: 'make check', build: 'npm run build' });
  assert.deepEqual(b.kept, ['test']);
  assert.deepEqual(b.written, ['build']);
});

test('starter .crew.yaml passes the repo spec and refuses an existing file', () => {
  const text = starterRepoConfig({ test: 'swift test', build: 'swift build' });
  assert.match(text, /mode: integrate/);
  assert.match(text, /test: "swift test"/);
  starterRepoConfig({});
  assert.equal(existingRepoConfig(tree({ '.crew.yml': '' })), '.crew.yml');
  assert.equal(existingRepoConfig(tree({})), undefined);
});

test('argument parsing and repo lookup', () => {
  assert.deepEqual(parseHooksArgs(['a/b', 'x'], ['a/b', 'c/d']), { route: 'a/b', name: 'x' });
  assert.deepEqual(parseHooksArgs(['x'], ['a/b']), { route: 'a/b', name: 'x' });
  assert.throws(() => parseHooksArgs(['x'], ['a/b', 'c/d']), ReposError);
  assert.equal(repoDirOf(cfg, '/cfg', 'c/d', 'q'), '/src/q');
  assert.throws(() => repoDirOf(cfg, '/cfg', 'c/d', 'zz'), /have: p, q/);
});

test('replace overwrites named route hooks and leaves the rest (CREW-2523)', () => {
  const b = planRouteHooks(cfg, 'c/d', 'q', { test: 'npm test', build: 'npm run build' }, { replace: true });
  assert.deepEqual(route(b.text, 'c/d').repos.q.hooks, { test: 'npm test', build: 'npm run build' });
  assert.deepEqual(b.replaced, ['test']);
  assert.deepEqual(b.written, ['test', 'build']);
  assert.deepEqual(b.kept, []);
  const c = planRouteHooks(b.text, 'c/d', 'q', { test: 'other' }, { replace: true });
  assert.deepEqual(route(c.text, 'c/d').repos.q.hooks, { test: 'other', build: 'npm run build' });
});

test('clear removes the route hooks map, keeps dir and comments (CREW-2523)', () => {
  const a = clearRouteHooks(cfg, 'c/d', 'q');
  assert.deepEqual(a.removed, ['test']);
  assert.deepEqual(route(a.text, 'c/d').repos.q, { dir: '/src/q' });
  assert.deepEqual(route(a.text, 'c/d').repos.p, '/src/p');
  assert.match(a.text, /# keep me/);
  const none = clearRouteHooks(cfg, 'c/d', 'p');
  assert.deepEqual(none.removed, []);
  assert.equal(none.text, cfg);
  const dirRoute = planRouteHooks(cfg, 'a/b', 'x', { test: 'npm test' });
  const cleared = clearRouteHooks(dirRoute.text, 'a/b', 'x');
  assert.deepEqual(cleared.removed, ['test']);
  assert.equal(route(cleared.text, 'a/b').hooks, undefined);
});
