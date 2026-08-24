import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, connection, configuredMembers, reposOf, ticketsByRepo, ConfigError } from '../src/config.ts';

function withConfig(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cfg-'));
  const file = join(dir, 'crew.yaml');
  writeFileSync(file, yaml);
  return { dir, file };
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
connections:
  - name: synthesis
    workspace: issues
    project: Dev Crew
    dir: /tmp/proj
    worktreePrefix: proj-issue-
    baseUrl: https://example.test/
${RESOLVED}
`;

const TWO = `${ONE}  - name: tablation-js
    enabled: true
    workspace: issues
    dir: /tmp/other
    worktreePrefix: js-issue-
    baseUrl: https://example.test
${RESOLVED}
`;

test('a ship holds many connections', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.connections.length, 2);
  assert.deepEqual(cfg.connections.map((c) => c.name), ['synthesis', 'tablation-js']);
});

test('ship-level settings are shared; connection settings are not', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.ship.agent.model, 'claude-sonnet-5');
  assert.equal(cfg.connections[0]!.worktreePrefix, 'proj-issue-');
  assert.equal(cfg.connections[1]!.worktreePrefix, 'js-issue-');
});

test('the platform this ship IS is detected; what a project NEEDS defaults to any', () => {
  const { dir, file } = withConfig(ONE);
  const cfg = loadConfig(dir, file);
  assert.ok(['macos', 'linux', 'windows'].includes(cfg.ship.platform));
  assert.equal(cfg.connections[0]!.platform, 'any');
});

test('connections are addressed by name', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(connection(cfg, 'tablation-js').dir, '/tmp/other');
  assert.throws(() => connection(cfg, 'nope'), /no connection named "nope"/);
});

test('with several connections and no name, the single enabled one is implied', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(connection(cfg).name, 'tablation-js'); // the only one enabled
});

test('ambiguity is refused rather than guessed', () => {
  const both = TWO.replace('  - name: synthesis\n', '  - name: synthesis\n    enabled: true\n');
  const { dir, file } = withConfig(both);
  assert.throws(() => connection(loadConfig(dir, file)), /name one: synthesis, tablation-js/);
});

test('duplicate connection names are refused — a name is an address', () => {
  const dup = TWO.replace('name: tablation-js', 'name: synthesis');
  const { dir, file } = withConfig(dup);
  assert.throws(() => loadConfig(dir, file), /duplicate name "synthesis"/);
});

test('the interlock is per connection and opt-in', () => {
  const { dir, file } = withConfig(TWO);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.connections[0]!.enabled, false);
  assert.equal(cfg.connections[1]!.enabled, true);
});

test('every missing setting is reported at once, named by connection index', () => {
  const { dir, file } = withConfig('ship: {}\nconnections:\n  - name: x\n');
  assert.throws(() => loadConfig(dir, file), (e: Error) => {
    assert.ok(e instanceof ConfigError);
    for (const p of ['connections[0].workspace', 'connections[0].dir']) {
      assert.match(e.message, new RegExp(p.replace(/[.[\]]/g, '\\$&')));
    }
    return true;
  });
});

test('worktreePrefix is optional — a connection that says nothing gets no ship-level override', () => {
  const noPrefix = TWO.replace(/^\s*worktreePrefix:.*\n/m, '');
  const { dir, file } = withConfig(noPrefix);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.connections[0]!.worktreePrefix, undefined);
});

test('a config with no connections is refused', () => {
  const { dir, file } = withConfig('ship: {}\n');
  assert.throws(() => loadConfig(dir, file), /connections \(at least one\)/);
});

test('configuredMembers reads the resolved ids, not authored ones', () => {
  const { dir, file } = withConfig(ONE);
  const conn = connection(loadConfig(dir, file), 'synthesis');
  assert.deepEqual(configuredMembers(conn), [
    { id: 'dev-1', role: 'Dev', kind: 'seat' },
    { id: 'qa-1', role: 'QA', kind: 'seat' },
    { id: 'op-1', role: 'Operator', kind: 'hold' },
    { id: 'pair-1', role: 'live session', kind: 'hold' },
  ]);
});

test('an unresolved connection says to run crew connect', () => {
  const noIds = ONE.slice(0, ONE.indexOf('    resolved:'));
  const { dir, file } = withConfig(noIds);
  const conn = connection(loadConfig(dir, file), 'synthesis');
  assert.throws(() => configuredMembers(conn), /run `crew connect`/);
});

test('a connection names one area of development, distinct from the Tablation project', () => {
  const withArea = ONE.replace('    project: Dev Crew\n', '    project: Issues\n    area: Tablation\n');
  const { dir, file } = withConfig(withArea);
  const c = connection(loadConfig(dir, file), 'synthesis');
  assert.equal(c.project, 'Issues');    // the container holding the tracker's tables
  assert.equal(c.area, 'Tablation');    // a row of the Projects table inside it
});

test('an unsliced tracker needs no area, and gets the whole queue', () => {
  const { dir, file } = withConfig(ONE);
  const c = connection(loadConfig(dir, file), 'synthesis');
  assert.equal(c.area, undefined);
  assert.equal(c.resolved?.areaId, undefined);
});

test('the shipped example config still parses', () => {
  // The loader rejects unknown keys, so a renamed or removed setting turns the
  // example into a file that cannot be used — and the example is the only
  // thing a fresh install has to copy from. Failing here is the point.
  const example = join(import.meta.dirname, '..', 'crew.yaml.example');
  const cfg = loadConfig(process.cwd(), example);
  assert.equal(cfg.connections.length, 1);
  // Shipped disarmed: copying it must not start writing to someone's board.
  assert.equal(cfg.connections[0]!.enabled, false);
});

test('reposOf covers every checkout, not just the connection dir', () => {
  // Release, merge and sync are REPOSITORY operations. Treating `dir` as "the"
  // directory meant only the first repo on a board was ever released — the
  // others were configured, referenced by tickets, and silently never shipped.
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'connections:',
    '  - name: multi',
    '    workspace: w',
    '    apiKey: k',
    '    worktreePrefix: m-',
    '    baseUrl: https://example.com',
    '    repos:',
    '      alpha: /tmp/alpha',
    '      beta: /tmp/beta',
    '  - name: single',
    '    workspace: w',
    '    apiKey: k',
    '    worktreePrefix: s-',
    '    baseUrl: https://example.com',
    '    dir: /tmp/only',
  ].join('\n'));
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'));

  assert.deepEqual(reposOf(connection(cfg, 'multi')).map((r) => r.name), ['alpha', 'beta']);
  // A single-repo connection still yields exactly one target, so callers never
  // need to special-case it.
  assert.deepEqual(reposOf(connection(cfg, 'single')), [{ name: 'single', dir: '/tmp/only' }]);
});

test('tickets are partitioned by repo, and unplaceable ones are surfaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-repos-'));
  writeFileSync(join(dir, 'crew.yaml'), [
    'ship:', '  name: S', '  agent:', '    bin: /bin/echo', '    model: m',
    'connections:',
    '  - name: multi', '    workspace: w', '    apiKey: k',
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
  const c = connection(loadConfig(dir, join(dir, 'crew.yaml')), 'multi');

  const { byRepo, unplaceable } = ticketsByRepo(c, [
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
    'connections:',
    '  - name: multi', '    enabled: true', '    workspace: w',
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
  const c = connection(loadConfig(dir, join(dir, 'crew.yaml')), 'multi');

  const { unplaceable } = ticketsByRepo(c, [
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
