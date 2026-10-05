import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  planContainers, portFor, containerNameFor, listPassengerContainers, startContainer, stopContainer,
  syncPassengerContainers, syncAllPassengerCheckouts, dockerAvailable, passengerImageRef, ensureImage, type Exec, type ContainerPlan,
} from '../src/passenger-containers.ts';
import type { CrewConfig, Route } from '../src/config.ts';
import { passengerCheckoutDir } from '../src/config.ts';

const REPOS_BASE = '/tmp/repos-base';

function makeRoute(opts: {
  route: string; enabled?: boolean; hostPassengers?: boolean; workspaceId?: string;
  repos?: Record<string, string>; repoOverrides?: Record<string, { hostPassengers?: boolean }>;
  reposBasePath?: string;
}): Route {
  return {
    route: opts.route,
    enabled: opts.enabled ?? true,
    dir: '/tmp/does-not-matter',
    repos: opts.repos ?? { only: '/tmp/only' },
    repoOverrides: opts.repoOverrides ?? {},
    reposBasePath: opts.reposBasePath ?? REPOS_BASE,
    hostPassengers: opts.hostPassengers ?? false,
    baseUrl: 'https://example.test',
    apiKey: 'sk_test',
    hooks: {},
    labels: {},
    release: {},
    resolved: opts.workspaceId ? {
      workspaceId: opts.workspaceId,
      models: { issues: 'i', comments: 'c', crew: 'm' },
      seats: {},
      operator: 'op-1',
      holds: [],
    } : undefined,
  } as unknown as Route;
}

/** The dedicated passenger checkout path a mount should now resolve to (ISSUE-554). */
function checkoutFor(route: string, repoName: string): string {
  const [workspace] = route.split('/');
  return passengerCheckoutDir(REPOS_BASE, workspace!, repoName);
}

function makeConfig(routes: Route[]): CrewConfig {
  return { ship: { stateDir: '/tmp/state' }, routes, crewHome: '/tmp/crew' } as unknown as CrewConfig;
}

test('planContainers() ignores a route with hostPassengers off', () => {
  const cfg = makeConfig([makeRoute({ route: 'w/a', hostPassengers: false, workspaceId: 'ws-1' })]);
  assert.deepEqual(planContainers(cfg), []);
});

test('planContainers() ignores a route with hostPassengers on but not yet resolved (no workspaceId)', () => {
  const cfg = makeConfig([makeRoute({ route: 'w/a', hostPassengers: true })]);
  assert.deepEqual(planContainers(cfg), []);
});

test('planContainers() ignores a disabled route even with hostPassengers on', () => {
  const cfg = makeConfig([makeRoute({ route: 'w/a', hostPassengers: true, enabled: false, workspaceId: 'ws-1' })]);
  assert.deepEqual(planContainers(cfg), []);
});

test('planContainers() produces one plan per workspace, with a stable deterministic port', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { alpha: '/tmp/alpha' } }),
  ]);
  const plans = planContainers(cfg);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.workspaceId, 'ws-1');
  assert.equal(plans[0]!.containerName, containerNameFor('ws-1'));
  assert.equal(plans[0]!.port, portFor('ws-1'));
  assert.deepEqual(
    plans[0]!.mounts,
    [{ hostPath: checkoutFor('w/a', 'alpha'), containerPath: '/workspace/alpha' }],
  );
});

test('planContainers() mounts the DEDICATED passenger checkout, never the repo\'s ordinary working directory', () => {
  // The whole point of ISSUE-554: `repos: { alpha: '/tmp/alpha' }` names an
  // operator-placed working directory, which a builder role can leave dirty
  // or mid-branch — Host Passengers must never mount that directly.
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { alpha: '/tmp/alpha' } }),
  ]);
  const [mount] = planContainers(cfg)[0]!.mounts;
  assert.notEqual(mount!.hostPath, '/tmp/alpha');
  assert.equal(mount!.hostPath, checkoutFor('w/a', 'alpha'));
});

test('portFor() is deterministic — same workspace id, same port, every call', () => {
  assert.equal(portFor('ws-1'), portFor('ws-1'));
  assert.notEqual(portFor('ws-1'), portFor('ws-2'));
});

test('planContainers() merges repo targets across two routes that share a workspace, deduped by repo name', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { crew: '/tmp/crew' } }),
    makeRoute({ route: 'w/b', hostPassengers: true, workspaceId: 'ws-1', repos: { crew: '/tmp/crew', other: '/tmp/other' } }),
  ]);
  const plans = planContainers(cfg);
  assert.equal(plans.length, 1);
  assert.deepEqual(
    plans[0]!.mounts.map((m) => m.containerPath).sort(),
    ['/workspace/crew', '/workspace/other'],
  );
});

test('planContainers() excludes a workspace whose only route opted every repo out (repos: <name>: hostPassengers: false)', () => {
  const cfg = makeConfig([
    makeRoute({
      route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' },
      repoOverrides: { only: { hostPassengers: false } },
    }),
  ]);
  assert.deepEqual(planContainers(cfg), []);
});

test('planContainers() gives two different workspaces two different mountsHash values for the same single repo name', () => {
  // Distinct WORKSPACE SLUGS (the part of `route` before the `/`), not just
  // distinct resolved workspaceIds — a mount's path is keyed by that slug
  // the same way `defaultRepoDir` already keys an ordinary checkout, so two
  // routes sharing one slug are expected to share one dedicated checkout
  // (decision 6 in the Map: several routes may share one real workspace).
  const cfg = makeConfig([
    makeRoute({ route: 'w1/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/a' } }),
    makeRoute({ route: 'w2/a', hostPassengers: true, workspaceId: 'ws-2', repos: { only: '/tmp/b' } }),
  ]);
  const plans = planContainers(cfg);
  assert.equal(plans.length, 2);
  assert.notEqual(plans[0]!.mountsHash, plans[1]!.mountsHash);
});

/** Runs `fn` with `CREW_PASSENGER_IMAGE` set to `value` (or unset), restoring the caller's env afterwards. */
function withEnvImage<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.CREW_PASSENGER_IMAGE;
  if (value === undefined) delete process.env.CREW_PASSENGER_IMAGE;
  else process.env.CREW_PASSENGER_IMAGE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CREW_PASSENGER_IMAGE;
    else process.env.CREW_PASSENGER_IMAGE = prev;
  }
}

test('passengerImageRef() defaults to the Hub repository tagged with this crew\'s own version', () => {
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-version-'));
  writeFileSync(join(crewHome, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const cfg = { ship: { stateDir: '/tmp/state' }, routes: [], crewHome } as unknown as CrewConfig;
  withEnvImage(undefined, () => {
    assert.equal(passengerImageRef(cfg), 'tablation/crew-passenger-mcp:1.2.3');
  });
});

test('passengerImageRef() prefers ship.passengerImage over the default, and CREW_PASSENGER_IMAGE over both', () => {
  const cfg = { ship: { stateDir: '/tmp/state', passengerImage: 'crew-passenger-mcp:dev' }, routes: [], crewHome: '/tmp/crew' } as unknown as CrewConfig;
  withEnvImage(undefined, () => {
    assert.equal(passengerImageRef(cfg), 'crew-passenger-mcp:dev');
  });
  withEnvImage('crew-passenger-mcp:env', () => {
    assert.equal(passengerImageRef(cfg), 'crew-passenger-mcp:env');
  });
});

test('planContainers() carries the resolved image on each plan, and a different image changes the mountsHash', () => {
  const routes = [makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' } })];
  const plansAt = (image: string) => withEnvImage(undefined, () => planContainers(
    { ...makeConfig(routes), ship: { stateDir: '/tmp/state', passengerImage: image } } as unknown as CrewConfig,
  ));
  const before = plansAt('tablation/crew-passenger-mcp:1.0.0')[0]!;
  const after = plansAt('tablation/crew-passenger-mcp:1.1.0')[0]!;
  assert.equal(before.image, 'tablation/crew-passenger-mcp:1.0.0');
  assert.notEqual(before.mountsHash, after.mountsHash, 'an image upgrade must read as a stale container so it is recreated');
});

test('ensureImage() does nothing when Docker already has the image, and never pulls a present tag', () => {
  const { exec, calls } = fakeExec();
  ensureImage('tablation/crew-passenger-mcp:1.0.0', exec);
  assert.deepEqual(calls, [['docker', 'image', 'inspect', 'tablation/crew-passenger-mcp:1.0.0']]);
});

test('ensureImage() pulls an image Docker does not have locally', () => {
  const { exec, calls } = fakeExec();
  const missing: Exec = (cmd, args) => {
    if (args[0] === 'image') throw new Error('No such image');
    return exec(cmd, args);
  };
  ensureImage('tablation/crew-passenger-mcp:1.0.0', missing);
  assert.deepEqual(calls.slice(-1), [['docker', 'pull', 'tablation/crew-passenger-mcp:1.0.0']]);
});

test('ensureImage() surfaces a failed pull rather than swallowing it', () => {
  const failing: Exec = (_cmd, args) => {
    if (args[0] === 'image') throw new Error('No such image');
    throw new Error('pull access denied for tablation/crew-passenger-mcp');
  };
  assert.throws(() => ensureImage('tablation/crew-passenger-mcp:1.0.0', failing), /pull access denied/);
});

test('syncPassengerContainers() pulls the image before starting a container, when Docker lacks it', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' } }),
  ]);
  const { exec, calls } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': '',
  });
  const missing: Exec = (cmd, args) => {
    if (args[0] === 'image') throw new Error('No such image');
    return exec(cmd, args);
  };
  withEnvImage(undefined, () => syncPassengerContainers(cfg, 'https://app.tablation.com/api', missing));

  const pullAt = calls.findIndex((c) => c[1] === 'pull');
  const runAt = calls.findIndex((c) => c[1] === 'run');
  assert.ok(pullAt >= 0 && runAt > pullAt, 'the pull must happen before the run');
});

test('syncPassengerContainers() never touches Docker Hub while a healthy container is already running', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' } }),
  ]);
  const plans = withEnvImage(undefined, () => planContainers(cfg));
  const name = plans[0]!.containerName;
  const { exec, calls } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': `${name}\trunning\n`,
    [`docker inspect --format {{ index .Config.Labels "crew.mounts.hash" }} ${name}`]: `${plans[0]!.mountsHash}\n`,
  });
  withEnvImage(undefined, () => syncPassengerContainers(cfg, 'https://app.tablation.com/api', exec));
  assert.ok(!calls.some((c) => c[1] === 'pull' || c[1] === 'image'));
});

/** Records every docker invocation and lets a test script canned responses per argv-joined key. */
function fakeExec(responses: Record<string, string> = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    if (key in responses) return responses[key]!;
    // `docker ps -a --filter ...` etc. default to empty output unless a test overrides it.
    return '';
  };
  return { exec, calls };
}

test('dockerAvailable() is true when `docker info` succeeds, false when it throws', () => {
  const ok: Exec = () => '';
  assert.equal(dockerAvailable(ok), true);
  const broken: Exec = () => { throw new Error('no docker'); };
  assert.equal(dockerAvailable(broken), false);
});

test('listPassengerContainers() parses newline-separated name+state pairs, dropping blanks', () => {
  const { exec } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}':
      'crew-passenger-ws-1\trunning\ncrew-passenger-ws-2\texited\n',
  });
  assert.deepEqual(listPassengerContainers(exec), [
    { name: 'crew-passenger-ws-1', running: true },
    { name: 'crew-passenger-ws-2', running: false },
  ]);
});

test('startContainer() runs `docker run -d` with one -v per mount, the mountsHash label, and the plan\'s image', () => {
  const { exec, calls } = fakeExec();
  const plan: ContainerPlan = {
    workspaceId: 'ws-1', containerName: 'crew-passenger-ws-1', port: 28800, image: 'tablation/crew-passenger-mcp:9.9.9',
    mounts: [{ hostPath: '/tmp/a', containerPath: '/workspace/a' }, { hostPath: '/tmp/b', containerPath: '/workspace/b' }],
    mountsHash: 'deadbeef',
  };
  startContainer(plan, 'https://app.tablation.com/api', undefined, exec);

  assert.equal(calls.length, 1);
  const [cmd, ...args] = calls[0]!;
  assert.equal(cmd, 'docker');
  assert.deepEqual(args.slice(0, 3), ['run', '-d', '--name']);
  assert.ok(args.includes('crew-passenger-ws-1'));
  assert.ok(args.includes('28800:8765'));
  assert.ok(args.includes('PASSENGER_MCP_WORKSPACE_ID=ws-1'));
  assert.ok(args.includes('TABLATION_API_BASE_URL=https://app.tablation.com/api'));
  assert.ok(args.includes('crew.mounts.hash=deadbeef'));
  assert.ok(args.includes('/tmp/a:/workspace/a:ro'));
  assert.ok(args.includes('/tmp/b:/workspace/b:ro'));
  assert.equal(args[args.length - 1], 'tablation/crew-passenger-mcp:9.9.9');
  assert.ok(!args.includes('host.docker.internal:host-gateway'), 'no --add-host without a sync endpoint');
});

test('startContainer() wires up the sync-daemon callback when given a SyncDaemonEndpoint', () => {
  const { exec, calls } = fakeExec();
  const plan: ContainerPlan = {
    workspaceId: 'ws-1', containerName: 'crew-passenger-ws-1', port: 28800, image: 'tablation/crew-passenger-mcp:9.9.9',
    mounts: [{ hostPath: '/tmp/a', containerPath: '/workspace/a' }],
    mountsHash: 'deadbeef',
  };
  startContainer(plan, 'https://app.tablation.com/api', { host: 'host.docker.internal', port: 30800, secret: 'sekrit' }, exec);

  const [, ...args] = calls[0]!;
  assert.ok(args.includes('host.docker.internal:host-gateway'));
  assert.ok(args.includes('PASSENGER_SYNC_URL=http://host.docker.internal:30800/sync'));
  assert.ok(args.includes('PASSENGER_SYNC_SECRET=sekrit'));
  // ISSUE-685: the same sync secret doubles as the MCP auth secret.
  assert.ok(args.includes('PASSENGER_MCP_SECRET=sekrit'));
});

test('startContainer() omits PASSENGER_MCP_SECRET, same as the sync env vars, when there is no sync endpoint (ISSUE-685)', () => {
  const { exec, calls } = fakeExec();
  const plan: ContainerPlan = {
    workspaceId: 'ws-1', containerName: 'crew-passenger-ws-1', port: 28800, image: 'tablation/crew-passenger-mcp:9.9.9',
    mounts: [{ hostPath: '/tmp/a', containerPath: '/workspace/a' }],
    mountsHash: 'deadbeef',
  };
  startContainer(plan, 'https://app.tablation.com/api', undefined, exec);

  const [, ...args] = calls[0]!;
  assert.ok(!args.some((a) => a.startsWith('PASSENGER_MCP_SECRET=')));
});

test('stopContainer() swallows an already-gone container rather than throwing', () => {
  const broken: Exec = () => { throw new Error('no such container'); };
  assert.doesNotThrow(() => stopContainer('crew-passenger-ws-1', broken));
});

test('syncPassengerContainers() starts a planned container that is not yet running', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' } }),
  ]);
  const { exec, calls } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': '',
  });
  const result = syncPassengerContainers(cfg, 'https://app.tablation.com/api', exec);

  assert.deepEqual(result.started, [containerNameFor('ws-1')]);
  assert.deepEqual(result.recreated, []);
  assert.deepEqual(result.stopped, []);
  assert.ok(calls.some((c) => c[0] === 'docker' && c[1] === 'run'));
});

test('syncPassengerContainers() leaves a running container alone when its mountsHash label already matches the plan', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' } }),
  ]);
  const plans = planContainers(cfg);
  const name = plans[0]!.containerName;
  const { exec, calls } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': `${name}\trunning\n`,
    [`docker inspect --format {{ index .Config.Labels "crew.mounts.hash" }} ${name}`]: `${plans[0]!.mountsHash}\n`,
  });
  const result = syncPassengerContainers(cfg, 'https://app.tablation.com/api', exec);

  assert.deepEqual(result, { started: [], recreated: [], stopped: [] });
  assert.ok(!calls.some((c) => c[0] === 'docker' && (c[1] === 'run' || c[1] === 'rm')));
});

test('syncPassengerContainers() recreates a running container whose mountsHash label has gone stale', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' } }),
  ]);
  const plans = planContainers(cfg);
  const name = plans[0]!.containerName;
  const { exec } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': `${name}\trunning\n`,
    [`docker inspect --format {{ index .Config.Labels "crew.mounts.hash" }} ${name}`]: 'stale-hash\n',
  });
  const result = syncPassengerContainers(cfg, 'https://app.tablation.com/api', exec);

  assert.deepEqual(result.recreated, [name]);
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.stopped, []);
});

test('syncPassengerContainers() stops a running container whose workspace is no longer planned (toggle went off)', () => {
  const cfg = makeConfig([]); // no routes at all -> nothing planned
  const { exec, calls } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': 'crew-passenger-ws-old\trunning\n',
  });
  const result = syncPassengerContainers(cfg, 'https://app.tablation.com/api', exec);

  assert.deepEqual(result.stopped, ['crew-passenger-ws-old']);
  assert.ok(calls.some((c) => c[0] === 'docker' && c[1] === 'rm' && c.includes('crew-passenger-ws-old')));
});

test('syncPassengerContainers() restarts a planned container that is present but Exited, rather than leaving it alone (ISSUE-700)', () => {
  const cfg = makeConfig([
    makeRoute({ route: 'w/a', hostPassengers: true, workspaceId: 'ws-1', repos: { only: '/tmp/only' } }),
  ]);
  const plans = planContainers(cfg);
  const name = plans[0]!.containerName;
  const { exec, calls } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': `${name}\texited\n`,
  });
  const result = syncPassengerContainers(cfg, 'https://app.tablation.com/api', exec);

  assert.deepEqual(result.started, [name]);
  assert.deepEqual(result.recreated, []);
  assert.deepEqual(result.stopped, []);
  assert.ok(calls.some((c) => c[0] === 'docker' && c[1] === 'rm' && c.includes(name)));
  assert.ok(calls.some((c) => c[0] === 'docker' && c[1] === 'run'));
  // never asks docker inspect about a container it's about to remove and recreate
  assert.ok(!calls.some((c) => c.join(' ').includes('docker inspect')));
});

test('syncPassengerContainers() stops (rm -f) a no-longer-planned container even when it is already Exited, not just running ones', () => {
  const cfg = makeConfig([]); // no routes at all -> nothing planned
  const { exec, calls } = fakeExec({
    'docker ps -a --filter name=crew-passenger- --format {{.Names}}\t{{.State}}': 'crew-passenger-ws-old\texited\n',
  });
  const result = syncPassengerContainers(cfg, 'https://app.tablation.com/api', exec);

  assert.deepEqual(result.stopped, ['crew-passenger-ws-old']);
  assert.ok(calls.some((c) => c[0] === 'docker' && c[1] === 'rm' && c.includes('crew-passenger-ws-old')));
});

/* ── syncAllPassengerCheckouts(): the poll-cadence half of freshness
   (ISSUE-554, decision 8 in the Map) — real git operations against a
   throwaway bare origin, since this is exactly the fast-forward-or-report
   logic `syncPassengerCheckout` (git.ts) already covers, exercised through
   the route/config plumbing that picks which directory gets synced. ── */

test('syncAllPassengerCheckouts() fast-forwards a repo\'s dedicated checkout to what the ordinary checkout\'s config calls its base branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-passenger-sync-'));
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);

  const seed = join(root, 'seed');
  execFileSync('git', ['clone', '-q', bare, seed]);
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: seed });
  writeFileSync(join(seed, 'README.md'), 'x');
  execFileSync('git', ['add', '.'], { cwd: seed });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

  const basePath = join(root, 'repos-base');
  const checkoutDir = passengerCheckoutDir(basePath, 'w', 'crew');
  execFileSync('git', ['clone', '-q', bare, checkoutDir]);

  // Lands after the dedicated checkout was already cloned — this is what
  // the sync call below must catch up on.
  writeFileSync(join(seed, 'more.txt'), '1');
  execFileSync('git', ['add', '.'], { cwd: seed });
  execFileSync('git', ['commit', '-qm', 'more'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

  const cfg = makeConfig([
    makeRoute({
      route: 'w/a', hostPassengers: true, workspaceId: 'ws-1',
      repos: { crew: bare }, reposBasePath: basePath,
    }),
  ]);

  const results = syncAllPassengerCheckouts(cfg);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, 'crew');
  assert.equal(results[0]!.workspaceId, 'ws-1');
  assert.equal(results[0]!.outcome.action, 'fast-forwarded');
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir, encoding: 'utf8' }).trim(),
    execFileSync('git', ['rev-parse', 'main'], { cwd: bare, encoding: 'utf8' }).trim(),
  );
});

test('syncAllPassengerCheckouts() ignores every route with hostPassengers off, same as planContainers()', () => {
  const cfg = makeConfig([makeRoute({ route: 'w/a', hostPassengers: false, workspaceId: 'ws-1' })]);
  assert.deepEqual(syncAllPassengerCheckouts(cfg), []);
});
