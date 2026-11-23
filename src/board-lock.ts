/**
 * A lock every ship can see (ISSUE-394).
 *
 * `State.acquire` in state.ts is a pid file: it excludes two processes on
 * ONE machine, and nothing else, because a second ship's pid means nothing
 * to `process.kill(pid, 0)`. Two ships serving the same repo both pass it,
 * both merge, both cut a version, both tag.
 *
 * The board is the only state every ship already reads and writes, and the
 * platform's own compare-and-swap (`PATCH .../records/:id` with
 * `X-Expected-Updated-At`, surfaced by @tablation/client as
 * `RecordsResource.update(..., expectedUpdatedAt)` throwing
 * `StaleWriteError` on conflict) is exactly the primitive a contended claim
 * needs. This wraps that primitive around one row of a `Locks` table.
 *
 * `acquireBoardLock` itself never creates the row. Since CREW-1384 `crew
 * connect` provisions one row per repo scope (`ensureLockRows`); a release
 * that finds none creates it through `acquireOrCreateBoardLock` (CREW-4026),
 * which uses the same race-safe `ensureLockRows` and then claims. Only a
 * refused create is an error, and it is never a silent downgrade to
 * local-only locking: that fallback is how every ship ended up releasing at
 * once while the rows sat stale (CREW-1399). A workspace with no Locks table
 * at all still has no board lock, as before.
 *
 * Every reader of a scope picks the same row (`pickLockRow`: earliest
 * `created_at`, then `id`, the one `ensureLockRows` keeps), so two ships that
 * briefly have a row each still contend on ONE row and the compare-and-swap
 * decides.
 */

import { StaleWriteError } from '@tablation/client';

interface LockRow {
  id: string;
  scope: string;
  holder?: string | null;
  created_at?: string;
  updated_at: string;
}

/**
 * The slice of RecordsResource this needs — narrowed to `LockRow` (rather
 * than kept generic like the real `RecordsResource`) so a fake in a test can
 * implement it without also satisfying every other shape the real client's
 * generic methods could be called with.
 */
export interface LockRecordsClient {
  list(dataModelId: string, params?: { filters?: string; limit?: number }): Promise<LockRow[]>;
  update(
    dataModelId: string, recordId: string, body: Record<string, unknown>, expectedUpdatedAt?: string,
  ): Promise<LockRow>;
}

export type BoardLockResult =
  | {
    ok: true;
    release: () => Promise<void>;
    /**
     * Whether this process still holds the row, read from the board (CREW-3870).
     * False once another holder has taken it; a read that fails is not proof
     * of loss, so it answers true and the failure is logged.
     */
    stillHeld: () => Promise<boolean>;
    /** One renewal now; the timer calls this every `renewEveryMs`. Exposed for tests. */
    renew: () => Promise<void>;
    /** `'off'` means this board has no Locks table, so there is NO cross-ship protection; the caller must say so in its log (CREW-1399). */
    exclusion: 'taken' | 'off';
  }
  | { ok: false; heldBy?: string; reason: 'held' | 'contended' | 'missing' };

/** The key a repo's lock row carries — one definition for `crew connect`, the release phase and `crew status`. */
export function releaseLockScope(route: string, repo: string): string {
  return `${route}/${repo}`;
}

/**
 * Claim `scope` on the board, or say who holds it.
 *
 * A row with no `holder` is free. A held row older than `ttlMs` is stale —
 * the machine that claimed it died or lost network before releasing, and a
 * dead ship must not wedge every other ship's releases forever, the same
 * reasoning `State.acquire` applies to a dead pid. Staleness is judged by
 * the row's own `updated_at`, not a separate timestamp field: any claim or
 * release writes it, so it already tracks "since when has this been true".
 *
 * `holder === holderLabel` (this same ship reclaiming after a crash before
 * TTL) is treated as free too — a ship's own stale claim should never lock
 * it out of its own release.
 */
export async function acquireBoardLock(
  client: LockRecordsClient, modelId: string | undefined, scope: string, holderLabel: string, ttlMs: number,
  log: BoardLockLog = {}, renewEveryMs: number = DEFAULT_RENEW_EVERY_MS,
): Promise<BoardLockResult> {
  if (!modelId) return { ok: true, release: async () => {}, stillHeld: async () => true, renew: async () => {}, exclusion: 'off' };

  const row = await readLockRow(client, modelId, scope);
  if (!row) return { ok: false, reason: 'missing' };   // `acquireOrCreateBoardLock` (or `crew connect`) provisions it

  const age = Date.now() - new Date(row.updated_at).getTime();
  const staleOwn = !!row.holder && row.holder !== holderLabel && isDeadOwnClaim(row.holder, holderLabel);
  const free = !row.holder || row.holder === holderLabel || age > ttlMs || staleOwn;
  if (staleOwn) log.warn?.(`reclaimed stale own claim ${row.holder} on ${scope} (process is gone)`);
  if (!free) return { ok: false, heldBy: row.holder ?? undefined, reason: 'held' };

  let claimed: LockRow;
  try {
    claimed = await client.update(modelId, row.id, { holder: holderLabel }, row.updated_at);
  } catch (e) {
    if (e instanceof StaleWriteError) return { ok: false, reason: 'contended' };
    throw e;
  }

  // CREW-3870: the lifetime is a backstop for a dead holder, not a cap on a
  // live release. While this process runs, the row is rewritten on a timer so
  // its `updated_at` never ages past `ttlMs`; `current` follows each write so
  // the next compare-and-swap (and the release) uses the latest stamp.
  let current = claimed.updated_at;
  let lost = false;
  let stopped = false;
  let renewing = false;
  const renew = async (): Promise<void> => {
    if (stopped || lost || renewing) return;
    renewing = true;
    try {
      try {
        current = (await client.update(modelId, row.id, { holder: holderLabel }, current)).updated_at;
      } catch (e) {
        if (!(e instanceof StaleWriteError)) throw e;
        const now = await readLockRow(client, modelId, scope);
        if (now?.holder !== holderLabel) {
          lost = true;
          log.warn?.(`board lock ${scope} was taken by ${now?.holder || 'another ship'} while this release was running`);
          return;
        }
        current = (await client.update(modelId, row.id, { holder: holderLabel }, now.updated_at)).updated_at;
      }
    } catch (e) {
      log.warn?.(`lock renewal failed for ${scope}: ${(e as Error).message}; will retry`);
    } finally {
      renewing = false;
    }
  };
  const timer = setInterval(() => { void renew(); }, renewEveryMs);
  timer.unref();

  return {
    ok: true,
    exclusion: 'taken',
    renew,
    stillHeld: async () => {
      if (lost) return false;
      try {
        const now = await readLockRow(client, modelId, scope);
        if (now?.holder === holderLabel) return true;
        lost = true;
        return false;
      } catch (e) {
        log.warn?.(`could not confirm board lock ${scope} is still held: ${(e as Error).message}`);
        return true;
      }
    },
    release: async () => {
      stopped = true;
      clearInterval(timer);
      try {
        try {
          await client.update(modelId, row.id, { holder: '' }, current);
        } catch (e) {
          if (!(e instanceof StaleWriteError)) throw e;
          // Something touched the row since our claim. If it still names us,
          // the release must still land (CREW-2411); if not, it is not ours.
          const now = await readLockRow(client, modelId, scope);
          if (now?.holder === holderLabel) await client.update(modelId, row.id, { holder: '' }, now.updated_at);
        }
        log.debug?.(`lock released for ${scope}`);
      } catch (e) {
        // Best-effort: a failed release leaves the row held until its TTL
        // expires, same as a ship that lost network mid-run would — but say so.
        log.warn?.(`lock release failed for ${scope}: ${(e as Error).message}`);
      }
    },
  };
}

/** Well inside `RELEASE_LOCK_TTL_MS` (20 min), so several renewals can fail before the lock is considered dead. */
export const DEFAULT_RENEW_EVERY_MS = 3 * 60 * 1000;

export interface BoardLockLog { warn?: (m: string) => void; debug?: (m: string) => void }

/** A holder label is `<ship>:<pid>`. True when it names this ship (same hostname-part) and that pid no longer runs. */
function isDeadOwnClaim(holder: string, mine: string): boolean {
  const split = (l: string) => { const i = l.lastIndexOf(':'); return i < 0 ? null : { ship: l.slice(0, i), pid: Number(l.slice(i + 1)) }; };
  const h = split(holder), m = split(mine);
  if (!h || !m || h.ship !== m.ship || !Number.isInteger(h.pid) || h.pid <= 0) return false;
  try { process.kill(h.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** What `crew status` shows for one scope: whether a row exists and who holds it. */
export interface LockRowState { exists: boolean; holder?: string; since?: string }

export async function lockRowState(
  client: Pick<LockRecordsClient, 'list'>, modelId: string, scope: string,
): Promise<LockRowState> {
  const row = await readLockRow(client, modelId, scope);
  if (!row) return { exists: false };
  return { exists: true, ...(row.holder ? { holder: row.holder, since: row.updated_at } : {}) };
}

const scopeFilter = (scope: string): string => JSON.stringify([{ columnName: 'scope', operator: 'EQ', value: scope }]);

/** The row every reader of a scope acts on: earliest `created_at`, then `id` (the one `ensureLockRows` keeps). */
export function pickLockRow<T extends { id: string; created_at?: string }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))[0];
}

async function readLockRow(client: Pick<LockRecordsClient, 'list'>, modelId: string, scope: string): Promise<LockRow | undefined> {
  return pickLockRow(await client.list(modelId, { filters: scopeFilter(scope), limit: 20 }));
}

/** The slice of RecordsResource `ensureLockRows` needs on top of `list`. */
export interface LockProvisionClient extends Pick<LockRecordsClient, 'list'> {
  create(modelId: string, body: Record<string, unknown>): Promise<LockRow>;
  remove(modelId: string, recordId: string): Promise<void>;
}

/**
 * Make sure each scope has exactly one Locks row; returns the scopes this
 * call created. Idempotent: an existing row (held or not) is never touched.
 *
 * Two ships connecting at once both see "missing" and both create, so after
 * creating, re-read the scope: when more than one row exists, the earliest
 * (`created_at`, then `id`) survives and every other creator removes its own.
 * Both ships apply the same ordering, so exactly one row is left whatever
 * the interleaving. A uniqueness rejection on `scope` (the template may
 * enforce one) means someone else won and is treated the same as a loser.
 */
export async function ensureLockRows(
  client: LockProvisionClient, modelId: string, scopes: string[],
): Promise<string[]> {
  const created: string[] = [];
  for (const scope of scopes) {
    const filters = scopeFilter(scope);
    if ((await client.list(modelId, { filters, limit: 1 })).length > 0) continue;
    let mine: LockRow;
    try {
      mine = await client.create(modelId, { scope, holder: '' });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409 || status === 400) {
        if ((await client.list(modelId, { filters, limit: 1 })).length > 0) continue;
      }
      throw e;
    }
    const keeper = pickLockRow(await client.list(modelId, { filters, limit: 20 }));
    if (keeper && keeper.id !== mine.id) {
      await client.remove(modelId, mine.id).catch(() => {});
      continue;
    }
    created.push(scope);
  }
  return created;
}

/** Why a missing row could not be created: `forbidden` when the tracker refused the write for lack of permission, `error` otherwise. */
export type LockCreateCause = 'forbidden' | 'error';

export type CreatingLockResult =
  | (Extract<BoardLockResult, { ok: true }> & { created: boolean })
  | Extract<BoardLockResult, { ok: false }>
  | { ok: false; reason: 'create_refused'; cause: LockCreateCause; error: string };

/**
 * `acquireBoardLock`, but a scope with no row gets one (CREW-4026): create it
 * through `ensureLockRows` (safe against a concurrent creator), then claim
 * once more. `created` is true only when this call's own row survived. A
 * create that is rejected is `create_refused` and never falls through to a
 * release without the row.
 */
export async function acquireOrCreateBoardLock(
  client: LockRecordsClient & LockProvisionClient, modelId: string | undefined, scope: string, holderLabel: string, ttlMs: number,
  log: BoardLockLog = {}, renewEveryMs: number = DEFAULT_RENEW_EVERY_MS,
): Promise<CreatingLockResult> {
  const first = await acquireBoardLock(client, modelId, scope, holderLabel, ttlMs, log, renewEveryMs);
  if (first.ok || first.reason !== 'missing' || !modelId) return first.ok ? { ...first, created: false } : first;
  let created: string[];
  try {
    created = await ensureLockRows(client, modelId, [scope]);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { ok: false, reason: 'create_refused', cause: status === 403 ? 'forbidden' : 'error', error: (e as Error).message };
  }
  const again = await acquireBoardLock(client, modelId, scope, holderLabel, ttlMs, log, renewEveryMs);
  if (again.ok) return { ...again, created: created.length > 0 };
  return again;
}
