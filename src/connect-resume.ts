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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionStore } from '@tablation/client';

export function lastSessionFile(stateDir: string): string {
  return join(stateDir, 'connect-session.json');
}

/** host to every workspace slug a keychain session was stored for (a pointer written before CREW-2498 holds one slug as a string). */
function readPointers(stateDir: string): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lastSessionFile(stateDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [host, v] of Object.entries(parsed)) {
      const slugs = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== '');
      if (slugs.length) out[host] = slugs;
    }
    return out;
  } catch {
    return {};
  }
}

function writePointers(stateDir: string, pointers: Record<string, string[]>): void {
  const file = lastSessionFile(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pointers, null, 2)}\n`, { mode: 0o600 });
}

/** Remember that `host` has a keychain session stored for `workspaceSlug`; the most recent goes last. Best-effort: never throws. */
export function rememberSession(stateDir: string, host: string, workspaceSlug: string): void {
  try {
    const all = readPointers(stateDir);
    writePointers(stateDir, { ...all, [host]: [...(all[host] ?? []).filter((w) => w !== workspaceSlug), workspaceSlug] });
  } catch { /* the pointer only saves a re-approval; losing it is not a failure */ }
}

export interface ResumedSession {
  workspace: string;
  apiKey: string;
}

/**
 * Every keychain session remembered for `host` whose key the keychain still
 * holds and `verify` says the server still accepts. Empty for every other
 * outcome, including a keychain that cannot be reached right now.
 */
export async function resumableSessions(o: {
  store: Pick<SessionStore, 'get'>;
  stateDir: string;
  host: string;
  verify: (apiKey: string) => Promise<boolean>;
}): Promise<ResumedSession[]> {
  const out: ResumedSession[] = [];
  for (const workspace of readPointers(o.stateDir)[o.host] ?? []) {
    try {
      const stored = await o.store.get(o.host, workspace);
      if (stored?.apiKey && (await o.verify(stored.apiKey))) out.push({ workspace, apiKey: stored.apiKey });
    } catch { /* this entry is unusable; the others may not be */ }
  }
  return out;
}

/** The one resumable session for `host`, or `undefined` when there is none or more than one (the caller must choose). */
export async function resumeKeychainSession(o: Parameters<typeof resumableSessions>[0]): Promise<ResumedSession | undefined> {
  const all = await resumableSessions(o);
  return all.length === 1 ? all[0] : undefined;
}

/** Every host/workspace pair a `crew connect` keychain sign-in was remembered for (the keychain itself cannot be listed). */
export function rememberedSessions(stateDir: string): Array<{ host: string; workspace: string }> {
  return Object.entries(readPointers(stateDir)).flatMap(([host, ws]) => ws.map((workspace) => ({ host, workspace })));
}

/** Drop `host`'s pointer, removing the file when it was the last one. Best-effort: never throws. */
export function forgetSession(stateDir: string, host: string): void {
  try {
    const { [host]: _gone, ...rest } = readPointers(stateDir);
    if (Object.keys(rest).length) writePointers(stateDir, rest);
    else rmSync(lastSessionFile(stateDir), { force: true });
  } catch { /* a stale pointer only costs a failed keychain lookup */ }
}

export interface SignOutOutcome {
  host: string;
  workspace: string;
  action: 'removed' | 'would-remove' | 'absent' | 'failed';
  detail?: string;
}

/**
 * `crew connect --sign-out` (CREW-2440): clears the keychain session(s) a
 * dry-run sign-in stored. Works with no crew.yaml because it follows the state
 * directory's pointer, not the configured routes. `host` limits it to one host;
 * `workspace` additionally clears that workspace's credential even when no
 * pointer names it. Nothing to remove is an `absent` outcome, never an error.
 */
export async function signOutSessions(o: {
  store: Pick<SessionStore, 'get' | 'clear'>;
  stateDir: string;
  host?: string;
  workspace?: string;
  dryRun?: boolean;
}): Promise<SignOutOutcome[]> {
  const targets = rememberedSessions(o.stateDir).filter((t) => !o.host || t.host === o.host);
  if (o.host && o.workspace && !targets.some((t) => t.host === o.host && t.workspace === o.workspace)) {
    targets.push({ host: o.host, workspace: o.workspace });
  }
  const out: SignOutOutcome[] = [];
  for (const t of targets) {
    try {
      const stored = await o.store.get(t.host, t.workspace);
      if (stored?.apiKey) {
        if (!o.dryRun) await o.store.clear(t.host, t.workspace);
        out.push({ ...t, action: o.dryRun ? 'would-remove' : 'removed' });
      } else {
        out.push({ ...t, action: 'absent', detail: 'no keychain entry' });
      }
      if (!o.dryRun) forgetSession(o.stateDir, t.host);
    } catch (e) {
      out.push({ ...t, action: 'failed', detail: (e as Error).message });
    }
  }
  return out;
}
