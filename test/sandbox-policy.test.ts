import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import {
  CREW_BIN, generateSandboxPolicy, parseEndpoint, parseDeniedRequests, parseSandboxNetwork, policyPathFor, SandboxPolicyError, type SandboxPolicyInput,
} from '../src/sandbox-policy.ts';
import { parseRepoConfig, RepoConfigError } from '../src/repo-config.ts';
import { CREW_PREFIX } from '../src/sandbox-image.ts';

const base: SandboxPolicyInput = {
  forgeHosts: ['github.com'], tablationUrl: 'https://app.tablation.com', authMode: 'workspace', provider: 'anthropic', harnessBin: 'claude',
};
const hostsOf = (input: SandboxPolicyInput) => {
  const doc = parse(generateSandboxPolicy(input).yaml);
  return Object.values<{ endpoints: Array<{ host: string; port: number }> }>(doc.network_policies).flatMap((g) => g.endpoints.map((e) => e.host));
};

test('workspace mode allows the tracker and forge, and never the provider hosts', () => {
  const hosts = hostsOf(base);
  assert.deepEqual(hosts.sort(), ['app.tablation.com', 'github.com']);
  assert.ok(!hosts.some((h) => /anthropic|claude\.ai/.test(h)));
});

test('subscription and inherit modes allow the provider hosts of the toolchain', () => {
  for (const authMode of ['subscription', 'inherit'] as const) {
    assert.ok(hostsOf({ ...base, authMode }).includes('api.anthropic.com'));
  }
  assert.ok(hostsOf({ ...base, authMode: 'inherit', provider: 'openai' }).includes('api.openai.com'));
  assert.ok(!hostsOf({ ...base, authMode: 'inherit', provider: 'openai' }).includes('api.anthropic.com'));
});

test('every rule names the binaries it applies to, and the model rule is the harness only', () => {
  const doc = parse(generateSandboxPolicy({ ...base, authMode: 'inherit' }).yaml);
  for (const g of Object.values<{ binaries: Array<{ path: string }> }>(doc.network_policies)) assert.ok(g.binaries.length > 0);
  const model = doc.network_policies.model.binaries.map((b: { path: string }) => b.path);
  assert.ok(model.includes('/usr/local/bin/claude'));
  assert.ok(model.includes('/opt/crew/bin/claude'), 'the crew layer installs Claude Code under /opt/crew/bin');
  assert.ok(model.includes('/opt/crew/bin/node'));
  assert.ok(!model.includes('/usr/bin/curl'), 'curl cannot reach the provider');
});

test('the policy names the directory the crew layer installs into', () => {
  assert.equal(CREW_BIN, `${CREW_PREFIX}/bin`);
});

test('package registries are denied unless a toolchain or the repository declares them', () => {
  assert.ok(!hostsOf(base).includes('registry.npmjs.org'));
  assert.ok(hostsOf({ ...base, toolchains: ['pnpm'] }).includes('registry.npmjs.org'));
  assert.ok(hostsOf({ ...base, toolchains: ['prisma'] }).includes('binaries.prisma.sh'));
});

test('a declared extra host is in the policy and named in the result; a repo declaring none gets nothing extra', () => {
  const withExtra = generateSandboxPolicy({ ...base, extraHosts: ['API.Example.com', 'data.example.org:8443'] });
  const doc = parse(withExtra.yaml);
  assert.deepEqual(doc.network_policies.declared.endpoints, [{ host: 'api.example.com', port: 443 }, { host: 'data.example.org', port: 8443 }]);
  assert.deepEqual(withExtra.extraHosts, ['api.example.com', 'data.example.org:8443']);
  assert.equal(parse(generateSandboxPolicy(base).yaml).network_policies.declared, undefined);
});

test('the metadata address and other internal addresses are refused wherever they are declared', () => {
  for (const bad of ['169.254.169.254', '169.254.0.1', 'metadata.google.internal', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.9', 'localhost', '[::1]', '0xa9fea9fe', '2852039166', '0251.0376.0251.0376', '169.254.43518']) {
    assert.throws(() => parseEndpoint(bad), SandboxPolicyError, bad);
    assert.throws(() => generateSandboxPolicy({ ...base, extraHosts: [bad] }), SandboxPolicyError, bad);
  }
  assert.throws(() => generateSandboxPolicy({ ...base, tablationUrl: 'http://169.254.169.254' }), SandboxPolicyError);
  for (const url of ['http://0xa9fea9fe', 'http://2852039166', 'http://0251.0376.0251.0376', 'http://169.254.43518']) {
    assert.throws(() => generateSandboxPolicy({ ...base, tablationUrl: url }), SandboxPolicyError, url);
  }
  assert.doesNotThrow(() => parseEndpoint('203.0.113.7'));
  assert.match(generateSandboxPolicy(base).yaml, /169\.254\.169\.254 is denied/);
});

test('landlock is hard_requirement and the cache mount is read-only', () => {
  const doc = parse(generateSandboxPolicy({ ...base, mirrorDir: '/cache' }).yaml);
  assert.equal(doc.landlock.compatibility, 'hard_requirement');
  assert.ok(doc.filesystem_policy.read_only.includes('/cache'));
  assert.ok(!doc.filesystem_policy.read_write.includes('/cache'));
});

test('an unknown toolchain is an error naming the ones crew knows', () => {
  assert.throws(() => generateSandboxPolicy({ ...base, toolchains: ['frobnicate'] }), /not one crew knows.*pnpm/);
});

test('the policy is written beside the stream file', () => {
  assert.equal(policyPathFor('/s/streams/proj-dev-c1.jsonl'), '/s/streams/proj-dev-c1.policy.yaml');
});

test('denied-request lines collapse per host, port and binary', () => {
  const log = [
    'INFO ok host=api.github.com',
    'WARN network deny host=api.anthropic.com port=443 binary=/usr/bin/curl',
    'WARN network deny host=api.anthropic.com port=443 binary=/usr/bin/curl',
    'WARN request denied by policy',
  ].join('\n');
  const d = parseDeniedRequests(log);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], { host: 'api.anthropic.com', port: 443, binary: '/usr/bin/curl', count: 2, line: d[0]!.line });
  assert.equal(d[1]!.host, '?');
});

test('.crew.yaml sandbox.hosts and sandbox.toolchains parse, and bad entries are refused', () => {
  const MIN = 'version: 1\nhooks:\n  test: t\n  build: b\n  deploy: d\n';
  const yml = (sandbox: string) => `${MIN}sandbox:\n${sandbox}\n`;
  const ok = parseRepoConfig(yml('  hosts: [api.example.com]\n  toolchains: [pnpm]'), '.crew.yaml');
  assert.deepEqual(ok.sandboxNetwork, { hosts: ['api.example.com'], toolchains: ['pnpm'] });
  assert.equal(ok.sandbox, undefined, 'a network-only section declares no image to build');
  const both = parseRepoConfig(yml('  packages: [git]\n  hosts: [api.example.com]'), '.crew.yaml');
  assert.deepEqual(both.sandbox, { packages: ['git'], setup: [], warm: [] });
  assert.deepEqual(both.sandboxNetwork, { hosts: ['api.example.com'], toolchains: [] });
  assert.equal(parseRepoConfig(MIN, '.crew.yaml').sandboxNetwork, undefined);
  const warmed = parseRepoConfig(yml('  warm: [pnpm-lock.yaml]\n  hosts: [api.example.com]\n  toolchains: [pnpm]'), '.crew.yaml');
  assert.deepEqual(warmed.sandbox?.warm, ['pnpm-lock.yaml'], 'a warm-only build section is not dropped by the network early-out');
  assert.deepEqual(warmed.sandboxNetwork, { hosts: ['api.example.com'], toolchains: ['pnpm'] });
  assert.throws(() => parseRepoConfig(yml('  hosts: [169.254.169.254]'), '.crew.yaml'), RepoConfigError);
  assert.throws(() => parseRepoConfig(yml('  toolchains: [nope]'), '.crew.yaml'), /not known/);
  assert.throws(() => parseSandboxNetwork({ hosts: 'x' }, 'f', (m) => new Error(m)), /list of non-empty strings/);
});
