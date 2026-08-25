/**
 * `crew watch` — what the crew is doing, live.
 *
 * A renderer over the structured event stream (events.ts), not a log tailer:
 * it reads `{cycle, step, role, ticket, data}` and can therefore show state
 * rather than scrollback. ISSUE-335.
 *
 * Deliberately plain ANSI and no dependencies — it has to work over SSH on a
 * headless ship.
 */

import { watch as watchFile, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import type { CrewEvent, Step } from './events.ts';

const E = '\x1b[';
const dim = (s: string) => `${E}2m${s}${E}0m`;
const bold = (s: string) => `${E}1m${s}${E}0m`;
const paintWith = (n: number) => (s: string) => `${E}${n}m${s}${E}0m`;
const green = paintWith(32);
const yellow = paintWith(33);
const red = paintWith(31);
const cyan = paintWith(36);

const STEP_ORDER: Step[] = ['poll', 'sweep', 'select', 'worktree', 'agent', 'reconcile', 'merge', 'release', 'idle'];

/**
 * Steps where a ticket mentioned IS the ticket being worked.
 *
 * `poll` and `sweep` mention plenty of tickets they are only reporting on —
 * parked blockers, stranded needs_info — and treating the last of those as
 * "current" made the header claim the crew was working a ticket it had merely
 * commented about. A monitor that misattributes work is worse than none.
 */
const WORKING_STEPS = new Set<Step>(['worktree', 'agent', 'reconcile', 'merge', 'release']);

export interface WatchFilter {
  role?: string;
  ticket?: string;
  route?: string;
  level?: 'warn' | 'error';
}

export function matches(e: CrewEvent, f: WatchFilter): boolean {
  if (f.role && e.role !== f.role) return false;
  if (f.ticket && e.ticket !== f.ticket) return false;
  if (f.route && e.route !== f.route) return false;
  if (f.level === 'warn' && e.level === 'info') return false;
  if (f.level === 'error' && e.level !== 'error') return false;
  return true;
}

/**
 * Events are stamped in UTC, which is right for a log file that may be
 * compared across machines. A person watching a terminal wants their own
 * clock, so the view converts.
 */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);   // unparseable: show it raw
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** One event as a line: local time, step[role], ticket, message. */
export function formatLine(e: CrewEvent): string {
  const t = dim(localTime(e.at));
  const scope = e.role ? `${e.step}[${e.role}]` : e.step;
  const paint = e.level === 'error' ? red : e.level === 'warn' ? yellow : cyan;
  const ticket = e.ticket ? ` ${bold(e.ticket)}` : '';
  return `${t} ${paint(scope.padEnd(14))}${ticket} ${e.message}`;
}

export interface CycleState {
  cycle: string;
  route: string;
  step: Step;
  role?: string;
  ticket?: string;
  startedAt: string;
  lastAt: string;
  rank?: number;
  pending?: string[];
  warnings: number;
  errors: number;
  /** Ticket keys parked as `blocked`, off the sweep step's own emit. */
  blockedTickets?: string[];
  /** Ticket keys sitting in QA, off the sweep step's own emit. */
  qaHeldTickets?: string[];
  /** Consecutive cycles the release phase has refused to release, if any. */
  releaseBlockedCycles?: number;
  releaseBlockedReason?: string;
}

/** Fold an event stream into "where is this cycle now". */
export function foldCycle(events: CrewEvent[]): CycleState | null {
  const last = events[events.length - 1];
  if (!last) return null;
  const ofCycle = events.filter((e) => e.cycle === last.cycle);
  const first = ofCycle[0]!;
  const state: CycleState = {
    cycle: last.cycle,
    route: last.route,
    step: last.step,
    role: last.role,
    ticket: [...ofCycle].reverse().find((e) => e.ticket && WORKING_STEPS.has(e.step))?.ticket,
    startedAt: first.at,
    lastAt: last.at,
    warnings: ofCycle.filter((e) => e.level === 'warn').length,
    errors: ofCycle.filter((e) => e.level === 'error').length,
  };
  for (const e of ofCycle) {
    if (typeof e.data?.rank === 'number') state.rank = e.data.rank as number;
    if (Array.isArray(e.data?.pending)) state.pending = e.data.pending as string[];
    if (Array.isArray(e.data?.blocked)) state.blockedTickets = e.data.blocked as string[];
    if (Array.isArray(e.data?.qaHeld)) state.qaHeldTickets = e.data.qaHeld as string[];
    if (e.step === 'release' && typeof e.data?.cycles === 'number') {
      state.releaseBlockedCycles = e.data.cycles as number;
      state.releaseBlockedReason = typeof e.data.reason === 'string' ? e.data.reason : undefined;
    }
  }
  return state;
}

/** The header: what is happening right now, and how long it has been. */
export function renderHeader(s: CycleState | null, now = Date.now()): string {
  if (!s) return dim('no cycle seen yet - waiting for the crew to run\n');
  const elapsed = Math.max(0, Math.round((now - Date.parse(s.lastAt)) / 1000));
  const progress = STEP_ORDER.map((st) => (st === s.step ? bold(green(st)) : dim(st))).join(dim(' > '));
  const bits = [
    `${bold(s.route)}  cycle ${s.cycle}`,
    s.role ? `role ${bold(s.role)}` : null,
    s.ticket ? `ticket ${bold(s.ticket)}` : null,
    s.rank !== undefined ? dim(`rank ${s.rank}`) : null,
    s.pending?.length ? dim(`pending: ${s.pending.join(' ')}`) : null,
    s.errors ? red(`${s.errors} error(s)`) : s.warnings ? yellow(`${s.warnings} warning(s)`) : null,
    dim(`${elapsed}s in ${s.step}`),
  ].filter(Boolean);
  // A release "in progress" and a release "blocked" both sit in step
  // `release` — indistinguishable from the progress bar alone — so a
  // refusal gets its own loud line naming how long and why (ISSUE-399).
  const releaseLine = s.releaseBlockedCycles
    ? red(
        `release BLOCKED (${s.releaseBlockedCycles} cycle${s.releaseBlockedCycles === 1 ? '' : 's'}): ` +
          `${s.releaseBlockedReason ?? 'unknown reason'}`,
      )
    : null;
  const extra = [
    releaseLine,
    s.blockedTickets?.length ? dim(`blocked: ${s.blockedTickets.join(' ')}`) : null,
    s.qaHeldTickets?.length ? dim(`qa holding: ${s.qaHeldTickets.join(' ')}`) : null,
  ].filter(Boolean);
  const extraLines = extra.length ? `${extra.join('\n')}\n` : '';
  return `${bits.join(dim('  |  '))}\n${extraLines}${progress}\n${dim('-'.repeat(72))}\n`;
}

/** Read whole lines appended since `from`; returns the new offset. */
export function readFrom(file: string, from: number): { events: CrewEvent[]; offset: number } {
  if (!existsSync(file)) return { events: [], offset: from };
  const size = statSync(file).size;
  // Truncated or rotated: start over rather than reading garbage.
  if (size < from) return readFrom(file, 0);
  if (size === from) return { events: [], offset: from };
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - from);
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  const text = buf.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return { events: [], offset: from };   // a partial line; wait for the rest
  const events: CrewEvent[] = [];
  for (const line of text.slice(0, lastNewline).split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as CrewEvent); } catch { /* a torn write; skip it */ }
  }
  return { events, offset: from + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8') };
}

export interface WatchOptions {
  file: string;
  filter?: WatchFilter;
  /** Lines of history to show on start. */
  tail?: number;
  out?: (s: string) => void;
}

export function startWatch(o: WatchOptions): () => void {
  const out = o.out ?? ((s: string) => process.stdout.write(s));
  const filter = o.filter ?? {};
  let all: CrewEvent[] = [];
  let offset = 0;
  let paused = false;

  const seed = readFrom(o.file, 0);
  all = seed.events;
  offset = seed.offset;
  for (const e of all.slice(-(o.tail ?? 20)).filter((x) => matches(x, filter))) out(`${formatLine(e)}\n`);
  out(renderHeader(foldCycle(all)));

  const pump = () => {
    const { events, offset: next } = readFrom(o.file, offset);
    offset = next;
    if (!events.length) return;
    all = [...all, ...events].slice(-5000);
    if (paused) return;   // scrollback stays readable; nothing is lost
    for (const e of events) if (matches(e, filter)) out(`${formatLine(e)}\n`);
    out(renderHeader(foldCycle(all)));
  };

  const timer = setInterval(pump, 1000);
  let watcher: ReturnType<typeof watchFile> | undefined;
  try { watcher = watchFile(o.file, { persistent: false }, pump); } catch { /* polling alone is fine */ }

  const stdin = process.stdin;
  const stop = () => {
    clearInterval(timer);
    watcher?.close();
    if (stdin.isTTY) { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onKey); }
  };
  const onKey = (k: Buffer) => {
    const s = k.toString();
    if (s === ' ') { paused = !paused; out(dim(paused ? '\n-- paused (space to resume) --\n' : '-- resumed --\n')); }
    if (s === 'q' || s === '\x03') { stop(); process.exit(0); }
  };
  if (stdin.isTTY) { stdin.setRawMode(true); stdin.resume(); stdin.on('data', onKey); }
  return stop;
}
