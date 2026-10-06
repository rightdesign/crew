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
 * `acquireBoardLock` never creates the row, so a release cannot race two
 * ships on who creates it. Since CREW-1384 `crew connect` provisions one row
 * per repo scope (`ensureLockRows`), and a workspace that HAS a Locks table
 * but no row for a scope is an error, not a silent downgrade to local-only
 * locking: that fallback is how every ship ended up releasing at once while
 * the rows sat stale (CREW-1399). A workspace with no Locks table at all
 * still has no board lock, as before.
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
): Promise<BoardLockResult> {
  if (!modelId) return { ok: true, release: async () => {}, exclusion: 'off' };

  const filters = JSON.stringify([{ columnName: 'scope', operator: 'EQ', value: scope }]);
  const rows = await client.list(modelId, { filters, limit: 1 });
  const row = rows[0];
  if (!row) return { ok: false, reason: 'missing' };   // `crew connect` provisions it

  const age = Date.now() - new Date(row.updated_at).getTime();
  const free = !row.holder || row.holder === holderLabel || age > ttlMs;
  if (!free) return { ok: false, heldBy: row.holder ?? undefined, reason: 'held' };

  let claimed: LockRow;
  try {
    claimed = await client.update(modelId, row.id, { holder: holderLabel }, row.updated_at);
  } catch (e) {
    if (e instanceof StaleWriteError) return { ok: false, reason: 'contended' };
    throw e;
  }

  return {
    ok: true,
    exclusion: 'taken',
    release: async () => {
      try {
        await client.update(modelId, row.id, { holder: '' }, claimed.updated_at);
      } catch {
        // Best-effort: a failed release just leaves the row held until its
        // TTL expires, same as a ship that lost network mid-run would.
      }
    },
  };
}

/** What `crew status` shows for one scope: whether a row exists and who holds it. */
export interface LockRowState { exists: boolean; holder?: string; since?: string }

export async function lockRowState(
  client: Pick<LockRecordsClient, 'list'>, modelId: string, scope: string,
): Promise<LockRowState> {
  const rows = await client.list(modelId, { filters: scopeFilter(scope), limit: 1 });
  const row = rows[0];
  if (!row) return { exists: false };
  return { exists: true, ...(row.holder ? { holder: row.holder, since: row.updated_at } : {}) };
}

const scopeFilter = (scope: string): string => JSON.stringify([{ columnName: 'scope', operator: 'EQ', value: scope }]);

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
    const all = await client.list(modelId, { filters, limit: 20 });
    const keeper = [...all].sort((a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))[0];
    if (keeper && keeper.id !== mine.id) {
      await client.remove(modelId, mine.id).catch(() => {});
      continue;
    }
    created.push(scope);
  }
  return created;
}
