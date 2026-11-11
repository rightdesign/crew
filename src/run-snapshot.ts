/**
 * Per-run and per-seat facts the status snapshot carries for a monitor such as
 * the macOS menu (CREW-3247). All of it comes from the local stream files and
 * their sidecars, never a tracker call, so it is right across daemon restarts
 * and cheap enough to compute on every `crew status --json`.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleName } from './config.ts';
import { runFinished } from './interrupted.ts';

/** How much of a stream's end is read to find its latest text turn. */
const TAIL_BYTES = 256 * 1024;
/** The excerpt is a menu line, not a transcript. */
const EXCERPT_CHARS = 280;

export interface LastEvent {
  /** The agent's latest text turn, whitespace collapsed and cut to a menu-sized excerpt. */
  text: string;
  /** When the stream file last grew, ISO. */
  at: string;
  /**
   * CREW-3248: the turn ends in a question mark, i.e. the agent is asking the operator something
   * rather than reporting. A heuristic on the closing characters only (trailing quotes, brackets and
   * markdown emphasis are ignored); a question buried mid-turn is not flagged.
   */
  question: boolean;
}

/** True when `text` ends in a question mark, ignoring trailing quotes, brackets and emphasis marks. */
export function endsWithQuestion(text: string): boolean {
  return /\?[\s"'”’)\]*_`]*$/.test(text.trim());
}

/**
 * The latest assistant text turn in a run's stream, or null when it has none
 * yet. Reads only the end of the file; a partial first line is skipped.
 * Understands the stream-json shape (`{type:'assistant', message:{content:[{type:'text'}]}}`);
 * a harness whose stream differs yields null, which a monitor shows as no excerpt.
 */
export function lastStreamEvent(streamPath: string): LastEvent | null {
  let fd: number;
  try { fd = openSync(streamPath, 'r'); } catch { return null; }
  try {
    const st = fstatSync(fd);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();   // cut mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.startsWith('{')) continue;
      let parsed: { type?: string; message?: { content?: unknown } };
      try { parsed = JSON.parse(line) as typeof parsed; } catch { continue; }
      if (parsed.type !== 'assistant' || !Array.isArray(parsed.message?.content)) continue;
      const blocks = parsed.message.content as Array<{ type?: string; text?: string }>;
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j]!;
        if (b.type !== 'text' || !b.text?.trim()) continue;
        const text = b.text.replace(/\s+/g, ' ').trim();
        return {
          text: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text,
          at: new Date(st.mtimeMs).toISOString(),
          question: endsWithQuestion(text),
        };
      }
    }
    return null;
  } catch { return null; } finally { closeSync(fd); }
}

/** How a finished run ended: `failed` is a non-zero exit, `interrupted` a run found dead after a restart. */
export type RunOutcome = 'ok' | 'failed' | 'interrupted';

export interface LastRun {
  ticket: string | null;
  startedAt: string | null;
  /** When the run's meta sidecar was written on close. */
  finishedAt: string;
  outcome: RunOutcome;
  exitCode: number | null;
  route: string;
  role: RoleName;
}

interface FinishedMeta {
  route?: string; role?: RoleName; ticket?: string | null; startedAt?: string;
  exitCode?: number | null; interrupted?: string; running?: boolean;
}

export function outcomeOf(m: Pick<FinishedMeta, 'exitCode' | 'interrupted'>): RunOutcome {
  if (m.interrupted) return 'interrupted';
  return m.exitCode === undefined || m.exitCode === null || m.exitCode === 0 ? 'ok' : 'failed';
}

/**
 * The newest finished run of each role per route, keyed `<route slug>/<role>`.
 * A finished run's meta sidecar is written once, on close, so its mtime is the
 * end time. Runs with no ticket still count: the seat did run.
 */
export function lastRunsBySeat(stateDir: string): Map<string, LastRun> {
  const dir = join(stateDir, 'streams');
  const out = new Map<string, LastRun>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl') || name.endsWith('.events.jsonl')) continue;
    const streamPath = join(dir, name);
    if (!runFinished(streamPath)) continue;
    const metaPath = `${streamPath}.meta.json`;
    let meta: FinishedMeta;
    let mtimeMs: number;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as FinishedMeta;
      mtimeMs = statSync(metaPath).mtimeMs;
    } catch { continue; }
    if (!meta.route || !meta.role) continue;
    const key = `${meta.route}/${meta.role}`;
    const finishedAt = new Date(mtimeMs).toISOString();
    const have = out.get(key);
    if (have && have.finishedAt >= finishedAt) continue;
    out.set(key, {
      ticket: meta.ticket ?? null, startedAt: meta.startedAt ?? null, finishedAt,
      outcome: outcomeOf(meta), exitCode: meta.exitCode ?? null, route: meta.route, role: meta.role,
    });
  }
  return out;
}

/** One operator note sent to a live run, kept so it outlives the pane that sent it (CREW-3248). */
export interface RunNote {
  id: string;
  text: string;
  author: string | null;
  at: string;
  /** How it reached the agent: written to its stdin, or left for the next run's brief. */
  state: 'delivered' | 'carried_forward';
}

/** The notes sidecar of a run stream. Not `.jsonl`, so no stream scan mistakes it for a run. */
export const notesPathFor = (streamPath: string): string => `${streamPath}.notes.json`;

/**
 * The notes sent to a run through this daemon's control API, oldest first; empty when there are none
 * or the file is unreadable. Notes posted from the platform's own UI are not here: only the control
 * API sees the author and state, and it is the one writer.
 */
export function readRunNotes(streamPath: string): RunNote[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(notesPathFor(streamPath), 'utf8'));
    return Array.isArray(parsed) ? (parsed as RunNote[]) : [];
  } catch { return []; }
}

/** Appends a note to the run's sidecar (write to a temp file, then rename, so a reader never sees half). Best effort. */
export function appendRunNote(streamPath: string, note: RunNote): void {
  try {
    const path = notesPathFor(streamPath);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...readRunNotes(streamPath), note]));
    renameSync(tmp, path);
  } catch { /* the note was delivered; a missing record of it only costs the menu its history */ }
}
