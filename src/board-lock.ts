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
 * Deliberately does NOT create the row: the caller (`acquireBoardLock`)
 * treats a missing row as "this scope has no board lock provisioned yet"
 * and falls back to the old local-only behaviour, rather than racing every
 * ship's first-ever release on which one gets to create it. A Locks table
 * is optional per workspace, and a scope's row is provisioned once, by
 * hand, the same way the table itself is.
 */

import { StaleWriteError } from '@tablation/client';

interface LockRow {
  id: string;
  scope: string;
  holder?: string | null;
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
  | { ok: true; release: () => Promise<void> }
  | { ok: false; heldBy?: string; reason: 'held' | 'contended' };

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
  if (!modelId) return { ok: true, release: async () => {} };

  const filters = JSON.stringify([{ columnName: 'scope', operator: 'EQ', value: scope }]);
  const rows = await client.list(modelId, { filters, limit: 1 });
  const row = rows[0];
  if (!row) return { ok: true, release: async () => {} };   // scope not provisioned — no board lock for it yet

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
