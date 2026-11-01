/**
 * `crew deprovision` (CREW-2882): wipes a host back to "crew is installed and
 * nothing else", so a pooled instance can serve the next tenant with no trace
 * of the last. It builds on `crew disconnect --reset --remove-checkouts`
 * (`reset.ts`, whose order it keeps) and adds what that leaves behind.
 *
 * Order, fixed:
 *   1. the scheduler units go (nothing wakes mid-wipe);
 *   2. every run in flight is killed, the kill is recorded on the event stream
 *      and the ticket is told, while the seat keys still exist;
 *   3. sandboxes are deleted, and this ship's Ships rows are cleared of
 *      `engaged`, `tunnel_status` and `relay_url` (the platform marks the rows
 *      retired afterwards; crew has no retired marker);
 *   4. seat keys revoked, workspace credential, Pair/MCP entries and the
 *      checkouts removed (the reset order), then every forge token erased;
 *   5. the cache volumes and repository image layers crew labeled are removed,
 *      the base and crew layers kept, anything crew did not label untouched;
 *   6. the state directory is emptied and crew.yaml removed last;
 *   7. verify: whatever still exists is listed and the exit is non-zero.
 *
 * Every effect is injected (`DeprovisionDeps`), so the order and the verify are
 * tested with fakes; `cli.ts` supplies the real ones.
 */

import { runReset, resetIncomplete, type ResetEffects, type ResetOptions, type ResetStep } from './reset.ts';

/** A run found live on this ship, enough to stop it and tell its ticket. */
export interface LiveRunRef {
  role: string;
  route: string;
  pid: number;
  ticketRecordId?: string;
  streamPath: string;
}

/** What crew labeled on Docker: removable caches and layers, and the layers that stay. */
export interface LabeledDockerResources {
  volumes: string[];
  /** Repository image layers (not the base or crew layers). */
  images: string[];
}

export interface DeprovisionDeps {
  liveRuns(): LiveRunRef[];
  /** SIGTERM the run's process group, SIGKILL after a grace period. */
  killRun(run: LiveRunRef): Promise<void>;
  /** Records the kill on the event stream. */
  recordKill(run: LiveRunRef): void;
  /** Tells the run's ticket it was interrupted (the orphaned-run hand-back); throws when the tracker is unreachable. */
  handBack(run: LiveRunRef): Promise<void>;
  /** Sandbox containers to delete, by name. */
  sandboxes(): string[];
  removeSandbox(name: string): void;
  /** Clears `engaged`, `tunnel_status` and `relay_url` on this ship's row in each served workspace; one line per route. */
  clearShipRows(): Promise<Array<{ route: string; ok: boolean; detail: string }>>;
  /** Forge hosts configured on this ship, and a way to erase each token. */
  forgeHosts(): string[];
  eraseForgeToken(host: string): 'erased' | 'env' | 'absent';
  labeled(): LabeledDockerResources;
  removeVolume(name: string): void;
  removeImage(name: string): void;
  /** Everything of the lease that still exists, one line each; empty when the host is clean. */
  remaining(): string[];
}

export interface DeprovisionOptions extends Omit<ResetOptions, 'afterScheduler' | 'beforeState' | 'wipeState' | 'removeCheckouts'> {}

export interface DeprovisionResult {
  steps: ResetStep[];
  /** What still exists after the wipe (verify). */
  remaining: string[];
  ok: boolean;
}

const mark = (dryRun: boolean): ResetStep['action'] => (dryRun ? 'would-remove' : 'removed');

export async function runDeprovision(o: DeprovisionOptions, fx: ResetEffects, deps: DeprovisionDeps): Promise<DeprovisionResult> {
  const attempt = (step: ResetStep['step'], target: string, fn: () => void, dry: boolean): ResetStep => {
    try {
      if (!dry) fn();
      return { step, target, action: mark(dry) };
    } catch (e) {
      return { step, target, action: 'failed', detail: (e as Error).message };
    }
  };

  const afterScheduler = async (): Promise<ResetStep[]> => {
    const steps: ResetStep[] = [];
    for (const run of deps.liveRuns()) {
      const target = `${run.role} run on ${run.route} (pid ${run.pid})`;
      if (o.dryRun) { steps.push({ step: 'run', target, action: 'would-remove' }); continue; }
      try {
        await deps.killRun(run);
        deps.recordKill(run);
      } catch (e) {
        steps.push({ step: 'run', target, action: 'failed', detail: (e as Error).message });
        continue;
      }
      try {
        await deps.handBack(run);
        steps.push({ step: 'run', target, action: 'removed', detail: 'killed' });
      } catch (e) {
        // The run is dead either way; the ticket not hearing about it is worth saying, not a reason to stop the wipe.
        steps.push({ step: 'run', target, action: 'removed', detail: `killed; could not tell its ticket (${(e as Error).message})` });
      }
    }
    for (const name of deps.sandboxes()) steps.push(attempt('sandbox', name, () => { deps.removeSandbox(name); }, o.dryRun));
    if (!o.dryRun) {
      for (const r of await deps.clearShipRows()) {
        steps.push({ step: 'ship-row', target: r.route, action: r.ok ? 'removed' : 'failed', detail: r.detail });
      }
    }
    return steps;
  };

  const beforeState = async (): Promise<ResetStep[]> => {
    const steps: ResetStep[] = [];
    for (const host of deps.forgeHosts()) {
      try {
        const result = o.dryRun ? 'erased' : deps.eraseForgeToken(host);
        if (result === 'env') steps.push({ step: 'forge', target: host, action: 'kept', detail: 'the token is read from the environment; crew does not own it' });
        else if (result === 'absent') steps.push({ step: 'forge', target: host, action: 'absent' });
        else steps.push({ step: 'forge', target: host, action: mark(o.dryRun) });
      } catch (e) {
        steps.push({ step: 'forge', target: host, action: 'failed', detail: (e as Error).message });
      }
    }
    const { volumes, images } = deps.labeled();
    for (const v of volumes) steps.push(attempt('cache', `volume ${v}`, () => { deps.removeVolume(v); }, o.dryRun));
    for (const i of images) steps.push(attempt('cache', `image ${i}`, () => { deps.removeImage(i); }, o.dryRun));
    return steps;
  };

  const steps = await runReset({ ...o, removeCheckouts: true, wipeState: true, afterScheduler, beforeState }, fx);
  const remaining = o.dryRun ? [] : deps.remaining();
  return { steps, remaining, ok: !resetIncomplete(steps) && remaining.length === 0 };
}
