import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseForges, parseCredentialInput, answerCredential, gitCredentialEnv, forgeRunEnv, readForgeToken,
  storeForgeToken, hostOfRemote, forgeOfRemote, ForgeError, defaultTokenFilePath, type ForgesConfig,
} from '../src/forges.ts';
import { runCredential, runForge } from '../src/forge-cmd.ts';
import { probePushAuth } from '../src/doctor-checks.ts';
import { cloneUrlFor, setForgeTokenHosts } from '../src/git.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'crew-forge-'));
const envForges = (): ForgesConfig => parseForges({ 'github.com': { token: { source: 'env', var: 'T' } } })!;

test('parseForges: defaults, validation and host normalisation', () => {
  const f = parseForges({ 'GitHub.com': { token: { source: 'file' } } })!;
  assert.equal(f['github.com']!.username, 'x-access-token');
  assert.throws(() => parseForges({ 'https://github.com': { token: { source: 'file' } } }), ForgeError);
  assert.throws(() => parseForges({ 'github.com': { token: { source: 'env' } } }), /token\.var/);
  assert.throws(() => parseForges({ 'github.com': { token: { source: 'vault' } } }), /source must be one of/);
  assert.throws(() => parseForges({ 'github.com': { token: { source: 'file' }, extra: 1 } }), /unknown key/);
  assert.equal(parseForges(undefined), undefined);
});

test('credential get: matches host (port ignored), answers username and password', () => {
  const input = parseCredentialInput('protocol=https\nhost=GitHub.com:443\n\nignored=1\n');
  assert.deepEqual(input, { protocol: 'https', host: 'GitHub.com:443' });
  assert.equal(answerCredential('get', input, envForges(), '/x', { T: 'tok' }), 'username=x-access-token\npassword=tok\n');
});

test('credential: no match, other protocol, no token and store/erase all answer nothing', () => {
  const f = envForges();
  const get = (i: Record<string, string>, env = { T: 'tok' }) => answerCredential('get', i, f, '/x', env);
  assert.equal(get({ protocol: 'https', host: 'gitlab.com' }), '');
  assert.equal(get({ protocol: 'http', host: 'github.com' }), '');
  assert.equal(get({ protocol: 'https', host: 'github.com' }, {} as { T: string }), '');
  assert.equal(answerCredential('store', { protocol: 'https', host: 'github.com', password: 'x' }, f, '/x', { T: 'tok' }), '');
  assert.equal(answerCredential('erase', { protocol: 'https', host: 'github.com' }, f, '/x', { T: 'tok' }), '');
  assert.equal(runCredential('get', 'protocol=https\nhost=github.com\n\n', f, '/x', { T: 'tok' }).out, 'username=x-access-token\npassword=tok\n');
});

test('file source: created 0600, refused when group/world readable, never touches anything else', () => {
  const state = dir();
  const f = parseForges({ 'github.com': { token: { source: 'file' } } })!;
  storeForgeToken(f, 'github.com', 'secret', state);
  const p = defaultTokenFilePath(state, 'github.com');
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(readForgeToken(f, 'github.com', state), 'secret');
  chmodSync(p, 0o640);
  assert.throws(() => readForgeToken(f, 'github.com', state), /owner-only/);
  assert.equal(runCredential('get', 'protocol=https\nhost=github.com\n\n', f, state).out, '');
  chmodSync(p, 0o600);
  storeForgeToken(f, 'github.com', 'rotated', state);
  assert.equal(readForgeToken(f, 'github.com', state), 'rotated');
  assert.deepEqual(readdirSync(join(state, 'forges')), ['github.com.token']);
});

test('env source cannot be written', () => {
  assert.throws(() => storeForgeToken(envForges(), 'github.com', 'x', '/x'), /cannot write/);
});

test('gitCredentialEnv: GIT_CONFIG_COUNT entries after existing ones, no token, idempotent', () => {
  const e = gitCredentialEnv({ crewCommand: "'/n' '/c'", configFile: '/etc/crew.yaml' }, { GIT_CONFIG_COUNT: '1' });
  assert.equal(e.GIT_CONFIG_COUNT, '3');
  assert.equal(e.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(e.GIT_CONFIG_VALUE_1, '');
  assert.equal(e.GIT_CONFIG_VALUE_2, "!'/n' '/c' credential");
  assert.equal(e.CREW_CONFIG, '/etc/crew.yaml');
  const again = gitCredentialEnv({ crewCommand: "'/n' '/c'" }, { ...e });
  assert.equal(again.GIT_CONFIG_COUNT, undefined);
});

test('forgeRunEnv: helper config plus the token; empty without forges; token not in the helper config', () => {
  assert.deepEqual(forgeRunEnv(undefined, { crewCommand: 'c', stateDir: '/x' }, {}), {});
  const env = forgeRunEnv(envForges(), { crewCommand: 'c', stateDir: '/x' }, { T: 'tok' });
  assert.equal(env.GH_TOKEN, 'tok');
  assert.equal(env.GITHUB_TOKEN, 'tok');
  assert.equal(env.CREW_FORGE_TOKEN, 'tok');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  for (const [k, v] of Object.entries(env)) if (k.startsWith('GIT_CONFIG_')) assert.ok(!v.includes('tok'), k);
});

test('clone URL is HTTPS for a host with a token, whatever the origin says', () => {
  const ssh = { originUrl: 'git@github.com:a/b.git' };
  setForgeTokenHosts([]);
  assert.equal(cloneUrlFor('a/b', ssh), 'git@github.com:a/b.git');
  setForgeTokenHosts(['github.com']);
  assert.equal(cloneUrlFor('a/b', ssh), 'https://github.com/a/b.git');
  setForgeTokenHosts([]);
});

test('hostOfRemote and forgeOfRemote', () => {
  assert.equal(hostOfRemote('https://x@GitHub.com/a/b.git'), 'github.com');
  assert.equal(hostOfRemote('git@github.com:a/b.git'), 'github.com');
  assert.equal(hostOfRemote(null), null);
  assert.deepEqual(forgeOfRemote(envForges(), 'https://github.com/a/b.git', () => false), { host: 'github.com', hasToken: false });
  assert.equal(forgeOfRemote(envForges(), 'https://gitlab.com/a/b.git', () => true), undefined);
});

const fail = (msg: string) => () => { throw Object.assign(new Error('x'), { stderr: msg }); };
const base = { dir: '/x', remote: 'origin', remoteUrl: 'https://github.com/a/b.git' };

test('doctor: missing token names the forge host', () => {
  const r = probePushAuth({ ...base, forge: { host: 'github.com', hasToken: false } }, fail('could not read Username'));
  assert.equal(r.state, 'failed');
  if (r.state === 'failed') {
    assert.match(r.detail, /no token for forge github\.com/);
    assert.match(r.hint, /crew forge set github\.com/);
  }
});

test('doctor: a token that can fetch but not push is reported as read-only', () => {
  const run = (_c: string, args: string[]) => { if (args[0] === 'push') throw Object.assign(new Error('x'), { stderr: 'remote: Permission denied' }); };
  const r = probePushAuth({ ...base, forge: { host: 'github.com', hasToken: true } }, run);
  assert.equal(r.state, 'failed');
  if (r.state === 'failed') assert.match(r.detail, /github\.com is read-only \(fetch works, push refused\)/);
});

test('doctor: a refused token is its own finding; a working one is ok', () => {
  const r = probePushAuth({ ...base, forge: { host: 'github.com', hasToken: true } }, fail('Authentication failed'));
  if (r.state === 'failed') assert.match(r.detail, /was refused/); else assert.fail('expected failure');
  assert.equal(probePushAuth({ ...base, forge: { host: 'github.com', hasToken: true } }, () => {}).state, 'ok');
});

test('crew forge set/rotate: writes the entry comment-safe, stores 0600, no home or checkout files', () => {
  const state = dir();
  const cfgFile = join(state, 'crew.yaml');
  writeFileSync(cfgFile, '# mine\nship:\n  name: s\n');
  const io = {
    forges: undefined as ForgesConfig | undefined, stateDir: state, configFile: cfgFile,
    readFile: (p: string) => readFileSync(p, 'utf8'), writeFile: (p: string, t: string) => writeFileSync(p, t),
    stdin: () => 'from-stdin\n', env: {} as NodeJS.ProcessEnv,
  };
  const noTok = runForge({ sub: 'set', host: 'github.com', tokenStdin: false }, io);
  assert.equal(noTok.code, 2);
  const set = runForge({ sub: 'set', host: 'github.com', tokenStdin: true }, io);
  assert.equal(set.code, 0, set.err);
  assert.match(readFileSync(cfgFile, 'utf8'), /# mine/);
  const p = defaultTokenFilePath(state, 'github.com');
  assert.equal(readFileSync(p, 'utf8'), 'from-stdin\n');
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const rot = runForge({ sub: 'rotate', host: 'github.com', tokenStdin: false, token: 'new' }, io);
  assert.equal(rot.code, 0, rot.err);
  assert.equal(readFileSync(p, 'utf8'), 'new\n');
  assert.equal(runForge({ sub: 'rotate', host: 'gitlab.com', tokenStdin: false, token: 'x' }, io).code, 2);
  assert.match(runForge({ sub: 'list', tokenStdin: false }, io).out, /github\.com\s+token present/);
  assert.ok(!existsSync(join(state, '.git-credentials')));
});
