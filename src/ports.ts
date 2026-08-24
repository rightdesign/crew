/**
 * Ports and the processes holding them.
 *
 * Every worktree derives its own ports from its ticket number, so parallel
 * checkouts never race each other or the operator's own dev stack. The
 * consequence is that a removed worktree can leave a server running on a port
 * nothing will ever reclaim — which is what `reap` is for.
 *
 * Ported from reap_orphan_ports / drop_worktree / the `ports` subcommand in
 * bin/crew. `lsof` is preferred and `ss` is the fallback, because lsof is not
 * installed by default on a minimal Linux.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Listener { pid: number; port: number }

const run = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

/** Everything listening on TCP, as {pid, port}. */
export function listeners(): Listener[] {
  const out: Listener[] = [];
  const seen = new Set<string>();
  const add = (pid: number, port: number) => {
    const key = `${pid}:${port}`;
    if (!Number.isFinite(pid) || !Number.isFinite(port) || seen.has(key)) return;
    seen.add(key);
    out.push({ pid, port });
  };

  const lsof = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  if (lsof) {
    for (const line of lsof.split('\n').slice(1)) {
      const cols = line.split(/\s+/);
      const addr = cols[8];
      if (!addr) continue;
      add(Number(cols[1]), Number(addr.slice(addr.lastIndexOf(':') + 1)));
    }
    return out;
  }
  // Linux without lsof: ss reports users:(("node",pid=123,fd=20)).
  const ss = run('ss', ['-ltnpH']);
  for (const line of ss.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    const pid = /pid=(\d+)/.exec(line)?.[1];
    if (!local || !pid) continue;
    add(Number(pid), Number(local.slice(local.lastIndexOf(':') + 1)));
  }
  return out;
}

export const pidsOnPort = (port: number): number[] =>
  listeners().filter((l) => l.port === port).map((l) => l.pid);

export interface PortScheme {
  backendBase: number;
  frontendBase: number;
  /** Ports at or above base+span belong to something else. */
  span: number;
}

export const DEFAULT_PORTS: PortScheme = { backendBase: 30000, frontendBase: 40000, span: 1000 };

/** Which ticket a port belongs to, or null if it is nothing of ours. */
export function ticketForPort(port: number, s: PortScheme = DEFAULT_PORTS): { n: number; role: string } | null {
  if (port >= s.backendBase && port < s.backendBase + s.span) return { n: port - s.backendBase, role: 'backend' };
  if (port >= s.frontendBase && port < s.frontendBase + s.span) return { n: port - s.frontendBase, role: 'frontend' };
  return null;
}

/**
 * Does a worktree for this ticket still exist?
 *
 * Tests for the `.git` FILE, not merely the directory. A removed worktree
 * whose leaked server rebuilt `dist/` leaves a directory behind that is no
 * longer a worktree at all — and matching on the directory let that skeleton
 * shield the very process that recreated it from being reaped.
 */
export function worktreeExists(parent: string, prefix: string, n: number): boolean {
  for (const name of [`${prefix}${n}`, `${prefix}${String(n).padStart(3, '0')}`]) {
    if (existsSync(join(parent, name, '.git'))) return true;
  }
  return false;
}

/**
 * The same question across every repository a connection serves.
 *
 * A connection spans several repos (ISSUE-331) and each names its worktrees
 * after itself (ISSUE-350), so asking one directory whether ISSUE-346's
 * worktree exists answers "no" for a ticket whose worktree is alive next
 * door — and `reap` acts on that answer by killing processes.
 */
export interface WorktreeLocation { parent: string; prefix: string }

export const worktreeExistsIn = (where: WorktreeLocation[], n: number): boolean =>
  where.some((w) => worktreeExists(w.parent, w.prefix, n));

export interface Orphan extends Listener { n: number; role: string }

export function findOrphans(parent: string, prefix: string, s: PortScheme = DEFAULT_PORTS): Orphan[] {
  return findOrphansIn([{ parent, prefix }], s);
}

/** Orphans across every repository — see `worktreeExistsIn`. */
export function findOrphansIn(where: WorktreeLocation[], s: PortScheme = DEFAULT_PORTS): Orphan[] {
  const orphans: Orphan[] = [];
  for (const l of listeners()) {
    const t = ticketForPort(l.port, s);
    if (!t) continue;
    if (worktreeExistsIn(where, t.n)) continue;
    orphans.push({ ...l, ...t });
  }
  return orphans;
}

/** SIGTERM, a moment to unwind, then SIGKILL. */
export async function killGently(pids: number[], graceMs = 2000): Promise<void> {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  if (pids.length === 0) return;
  await new Promise((r) => setTimeout(r, graceMs));
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

/** Processes with a foot in a worktree: its ports, plus anything running inside it. */
export function pidsInWorktree(path: string, n: number, s: PortScheme = DEFAULT_PORTS): number[] {
  const pids = new Set<number>();
  for (const port of [s.backendBase + n, s.frontendBase + n]) for (const p of pidsOnPort(port)) pids.add(p);
  const matched = run('pgrep', ['-f', `${path}/`]);
  for (const line of matched.split('\n')) {
    const pid = Number(line.trim());
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}
