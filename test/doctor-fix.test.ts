import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { gatherHealth, planEnable, planFix, routesInScope, schedulerInstalled, type RouteHealth } from '../src/doctor-fix.ts';
import type { InstallPlan } from '../src/install.ts';

const clean = (route: string, o: Partial<RouteHealth> = {}): RouteHealth =>
  ({ route, enabled: false, hasRepos: true, problems: [], ...o });

test('offers to enable only clean, off routes that have a repo', () => {
  const p = planFix({
    host: 'macos', schedulerAbsent: false,
    routes: [
      clean('a/clean'),
      clean('a/broken', { problems: ['contract: x'] }),
      clean('a/norepo', { hasRepos: false }),
      clean('a/already', { enabled: true }),
    ],
  });
  assert.deepEqual(p.actions, [{ kind: 'enable', route: 'a/clean' }]);
});

test('recommends install after enabling, only when units are absent', () => {
  const routes = [clean('a/clean')];
  assert.deepEqual(planFix({ host: 'linux', schedulerAbsent: true, routes }).actions,
    [{ kind: 'enable', route: 'a/clean' }, { kind: 'install' }]);
  assert.deepEqual(planFix({ host: 'linux', schedulerAbsent: false, routes }).actions,
    [{ kind: 'enable', route: 'a/clean' }]);
});

test('an already-enabled sound route is enough to recommend install', () => {
  const p = planFix({ host: 'macos', schedulerAbsent: true, routes: [clean('a/on', { enabled: true })] });
  assert.deepEqual(p.actions, [{ kind: 'install' }]);
});

test('no install when no route is enabled and sound', () => {
  const p = planFix({ host: 'macos', schedulerAbsent: true, routes: [clean('a/bad', { problems: ['x'] }), clean('a/on', { enabled: true, problems: ['y'] })] });
  assert.deepEqual(p.actions, []);
});

test('Windows gets a note, never an install action', () => {
  const p = planFix({ host: 'windows', schedulerAbsent: true, routes: [clean('a/on', { enabled: true })] });
  assert.deepEqual(p.actions, []);
  assert.equal(p.notes.length, 1);
});

test('planEnable writes only the enabled key of the named route', () => {
  const text = `ship:\n  name: box\nroutes:\n  # main\n  - route: a/one\n    enabled: false\n    dir: /x\n  - route: a/two\n    enabled: false\n    dir: /y\n`;
  const out = planEnable(text, 'a/one');
  assert.equal(out, text.replace('enabled: false\n    dir: /x', 'enabled: true\n    dir: /x'));
  const routes = parse(out).routes as Array<Record<string, unknown>>;
  assert.equal(routes[0]!.enabled, true);
  assert.equal(routes[1]!.enabled, false);
});

test('planEnable adds the key when the route omits it', () => {
  const out = planEnable(`routes:\n  - route: a/one\n    dir: /x\n`, 'a/one');
  assert.equal((parse(out).routes as Array<Record<string, unknown>>)[0]!.enabled, true);
});

const plan = (o: Partial<InstallPlan>): InstallPlan => ({
  mechanism: 'launchd', unitPaths: ['/u/run.plist'], unitContent: {}, crontabLine: null,
  preLoadCommands: [], loadCommands: [], crewLog: '', schedulerLog: '', cronMarker: null, ...o,
});

test('schedulerInstalled: unit files for launchd/systemd, marker for cron', () => {
  assert.equal(schedulerInstalled(plan({}), () => true, ''), true);
  assert.equal(schedulerInstalled(plan({}), () => false, ''), false);
  const cron = plan({ mechanism: 'cron', unitPaths: [], cronMarker: '# crew:run:abc' });
  assert.equal(schedulerInstalled(cron, () => false, '0 * * * * x # crew:run:abc\n'), true);
  assert.equal(schedulerInstalled(cron, () => false, ''), false);
});

test('a route whose checks throw is reported as failing and never enabled', async () => {
  const bad = await gatherHealth({ route: 'a/unconnected', enabled: false, hasRepos: true }, async () => {
    throw new Error('route "a/unconnected" has no resolved ids — run crew connect');
  });
  assert.match(bad.problems[0]!, /checks could not run: .*crew connect/);
  const good = await gatherHealth({ route: 'a/clean', enabled: false, hasRepos: true }, async () => []);
  assert.deepEqual(planFix({ host: 'macos', schedulerAbsent: false, routes: [bad, good] }).actions,
    [{ kind: 'enable', route: 'a/clean' }]);
});

test('a named route limits the fix to that route', () => {
  const routes = [{ route: 'a/one' }, { route: 'a/two' }];
  assert.deepEqual(routesInScope(routes, 'a/two'), [{ route: 'a/two' }]);
  assert.deepEqual(routesInScope(routes, undefined), routes);
});
