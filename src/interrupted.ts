/**
 * Runs that outlived the crew process that started them (CREW-1775).
 *
 * `spawnAgent` gives each agent its own process group and a `<stream>.pid`
 * sidecar, so a daemon exit (a crash, a launchd relaunch, a self-update) no
 * longer takes the in-flight run with it. What is left is bookkeeping: the
 * process that was going to write the run's meta, finish event and Agent Log
 * row is gone. This module is the restarted daemon's half of that — it finds
 * every stream that has a sidecar, no meta, and no live owner, then adopts the
 * run if it is still going (it counts against `maxConcurrentAgents` and keeps
 * its role busy until it exits) or reports it as interrupted if it is not.
 *
 * Streams written before the sidecar existed have none and are left alone.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reattachRun, readRunSidecar, runIsAlive, type ReattachOptions, type ReattachResult, type RunSidecar } from './agent.ts';
import type { Emitter } from './events.ts';
import type { State } from './state.ts';

/** The `interrupted` event posted on the ticket a dead run was holding. */
export const INTERRUPTED_MARKER = '<!-- crew:interrupted -->';

export interface InterruptedBody {
  branch: string | null;
  /** Null when the worktree could not be located or read. */
  dirty: boolean | null;
  reason: string;
}

/** The event body: marker first (so a reader can match it), then what the next run needs to know. */
export function interruptedComment(b: InterruptedBody): string {
  const tree =
    b.dirty === null ? 'The worktree could not be checked.'
    : b.dirty ? 'The worktree has uncommitted changes — they are this seat\'s own, from that run.'
    : 'The worktree is clean.';
  return `${INTERRUPTED_MARKER}\n` +
    `The agent run on this ticket was cut short (${b.reason}) before it handed on` +
    `${b.branch ? `; its branch is \`${b.branch}\`` : ''}. ${tree} ` +
    'The next run on this seat resumes from the worktree rather than starting over.';
}

export interface ReconcileOptions {
  stateDir: string;
  /** Only streams of this route (`routeSlug`) are handled; the streams directory is ship-wide. */
  routeLabel: string;
  emit: Emitter;
  state: State;
  maxConcurrentAgents: number;
  /** Keeps adopted runs in the pass's in-flight set so a caller can await them. */
  inFlight?: Set<Promise<void>>;
  agentLogKey?: (role: string) => Promise<string | undefined>;
  /** Tracker-side follow-up for a finished or interrupted run (event, crew status, hand-off check). */
  afterRun?: (sc: RunSidecar, result: ReattachResult) => Promise<void>;
  /** Injected for tests. */
  isAlive?: ReattachOptions['isAlive'];
  isOwnerAlive?: (pid: number) => boolean;
  pollMs?: number;
}

/** Streams already handed to `reattachRun` by this process, so a later pass does not take them twice. */
const handled = new Set<string>();

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Stream files in `<stateDir>/streams` that carry a sidecar and no meta. */
export function orphanedStreams(o: Pick<ReconcileOptions, 'stateDir' | 'routeLabel' | 'isOwnerAlive'>): Array<{ streamPath: string; sidecar: RunSidecar }> {
  const dir = join(o.stateDir, 'streams');
  if (!existsSync(dir)) return [];
  const ownerAlive = o.isOwnerAlive ?? pidAlive;
  const out: Array<{ streamPath: string; sidecar: RunSidecar }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl') || name.endsWith('.events.jsonl')) continue;
    const streamPath = join(dir, name);
    if (existsSync(`${streamPath}.meta.json`)) continue;
    const sidecar = readRunSidecar(streamPath);
    if (!sidecar || sidecar.route !== o.routeLabel) continue;
    if (ownerAlive(sidecar.ownerPid)) continue;   // its own process is still finishing it
    out.push({ streamPath, sidecar });
  }
  return out;
}

/**
 * Adopts or reports every orphaned run. Resolves once the dead ones are
 * reported; runs found alive carry on in the background (tracked in
 * `inFlight`) and release their role and capacity slot when they exit.
 */
export async function reconcileRuns(o: ReconcileOptions): Promise<{ adopted: number; interrupted: number }> {
  let adopted = 0;
  let interrupted = 0;
  for (const { streamPath, sidecar } of orphanedStreams(o)) {
    if (handled.has(streamPath)) continue;
    handled.add(streamPath);
    const isAlive = o.isAlive ?? runIsAlive;
    // A run still going holds its role and a capacity slot from this process,
    // so a new run cannot double up on it; if the locks cannot be taken it is
    // adopted anyway — it is running whatever the books say.
    const lock = isAlive(sidecar) ? o.state.acquireRun(sidecar.role, o.maxConcurrentAgents) : null;
    const work = (async () => {
      try {
        const result = await reattachRun(streamPath, sidecar, o.emit, {
          agentLogKey: await o.agentLogKey?.(sidecar.role).catch(() => undefined),
          isAlive: o.isAlive,
          pollMs: o.pollMs,
          onAdopted: () => o.emit.emit(`adopted ${sidecar.role} run (pid ${sidecar.pid}) left by a previous crew process`, { step: 'agent', role: sidecar.role }),
        });
        if (result.adopted) adopted++; else interrupted++;
        try { await o.afterRun?.(sidecar, result); } catch (e) {
          o.emit.warn(`could not follow up on ${sidecar.role} run ${streamPath}: ${(e as Error).message}`, { step: 'agent' });
        }
      } catch (e) {
        o.emit.warn(`could not reattach ${sidecar.role} run ${streamPath}: ${(e as Error).message}`, { step: 'agent' });
      } finally {
        if (lock?.ok) lock.release();
      }
    })();
    if (isAlive(sidecar)) {
      if (o.inFlight) {
        o.inFlight.add(work);
        void work.finally(() => o.inFlight!.delete(work));
      }
    } else {
      await work;
    }
  }
  return { adopted, interrupted };
}

/** Test seam: forget which streams this process has handled. */
export function resetReconcileForTests(): void { handled.clear(); }
