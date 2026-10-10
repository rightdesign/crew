/**
 * What the crew is doing, as data.
 *
 * The bash runner emitted free text: `log "poll[dev]: 3 ticket(s) ..."`.
 * Anything wanting to *show* what the crew is doing had to regex that back
 * into meaning, and every reworded message broke it.
 *
 * So the runner emits structured events and the human-readable log is
 * RENDERED from them, rather than being the only artifact. `crew watch`
 * (ISSUE-335) is then a renderer over this; so are the PRD's tray, a truthful
 * Ships heartbeat (ISSUE-328), and `crew status` — none of which should be
 * parsing a log file.
 *
 * The emission half is built here, with stages 5-7, because writing it
 * alongside the code that emits is nearly free and retrofitting it is not.
 * No view is built yet.
 */

import {
  appendFileSync, mkdirSync, readFileSync, existsSync, statSync, renameSync, openSync, closeSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/** Where a cycle is. Ordered as they occur, which is what a view renders as progress. */
export const STEPS = [
  'poll', 'sweep', 'select', 'worktree', 'agent', 'reconcile', 'merge', 'release', 'idle', 'passengers',
] as const;
export type Step = (typeof STEPS)[number];

export type Level = 'info' | 'warn' | 'error';

export interface CrewEvent {
  at: string;
  /** Groups every event of one poll cycle, so a view can show "this cycle". */
  cycle: string;
  route: string;
  step: Step;
  level: Level;
  message: string;
  role?: string;
  /** The human-facing key, e.g. ISSUE-326 — never the uuid. */
  ticket?: string;
  /** Anything structured a view might want: ranks, counts, durations. */
  data?: Record<string, unknown>;
}

/** The text form, matching the bash log so existing habits still work. */
export function render(e: CrewEvent): string {
  const scope = e.role ? `${e.step}[${e.role}]` : e.step;
  const ticket = e.ticket ? ` ${e.ticket}` : '';
  const level = e.level === 'info' ? '' : `${e.level.toUpperCase()}: `;
  return `${e.at} ${scope}:${ticket} ${level}${e.message}`;
}

export interface EmitterOptions {
  route: string;
  /** JSONL sink — what a view tails. */
  eventFile?: string;
  /** Text sink — the human log. */
  logFile?: string;
  /** Also write text here. Defaults to stderr so stdout stays parseable. */
  console?: (line: string) => void;
  /** Injected so cycle ids and timestamps are testable. */
  now?: () => Date;
  cycleId?: string;
  /**
   * Rotate `eventFile` once it exceeds this many bytes (CREW-1509). Unset
   * means never rotate (tests, one-off emitters).
   */
  rotateBytes?: number;
}

/** Default `ship.eventsRotateBytes`: 64 MB. */
export const DEFAULT_EVENTS_ROTATE_BYTES = 64 * 1024 * 1024;

/** `events.<UTC stamp>.jsonl`, the name a rotated live file is renamed to. */
export const ROTATED_EVENTS_RE = /^events\.\d{8}T\d{6}Z(?:-\d+)?\.jsonl$/;

const ROTATE_LOCK_STALE_MS = 60_000;

/**
 * Rename `file` to `events.<UTC timestamp>.jsonl` beside it when it is larger
 * than `maxBytes`, so the next append starts a fresh live file. Returns the
 * rotated path, or undefined when nothing was rotated.
 *
 * Rename, never truncate in place: a reader holding an offset sees the live
 * file shrink and re-seeds, and no line is torn. Every process on the ship
 * (daemon, `crew release --fleet`, a manual `crew run`) appends to the same
 * file, so rotation takes an exclusive lock file and re-checks the size under
 * it — a loser of the race finds a small file and leaves it alone rather than
 * renaming the fresh one the winner just started.
 */
export function rotateEventsFile(file: string, maxBytes: number, now: Date = new Date()): string | undefined {
  try {
    if (!existsSync(file) || statSync(file).size <= maxBytes) return undefined;
  } catch { return undefined; }
  const lock = `${file}.rotate.lock`;
  try {
    try {
      closeSync(openSync(lock, 'wx'));
    } catch {
      // Held by another process — or left behind by one that died mid-rotate.
      try {
        if (Date.now() - statSync(lock).mtimeMs < ROTATE_LOCK_STALE_MS) return undefined;
        rmSync(lock, { force: true });
        closeSync(openSync(lock, 'wx'));
      } catch { return undefined; }
    }
    try {
      if (statSync(file).size <= maxBytes) return undefined;
      const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      let dest = join(dirname(file), `events.${stamp}.jsonl`);
      for (let n = 1; existsSync(dest); n++) dest = join(dirname(file), `events.${stamp}-${n}.jsonl`);
      renameSync(file, dest);
      return dest;
    } finally {
      rmSync(lock, { force: true });
    }
  } catch {
    return undefined;
  }
}

export class Emitter {
  readonly cycle: string;
  private readonly opts: EmitterOptions;
  private readonly now: () => Date;
  private step: Step = 'poll';
  private role: string | undefined;

  constructor(opts: EmitterOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    this.cycle = opts.cycleId ?? this.now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    // Same rule as emit(): a sink that cannot be prepared degrades
    // observability, it does not prevent the crew from running.
    for (const f of [opts.eventFile, opts.logFile]) {
      if (!f) continue;
      try { mkdirSync(dirname(f), { recursive: true }); } catch { /* ignore */ }
    }
  }

  /** Everything emitted after this belongs to `step`, until the next one. */
  enter(step: Step, role?: string): void {
    this.step = step;
    this.role = role;
  }

  emit(message: string, extra: Partial<CrewEvent> = {}): CrewEvent {
    const e: CrewEvent = {
      at: this.now().toISOString(),
      cycle: this.cycle,
      route: this.opts.route,
      step: extra.step ?? this.step,
      level: extra.level ?? 'info',
      message,
      ...(extra.role ?? this.role ? { role: extra.role ?? this.role } : {}),
      ...(extra.ticket ? { ticket: extra.ticket } : {}),
      ...(extra.data ? { data: extra.data } : {}),
    };
    const line = render(e);
    // A sink that cannot be written must never take the cycle down with it:
    // losing observability is bad, losing the run is worse.
    try {
      if (this.opts.eventFile && this.opts.rotateBytes) rotateEventsFile(this.opts.eventFile, this.opts.rotateBytes, this.now());
    } catch { /* ignore */ }
    try { if (this.opts.eventFile) appendFileSync(this.opts.eventFile, `${JSON.stringify(e)}\n`); } catch { /* ignore */ }
    try { if (this.opts.logFile) appendFileSync(this.opts.logFile, `${line}\n`); } catch { /* ignore */ }
    try { (this.opts.console ?? ((l: string) => process.stderr.write(`${l}\n`)))(line); } catch { /* ignore */ }
    return e;
  }

  warn(message: string, extra: Partial<CrewEvent> = {}) { return this.emit(message, { ...extra, level: 'warn' }); }
  error(message: string, extra: Partial<CrewEvent> = {}) { return this.emit(message, { ...extra, level: 'error' }); }

  /**
   * A view of this emitter labelling every event with a different route,
   * sharing the same sinks and cycle id. For a fleet-wide run, the top-level
   * Emitter is stamped with just one route (see cli.ts) — a phase that
   * actually knows which route it's working (release, per-repo poll) uses
   * this instead, so its events aren't all attributed to `routes[0]`.
   */
  forRoute(route: string): Emitter {
    return new Emitter({ ...this.opts, route, cycleId: this.cycle });
  }

  /** Times a step and emits its outcome, so a view can show duration. */
  async timed<T>(step: Step, message: string, fn: () => Promise<T>, role?: string): Promise<T> {
    this.enter(step, role);
    const started = this.now().getTime();
    try {
      const result = await fn();
      this.emit(message, { data: { ms: this.now().getTime() - started, ok: true } });
      return result;
    } catch (err) {
      this.error(`${message} — ${(err as Error).message}`, {
        data: { ms: this.now().getTime() - started, ok: false },
      });
      throw err;
    }
  }
}

export const eventFileFor = (stateDir: string) => join(stateDir, 'events.jsonl');
