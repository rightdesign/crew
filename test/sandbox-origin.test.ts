import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { sandboxOriginFor } from '../src/agent.ts';
import type { Route } from '../src/config.ts';

const route = (repos: Record<string, string>): Route => ({ route: 'w/p', dir: '/nowhere', repos } as unknown as Route); // only the fields reposOf reads

test('sandboxOriginFor picks the ticket repository on a multi-repository route (CREW-2946)', () => {
  const mk = (url: string) => {
    const d = mkdtempSync(join(tmpdir(), 'crew-origin-'));
    execFileSync('git', ['init', '-q', d]);
    execFileSync('git', ['-C', d, 'remote', 'add', 'origin', url]);
    return d;
  };
  const r = route({ first: mk('git@github.com:acme/first.git'), second: mk('git@github.com:acme/second.git') });
  assert.equal(sandboxOriginFor(r, 'second'), 'git@github.com:acme/second.git');
  assert.equal(sandboxOriginFor(r, 'first'), 'git@github.com:acme/first.git');
  assert.equal(sandboxOriginFor(r, null), undefined);
  assert.equal(sandboxOriginFor(r, 'missing'), undefined);
});

test('sandboxOriginFor derives the URL from the board remote on a provisioned ship with no origin (CREW-2946)', () => {
  const r = { route: 'w/p', dir: '/nowhere/w', dirIsCloneBase: true, repos: {}, reposBasePath: '/nowhere',
    resolved: { repoNames: { a: 'crew', b: 'other' }, repoRemotes: { a: 'acme/crew', b: 'acme/other' } } } as unknown as Route; // only the fields reposOf reads
  assert.match(sandboxOriginFor(r, 'other')!, /acme\/other(\.git)?$/);
});
