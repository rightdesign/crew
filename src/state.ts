/**
 * The installation's state directory: the poll watermark, pause sentinels and
 * the release-block counter. Everything here belongs to one installation on
 * one machine, which is why none of it is in the repo or the tracker.
 *
 * Ported from the state-file handling in bin/crew. Paths are built with
 * node:path throughout — a state dir on Windows is as valid as one on POSIX.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleName } from './config.ts';

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
   * How many consecutive cycles the release phase has refused to deploy.
   *
   * Refusing is correct — a dirty tree or a non-main checkout must never be
   * released — but it used to be SILENT, and eight commits once sat unreleased
   * behind a single untracked file with nothing saying so (ISSUE-174). One
   * blocked cycle is normal; the count is what makes a persistent one loud.
   */
  releaseBlockedCount(): number {
    try {
      return Number.parseInt(readFileSync(this.path('.release-blocked'), 'utf8').trim(), 10) || 0;
    } catch {
      return 0;
    }
  }
  noteReleaseBlocked(): number {
    const n = this.releaseBlockedCount() + 1;
    writeFileSync(this.path('.release-blocked'), `${n}\n`);
    return n;
  }
  clearReleaseBlock(): void {
    rmSync(this.path('.release-blocked'), { force: true });
  }
}
