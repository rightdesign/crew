/**
 * The wall-clock limit on a host agent run (CREW-2786, EPIC-075 §10).
 *
 * An agent run used to have no timeout and no kill path: stalled-work
 * detection only posts a comment. `maxRunMinutes` (a toolchain setting, a
 * route may override it) is the ceiling the daemon enforces for every run it
 * spawns. The deadline is written into the run's `.pid` sidecar and
 * `.meta.json` at spawn, so a daemon that restarts mid-run and adopts the run
 * (`reattachRun`) enforces the ORIGINAL deadline rather than starting a new
 * clock. The sandbox runner implements the same limit with a sandbox delete as
 * the kill; this module is the host runner's half of one contract.
 */

/** Ship default when neither the toolchain nor the route says: four hours. */
export const DEFAULT_MAX_RUN_MINUTES = 240;

/** How long a SIGTERMed process group gets before it is SIGKILLed. */
export const KILL_GRACE_MS = 5_000;

/** Why a run was ended by the daemon, as recorded on `interrupted` and the event. */
export const WALL_CLOCK_REASON = 'wall-clock';

/**
 * The limit that applies: the route's own, else the toolchain's, else the ship
 * default. 0 means "no limit".
 */
export function resolveMaxRunMinutes(route: number | undefined, toolchain: number | undefined): number {
  return route ?? toolchain ?? DEFAULT_MAX_RUN_MINUTES;
}

/** ISO deadline for a run spawned at `spawnedAt`, or undefined when unlimited. */
export function deadlineFor(spawnedAt: string, maxRunMinutes: number | undefined): string | undefined {
  if (!maxRunMinutes || maxRunMinutes <= 0) return undefined;
  const t = Date.parse(spawnedAt);
  return Number.isNaN(t) ? undefined : new Date(t + maxRunMinutes * 60_000).toISOString();
}

/** Milliseconds until `deadline` (negative once past); undefined when there is none. */
export function msUntilDeadline(deadline: string | undefined, now: number = Date.now()): number | undefined {
  if (!deadline) return undefined;
  const t = Date.parse(deadline);
  return Number.isNaN(t) ? undefined : t - now;
}

/**
 * Ends a run's whole process group the way `selftest` does: the agent was
 * spawned `detached`, so its pid is its group id and `-pid` reaches every
 * child it started. SIGTERM first, SIGKILL after a grace period if the leader
 * is still there. Resolves once the group has been signalled for the last time.
 */
export async function killRunGroup(
  pid: number, o: { graceMs?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<void> {
  const alive = o.isAlive ?? ((p: number) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } });
  const signal = (sig: NodeJS.Signals): void => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
  };
  signal('SIGTERM');
  const end = Date.now() + (o.graceMs ?? KILL_GRACE_MS);
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  if (alive(pid)) signal('SIGKILL');
}

export const RUN_KILLED_MARKER = '<!-- crew:run-killed -->';

/** The ticket comment a run killed at its limit leaves, in the shape of the interrupted comment. */
export function runKilledComment(b: { limitMinutes: number; branch: string | null; dirty: boolean | null }): string {
  const tree =
    b.dirty === null ? 'The worktree could not be checked.'
    : b.dirty ? 'The worktree has uncommitted changes — they are this seat\'s own, from that run.'
    : 'The worktree is clean.';
  return `${RUN_KILLED_MARKER}\n\n` +
    `The agent run on this ticket was stopped at its wall-clock limit of ${b.limitMinutes} minutes before it handed on` +
    `${b.branch ? `; its branch is \`${b.branch}\`` : ''}. ${tree} ` +
    'The worktree is left as it was. The next run on this seat resumes from it rather than starting over.';
}
