/**
 * Ship-level attention items (CREW-1373): conditions that belong to the ship
 * rather than to a ticket, so `attention.ts` (ticket-scoped) cannot carry
 * them — a role parked by the spawn breaker, a repo hook whose command is not
 * on the scheduler PATH, a release timer that has stopped firing.
 *
 * Three surfaces, none of which needs a client installed anywhere: the Ships
 * row's `attention` column (written on every heartbeat), `crew status`, and a
 * `sweep`-step event for a client that wants to announce it (crew-macos's
 * `AttentionAnnouncer`, or a configured `hooks.notify`).
 *
 * Detector-sourced items are persisted in `.ship-attention.json`;
 * `release_stale` is never stored — it is derived at read time from the
 * timestamp the release phase touches, so it clears itself the moment a
 * release cycle runs again.
 */

import type { Emitter } from './events.ts';
import type { Route, Ship } from './config.ts';
import { notify } from './notify.ts';
import { INTERVAL_SECONDS } from './install.ts';
import type { State } from './state.ts';

export type ShipAttentionKind = 'role_parked' | 'hook_missing' | 'release_stale';

export interface ShipAttentionItem {
  kind: ShipAttentionKind;
  /** Disambiguates within a kind: `role_parked:qa`, `hook_missing:crew/setup`. */
  key: string;
  message: string;
  /** ISO time the condition was first raised; kept across re-raises of the same key. */
  since: string;
}

/** The release timer is stale once it has not run for this many intervals. */
export const RELEASE_STALE_AFTER_INTERVALS = 3;

/** Adds `item`, or refreshes the message of the same key while keeping its original `since`. */
export function upsert(items: ShipAttentionItem[], item: ShipAttentionItem): ShipAttentionItem[] {
  const existing = items.find((i) => i.key === item.key);
  if (!existing) return [...items, item];
  return items.map((i) => (i.key === item.key ? { ...item, since: existing.since } : i));
}

/** Drops the item with `key`, if any. */
export function clear(items: ShipAttentionItem[], key: string): ShipAttentionItem[] {
  return items.filter((i) => i.key !== key);
}

/**
 * Items present in `current` but absent from `previous` — the same
 * present-now/absent-before rule as `attentionTransitions`, so an item that
 * stays open does not re-announce every cycle, and one that clears and
 * returns announces again.
 */
export function transitions(previous: ShipAttentionItem[], current: ShipAttentionItem[]): ShipAttentionItem[] {
  const before = new Set(previous.map((i) => i.key));
  return current.filter((i) => !before.has(i.key));
}

/**
 * `release_stale`, derived. `lastRunMs` is when the release phase last
 * touched its heartbeat file, or null if it never has: a ship that has never
 * run a release cycle (no release timer installed, a fresh install) is not
 * stale, it is simply not a releasing ship — flagging it would be noise.
 */
export function staleRelease(
  lastRunMs: number | null, nowMs: number, intervalSeconds = INTERVAL_SECONDS,
): ShipAttentionItem | null {
  if (lastRunMs === null) return null;
  const limitMs = RELEASE_STALE_AFTER_INTERVALS * intervalSeconds * 1000;
  const ageMs = nowMs - lastRunMs;
  if (ageMs <= limitMs) return null;
  const minutes = Math.round(ageMs / 60_000);
  return {
    kind: 'release_stale',
    key: 'release_stale',
    message: `This ship has not run a release cycle for ${minutes} minute${minutes === 1 ? '' : 's'} — check its release timer`,
    since: new Date(lastRunMs + limitMs).toISOString(),
  };
}

/** Every open item: the persisted ones plus the derived `release_stale`. */
export function openShipAttention(state: State, nowMs = Date.now()): ShipAttentionItem[] {
  const stale = staleRelease(state.releaseHeartbeat().at(), nowMs);
  const stored = state.shipAttention().previous();
  return stale ? [...stored, stale] : stored;
}

/** The sweep event a client announces: `attention: ['ship:<kind>']`, no ticket, no url. */
export function announce(emit: Emitter, item: ShipAttentionItem): void {
  emit.warn(item.message, {
    step: 'sweep',
    data: { attention: [`ship:${item.kind}`], title: item.message },
  });
}

export interface RaiseOptions {
  state: State;
  emit: Emitter;
  /** With these, a newly raised item also goes through the route's `hooks.notify`. */
  route?: Route;
  ship?: Ship;
}

/** Persists `item` and announces it once, when it was not already open. Returns whether it was new. */
export async function raiseShipAttention(o: RaiseOptions, item: ShipAttentionItem): Promise<boolean> {
  const store = o.state.shipAttention();
  const previous = store.previous();
  const next = upsert(previous, item);
  store.persist(next);
  if (transitions(previous, next).length === 0) return false;
  announce(o.emit, item);
  if (o.route && o.ship) {
    await notify(o.route, o.ship, { level: 'warn', headline: item.message }, o.emit);
  }
  return true;
}

/** Closes the item with `key`. Silent: nothing needs announcing about a problem going away. */
export function clearShipAttention(state: State, key: string): void {
  const store = state.shipAttention();
  const previous = store.previous();
  const next = clear(previous, key);
  if (next.length !== previous.length) store.persist(next);
}

/**
 * The command a hook script starts with, for `crew doctor`'s PATH check: the
 * first word of the first line that is not blank, a comment or a `VAR=value`
 * assignment. Deliberately only the first command — a script's later lines
 * may be shell builtins, functions or branches, and guessing at those would
 * raise false alarms. Null when the script has no plain command word to check
 * (a leading `if`/`for`, a path, a subshell).
 */
export function hookCommand(script: string): string | null {
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const word = line.split(/\s+/)[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (!/^[A-Za-z0-9._+-]+$/.test(word)) return null;
    if (SHELL_WORDS.has(word)) return null;
    return word;
  }
  return null;
}

const SHELL_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'cd', 'echo', 'export', 'set', 'exit', 'test', 'true', 'false', 'source', '.', 'eval', 'exec', 'ok',
]);
