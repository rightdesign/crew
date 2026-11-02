import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intelFlavor } from '../src/intel.ts';
import { intelPortFor, ticketForPort, DEFAULT_PORTS } from '../src/ports.ts';
import { ensureMainIndex, missingPrerequisites, serenaPaths, serenaProjectYaml, serenaServeArgs, startSerena, type SerenaDeps } from '../src/intel-serena.ts';
import { repoFindings } from '../src/doctor-problems.ts';

const fakeDeps = (over: Partial<SerenaDeps> = {}) => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const log: string[] = [];
  const deps: SerenaDeps = {
    onPath: () => true,
    exists: (p) => files.has(p) || dirs.has(p),
    mkdir: (p) => { dirs.add(p); },
    read: (p) => files.get(p),
    write: (p, t) => { files.set(p, t); },
    copyDir: (a, b) => { log.push(`copy ${a} -> ${b}`); dirs.add(b); },
    headOf: () => 'abc123',
    spawnDetached: (bin, args) => { log.push(`spawn ${bin} ${args.join(' ')}`); return 111; },
    spawnIndex: (args) => { log.push(`index ${args.join(' ')}`); return 222; },
    alive: () => false,
    ...over,
  };
  return { deps, files, dirs, log };
};
const start = { stateDir: '/s', route: 'r', ticket: 2914, worktree: '/w/crew-2914', mainCheckout: '/w/crew' };

test('a flavor name is recognized, anything else is a command', () => {
  assert.equal(intelFlavor('serena'), 'serena');
  assert.equal(intelFlavor(' typescript-lsp\n'), 'typescript-lsp');
  assert.equal(intelFlavor('scripts/dev-intel.sh'), undefined);
  assert.equal(intelFlavor('toString'), undefined);
  assert.equal(intelFlavor(undefined), undefined);
});

test('the intel port band keys on the ticket and is recognized by ticketForPort', () => {
  assert.equal(intelPortFor(2914 % 1000), 60914);
  assert.deepEqual(ticketForPort(60914, DEFAULT_PORTS), { n: 914, role: 'intel' });
});

test('start prints the URL, writes nothing in the worktree, and seeds the cache from main', () => {
  const { deps, files, dirs, log } = fakeDeps();
  const p = serenaPaths('/s', 'r', '2914');
  dirs.add(`${p.mainProject}/cache`);
  const r = startSerena(deps, start);
  assert.equal(r.code, 0);
  assert.match(r.output.trim(), /^http:\/\/127\.0\.0\.1:6\d{4}\/mcp$/);
  assert.ok(log.includes(`copy ${p.mainProject}/cache -> ${p.project}/cache`));
  assert.ok(log.some((l) => l.startsWith('spawn serena start-mcp-server') && l.includes('--context ide') && l.includes('--project /w/crew-2914')));
  assert.match(files.get(`${p.home}/serena_config.yml`)!, /web_dashboard: False/);
  assert.match(files.get(`${p.project}/project.yml`)!, /read_only: true/);
  for (const path of [...files.keys(), ...dirs]) assert.ok(!path.startsWith('/w/crew-2914'), path);
});

test('a worktree with its own cache keeps it', () => {
  const { deps, dirs, log } = fakeDeps();
  const p = serenaPaths('/s', 'r', '2914');
  dirs.add(`${p.mainProject}/cache`); dirs.add(`${p.project}/cache`);
  startSerena(deps, start);
  assert.ok(!log.some((l) => l.startsWith('copy')));
});

test('a missing prerequisite is a one-line failure naming the install line', () => {
  const { deps, log } = fakeDeps({ onPath: (b) => b === 'uv' });
  const r = startSerena(deps, start);
  assert.equal(r.code, 1);
  assert.match(r.output, /serena \(uv tool install -p 3\.13 serena-agent\)/);
  assert.equal(log.length, 0);
});

test('the main checkout is indexed once per commit, never twice at once', () => {
  const a = fakeDeps();
  assert.equal(ensureMainIndex(a.deps, start), 'started');
  assert.ok(a.log.includes('index project index /w/crew'));
  const p = serenaPaths('/s', 'r', '2914');
  a.files.set(`${p.mainProject}/indexed-commit`, 'abc123');
  assert.equal(ensureMainIndex(a.deps, start), 'fresh');
  a.files.set(`${p.mainProject}/indexed-commit`, 'old');
  const b = fakeDeps({ alive: () => true });
  b.files.set(`${p.mainProject}/indexed-commit`, 'old');
  b.files.set(`${p.mainProject}/indexing.pid`, '222');
  assert.equal(ensureMainIndex(b.deps, start), 'running');
});

test('a committed project.yml is kept and forced read-only', () => {
  assert.equal(serenaProjectYaml('languages:\n- swift\nread_only: false\n'), 'languages:\n- swift\nread_only: true\n');
  assert.equal(serenaProjectYaml('languages:\n- swift'), 'languages:\n- swift\nread_only: true\n');
  assert.deepEqual(serenaServeArgs(60914, '/w').slice(0, 5), ['start-mcp-server', '--transport', 'streamable-http', '--host', '127.0.0.1']);
});

test('doctor names the missing prerequisite of a flavor', () => {
  const base = { route: 'r', repo: 'crew', dir: '/x', notes: [], base: { message: '', failed: false, skipRest: false }, hooks: {}, onPath: () => true };
  const f = repoFindings({ ...base, intelFlavor: { name: 'serena', missing: missingPrerequisites('serena', (b) => b === 'uv') } });
  assert.equal(f.problems[0]!.kind, 'intel_prerequisite_missing');
  assert.match(f.problems[0]!.message, /uv tool install/);
  assert.equal(repoFindings({ ...base, intelFlavor: { name: 'serena', missing: [] } }).problems.length, 0);
});
