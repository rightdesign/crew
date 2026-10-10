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
