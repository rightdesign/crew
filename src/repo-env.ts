/**
 * CREW-3084: repository-scoped environment (Map EPIC-083 §8). The platform
 * delivers `repositoryEnv: [{ repoRowId, remote, env }]` in the lease payload
 * and in every `tokens` message; a repository's `env` goes into the sandboxes
 * of runs for that repository and nowhere else.
 *
 * The set lives in one owner-only file in the ship's state directory (so a
 * daemon restart keeps it and `crew deprovision`'s state wipe erases it). The
 * values are secrets: they reach the sandbox through `--env-from` only, and
 * nothing here, in the event stream, in a run sidecar or in `status` ever
 * prints one. `status` reports the count of repositories, never names.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RepositoryEnv {
  repoRowId?: string;
  remote?: string;
  env: Record<string, string>;
}

export function repoEnvPathFor(stateDir: string): string {
  return join(stateDir, 'repo-env.json');
}

/** A remote compared without scheme, credentials, `.git` and case, so `git@h:o/r.git` equals `https://h/o/r`. */
export function normalizeRemote(remote: string): string {
  return remote.trim().toLowerCase()
    .replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(':', '/')
    .replace(/\.git$/, '').replace(/\/+$/, '');
}

/** Keeps only well-formed entries: an entry with no env, a non-string value or no way to identify its repository is dropped. */
export function sanitizeRepositoryEnv(raw: unknown): RepositoryEnv[] {
  if (!Array.isArray(raw)) return [];
  const out: RepositoryEnv[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    if (!e || typeof e !== 'object' || !e.env || typeof e.env !== 'object') continue;
    const repoRowId = typeof e.repoRowId === 'string' && e.repoRowId ? e.repoRowId : undefined;
    const remote = typeof e.remote === 'string' && e.remote ? e.remote : undefined;
    if (!repoRowId && !remote) continue;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') env[k] = v;
    }
    if (Object.keys(env).length) out.push({ ...(repoRowId ? { repoRowId } : {}), ...(remote ? { remote } : {}), env });
  }
  return out;
}

export function readRepositoryEnv(stateDir: string): RepositoryEnv[] {
  try { return sanitizeRepositoryEnv(JSON.parse(readFileSync(repoEnvPathFor(stateDir), 'utf8'))); } catch { return []; }
}

/** Replaces the whole set; an empty set removes the file. */
export function writeRepositoryEnv(stateDir: string, entries: RepositoryEnv[]): void {
  const file = repoEnvPathFor(stateDir);
  const clean = sanitizeRepositoryEnv(entries);
  if (!clean.length) { eraseRepositoryEnv(stateDir); return; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function eraseRepositoryEnv(stateDir: string): void {
  rmSync(repoEnvPathFor(stateDir), { force: true });
}

export function hasRepositoryEnv(stateDir: string): boolean {
  return existsSync(repoEnvPathFor(stateDir));
}

/** How many repositories carry environment: the only thing `status` says about it. */
export function repositoryEnvCount(stateDir: string): number {
  return readRepositoryEnv(stateDir).length;
}

/** The environment for one run: matched by Repos row id, else by remote. A run with neither gets nothing. */
export function envForRepository(entries: RepositoryEnv[], repo: { repoRowId?: string; remote?: string }): Record<string, string> {
  const byId = repo.repoRowId ? entries.find((e) => e.repoRowId === repo.repoRowId) : undefined;
  if (byId) return { ...byId.env };
  const want = repo.remote ? normalizeRemote(repo.remote) : '';
  const byRemote = want ? entries.find((e) => e.remote && normalizeRemote(e.remote) === want) : undefined;
  return byRemote ? { ...byRemote.env } : {};
}
