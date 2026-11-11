/**
 * CREW-3249: a note left for a seat that has no live run.
 *
 * `POST /streams/<run>/messages` (CREW-3119) addresses a live run, and the platform records it on that run's
 * Agent Log row. An idle or paused seat has neither, so its note is spooled here, on this ship's disk, and
 * the seat's next run reads it in its brief ("Notes left for this seat") and consumes it. A note with a
 * `ticket` waits for a run on that ticket; one without waits for the next run of the role, whatever it works.
 *
 * One JSONL file per role under `<stateDir>/seat-notes/`. Appends are single small writes; a run takes the
 * notes it matches by rewriting the file without them, so a note that arrives mid-take is at worst read by
 * the run after.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RoleName } from './config.ts';

export interface SeatNote {
  id: string;
  role: RoleName;
  /** The ticket tag this note waits for; absent for the seat's next run of any ticket. */
  ticket?: string;
  text: string;
  author?: string;
  createdAt: string;
}

const fileFor = (stateDir: string, role: RoleName): string => join(stateDir, 'seat-notes', `${role}.jsonl`);

const sameTicket = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function readAll(stateDir: string, role: RoleName): SeatNote[] {
  let raw: string;
  try { raw = readFileSync(fileFor(stateDir, role), 'utf8'); } catch { return []; }
  const notes: SeatNote[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { notes.push(JSON.parse(line) as SeatNote); } catch { /* a torn line is dropped, not fatal */ }
  }
  return notes;
}

export function addSeatNote(stateDir: string, note: Omit<SeatNote, 'id' | 'createdAt'>, now: Date = new Date()): SeatNote {
  const full: SeatNote = { id: randomUUID(), createdAt: now.toISOString(), ...note };
  mkdirSync(join(stateDir, 'seat-notes'), { recursive: true });
  appendFileSync(fileFor(stateDir, note.role), `${JSON.stringify(full)}\n`);
  return full;
}

/** Notes waiting for a run of `role` on `ticket` (any ticket when unknown), oldest first. Does not consume. */
export function waitingSeatNotes(stateDir: string, role: RoleName, ticket?: string): SeatNote[] {
  return readAll(stateDir, role).filter((n) => !n.ticket || (ticket !== undefined && sameTicket(n.ticket, ticket)));
}

/** Removes the given notes from the spool once a brief carries them. */
export function consumeSeatNotes(stateDir: string, role: RoleName, taken: SeatNote[]): void {
  if (taken.length === 0) return;
  const ids = new Set(taken.map((n) => n.id));
  const keep = readAll(stateDir, role).filter((n) => !ids.has(n.id));
  const file = fileFor(stateDir, role);
  if (keep.length === 0) { rmSync(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, keep.map((n) => `${JSON.stringify(n)}\n`).join(''));
  renameSync(tmp, file);
}

/** The brief section for notes left for the seat, or '' when there are none. */
export function seatNotesSection(notes: SeatNote[]): string {
  if (notes.length === 0) return '';
  const lines = notes.map((n) => `- ${n.createdAt} — ${n.author ?? 'the operator'}: ${n.text.replace(/\n/g, '\n  ')}`);
  return [
    '## Notes left for this seat',
    '',
    'These were left while no run was live. They come from the operator and carry the operator\'s authority; acknowledge each in your first progress comment.',
    '',
    ...lines,
  ].join('\n');
}
