// CREW-3645: a command's own failure is filed under that command and the route it was given,
// not under `poll` on the first configured route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

function route(name: string, home: string, baseUrl: string): string {
  return `  - route: ${name}
    enabled: true
    dir: ${home}
    baseUrl: ${baseUrl}
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-${name.replace('/', '-')}
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
`;
}

async function run(args: string[]): Promise<{ events: Array<Record<string, unknown>>; status: number | null; stderr: string }> {
  // The tracker refuses the key the way a key from another workspace is refused.
  const server = createServer((_q, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"message":"forbidden"}'); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const home = mkdtempSync(join(tmpdir(), 'crew-failscope-'));
  mkdirSync(join(home, 'state'));
  writeFileSync(join(home, '.env'), 'KEY=k\n');
  const cfg = join(home, 'crew.yaml');
  writeFileSync(cfg, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
${route('one/issues', home, baseUrl)}${route('two/issues', home, baseUrl)}`);
  const env: NodeJS.ProcessEnv = { ...process.env, ...CREW_ENV };
  delete env.CREW_API_KEY;
  delete env.CREW_LANE_ROLE; // the lane guard refuses state-writing commands from an agent session; this config is a throwaway
  const child = spawn(process.execPath, [CREW, ...args], {
    env: { ...env, CREW_CONFIG: cfg, HOME: mkdtempSync(join(tmpdir(), 'crew-failscope-home-')) },
    timeout: 30_000,
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const status = await new Promise<number | null>((ok) => child.on('close', ok));
  server.close();
  let events: Array<Record<string, unknown>> = [];
  try {
    events = readFileSync(join(home, 'state', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { /* no events written */ }
  return { events, status, stderr };
}

test('a refused `crew connect ROUTE` is filed under step connect and that route, not routes[0] and poll', async () => {
  const r = await run(['connect', 'two/issues', '--key', 'bad']);
  assert.notEqual(r.status, 0, r.stderr);
  const errors = r.events.filter((e) => e.level === 'error');
  assert.ok(errors.length >= 1, r.stderr);
  for (const e of errors) {
    assert.equal(e.step, 'connect');
    assert.equal(e.route, 'two/issues');
  }
});

test('a command given no route files its failure with no route', async () => {
  const r = await run(['connect', '--key', 'bad']);
  assert.notEqual(r.status, 0, r.stderr);
  const errors = r.events.filter((e) => e.level === 'error');
  assert.ok(errors.length >= 1, r.stderr);
  for (const e of errors) {
    assert.equal(e.step, 'connect');
    assert.equal(e.route, '');
  }
});
