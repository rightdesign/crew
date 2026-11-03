import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxImageOf, sandboxPolicyInputFor } from '../src/agent.ts';
import { repoContractFor } from '../src/mirror-contract.ts';
import { parseRepoConfig } from '../src/repo-config.ts';
import { SHIP_SANDBOX_KEY } from '../src/sandbox-image.ts';

const route = { route: 'r', dir: '/nonexistent/route', repos: { synthesis: { dir: '/nonexistent/synthesis' } } } as never;
const declares = parseRepoConfig('version: 1\nrelease: {mode: external}\nsandbox:\n  packages: [git]\n  setup: ["true"]\n', 'test');
const silent = parseRepoConfig('version: 1\nrelease: {mode: external}\nhooks:\n  test: "true"\n', 'test');

function stateWith(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-state-'));
  const state = Object.fromEntries(Object.entries(entries).map(([k, tag]) => [k, { tags: [{ tag, at: 'x' }] }]));
  writeFileSync(join(dir, 'sandbox-images.json'), JSON.stringify(state));
  return dir;
}

test('CREW-3032: a repository whose contract declares sandbox: runs in its recorded image with no host checkout', () => {
  const stateDir = stateWith({ synthesis: 'crew-sandbox/synthesis:abc', [SHIP_SANDBOX_KEY]: 'crew-sandbox/ship:1' });
  const got = sandboxImageOf(route, 'synthesis', stateDir, declares);
  assert.deepEqual(got, { image: 'crew-sandbox/synthesis:abc', reason: 'repository image' });
});

test('CREW-3032: a repository declaring sandbox: with no recorded image is refused, not run in the ship layer', () => {
  const stateDir = stateWith({ [SHIP_SANDBOX_KEY]: 'crew-sandbox/ship:1' });
  assert.deepEqual(sandboxImageOf(route, 'synthesis', stateDir, declares), { reason: 'refused: image missing' });
});

test('CREW-3032: a repository declaring no sandbox: keeps the ship layer', () => {
  const stateDir = stateWith({ synthesis: 'crew-sandbox/synthesis:abc', [SHIP_SANDBOX_KEY]: 'crew-sandbox/ship:1' });
  for (const c of [silent, null]) {
    assert.deepEqual(sandboxImageOf(route, 'synthesis', stateDir, c), { image: 'crew-sandbox/ship:1', reason: 'ship layer: repository declares no sandbox' });
  }
});

test('CREW-3032: the policy input takes the supplied contract instead of reading a host directory', () => {
  const withHosts = parseRepoConfig('version: 1\nrelease: {mode: external}\nsandbox:\n  packages: [git]\n  hosts: [registry.example.com]\n', 'test');
  const input = sandboxPolicyInputFor(route, { name: 'c', harness: 'claude', bin: 'claude' } as never, { harnessBin: 'claude', repo: 'synthesis', contract: withHosts });
  assert.ok(input.extraHosts?.includes('registry.example.com'), JSON.stringify(input));
});

test('CREW-3032: on a sandbox ship with no mirror settings the contract falls back to the checkout and tolerates its absence', async () => {
  const got = await repoContractFor({ runner: 'sandbox' } as never, {} as never, { name: 'synthesis', dir: '/nonexistent/synthesis' } as never);
  assert.equal(got, null);
});
