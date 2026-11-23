// CREW-4019: `crew status` reads the open board once per run, and `--json --no-tracker` makes no tracker request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

async function withStub(args: string[], sharedHome?: string, withRepo = false): Promise<{ urls: string[]; stdout: string; stderr: string; code: number | null }> {
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end('[]');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const home = sharedHome ?? mkdtempSync(join(tmpdir(), 'crew-status-reads-'));
  if (!sharedHome) mkdirSync(join(home, 'state'));
  if (!sharedHome) execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: home });
  if (!sharedHome) execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: home });
  writeFileSync(join(home, '.env'), 'KEY=k\n');
  const cfg = join(home, 'crew.yaml');
  writeFileSync(cfg, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
  - route: test/proj
    enabled: true
    dir: ${home}
    baseUrl: http://127.0.0.1:${port}
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-1
      projectId: p-1
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
${withRepo ? `      reposModelId: rm\n      repoNames: { r1: myrepo }\n    repos:\n      myrepo: ${home}\n` : ''}`);
  const child = spawn(process.execPath, [CREW, 'status', ...args], {
    env: { ...process.env, ...CREW_ENV, CREW_CONFIG: cfg, HOME: home },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const [code] = (await once(child, 'close')) as [number | null];
  server.close();
  return { urls, stdout, stderr, code };
}

const issueReads = (urls: string[]): number => urls.filter((u) => /\/data-models\/i\/records\?/.test(u) && u.includes('filters=')).length;

test('a full crew status reads the open tickets once', async () => {
  const text = await withStub([]);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(issueReads(text.urls), 1, text.urls.join('\n'));
  const json = await withStub(['--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(issueReads(json.urls), 1, json.urls.join('\n'));
});

test('--json --no-tracker makes no tracker request and says what it left out', async () => {
  const light = await withStub(['--json', '--no-tracker']);
  assert.equal(light.code, 0, light.stderr);
  assert.deepEqual(light.urls, []);
  const doc = JSON.parse(light.stdout) as Record<string, unknown> & { tracker: { read: boolean; readAt: unknown; omitted: string[] } };
  assert.equal(doc.tracker.read, false);
  assert.equal(doc.tracker.readAt, null);
  assert.ok(doc.tracker.omitted.includes('todo') && doc.tracker.omitted.includes('ships'));
  assert.ok(!('todo' in doc) && !('ships' in doc));
});

test('the light document carries the same local values as the full one, and the full one is stamped', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-status-reads-'));
  mkdirSync(join(home, 'state'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: home });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: home });
  const full = await withStub(['--json'], home);
  const light = await withStub(['--json', '--no-tracker'], home);
  type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const f = JSON.parse(full.stdout) as Doc;
  const l = JSON.parse(light.stdout) as Doc;
  assert.equal(f.tracker.read, true);
  assert.ok(!Number.isNaN(Date.parse(f.tracker.readAt as string)));
  for (const k of ['version', 'runs', 'periscopes', 'watermark']) assert.deepEqual(l[k], f[k], k);
  assert.deepEqual(l.crew.paused, f.crew.paused);
  assert.deepEqual(l.crew.roles, f.crew.roles);
  assert.deepEqual(l.route.repos, f.route.repos);
  assert.equal(l.route.dir, f.route.dir);
  assert.equal(l.ship.stateDir, f.ship.stateDir);
});

test('--no-tracker without --json is refused', async () => {
  const r = await withStub(['--no-tracker']);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.urls, []);
  assert.match(r.stderr + r.stdout, /--no-tracker applies to --json/);
});

test('--json --no-tracker makes no request on a route that declares a repository with a tracker row', async () => {
  const light = await withStub(['--json', '--no-tracker'], undefined, true);
  assert.equal(light.code, 0, light.stderr);
  assert.deepEqual(light.urls, []);
  const doc = JSON.parse(light.stdout) as { route: { repos: { name: string }[] } };
  assert.deepEqual(doc.route.repos.map((r) => r.name), ['myrepo']);
  const full = await withStub(['--json'], undefined, true);
  assert.equal(full.code, 0, full.stderr);
  assert.ok(full.urls.some((u) => u.includes('/data-models/rm/records/r1')), full.urls.join('\n'));
});
