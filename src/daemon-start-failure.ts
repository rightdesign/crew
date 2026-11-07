/**
 * A daemon that cannot start (CREW-3064). The unit `crew install` writes
 * relaunches `crew daemon` every few seconds, so a failure that will repeat
 * (an unresolvable route, a bad config, nothing servable) used to exist only
 * as a stderr line in the scheduler log, repeated hundreds of times. This
 * records it where `crew status`, the Ships row and the menu bar already look:
 * a `daemon_start_failed` ship attention item, plus one `error` event.
 *
 * Nothing here may need the thing that failed, so the record is a plain file in
 * the state directory (found without a loadable config when need be), read and
 * written with no route, key or tracker. It clears when a daemon completes a
 * pass.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Emitter } from './events.ts';
import { clearShipAttention, raiseShipAttention, type ShipAttentionItem } from './ship-attention.ts';
import type { State } from './state.ts';
import type { Route, Ship } from './config.ts';

export const DAEMON_START_FAILED_KEY = 'daemon_start_failed';

/** How long a daemon that has failed the same way twice running sleeps before exiting, so the unit's relaunch is one log line a minute. */
export const START_FAILURE_BACKOFF_MS = 60_000;

/** The second identical failure in a row is the first one that sleeps; the first exits at once so a fixed config takes effect immediately. */
export const BACKOFF_AFTER_FAILURES = 2;

export interface StartFailureRecord {
  reason: string;
  /** Consecutive identical failures, this one included. */
  count: number;
  firstAt: string;
  lastAt: string;
}

const fileFor = (stateDir: string): string => join(stateDir, '.daemon-start-failure.json');

export function readStartFailure(stateDir: string): StartFailureRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(stateDir), 'utf8')) as Partial<StartFailureRecord>;
    return typeof parsed.reason === 'string' && typeof parsed.count === 'number'
      ? { reason: parsed.reason, count: parsed.count, firstAt: String(parsed.firstAt), lastAt: String(parsed.lastAt) }
      : null;
  } catch {
    return null;
  }
}

/** Counts this failure against the previous one: the same reason continues the run, a different one starts it over. */
export function noteStartFailure(stateDir: string, reason: string, nowMs = Date.now()): StartFailureRecord {
  const previous = readStartFailure(stateDir);
  const nowIso = new Date(nowMs).toISOString();
  const same = previous?.reason === reason;
  const record: StartFailureRecord = {
    reason,
    count: same ? previous.count + 1 : 1,
    firstAt: same ? previous.firstAt : nowIso,
    lastAt: nowIso,
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(fileFor(stateDir), JSON.stringify(record));
  return record;
}

/** Milliseconds to sleep before exiting after the failure `count`: none for the first, a minute from the second on. */
export function startFailureDelayMs(count: number): number {
  return count >= BACKOFF_AFTER_FAILURES ? START_FAILURE_BACKOFF_MS : 0;
}

export function startFailureItem(record: StartFailureRecord, o: { fix?: string; logPath?: string } = {}): ShipAttentionItem {
  const parts = [`The daemon cannot start: ${record.reason}`];
  if (o.fix) parts.push(o.fix);
  if (o.logPath) parts.push(`Unit log: ${o.logPath}`);
  parts.push('Resumes automatically once a daemon completes a pass.');
  return { kind: 'daemon_start_failed', key: DAEMON_START_FAILED_KEY, message: parts.join('. ').replace(/\.\./g, '.'), since: record.firstAt };
}

/** Removes the record and the attention item; called when a pass completes. Silent when there is nothing to clear. */
export function clearStartFailure(state: State, stateDir: string): void {
  if (existsSync(fileFor(stateDir))) {
    try { unlinkSync(fileFor(stateDir)); } catch { /* the item clearing below is what matters */ }
  }
  clearShipAttention(state, DAEMON_START_FAILED_KEY);
}

export interface ReportStartFailure {
  state: State;
  stateDir: string;
  emit: Emitter;
  reason: string;
  fix?: string;
  logPath?: string;
  route?: Route;
  ship?: Ship;
  /** Best-effort extra publishers (the Ships row on each route whose key resolves); a throw is swallowed. */
  publish?: (item: ShipAttentionItem) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: number;
}

/**
 * Records the failure, raises the item and an `error` event, then sleeps the
 * backoff. The caller exits afterwards. Returns the delay it slept.
 */
export async function reportStartFailure(o: ReportStartFailure): Promise<number> {
  const record = noteStartFailure(o.stateDir, o.reason, o.nowMs);
  const item = startFailureItem(record, { fix: o.fix, logPath: o.logPath });
  // One error event per run of identical failures: the item stays open, and the relaunches that follow must not flood the stream either.
  if (record.count === 1) o.emit.error(item.message, { step: 'poll' });
  try {
    await raiseShipAttention({ state: o.state, emit: o.emit, route: o.route, ship: o.ship }, item);
  } catch { /* the persisted file and the event above already say it */ }
  if (o.publish) {
    try { await o.publish(item); } catch { /* best effort: the route's key may be the thing that failed */ }
  }
  const delay = startFailureDelayMs(record.count);
  if (delay > 0) await (o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
  return delay;
}

/** The state directory when no config loaded: beside the config file, as `ship.stateDir` defaults to. */
export function fallbackStateDir(configFile: string): string {
  return join(dirname(configFile), 'state');
}
