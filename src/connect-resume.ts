/**
 * Resuming a dry-run sign-in from the OS keychain (CREW-2315, EPIC-053).
 *
 * The macOS wizard signs in with `crew connect --json --no-wizard --dry-run`
 * and no workspace named: the device approval itself says which workspace the
 * key is for. The keychain is keyed by host AND workspace slug, and cannot be
 * listed, so a relaunch of the app (before provisioning) had no way to find
 * the session it had just stored and went through a fresh device approval.
 *
 * `crew connect` therefore writes a small pointer — host to the workspace slug
 * it last signed in to — under the state directory whenever it stores a
 * keychain session, and this module follows it back. The pointer holds no
 * secret; the key itself stays in the keychain. A pointer that is missing, a
 * keychain entry that is gone, or a key the server rejects all mean "no
 * session": the caller falls back to the device flow.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionStore } from '@tablation/client';

export function lastSessionFile(stateDir: string): string {
  return join(stateDir, 'connect-session.json');
}

function readPointers(stateDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lastSessionFile(stateDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

/** Remember which workspace `host`'s keychain session was last stored for. Best-effort: never throws. */
export function rememberSession(stateDir: string, host: string, workspaceSlug: string): void {
  try {
    const file = lastSessionFile(stateDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...readPointers(stateDir), [host]: workspaceSlug }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* the pointer only saves a re-approval; losing it is not a failure */ }
}

export interface ResumedSession {
  workspace: string;
  apiKey: string;
}

/**
 * The keychain session `host` last signed in to, when the keychain still holds
 * it and `verify` says the server still accepts the key. `undefined` for every
 * other outcome, including a keychain that cannot be reached right now.
 */
export async function resumeKeychainSession(o: {
  store: Pick<SessionStore, 'get'>;
  stateDir: string;
  host: string;
  verify: (apiKey: string) => Promise<boolean>;
}): Promise<ResumedSession | undefined> {
  const workspace = readPointers(o.stateDir)[o.host];
  if (!workspace) return undefined;
  try {
    const stored = await o.store.get(o.host, workspace);
    if (!stored?.apiKey) return undefined;
    if (!(await o.verify(stored.apiKey))) return undefined;
    return { workspace, apiKey: stored.apiKey };
  } catch {
    return undefined;
  }
}

