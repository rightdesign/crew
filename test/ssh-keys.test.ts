import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureShipSshKeypair, shipSshKeyPathFor, sshKeygenAvailable, SshKeyError } from '../src/ssh-keys.ts';

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'crew-ssh-'));
}

test('ensureShipSshKeypair() generates a keypair under <stateDir>/ssh when none exists', () => {
  const stateDir = tmpStateDir();
  const kp = ensureShipSshKeypair(stateDir);

  assert.equal(kp.privateKeyPath, shipSshKeyPathFor(stateDir));
  assert.equal(kp.publicKeyPath, `${kp.privateKeyPath}.pub`);
  assert.ok(existsSync(kp.privateKeyPath), 'private key file should exist');
  assert.ok(existsSync(kp.publicKeyPath), 'public key file should exist');
  assert.match(kp.publicKey, /^ssh-ed25519 /);
});

test('ensureShipSshKeypair() chmods the private key 0600 — it holds a live credential', () => {
  const stateDir = tmpStateDir();
  const kp = ensureShipSshKeypair(stateDir);
  const mode = statSync(kp.privateKeyPath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('ensureShipSshKeypair() is idempotent — a second call reads the same key back rather than regenerating it', () => {
  const stateDir = tmpStateDir();
  const first = ensureShipSshKeypair(stateDir);
  const second = ensureShipSshKeypair(stateDir);

  assert.equal(first.publicKey, second.publicKey);
});

test('ensureShipSshKeypair() throws SshKeyError when the private key exists but its .pub sibling is missing', () => {
  const stateDir = tmpStateDir();
  const privateKeyPath = shipSshKeyPathFor(stateDir);
  mkdirSync(join(stateDir, 'ssh'), { recursive: true });
  writeFileSync(privateKeyPath, 'not a real key');

  assert.throws(() => ensureShipSshKeypair(stateDir), SshKeyError);
});

test('sshKeygenAvailable() reflects whatever this test machine actually has on PATH', () => {
  // Not mocked deliberately — ssh-keygen is a normal OpenSSH tool assumed
  // present in this repo's own dev/CI environment (the same assumption
  // `dockerAvailable()`'s sibling test in passenger-containers.test.ts makes
  // about `docker`), so this just asserts the probe returns a boolean and
  // doesn't throw, rather than asserting a specific answer.
  assert.equal(typeof sshKeygenAvailable(), 'boolean');
});
