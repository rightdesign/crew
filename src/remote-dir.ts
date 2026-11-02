/**
 * A checkout that lives in a sandbox (CREW-2940).
 *
 * The release phase reads and writes one directory through `git`, through hook
 * scripts and through a handful of files (`.crew.yaml`, the version files, the
 * changelog). On a managed ship with no primary checkouts that directory is a
 * clone inside a release sandbox. Rather than thread an executor through every
 * caller, such a directory is given a host-side name under `REMOTE_ROOT` and
 * registered here; `git.ts`, `shell.ts`, `repo-config.ts` and the release's
 * file edits ask `remoteOf` and, for a registered name, run the same command
 * with `openshell sandbox exec` instead. A name that is not registered is an
 * ordinary host path and nothing changes for it.
 *
 * The name is a real-looking absolute path (not a URL) so `path.join` keeps
 * working on it. Nothing exists at that path on the host.
 */

import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

export const REMOTE_ROOT = '/.crew-sandbox';

export interface RemoteDir {
  /** The `openshell` binary the sandbox was created with. */
  bin: string;
  sandbox: string;
  /** The clone's directory inside the sandbox. */
  workDir: string;
  /** Shell text run before a hook script: the crew layer's variables and the container-engine stubs (the sandbox exec carries only PATH). */
  prelude?: string;
}

const registry = new Map<string, RemoteDir>();

/** Registers a sandbox clone and returns the host-side name callers use as its directory. */
export function registerRemoteDir(r: RemoteDir): string {
  const dir = `${REMOTE_ROOT}/${r.sandbox}`;
  registry.set(dir, r);
  return dir;
}

export function unregisterRemoteDir(dir: string): void {
  registry.delete(dir);
}

export interface RemoteHit { remote: RemoteDir; /** The path inside the sandbox. */ path: string }

/** The sandbox a path belongs to, or null for a host path. */
export function remoteOf(path: string): RemoteHit | null {
  if (!path.startsWith(`${REMOTE_ROOT}/`)) return null;
  for (const [dir, remote] of registry) {
    if (path === dir) return { remote, path: remote.workDir };
    if (path.startsWith(`${dir}/`)) return { remote, path: posix.join(remote.workDir, path.slice(dir.length + 1)) };
  }
  return null;
}

/** The `openshell` argv that runs `argv` in the sandbox at `cwd`. */
export function sandboxExecArgs(r: RemoteDir, cwd: string, argv: string[]): string[] {
  return ['sandbox', 'exec', '-n', r.sandbox, '--no-login-shell', '--workdir', cwd, '--', ...argv];
}

/** Runs `argv` in the sandbox like `execFileSync` would on the host: stdout as text, a thrown error carrying `stderr`/`stdout`. */
export function execRemoteSync(hit: RemoteHit, argv: string[], o: { input?: string; cwd?: string } = {}): string {
  return execFileSync(hit.remote.bin, sandboxExecArgs(hit.remote, o.cwd ?? hit.path, argv), {
    encoding: 'utf8', stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    ...(o.input === undefined ? {} : { input: o.input }),
  });
}

/** `existsSync` for a path that may be in a sandbox. */
export function existsAt(path: string, hostExists: (p: string) => boolean): boolean {
  const hit = remoteOf(path);
  if (!hit) return hostExists(path);
  try { execRemoteSync(hit, ['test', '-e', hit.path], { cwd: hit.remote.workDir }); return true; } catch { return false; }
}

/** `readFileSync(path, 'utf8')` for a path that may be in a sandbox. */
export function readTextAt(path: string, hostRead: (p: string) => string): string {
  const hit = remoteOf(path);
  return hit ? execRemoteSync(hit, ['cat', '--', hit.path], { cwd: hit.remote.workDir }) : hostRead(path);
}

/** `writeFileSync(path, text)` for a path that may be in a sandbox. */
export function writeTextAt(path: string, text: string, hostWrite: (p: string, t: string) => void): void {
  const hit = remoteOf(path);
  if (!hit) { hostWrite(path, text); return; }
  execRemoteSync(hit, ['sh', '-c', 'cat > "$1"', 'sh', hit.path], { input: text, cwd: hit.remote.workDir });
}
