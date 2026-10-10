/**
 * The installation's state directory: the poll watermark, pause sentinels and
 * the release-block counter. Everything here belongs to one installation on
 * one machine, which is why none of it is in the repo or the tracker.
 *
 * Ported from the state-file handling in bin/crew. Paths are built with
 * node:path throughout — a state dir on Windows is as valid as one on POSIX.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleName } from './config.ts';
import type { ShipAttentionItem } from './ship-attention.ts';

/** Before the first poll, everything is new. */
export const EPOCH = '1970-01-01T00:00:00.000Z';

export class State {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  /**
   * The timestamp every "new since last poll" check is measured against.
   *
   * Read once per cycle and advanced only AFTER every role has been
   * evaluated: bumping it inside the first role's check would hide that
   * role's new comments from the second.
   */
  watermark(): string {
    try {
      const v = readFileSync(this.path('.poll-watermark'), 'utf8').trim();
      return v || EPOCH;
    } catch {
      return EPOCH;
    }
  }

  setWatermark(at: string): void {
    writeFileSync(this.path('.poll-watermark'), `${at}\n`);
  }

  /**
   * Advance to the newest thing this cycle actually saw, never to "now".
   *
   * Using the clock would silently skip any comment written between the fetch
   * and the write — a race that loses work rather than repeating it, which is
   * the wrong way round. Repeating a cycle is free; missing one is not.
   */
  advanceWatermark(seen: Array<{ created_at?: string; updated_at?: string }>): string {
    const stamps = seen
      .flatMap((s) => [s.created_at, s.updated_at])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const next = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : this.watermark();
    this.setWatermark(next);
    return next;
  }

  /** Whole-crew pause, and the per-role sentinels one level down. */
  isPaused(): boolean {
    return existsSync(this.path('.crew-paused'));
  }
  isRolePaused(role: RoleName): boolean {
    return existsSync(this.path(`.role-paused-${role}`));
  }
  pausedRoles(roles: RoleName[]): Set<RoleName> {
    return new Set(roles.filter((r) => this.isRolePaused(r)));
  }
  pause(role?: RoleName): void {
    writeFileSync(role ? this.path(`.role-paused-${role}`) : this.path('.crew-paused'), '');
  }
  resume(role?: RoleName): void {
    rmSync(role ? this.path(`.role-paused-${role}`) : this.path('.crew-paused'), { force: true });
  }

  /**
   * The release phase (merge, deploy, release) has its own sentinel, one
   * level below the whole-crew pause: `crew pause release` stops shipping
   * while agents keep working.
   */
  isReleasePaused(): boolean {
    return existsSync(this.path('.release-paused'));
  }
  setReleasePaused(paused: boolean): void {
    if (paused) writeFileSync(this.path('.release-paused'), '');
    else rmSync(this.path('.release-paused'), { force: true });
  }
  /**
   * Why a release cycle must not run right now, or null when it may. Every
   * release entry point checks this first — the release timer, `crew release`,
   * `crew merge`, `crew deploy` and the inline release a `run` cycle used to
   * do — so a paused ship cannot merge, deploy, or file release alerts.
   * A release already in flight when the pause lands finishes; only new
   * cycles are refused.
   */
  releaseSkipReason(): string | null {
    if (this.isPaused()) return 'the crew is paused';
    if (this.isReleasePaused()) return 'releases are paused';
    return null;
  }

  /**
   * Take an exclusive lock, or report who holds it.
   *
   * A timer fires every couple of minutes and an agent run takes minutes, so
   * overlapping fires are certain rather than hypothetical — and two agents
   * on one checkout would fight over the same worktree and the same tickets.
   *
   * A lock naming a DEAD pid is stale and taken over: a run killed mid-cycle
   * (a reboot, a Ctrl-C) must not wedge the crew until someone notices.
   */
  /**
   * Lock names become filenames, so anything that could be read as a path has
   * to go. A scope like `route/repo` otherwise produced
   * `.release-route/repo.lock` — a write into a directory that does not exist.
   */
  private static safe(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, '_');
  }

  acquire(rawName: string): { ok: true; release: () => void } | { ok: false; heldBy: number } {
    const name = State.safe(rawName);
    const file = this.path(`.${name}.lock`);
    try {
      const existing = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
      if (Number.isFinite(existing) && existing > 0) {
        try {
          process.kill(existing, 0);        // signal 0 tests liveness only
          return { ok: false, heldBy: existing };
        } catch { /* the pid is gone; the lock is stale */ }
      }
    } catch { /* no lock file */ }
    writeFileSync(file, `${process.pid}\n`);
    return {
      ok: true,
      release: () => { try { rmSync(file, { force: true }); } catch { /* ignore */ } },
    };
  }

  /**
   * Like `acquire`, but for a resource with `max` interchangeable slots
   * rather than one exclusive holder — this machine's overall concurrency
   * capacity (ISSUE-381), which nothing needs to name a particular slot to
   * use. Takes whichever numbered slot is free first.
   */
  acquireN(rawPrefix: string, max: number): { ok: true; release: () => void } | { ok: false; heldBy: number[] } {
    const heldBy: number[] = [];
    for (let i = 1; i <= max; i++) {
      const got = this.acquire(`${rawPrefix}-${i}`);
      if (got.ok) return got;
      heldBy.push(got.heldBy);
    }
    return { ok: false, heldBy };
  }

  /**
   * The run lock (ISSUE-381): role-distinct AND capacity-limited, checked
   * together.
   *
   * Role queues are disjoint by construction (`sliceFor`), so two sessions
   * of the SAME role would collide on the same ticket if ever let run at
   * once — that half is a plain exclusive lock, one per role name, and
   * never relaxed. `max` is this machine's separate, configurable limit on
   * how many DIFFERENT roles may run together; a role that clears its own
   * lock but finds every slot taken must give the slot back its lock too,
   * or a locked-but-not-running role would wedge itself out for the rest
   * of the machine's uptime.
   */
  acquireRun(role: string, max: number): { ok: true; release: () => void } | { ok: false; reason: string } {
    const roleLock = this.acquire(`crew-role-${role}`);
    if (!roleLock.ok) {
      return { ok: false, reason: `${role} is already running (pid ${roleLock.heldBy})` };
    }
    const slot = this.acquireN('crew-slot', max);
    if (!slot.ok) {
      roleLock.release();
      return {
        ok: false,
        reason: `at capacity — ${max} agent(s) already running (pid${slot.heldBy.length > 1 ? 's' : ''} ${slot.heldBy.join(', ')})`,
      };
    }
    return { ok: true, release: () => { slot.release(); roleLock.release(); } };
  }

  /**
   * How many consecutive cycles the release phase has refused to deploy.
   *
   * Refusing is correct — a dirty tree or a non-main checkout must never be
   * released — but it used to be SILENT, and eight commits once sat unreleased
   * behind a single untracked file with nothing saying so (ISSUE-174). One
   * blocked cycle is normal; the count is what makes a persistent one loud.
   */
  /**
   * Release bookkeeping, scoped to one route.
   *
   * Scoped because a ship serves several boards and releases each repo
   * independently (ISSUE-338). These were single global files, so a deploy
   * failure on one route suppressed releases on every other one, and a
   * release blocked in one repo counted cycles for all of them — a dirty tree
   * in one checkout would have silently held up an unrelated project.
   */
  release(route: string) {
    const suffix = State.safe(route);
    const blocked = `.release-blocked-${suffix}`;
    const failed = `.deploy-failed-sha-${suffix}`;
    const gateFailed = `.test-gate-failed-${suffix}`;
    const gateReported = `.test-gate-reported-${suffix}`;
    const heldReported = `.release-held-${suffix}`;
    const read = (f: string): string | null => {
      try { return readFileSync(this.path(f), 'utf8').trim() || null; } catch { return null; }
    };
    return {
      blockedCount: (): number => Number.parseInt(read(blocked) ?? '', 10) || 0,
      noteBlocked: (): number => {
        const n = (Number.parseInt(read(blocked) ?? '', 10) || 0) + 1;
        writeFileSync(this.path(blocked), `${n}\n`);
        return n;
      },
      clearBlocked: (): void => { rmSync(this.path(blocked), { force: true }); },

      /**
       * The commit a deploy last failed on.
       *
       * Without this the crew retries a broken deploy on every cycle — every
       * two minutes, indefinitely — hammering the target and burying the
       * original failure under identical ones. A failed commit is retried
       * only when a NEW commit lands, or when an operator forces it by hand.
       */
      deployFailedSha: (): string | null => read(failed),
      noteDeployFailed: (sha: string): void => { writeFileSync(this.path(failed), `${sha}\n`); },
      clearDeployFailed: (): void => { rmSync(this.path(failed), { force: true }); },

      /**
       * Consecutive test-gate failures on the same head (CREW-1368). A failure
       * on a new head restarts the count. Held on disk because one process is
       * one cycle, and "failed three cycles running" only exists across them.
       */
      noteTestGateFailed: (sha: string): number => {
        const [prev, n] = (read(gateFailed) ?? '').split(' ');
        const next = prev === sha ? (Number.parseInt(n ?? '', 10) || 0) + 1 : 1;
        writeFileSync(this.path(gateFailed), `${sha} ${next}\n`);
        return next;
      },
      clearTestGateFailed: (): void => { rmSync(this.path(gateFailed), { force: true }); },
      /** Whether the board was already told about this head's red gate. */
      heldReported: (): string | null => {
        try { return readFileSync(this.path(heldReported), 'utf8').replace(/\n$/, '') || null; } catch { return null; }
      },
      noteHeldReported: (signature: string): void => { writeFileSync(this.path(heldReported), `${signature}\n`); },
      clearHeldReported: (): void => { rmSync(this.path(heldReported), { force: true }); },
      testGateReported: (sha: string): boolean => read(gateReported) === sha,
      noteTestGateReported: (sha: string): void => { writeFileSync(this.path(gateReported), `${sha}\n`); },
    };
  }

  /**
   * Starvation bookkeeping, scoped to one route (ISSUE-382).
   *
   * `decideFleet` already renders the winner and each role's rank; what it
   * throws away is the other side — a route that had work and did not
   * win, and the same ticket sitting at the front of that route's queue
   * cycle after cycle. This is state, not memory: a single process is one
   * cycle, so "how long has this been waiting" only exists if it survives
   * between them.
   */
  fairness(route: string) {
    const suffix = State.safe(route);
    const streakFile = `.fairness-streak-${suffix}`;
    const ticketFile = `.fairness-ticket-${suffix}`;
    const sinceFile = `.fairness-since-${suffix}`;
    const ticketStreakFile = `.fairness-ticket-streak-${suffix}`;
    const read = (f: string): string | null => {
      try { return readFileSync(this.path(f), 'utf8').trim() || null; } catch { return null; }
    };
    const clear = (): void => {
      for (const f of [streakFile, ticketFile, sinceFile, ticketStreakFile]) rmSync(this.path(f), { force: true });
    };
    return {
      /** Consecutive cycles this route had actionable work and did not win. */
      streak: (): number => Number.parseInt(read(streakFile) ?? '', 10) || 0,
      /**
       * The ticket sitting at the front of this route's queue, how long
       * it has been there and its own consecutive-passed-over count — or
       * undefined if nothing is waiting.
       */
      waiting: (): { ticket: string; since: string; streak: number } | undefined => {
        const ticket = read(ticketFile);
        const since = read(sinceFile);
        if (!ticket || !since) return undefined;
        return { ticket, since, streak: Number.parseInt(read(ticketStreakFile) ?? '', 10) || 0 };
      },
      /**
       * Record what one cycle saw for this route: how many tickets were
       * actionable, which one was most urgent, and whether this route
       * won. Winning or running dry both reset the streak — there is nothing
       * left being passed over.
       */
      record: (actionable: number, topTicket: string | undefined, won: boolean): void => {
        if (won || actionable === 0) { clear(); return; }
        writeFileSync(this.path(streakFile), `${this.readInt(streakFile) + 1}\n`);
        const prior = read(ticketFile);
        if (topTicket && topTicket === prior) {
          writeFileSync(this.path(ticketStreakFile), `${this.readInt(ticketStreakFile) + 1}\n`);
        } else if (topTicket) {
          writeFileSync(this.path(ticketFile), `${topTicket}\n`);
          writeFileSync(this.path(sinceFile), `${new Date().toISOString()}\n`);
          writeFileSync(this.path(ticketStreakFile), '1\n');
        }
      },
    };
  }

  /**
   * The previous cycle's "needs a person" set, scoped to one route
   * (ISSUE-928) — `{ ticketId: [reason, ...] }`. `poll.ts` reads it once
   * per cycle to compute transitions and the caller (`cli.ts`'s run path,
   * `fleet.ts`'s per-route loop) persists the new set afterward, beside the
   * existing `fairness(route).record(...)` call — never inside `decideCycle`
   * itself, which does no writes. A corrupt or missing file reads as empty,
   * which is also deliberately what a fresh install sees: everything
   * currently needing a person emits once, rather than being silently
   * skipped as though already notified.
   */
  attention(route: string) {
    const file = `.attention-${State.safe(route)}.json`;
    return {
      previous: (): Record<string, string[]> => {
        try {
          const parsed = JSON.parse(readFileSync(this.path(file), 'utf8'));
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      },
      persist: (next: Record<string, string[]>): void => {
        writeFileSync(this.path(file), JSON.stringify(next));
      },
    };
  }

  /**
   * Open ship-level attention items (CREW-1373), ship-wide rather than
   * per-route: a parked role or a missing hook command is about this
   * machine. A corrupt or missing file reads as empty.
   */
  shipAttention() {
    const file = '.ship-attention.json';
    return {
      previous: (): ShipAttentionItem[] => {
        try {
          const parsed: unknown = JSON.parse(readFileSync(this.path(file), 'utf8'));
          return Array.isArray(parsed) ? (parsed as ShipAttentionItem[]) : [];
        } catch {
          return [];
        }
      },
      persist: (next: ShipAttentionItem[]): void => {
        writeFileSync(this.path(file), JSON.stringify(next));
      },
    };
  }

  /**
   * When the release phase last ran a cycle (CREW-1373), as the mtime of a
   * marker file. `touch()` is called at the start and the end of every cycle
   * so a long deploy does not read as a stopped timer.
   */
  releaseHeartbeat() {
    const file = '.release-last-run';
    return {
      touch: (): void => { writeFileSync(this.path(file), new Date().toISOString()); },
      at: (): number | null => {
        try { return statSync(this.path(file)).mtimeMs; } catch { return null; }
      },
    };
  }

  private readInt(file: string): number {
    try { return Number.parseInt(readFileSync(this.path(file), 'utf8').trim(), 10) || 0; } catch { return 0; }
  }
}
