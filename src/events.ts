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

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Where a cycle is. Ordered as they occur, which is what a view renders as progress. */
export const STEPS = [
  'poll', 'sweep', 'select', 'worktree', 'agent', 'reconcile', 'merge', 'release', 'idle',
] as const;
export type Step = (typeof STEPS)[number];

export type Level = 'info' | 'warn' | 'error';

export interface CrewEvent {
  at: string;
  /** Groups every event of one poll cycle, so a view can show "this cycle". */
  cycle: string;
  connection: string;
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
  connection: string;
  /** JSONL sink — what a view tails. */
  eventFile?: string;
  /** Text sink — the human log. */
  logFile?: string;
  /** Also write text here. Defaults to stderr so stdout stays parseable. */
  console?: (line: string) => void;
  /** Injected so cycle ids and timestamps are testable. */
  now?: () => Date;
  cycleId?: string;
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
      connection: this.opts.connection,
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
    try { if (this.opts.eventFile) appendFileSync(this.opts.eventFile, `${JSON.stringify(e)}\n`); } catch { /* ignore */ }
    try { if (this.opts.logFile) appendFileSync(this.opts.logFile, `${line}\n`); } catch { /* ignore */ }
    try { (this.opts.console ?? ((l: string) => process.stderr.write(`${l}\n`)))(line); } catch { /* ignore */ }
    return e;
  }

  warn(message: string, extra: Partial<CrewEvent> = {}) { return this.emit(message, { ...extra, level: 'warn' }); }
  error(message: string, extra: Partial<CrewEvent> = {}) { return this.emit(message, { ...extra, level: 'error' }); }

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

/** Read a cycle back out of the JSONL — what a view does, and what tests assert on. */
export function readEvents(file: string, cycle?: string): CrewEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CrewEvent)
    .filter((e) => !cycle || e.cycle === cycle);
}

export const eventFileFor = (stateDir: string) => join(stateDir, 'events.jsonl');
