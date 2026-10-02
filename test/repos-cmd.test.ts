import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredRepos, matchRepoName, normalizeRemote, planRepoAdd, ReposError } from '../src/repos-cmd.ts';
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
