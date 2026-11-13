/**
 * Retention for the artifacts `spawnAgent` writes under `<stateDir>/streams`
 * (ISSUE-401) — the raw NDJSON, the mapped fine-grained events, and the
 * per-run sidecar, one set per agent run. The shared `events.jsonl` this
 * whole ship writes to already passed 30MB in a day; per-run stream files
 * are bigger again and unbounded unless something sweeps them.
 *
 * Same shape as `worktree-sweep.ts` on purpose — plan, then apply — and
 * called from the same places, so a stale artifact never outlives the
 * worktree it came from by more than one sweep.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROTATED_EVENTS_RE } from './events.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every stream artifact older than `retentionDays`, oldest first. */
export function planStreamSweep(stateDir: string, retentionDays: number, now: number = Date.now()): string[] {
  const dir = join(stateDir, 'streams');
  if (!existsSync(dir)) return [];
  const cutoff = now - retentionDays * DAY_MS;
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => {
      try { return statSync(path).mtimeMs < cutoff; } catch { return false; }
    })
    .sort();
}

export interface SweepLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

/** Perform the plan. A file that fails to delete is logged and skipped, not fatal. */
export function applyStreamSweep(paths: string[], dryRun: boolean, log: SweepLog): number {
  let removed = 0;
  for (const path of paths) {
    if (dryRun) {
      log.emit(`would remove stream artifact ${path}`, { step: 'worktree' });
      continue;
    }
    try {
      rmSync(path, { force: true });
      removed++;
      log.emit(`removed stream artifact ${path}`, { step: 'worktree' });
    } catch (e) {
      log.warn(`could not remove stream artifact ${path}: ${(e as Error).message}`, { step: 'worktree' });
    }
  }
  return removed;
}

/**
 * Rotated shared event logs (`events.<stamp>.jsonl`, CREW-1509) older than
 * `retentionDays`, oldest first. The live `events.jsonl` never matches.
 */
export function planEventsSweep(stateDir: string, retentionDays: number, now: number = Date.now()): string[] {
  if (!existsSync(stateDir)) return [];
  const cutoff = now - retentionDays * DAY_MS;
  return readdirSync(stateDir)
    .filter((name) => ROTATED_EVENTS_RE.test(name))
    .map((name) => join(stateDir, name))
    .filter((path) => {
      try { return statSync(path).mtimeMs < cutoff; } catch { return false; }
    })
    .sort();
}

/**
 * Size cap over everything the time rule keeps (CREW-3318): stream artifacts
 * and rotated event logs together, oldest first, until the total is at or
 * under `maxBytes`. The time rule alone lets a busy ship keep gigabytes inside
 * the window. The live `events.jsonl` is not a candidate, and nothing touched
 * within the last day is, so a run in flight is never swept from under itself.
 */
export function planSizeCapSweep(stateDir: string, maxBytes: number, now: number = Date.now()): string[] {
  const files: { path: string; mtime: number; size: number }[] = [];
  const add = (dir: string, keep: (name: string) => boolean) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!keep(name)) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile()) files.push({ path, mtime: st.mtimeMs, size: st.size });
      } catch { /* vanished between readdir and stat */ }
    }
  };
  add(join(stateDir, 'streams'), () => true);
  add(stateDir, (name) => ROTATED_EVENTS_RE.test(name));
  let total = files.reduce((n, f) => n + f.size, 0);
  const out: string[] = [];
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (f.mtime > now - DAY_MS) break;
    out.push(f.path);
    total -= f.size;
  }
  return out;
}

/** Everything the state sweep would remove: the time rule, then the size cap over what survives it. */
export function planStateSweep(stateDir: string, retentionDays: number, maxBytes: number, now: number = Date.now()): string[] {
  const aged = [...planStreamSweep(stateDir, retentionDays, now), ...planEventsSweep(stateDir, retentionDays, now)];
  const gone = new Set(aged);
  const capped = planSizeCapSweep(stateDir, maxBytes, now).filter((p) => !gone.has(p));
  return [...aged, ...capped];
}
