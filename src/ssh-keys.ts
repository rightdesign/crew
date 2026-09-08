/**
 * This ship's own SSH identity, for the Host Passengers tunnel client
 * (ISSUE-553, CREW_PRD.md §9.9). One keypair per ship, not per route/
 * workspace — the same identity is synced onto every workspace's Ships row
 * this machine connects to with `hostPassengers` on (`connect.ts`'s
 * `discover()`), and the tunnel client (`tunnel.ts`) uses it to authenticate
 * `ssh -R` to the relay for any of them.
 *
 * Shelled out to the real `ssh-keygen` binary rather than
 * `crypto.generateKeyPairSync` — CREW_PRD.md §9.9's own spike note is that
 * the real `ssh` binary needed a real interop fix distinct from what worked
 * against `ssh2`, so this repo's own key material should be exactly what
 * `ssh-keygen`/`ssh` themselves produce and expect, not a Node-encoded
 * equivalent that might not round-trip identically.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class SshKeyError extends Error {}

/**
 * Where this ship's keypair lives — a sibling of `<stateDir>/keys/` (the
 * per-route API-key files, see `apiKeyPathFor` in config.ts), but SHIP-level
 * rather than per-route: this identity is the same whichever workspace it's
 * being synced to. `<stateDir>/ssh/id_ed25519` (+ `.pub`).
 */
export function shipSshKeyPathFor(stateDir: string): string {
  return join(stateDir, 'ssh', 'id_ed25519');
}

export interface ShipSshKeypair {
  privateKeyPath: string;
  publicKeyPath: string;
  /** The public key line, e.g. `ssh-ed25519 AAAA... crew-ship`. */
  publicKey: string;
}

/**
 * Find-or-generate this ship's own keypair, idempotently. A key already on
 * disk is read back and never regenerated (a rotated key would invalidate
 * every workspace's `ssh_public_key` sync until reconnected everywhere it's
 * used — not something to do silently on every `crew connect`). Runs
 * `ssh-keygen -t ed25519 -N '' -f <path> -C crew-ship` when nothing exists
 * yet, then reads the `.pub` file it produced.
 */
export function ensureShipSshKeypair(stateDir: string): ShipSshKeypair {
  const privateKeyPath = shipSshKeyPathFor(stateDir);
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!existsSync(privateKeyPath)) {
    mkdirSync(dirname(privateKeyPath), { recursive: true });
    try {
      execFileSync('ssh-keygen', [
        '-t', 'ed25519',
        '-N', '', // no passphrase — this key authenticates an unattended daemon loop
        '-f', privateKeyPath,
        '-C', 'crew-ship',
        '-q',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      const err = e as { stderr?: Buffer; message: string };
      throw new SshKeyError(`ssh-keygen failed: ${err.stderr?.toString().trim() || err.message}`);
    }
    // 0600: this file holds a live credential, same convention as
    // apiKeyPathFor's `.env` file in cli.ts.
    chmodSync(privateKeyPath, 0o600);
  }

  if (!existsSync(publicKeyPath)) {
    throw new SshKeyError(`${privateKeyPath} exists but ${publicKeyPath} does not — regenerate or restore it`);
  }
  const publicKey = readFileSync(publicKeyPath, 'utf8').trim();
  return { privateKeyPath, publicKeyPath, publicKey };
}

/** Whether `ssh-keygen` is even on PATH — surfaced by `crew doctor`. */
export function sshKeygenAvailable(): boolean {
  try {
    execFileSync('ssh-keygen', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    // `ssh-keygen -V` on some builds exits non-zero while still printing a
    // version to stderr (it's meant to be paired with -A) — command not
    // found is the failure this actually cares about, and that throws
    // synchronously with no output at all either way, so a non-zero exit
    // here is treated the same as "no ssh-keygen": callers can't provision
    // a key regardless of which case it was.
    return false;
  }
}
