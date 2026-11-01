/**
 * Which agent runs are live on this ship right now (CREW-2822).
 *
 * With several runs of one role at once (`ship.roleConcurrency`, CREW-2821) a
 * seat or the ship is busy while ANY of its runs lives, so "this run ended"
 * no longer means "go idle". The answer is read from the run sidecars in
 * `<stateDir>/streams` (written at spawn, so a run adopted by a restarted
 * daemon and a one-shot `crew run` count the same as a daemon-spawned one),
 * never from an in-process counter.
 *
 * Known gap: a run between claiming its ticket and spawning its agent has no
 * sidecar yet, so it is not counted for that short window.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRunSidecar, runIsAlive, type RunSidecar } from './agent.ts';
import { reposOf, routeSlug, type RoleName, type Route } from './config.ts';
import { worktreeForNumber } from './git.ts';
import type { Emitter } from './events.ts';
import { runFinished } from './interrupted.ts';
import type { Tracker } from './tracker.ts';

export interface LiveRun extends RunSidecar {
  streamPath: string;
}

/** Every unfinished run on this ship whose agent process is alive, oldest first. */
export function liveRuns(stateDir: string, isAlive: (sc: RunSidecar) => boolean = runIsAlive): LiveRun[] {
  const dir = join(stateDir, 'streams');
  if (!existsSync(dir)) return [];
  const out: LiveRun[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl') || name.endsWith('.events.jsonl')) continue;
    const streamPath = join(dir, name);
    if (runFinished(streamPath)) continue;
    const sidecar = readRunSidecar(streamPath);
    if (!sidecar || !isAlive(sidecar)) continue;
    out.push({ ...sidecar, streamPath });
  }
  return out.sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
}

/** Live runs other than the one on `ownTicketRecordId`, oldest first. */
export function siblingRuns(runs: LiveRun[], ownTicketRecordId: string | null): LiveRun[] {
  return runs.filter((r) => !ownTicketRecordId || r.ticketRecordId !== ownTicketRecordId);
}

/**
 * What a run's end writes to the seat and the ship row. With no sibling run it
 * is the historical pair (seat idle, ship idle). While a sibling lives the seat
 * stays `working` and the ship `engaged`, both naming the newest sibling's
 * ticket, so whichever run finishes first never marks the others idle.
 */
export async function settleRunEnd(o: {
  tracker: Tracker; shipName: string; route: Route; role: RoleName; memberId?: string;
  ownTicketRecordId: string | null; stateDir: string; emit: Emitter;
  runs?: LiveRun[];
}): Promise<void> {
  const { tracker, emit } = o;
  const all = o.runs ?? liveRuns(o.stateDir);
  // Seats belong to one route, so a sibling on another route does not keep this seat busy;
  // the ship heartbeat below is ship-wide and counts every route.
  const slug = routeSlug(o.route.route);
  const seatSiblings = siblingRuns(all.filter((r) => r.role === o.role && r.route === slug), o.ownTicketRecordId);
  const shipSiblings = siblingRuns(all, o.ownTicketRecordId);
  const newest = (rs: LiveRun[]): LiveRun => rs[rs.length - 1]!;

  if (o.memberId) {
    try {
      if (seatSiblings.length) await tracker.setCrewStatus(o.memberId, 'working', newest(seatSiblings).ticketRecordId);
      else await tracker.setCrewStatus(o.memberId, 'idle');
    } catch (e) {
      emit.warn(`could not clear crew status: ${(e as Error).message}`, { step: 'agent' });
    }
  }
  try {
    if (shipSiblings.length) {
      const n = newest(shipSiblings);
      await tracker.beatEngaged(o.shipName, n.routeName ?? n.route, n.ticketRecordId, n.spawnedAt);
    } else {
      await tracker.beatIdle(o.shipName);
    }
  } catch (e) {
    emit.warn(`could not beat ship idle: ${(e as Error).message}`, { step: 'agent' });
  }
}

/** The `runs` entry `crew status --json` prints for one live run. */
export function describeRun(
  run: LiveRun, route: Route, seatIds: Partial<Record<string, string>>,
  worktreeOf: (repoDir: string, num: string) => string | null = (d, n) => {
    try { return worktreeForNumber(d, n)?.path ?? null; } catch { return null; }
  },
) {
  // The sidecar names the route by slug; a seat id is only known for this route's own runs.
  const ownRoute = run.route === routeSlug(route.route);
  const repoDir = run.repo ? reposOf(route).find((t) => t.name === run.repo)?.dir : undefined;
  const num = run.ticket?.replace(/^\D+/, '') ?? '';
  return {
    role: run.role,
    seat: ownRoute ? seatIds[run.role] ?? null : null,
    ticket: run.ticket,
    ticketRecordId: run.ticketRecordId,
    repo: run.repo ?? null,
    worktree: repoDir && num ? worktreeOf(repoDir, num) : null,
    stream: run.streamPath,
    pid: run.pid,
    startedAt: run.spawnedAt,
  };
}
