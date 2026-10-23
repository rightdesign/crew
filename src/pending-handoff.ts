/**
 * A hand-off that did not land, kept on disk until the tracker answers (CREW-2363).
 *
 * `spawnAgent` finds, from the run's own transcript, a hand-off write (the
 * `status: fixed` update, the hand-off comment) that failed with a transport
 * or 5xx error. It writes one record per ticket under
 * `<stateDir>/pending-handoffs/`. `replayPendingHandoffs` runs at the start of
 * every post-run hand-off check and walks the records with backoff:
 *
 *   - tracker still down: the record stays, with a longer wait. One warn the
 *     first time, none after (a pass every minute must not log an error each).
 *   - the ticket is no longer at the building status: the hand-off happened by
 *     other means (or was taken away); the record is dropped.
 *   - the branch is on the remote at the worktree's HEAD: post the `pushed`
 *     event, post the hand-off comment (the failed comment body, or the run's
 *     final text) unless the seat already has it, then replay the failed
 *     status write verbatim, which is what clears the assignee and ship hold,
 *     and delete the record.
 *   - the branch is not on the remote: the push never happened, so there is
 *     nothing to hand on; the record is dropped and the ordinary resume path
 *     owns the ticket.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract } from './contract.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import { inspectHandoff, pushedEventBody, type HandoffLog, type HandoffWriter } from './handoff-guard.ts';
import type { PendingHandoffDraft } from './handoff-transcript.ts';
import type { Comment } from './tracker.ts';
import { sleepBackoff } from './pending-backoff.ts';

export interface PendingHandoff extends PendingHandoffDraft {
  version: 1;
  route: string;
  role: string;
  /** The ticket key the run named, for logs only. */
  ticket?: string;
  streamPath: string;
  createdAt: string;
  attempts: number;
  /** ISO time before which a pass leaves the record alone. */
  nextAttemptAt: string;
  /** A warn about this record has been logged; later failed passes stay quiet. */
  warned?: boolean;
}

/** Records older than this are dropped: the ticket has long since been worked by someone else. */
export const PENDING_MAX_AGE_MS = 48 * 3600_000;

export const pendingDirFor = (stateDir: string): string => join(stateDir, 'pending-handoffs');

/** The state dir a stream file lives under (`<stateDir>/streams/<file>`). */
export const stateDirOfStream = (streamPath: string): string => join(streamPath, '..', '..');

export function writePendingHandoff(stateDir: string, rec: PendingHandoff): void {
  const dir = pendingDirFor(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.ticketRecordId}.json`), JSON.stringify(rec, null, 2));
}

export function listPendingHandoffs(stateDir: string, route?: string): PendingHandoff[] {
  const dir = pendingDirFor(stateDir);
  if (!existsSync(dir)) return [];
  const out: PendingHandoff[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PendingHandoff;
      if (rec.version === 1 && rec.ticketRecordId && (!route || rec.route === route)) out.push(rec);
    } catch { /* an unreadable record is not one to act on */ }
  }
  return out;
}

export function removePendingHandoff(stateDir: string, ticketRecordId: string): void {
  rmSync(join(pendingDirFor(stateDir), `${ticketRecordId}.json`), { force: true });
}

/** The pending record for one ticket, if a recent run left one. */
export function pendingHandoffFor(stateDir: string, ticketRecordId: string): PendingHandoff | undefined {
  return listPendingHandoffs(stateDir).find((r) => r.ticketRecordId === ticketRecordId);
}

export interface PendingWriter extends HandoffWriter {
  postComment(ticketId: string, body: string, memberId: string): Promise<void>;
  comments(limit?: number): Promise<Comment[]>;
}

export interface ReplayInput {
  writer: PendingWriter;
  contract: Contract;
  stateDir: string;
  /** Only this route's records are replayed. */
  route: string;
  /** Only records of this role are replayed (the writer is that seat's tracker). */
  role?: string;
  /** Seat ids by role: the author of the replayed event and comment. */
  seats: Partial<Record<string, string>>;
  /** Where this ticket's checkout is; null when this ship has no clone of its repo. */
  checkout(ticketRow: Awaited<ReturnType<HandoffWriter['ticket']>>): { dir: string; cfg: EffectiveRepoConfig } | null;
  log: HandoffLog;
  now?: Date;
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

/** Replays every due record; returns the ticket record ids whose hand-off landed. */
export async function replayPendingHandoffs(i: ReplayInput): Promise<string[]> {
  const now = i.now ?? new Date();
  const landed: string[] = [];
  for (const rec of listPendingHandoffs(i.stateDir, i.route).filter((r) => !i.role || r.role === i.role)) {
    const at = { ticket: rec.ticket, step: 'handoff' };
    if (now.getTime() - Date.parse(rec.createdAt) > PENDING_MAX_AGE_MS) {
      i.log.warn(`${rec.ticket ?? rec.ticketRecordId}: dropped a pending hand-off older than ${PENDING_MAX_AGE_MS / 3600_000}h`, at);
      removePendingHandoff(i.stateDir, rec.ticketRecordId);
      continue;
    }
    if (now.toISOString() < rec.nextAttemptAt) continue;
    const seatId = i.seats[rec.role];
    try {
      const t = await i.writer.ticket(rec.ticketRecordId);
      const st = i.contract.statuses;
      if (!seatId || t.status !== st.building || rec.patch.status !== st.handoff) {
        i.log.emit(`${t.issue_id}: pending hand-off no longer applies (ticket is at ${t.status}) — dropped`, at);
        removePendingHandoff(i.stateDir, rec.ticketRecordId);
        continue;
      }
      const co = i.checkout(t);
      const v = co ? inspectHandoff(co.dir, co.cfg, t, rec.role) : null;
      if (!v || v.kind === 'bounce') {
        i.log.warn(`${t.issue_id}: pending hand-off dropped — ${v ? v.reason : 'this ship has no checkout of the ticket\'s repo'}`, at);
        removePendingHandoff(i.stateDir, rec.ticketRecordId);
        continue;
      }
      if (v.kind === 'unverified') throw new Error(v.why);

      const text = rec.comment ?? (rec.commentLanded ? '' : rec.finalText);
      if (text) {
        const head = firstLine(text);
        const cc = i.contract.comments;
        const seen = (await i.writer.comments()).some((c) => {
          const row = c as unknown as Record<string, unknown>;
          return row[cc.parent] === t.id && row[cc.author] === seatId && firstLine(String(row[cc.body] ?? '')) === head;
        });
        if (!seen) await i.writer.postComment(t.id, text, seatId);
      }
      await i.writer.postEvent(t.id, pushedEventBody(v.sha, v.remote, v.branch), seatId, 'pushed');
      await i.writer.updateTicket(t.id, rec.patch);
      removePendingHandoff(i.stateDir, rec.ticketRecordId);
      i.log.emit(`${t.issue_id}: replayed a pending hand-off at ${v.sha.slice(0, 7)} — handed on to QA`, at);
      landed.push(t.id);
    } catch (e) {
      const attempts = rec.attempts + 1;
      writePendingHandoff(i.stateDir, {
        ...rec, attempts, warned: true,
        nextAttemptAt: new Date(now.getTime() + sleepBackoff(attempts)).toISOString(),
      });
      if (!rec.warned) {
        i.log.warn(`${rec.ticket ?? rec.ticketRecordId}: a hand-off is pending and could not be replayed yet (${(e as Error).message}); will retry`, at);
      }
    }
  }
  return landed;
}
