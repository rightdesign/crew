/**
 * The periscope drop file (EPIC-078 Map v1 §5, CREW-2874).
 *
 * A periscope's worktree has `.crew/pointed-at.jsonl`: one JSON object per
 * line, appended (never rewritten) by the repository's own dev-server
 * inspector when the viewer clicks something. Crew names the file and exports
 * its path to the `preview` hook; it reads the newest line back for
 * `periscope list --json` and the sidecar, and counts a new line as activity.
 * The `.crew/` directory is hidden from git through the worktree's
 * `info/exclude`, so `down --keep` never commits it.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const POINTED_AT_DIR = '.crew';
export const POINTED_AT_REL = `${POINTED_AT_DIR}/pointed-at.jsonl`;

/** One line of the drop file. `path`, `line` and `at` are required; the rest is optional. */
export interface PointedAt {
  path: string;
  line: number;
  column?: number;
  component?: string;
  at: string;
  url?: string;
}

export const pointedAtFile = (worktree: string): string => join(worktree, POINTED_AT_REL);

/** The environment the `preview` hook gets so the repository's dev server knows where to write. */
export function pointedAtEnv(worktree: string): Record<string, string> {
  return { CREW_PERISCOPE: '1', CREW_POINTED_AT_FILE: pointedAtFile(worktree) };
}

/** The worktree's `info/exclude`, resolved through git so a linked worktree's private git dir is found. */
function excludeFile(worktree: string): string | undefined {
  try {
    const p = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return p ? (isAbsolute(p) ? p : resolve(worktree, p)) : undefined;
  } catch {
    return undefined;
  }
}

/** Adds `entry` (one line) to the worktree's `info/exclude` unless it is already there. Idempotent. */
export function excludeFromGit(worktree: string, entry: string): void {
  const ex = excludeFile(worktree);
  if (!ex) return;
  mkdirSync(dirname(ex), { recursive: true });
  const have = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  if (have.split('\n').some((l) => l.trim() === entry)) return;
  appendFileSync(ex, `${have === '' || have.endsWith('\n') ? '' : '\n'}${entry}\n`);
}

/**
 * Creates the empty drop file (leaving an existing one alone) and keeps
 * `.crew/` out of git. Idempotent, so `--resume` can call it again.
 */
export function prepareDropFile(worktree: string): string {
  const file = pointedAtFile(worktree);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '');
  excludeFromGit(worktree, `${POINTED_AT_DIR}/`);
  return file;
}

function parseLine(raw: string): PointedAt | undefined {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return undefined; }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || o.path === '' || typeof o.line !== 'number' || !Number.isInteger(o.line) || o.line < 1) return undefined;
  if (typeof o.at !== 'string') return undefined;
  const out: PointedAt = { path: o.path, line: o.line, at: o.at };
  if (typeof o.column === 'number') out.column = o.column;
  if (typeof o.component === 'string') out.component = o.component;
  if (typeof o.url === 'string') out.url = o.url;
  return out;
}

/** The newest well-formed line (the last one in the file), or null; a torn or foreign line is skipped. */
export function readPointedAt(worktree: string): PointedAt | null {
  let text: string;
  try { text = readFileSync(pointedAtFile(worktree), 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === '') continue;
    const p = parseLine(lines[i]!);
    if (p) return p;
  }
  return null;
}

/** The drop file's mtime (ms), null when absent. A new line moves it, which the idle pass reads as activity. */
export function dropFileMtime(worktree: string): number | null {
  try { return statSync(pointedAtFile(worktree)).mtimeMs; } catch { return null; }
}
