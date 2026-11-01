/**
 * Periscope idle expiry (EPIC-077, CREW-2856).
 *
 * A periscope is a running preview of a draft ticket's worktree. Left alone it
 * would hold a server and its ports forever, so the daemon's pass watches each
 * live row for this ship: activity pushes `expires_at` forward, and once it
 * passes the server is stopped and a `periscope_idle` ship attention item is
 * raised. An idle stop is never a discard: the row stays `live`, and nothing
 * is committed, removed or closed. Ending the periscope is a person's call.
 *
 * Everything is injected (`IdleDeps`) so the pass is tested without git, a
 * tracker or processes; `daemon.ts` supplies the real ones.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { PeriscopeRow } from './tracker.ts';
import type { ShipAttentionItem } from './ship-attention.ts';

/** The most files the activity scan will stat; a bigger tree is sampled in listing order. */
const MAX_SCANNED_FILES = 20_000;

/**
 * The newest mtime (ms) of any file in `root` git would not ignore: tracked
 * and untracked-but-not-ignored, so `node_modules`, `.git` and build output
 * named in `.gitignore` never count as activity. Null when `root` is not a
 * readable checkout or has no such file.
 */
export function newestWorktreeMtime(root: string): number | null {
  let listing: string;
  try {
    listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  let newest: number | null = null;
  let scanned = 0;
  for (const rel of listing.split('\0')) {
    if (!rel) continue;
    if (++scanned > MAX_SCANNED_FILES) break;
    try {
      const m = statSync(join(root, rel)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch { /* deleted since the listing, or a dangling link */ }
  }
  return newest;
}

export type IdleDecision =
  | { action: 'none' }
  | { action: 'refresh'; lastActivityAt: string; expiresAt: string }
  | { action: 'expire'; idleMs: number };

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * What one row needs. Activity is the later of the row's own `last_activity_at`
 * (a `crew periscope` subcommand touched it) and the worktree's newest file
 * mtime; if that would put `expires_at` later than the recorded one, the row is
 * refreshed. Otherwise a passed `expires_at` is an expiry.
 */
export function decideIdle(row: PeriscopeRow, mtimeMs: number | null, nowMs: number, idleMinutes: number): IdleDecision {
  const idleMs = idleMinutes * 60_000;
  const recordedActivity = ms(row.last_activity_at);
  const activity = Math.max(recordedActivity, mtimeMs ?? 0);
  const expiresAt = ms(row.expires_at);
  if (activity > 0 && activity + idleMs > expiresAt) {
    return {
      action: 'refresh',
      lastActivityAt: new Date(activity).toISOString(),
      expiresAt: new Date(activity + idleMs).toISOString(),
    };
  }
  if (expiresAt > 0 && nowMs >= expiresAt) return { action: 'expire', idleMs: Math.max(0, nowMs - activity) };
  return { action: 'none' };
}

export const periscopeIdleKey = (ticket: string): string => `periscope_idle:${ticket}`;

const fmtIdle = (idleMs: number): string => {
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h ${minutes % 60}m` : `${minutes}m`;
};

/** The attention item for an idled periscope: names the ticket, repo and idle time, and the ways forward. */
export function periscopeIdleItem(ticket: string, repo: string, number: string, idleMs: number, nowIso: string): ShipAttentionItem {
  return {
    kind: 'periscope_idle',
    key: periscopeIdleKey(ticket),
    since: nowIso,
    message:
      `Periscope ${ticket} (${repo}) has been idle for ${fmtIdle(idleMs)}; its server is stopped and the worktree is untouched. ` +
      `End it with \`crew periscope down ${number} --keep\` (push the work) or \`crew periscope down ${number} --discard\`, ` +
      `or bring the server back with \`crew periscope up --resume ${number}\`.`,
  };
}

export interface IdleTicket { tag: string; number: string; repo: string }

export interface IdleDeps {
  idleMinutes: number;
  now(): Date;
  listLive(): Promise<PeriscopeRow[]>;
  /** Newest activity under the worktree, ms; null when unreadable. */
  mtimeOf(worktree: string): number | null;
  update(rowId: string, fields: Record<string, unknown>): Promise<void>;
  ticketOf(row: PeriscopeRow): Promise<IdleTicket>;
  /** Stops whatever listens on the worktree's ports. Must be safe to call when nothing does. */
  stopServer(worktree: string, number: string): Promise<void>;
  raise(item: ShipAttentionItem): Promise<void>;
  clear(key: string): void;
  /** Keys of the `periscope_idle` items currently open, so one whose periscope has ended can be cleared. */
  openKeys(): string[];
  warn(message: string): void;
}

export interface IdleResult { refreshed: number; expired: number }

/**
 * One idle pass over this ship's live periscopes. A row that fails is warned
 * about and skipped: one bad worktree must not stop the others expiring.
 */
export async function runPeriscopeIdlePass(d: IdleDeps): Promise<IdleResult> {
  const result: IdleResult = { refreshed: 0, expired: 0 };
  const now = d.now();
  const liveKeys = new Set<string>();
  let lookupFailed = false;
  for (const row of await d.listLive()) {
    try {
      const t = await d.ticketOf(row);
      liveKeys.add(periscopeIdleKey(t.tag));
      const decision = decideIdle(row, d.mtimeOf(row.worktree), now.getTime(), d.idleMinutes);
      if (decision.action === 'none') continue;
      if (decision.action === 'refresh') {
        await d.update(row.id, { last_activity_at: decision.lastActivityAt, expires_at: decision.expiresAt });
        // Activity resumed: the item clears, the server is not restarted (`up --resume` does that).
        d.clear(periscopeIdleKey(t.tag));
        result.refreshed++;
        continue;
      }
      await d.stopServer(row.worktree, t.number);
      await d.raise(periscopeIdleItem(t.tag, t.repo, t.number, decision.idleMs, now.toISOString()));
      result.expired++;
    } catch (e) {
      lookupFailed = true;
      d.warn(`periscope idle check failed for ${row.worktree}: ${(e as Error).message}`);
    }
  }
  // An item whose periscope is no longer live (kept or discarded) is done. Not
  // when a row failed to resolve: its item may be the one that would be dropped.
  if (!lookupFailed) for (const key of d.openKeys()) if (!liveKeys.has(key)) d.clear(key);
  return result;
}
