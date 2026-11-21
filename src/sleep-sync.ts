import { spawnSync } from 'node:child_process';

/** The Bun global, present only in the compiled binary (and under `bun run`). */
interface BunGlobal { sleepSync?: (ms: number) => void }

/**
 * Synchronous sleep, for the few loops that are themselves synchronous (the
 * passenger sync-daemon reconcile, the git checkout lock, `crew daemon start`).
 *
 * CREW-3876: the compiled binary's runtime has no `SharedArrayBuffer` global, so
 * the old `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), ...)` threw the
 * first time it ran there. Mechanisms, in order: `Atomics.wait` where the global
 * exists (the Node package), `Bun.sleepSync` (the compiled binary), then a `sleep`
 * child process. Each is skipped when it is missing or throws, so one runtime's
 * gap never surfaces as an error to the caller.
 */
export function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  if (typeof SharedArrayBuffer !== 'undefined') {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return;
    } catch { /* fall through */ }
  }
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (typeof bun?.sleepSync === 'function') {
    try {
      bun.sleepSync(ms);
      return;
    } catch { /* fall through */ }
  }
  const r = spawnSync('sleep', [String(ms / 1000)], { stdio: 'ignore' });
  if (r.error) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* last resort: busy-wait */ }
  }
}

/**
 * The build-time check behind `crew sleep-sync-check`: sleeps 50 ms and requires
 * that it neither threw nor returned early. `scripts/build-binaries.sh` runs it
 * on every compiled binary, so a runtime gap fails the build, not a ship.
 */
export function sleepSyncCheck(sleep: (ms: number) => void = sleepSync): { ok: boolean; message: string } {
  const started = Date.now();
  try {
    sleep(50);
  } catch (e) {
    return { ok: false, message: `sleep-sync failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const took = Date.now() - started;
  if (took < 40) return { ok: false, message: `sleep-sync returned after ${took} ms, expected about 50` };
  return { ok: true, message: `sleep-sync ok: ${took} ms` };
}
