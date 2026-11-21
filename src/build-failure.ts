/**
 * When the combined release build (or test gate) fails, find the verified
 * branch that broke it and hand THAT branch back, instead of holding every
 * verified ticket on the route until a person reads a failure alert.
 *
 * The case that motivated it (CREW-1581, 2026-10-12): three verified branches
 * squash-merged without a textual conflict, then the build failed with a
 * duplicate-identifier error. Only one branch was at fault — it added a type
 * member a branch already on the base had added a minute earlier. Git merged
 * both hunks; TypeScript refused the result; QA had verified the branch at its
 * own tip, where it builds. `conflict.ts` only covers TEXTUAL conflicts.
 *
 * Two ways to name the culprit, cheapest first:
 *  1. The failing output names files. If exactly one merged branch changed a
 *     named file, that branch is the culprit and nothing is rebuilt.
 *  2. Otherwise build each branch alone on the pre-merge base. A branch whose
 *     solo run fails is a culprit. Capped (`release.isolateFailures`), since
 *     each solo run is a full build.
 *
 * This module holds the pure parts and the board hand-back. The git/hook
 * driving lives in `release-run.ts`, next to the hooks it runs.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaleWriteError } from '@tablation/client';
import { worktreeForBranch, writeUnlessMoved } from './conflict.ts';
import type { ConflictWriter, ConflictLog } from './conflict.ts';
import type { Contract } from './contract.ts';
import { displayKey, type RunnerEvent, type Ticket } from './tracker.ts';
import { verifiedShaFor } from './verified-tip.ts';
import { calloutHeader } from './callout.ts';

/** A marker in the hand-back note, so a repeat is recognisable. */
export const BUILD_FAILURE_MARKER = calloutHeader('CAUTION', 'Build Failure');

/**
 * Repo-relative file paths named in a failing hook's output: tsc
 * (`path(line,col): error TS…`), tsc pretty / vite / eslint (`path:line:col`),
 * and jest/vitest/node:test (`FAIL path`, `✖ path`). Absolute paths under
 * `cwd` are made relative; anything else (a path outside the checkout, a
 * `node_modules` frame) is dropped.
 */
export function failingPaths(output: string, cwd: string): string[] {
  const found = new Set<string>();
  const ext = String.raw`[\w.-]+\.[A-Za-z]{1,6}`;
  const dir = String.raw`(?:[\w@.~-]+/)*`;
  const patterns = [
    new RegExp(String.raw`^\s*(${dir}${ext})\(\d+,\d+\)\s*:`, 'gm'),
    new RegExp(String.raw`(?:^|\s)(/?${dir}${ext}):\d+(?::\d+)?`, 'gm'),
    new RegExp(String.raw`(?:FAIL|✖|✕|not ok \d+ -)\s+(/?${dir}${ext})`, 'gm'),
  ];
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  for (const re of patterns) {
    for (const m of output.matchAll(re)) {
      let p = m[1]!;
      if (p.startsWith('/')) {
        if (!p.startsWith(root)) continue;
        p = p.slice(root.length);
      }
      p = p.replace(/^\.\//, '');
      if (p.includes('node_modules/')) continue;
      found.add(p);
    }
  }
  return [...found];
}

/**
 * The single candidate whose changed files include a file the failure names,
 * or null when none or several do (then the caller builds them one by one).
 */
export function culpritByFiles<T extends { changed: ReadonlySet<string> }>(
  candidates: readonly T[], paths: readonly string[],
): T | null {
  if (paths.length === 0) return null;
  const hits = candidates.filter((c) => paths.some((p) => c.changed.has(p)));
  return hits.length === 1 ? hits[0]! : null;
}


/** Lines of context kept before and after each output line that names a failing file. */
const EXCERPT_CONTEXT = 3;
/** How many such matches are shown before the rest are only counted. */
const EXCERPT_MATCHES = 3;
/** Closing lines of the output kept after the path-centered part. */
const EXCERPT_CLOSING = 5;
/** A line a multi-step hook prints to open a step (`--- frontend lint`). */
const STEP_MARKER = /^\s*(?:---+\s|===+\s|##\s)\S/;

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * The part of a failed hook's output a seat needs (CREW-3775). A multi-step
 * hook keeps going after a failed step and exits non-zero at the end, so the
 * last lines are the last step's output, not the failure. When the gate has
 * failing paths, quote around the lines that name them (a few lines of context,
 * plus the nearest step marker above), then the closing lines, clearly
 * separated. With no path to anchor on, the tail, and `pathCentered` false so
 * the note can say the failing step may be earlier.
 */
export function failureExcerpt(output: string, paths: readonly string[], tailLines: number): { text: string; pathCentered: boolean } {
  const lines = stripAnsi(output).trimEnd().split('\n');
  const tail = lines.slice(-tailLines).join('\n');
  const hits: number[] = [];
  if (paths.length) lines.forEach((l, i) => { if (paths.some((p) => l.includes(p))) hits.push(i); });
  if (!hits.length) return { text: tail, pathCentered: false };
  const shown = hits.slice(0, EXCERPT_MATCHES);
  const keep = new Set<number>();
  for (const i of shown) {
    for (let k = Math.max(0, i - EXCERPT_CONTEXT); k <= Math.min(lines.length - 1, i + EXCERPT_CONTEXT); k++) keep.add(k);
    for (let k = i; k >= 0; k--) { if (STEP_MARKER.test(lines[k]!)) { keep.add(k); break; } }
  }
  const out: string[] = [];
  let prev = -2;
  for (const k of [...keep].sort((a, b) => a - b)) {
    if (k !== prev + 1 && out.length) out.push('…');
    out.push(lines[k]!);
    prev = k;
  }
  const more = hits.length - shown.length;
  if (more > 0) out.push(`… and ${more} more line${more === 1 ? '' : 's'} naming these files`);
  const closing = lines.slice(-Math.min(EXCERPT_CLOSING, tailLines));
  const last = Math.max(...keep);
  if (last < lines.length - closing.length) out.push('… end of the output:', ...closing);
  return { text: out.join('\n'), pathCentered: true };
}

/**
 * Keep a failed gate run's whole output where a seat on this ship can read it.
 * Non-fatal: null when it cannot be written.
 */
export function saveGateOutput(ticketKey: string, hook: string, output: string): string | null {
  try {
    const dir = join(tmpdir(), 'crew-gate-output');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${ticketKey.replace(/[^\w.-]/g, '_')}-${hook}-${Date.now()}.log`);
    writeFileSync(path, stripAnsi(output));
    return path;
  } catch {
    return null;
  }
}

/** What a hand-back note records about its failure, for the next one to compare with. */
export interface RecordedFailure { paths: string[]; tip?: string; repeat?: boolean }

const RECORD_RE = /<!-- crew-gate-failure (\{.*?\}) -->/;

const recordLine = (b: BuildFailureBounce, repeat: boolean): string =>
  `<!-- crew-gate-failure ${JSON.stringify({ paths: b.failingFiles ?? [], ...(b.tip ? { tip: b.tip } : {}), ...(repeat ? { repeat: true } : {}) })} -->`;

/** The failure a hand-back note recorded; older notes fall back to the paths quoted in them. */
export function recordedFailure(note: string | undefined, cwd?: string): RecordedFailure | undefined {
  if (!note) return undefined;
  const m = RECORD_RE.exec(note);
  if (m) {
    try { return JSON.parse(m[1]!) as RecordedFailure; } catch { /* fall through to the quoted text */ }
  }
  return { paths: failingPaths(note, cwd ?? '/\0') };
}

/**
 * A repeat failure the seat was not shown enough to act on the first time: same
 * file, same branch tip, and this is the first repeat (CREW-3775).
 */
export function isUnseenRepeat(b: BuildFailureBounce, previousNote: string | undefined): boolean {
  const prev = recordedFailure(previousNote, b.cwd);
  if (!prev || prev.repeat || !prev.tip || !b.tip || prev.tip !== b.tip) return false;
  return (b.failingFiles ?? []).some((f) => prev.paths.includes(f));
}

/** A merged branch the build failure was pinned on. */
export interface BuildCulprit {
  ticket: Ticket;
  branch: string;
  /** Which hook failed: `build` or `test`. */
  hook: string;
  /** The tail of that hook's output. */
  tail: string;
  /** The checkout the failure was seen in (to relativize paths in the output). */
  cwd?: string;
  /** Repo-relative files the failing output names (CREW-3220). */
  failingFiles?: string[];
  /** Whether any named file is among the branch's changes; null when the output names none. */
  inBranch?: boolean | null;
  /** How the culprit was found: named by the output, by building it alone, or as half of a failing pair. */
  how: 'files' | 'solo' | 'pair';
  /** Whether `tail` is built around the lines naming the failing files (false: the closing lines). */
  pathCentered?: boolean;
  /** Where the whole output of the failed run was kept, on the ship that ran the gate. */
  outputPath?: string;
  /** The branch tip the gate saw. */
  tip?: string;
  /** For `pair`: the earlier-verified branch it fails together with. */
  sibling?: { key: string; branch: string };
}

export interface BuildFailureBounce extends BuildCulprit {
  base: string;
  remote: string;
  /** The branch's worktree ON THIS SHIP, or null when it was built elsewhere. */
  worktree: string | null;
}

export type BuildFailureOutcome = { kind: 'handed-back' } | { kind: 'escalated' } | { kind: 'stale' } | { kind: 'failed'; why: string };

export function planBuildFailureBounce(cwd: string, c: BuildCulprit, base: string, remote: string): BuildFailureBounce {
  return { ...c, base, remote, worktree: worktreeForBranch(cwd, c.branch) };
}

/** A hand-back line when the failing files lie outside the branch's changes (CREW-3220): not proof, but worth seeing at once. */
function outsideNote(b: BuildFailureBounce): string {
  if (b.inBranch !== false || !b.failingFiles?.length) return '';
  const shown = b.failingFiles.slice(0, 5).map((f) => `\`${f}\``).join(', ');
  return `**None of the files the failure names (${shown}) are among this branch's changes**, so this may be a flake or a failure that already lives on \`${b.base ?? 'the base'}\` rather than something the branch broke; check that before changing code.\n\n`;
}

/** What the quoted excerpt is, and where the rest is. */
function excerptNote(b: BuildFailureBounce): string {
  const where = b.outputPath ? ` The whole output is at \`${b.outputPath}\` on the ship that ran the gate.` : '';
  return b.pathCentered
    ? `The excerpt below is built around the output lines that name the failing files.${where}`
    : `No failing file could be read from the output, so this is its closing lines; **the failing step may be earlier than what is quoted.**${where}`;
}

export function buildFailureComment(b: BuildFailureBounce, repeat = false): string {
  const names = (b.failingFiles ?? []).slice(0, 5).map((f) => `\`${f}\``).join(', ');
  const byFiles = b.how === 'files';
  const how = b.how === 'pair' && b.sibling
    ? `Each branch passes the hook alone; \`${b.branch}\` together with ${b.sibling.key} (\`${b.sibling.branch}\`) fails it. ${b.sibling.key} was verified first, so the fix belongs on this branch: \`git merge ${b.remote}/${b.sibling.branch}\` first, then fix what disagrees. Fix it on this branch, never a fresh one.`
    : byFiles
    ? `The failing output names files this branch changed${names ? ` (${names})` : ''}. Nothing here shows whether the branch passes the hook on its own.`
    : `Built alone on the previous \`${b.base}\`, \`${b.branch}\` fails the same hook.`;
  const first = byFiles
    ? `First step: run the failing step on \`${b.branch}\` itself${b.worktree ? ` in \`${b.worktree}\`` : ''} and fix what it reports in the files above. Merge \`${b.remote}/${b.base}\` in only if it passes there.`
    : `First step: \`git merge ${b.remote}/${b.base}\` in ${b.worktree ? `\`${b.worktree}\`` : 'the branch\'s worktree'}, rebuild, and fix what disagrees — the merge is clean at the text level, so this is a semantic conflict (a duplicate identifier, a changed signature) with work that landed on \`${b.base}\` after this branch was cut.`;
  const heading = byFiles
    ? `Back with the dev lane — the release gate failed in files this branch changed.`
    : `Back with the dev lane — this branch builds on its own but not on current \`${b.base}\`.`;
  const again = repeat
    ? `**Second hand-back for the same failure on the same commit.** The first note did not show enough to act on, so this one quotes the lines that name the file.\n\n`
    : '';
  return `${BUILD_FAILURE_MARKER}

**${heading}**

${again}\`${b.branch}\` was verified, but the release's \`${b.hook}\` hook failed once it was merged with the other branches in the same release. ${how}

${outsideNote(b)}${first} Push as a plain fast-forward and hand back to QA as usual.

${excerptNote(b)}

\`\`\`
${b.tail.trimEnd()}
\`\`\`

Nothing was written to \`${b.base}\` for this ticket; the rest of the release shipped without it.
${recordLine(b, repeat)}`;
}

interface BuildFailureEvent { record_id?: string | null; event_type?: string | null; occurred_at?: string | null; created_at?: string | null }

/**
 * Hand-backs of this ticket for a failed hook that a lane has answered with a
 * push since (loop guard, CREW-2777): a second one means the fix did not hold.
 */
export function priorBuildFailures(ticket: Ticket, events: readonly BuildFailureEvent[]): number {
  const stamp = (e: BuildFailureEvent): string => e.occurred_at ?? e.created_at ?? '';
  const mine = events.filter((e) => e.record_id === ticket.id);
  const pushes = mine.filter((e) => e.event_type === 'pushed').map(stamp);
  return mine.filter((e) => e.event_type === 'build_failed' && pushes.some((p) => p > stamp(e))).length;
}

/** The tail of the latest hand-back note posted for this ticket's earlier failure, if any. */
export function priorFailureNote(ticket: Ticket, events: readonly BuildFailureEvent[]): string | undefined {
  const stamp = (e: BuildFailureEvent): string => e.occurred_at ?? e.created_at ?? '';
  return events
    .filter((e) => e.record_id === ticket.id && e.event_type === 'build_failed')
    .sort((a, b) => stamp(a).localeCompare(stamp(b)))
    .map((e) => (e as BuildFailureEvent & { message?: string | null }).message ?? '')
    .pop();
}

/** Whether the two failures were the same test, and whether the files are the branch's own (CREW-3220). */
export function failureComparison(b: BuildFailureBounce, previousNote?: string): string {
  const now = b.failingFiles ?? failingPaths(b.tail, b.cwd ?? '/\0');
  const before = recordedFailure(previousNote, b.cwd)?.paths ?? [];
  const lines: string[] = [];
  if (!before.length || !now.length) {
    lines.push('- Same failure both times? Unknown: the output of at least one run names no file.');
  } else {
    const same = now.filter((f) => before.includes(f));
    lines.push(same.length
      ? `- Same failure both times: yes, ${same.map((f) => `\`${f}\``).join(', ')} fails in both.`
      : `- Same failure both times: **no**. First ${before.slice(0, 3).map((f) => `\`${f}\``).join(', ')}, now ${now.slice(0, 3).map((f) => `\`${f}\``).join(', ')}. Two different failures look like a flake, not a branch that keeps breaking.`);
  }
  lines.push(b.inBranch == null
    ? '- Failing files among the branch\'s changes? Unknown: the failure names no file.'
    : b.inBranch
    ? '- Failing files among the branch\'s changes: yes.'
    : '- Failing files among the branch\'s changes: **no**, none of them. Not proof, but the branch probably did not break it.');
  return lines.join('\n');
}

export function buildFailureEscalation(b: BuildFailureBounce, previousNote?: string): string {
  return `${BUILD_FAILURE_MARKER}

**Failed the release gate again after a hand-back — stopping rather than looping.**

\`${b.branch}\` was handed back for breaking the \`${b.hook}\` hook, pushed, verified again, and breaks it once more. That is a call for a person, not another lap through the lanes.

${failureComparison(b, previousNote)}

\`\`\`
${b.tail.trimEnd()}
\`\`\``;
}

/**
 * Hand a culprit back to the dev lane. Non-fatal and stale-write-safe for the
 * same reasons as `applyConflictBounce`; the assignee is cleared so
 * `in_progress` + unassigned reads as "up for grabs" on every ship.
 */
export async function applyBuildFailureBounce(
  writer: ConflictWriter, b: BuildFailureBounce, contract: Contract, memberId: string,
  log: ConflictLog, dryRun: boolean, prior: { count: number; operatorId?: string; previousNote?: string } = { count: 0 },
): Promise<BuildFailureOutcome> {
  const t = { ticket: b.ticket.issue_id, step: 'release' };
  // Same file, same tip: the seat was not shown enough the first time, so one
  // more lap with the path-centered excerpt before a person is called (CREW-3775).
  const repeat = prior.count > 0 && isUnseenRepeat(b, prior.previousNote);
  if (prior.count > 0 && !repeat) {
    if (dryRun) {
      log.emit(`would escalate to ${contract.statuses.needsHuman} — handed back for the ${b.hook} hook before`, t);
      return { kind: 'escalated' };
    }
    try {
      const w = await writeUnlessMoved(
        writer, b.ticket,
        { status: contract.statuses.needsHuman, ...(prior.operatorId ? { assignee_id: prior.operatorId } : {}) },
        contract, memberId,
      );
      if (!w.ok) {
        log.emit(`${displayKey(b.ticket)} changed on the board since this run read it (${w.moved}) — not escalating over it`, t);
        return { kind: 'stale' };
      }
      await writer.postEvent(b.ticket.id, buildFailureEscalation(b, prior.previousNote), memberId, 'build_failed_escalated').catch(() => {
        log.warn('escalated, but the note failed to post', t);
      });
      log.warn(`breaks the ${b.hook} hook again after a hand-back — escalated to ${contract.statuses.needsHuman}`, t);
      return { kind: 'escalated' };
    } catch (e) {
      if (e instanceof StaleWriteError) return { kind: 'stale' };
      return { kind: 'failed', why: (e as Error).message };
    }
  }
  if (dryRun) {
    log.emit(`would hand ${displayKey(b.ticket)} back to ${contract.statuses.building} — its branch breaks the ${b.hook} hook`, t);
    return { kind: 'handed-back' };
  }
  try {
    const w = await writeUnlessMoved(
      writer, b.ticket, { status: contract.statuses.building, assignee_id: null }, contract, memberId,
    );
    if (!w.ok) {
      log.emit(`${displayKey(b.ticket)} changed on the board since this run read it (${w.moved}) — not handing it back over it`, t);
      return { kind: 'stale' };
    }
    await writer.postEvent(b.ticket.id, buildFailureComment(b, repeat), memberId, 'build_failed').catch(() => {
      log.warn('handed back, but the note failed to post', t);
    });
    // One compact record of who was blamed and how (CREW-2777), apart from the
    // comment the lane reads, for anything that wants to count or list them.
    await writer.postEvent(
      b.ticket.id,
      `${b.ticket.issue_tag ?? b.ticket.issue_id} left out of the release: ${b.hook} hook, found by ${b.how}${b.sibling ? `, together with ${b.sibling.key} (${b.sibling.branch})` : ''}`,
      memberId, 'release_culprit',
    ).catch(() => { /* the build_failed note above is the one that matters */ });
    log.emit(`handed back to ${contract.statuses.building} — breaks the ${b.hook} hook once merged with the rest`, t);
    return { kind: 'handed-back' };
  } catch (e) {
    if (e instanceof StaleWriteError) {
      log.emit(`${displayKey(b.ticket)} changed on the board since this run read it — not handing it back over it`, t);
      return { kind: 'stale' };
    }
    return { kind: 'failed', why: (e as Error).message };
  }
}

/** Whether the newest `build_failed` hand-back of this ticket has had no push since (CREW-3774). */
export function unansweredBuildFailure(ticket: Ticket, events: readonly BuildFailureEvent[]): boolean {
  const stamp = (e: BuildFailureEvent): string => e.occurred_at ?? e.created_at ?? '';
  const mine = events.filter((e) => e.record_id === ticket.id);
  const failed = mine.filter((e) => e.event_type === 'build_failed').map(stamp).sort().pop();
  if (!failed) return false;
  return !mine.some((e) => e.event_type === 'pushed' && stamp(e) > failed);
}

/** What a restore needs of the tracker. */
export interface RestoreVerifiedWriter {
  updateTicket(id: string, patch: Record<string, unknown>): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string, type?: string): Promise<void>;
  events?(type: string): Promise<RunnerEvent[]>;
}

/**
 * A building run answered a `build_failed` hand-back without changing the branch: its tip is
 * still the commit QA verified. That is a correct answer (the failure was not the branch's, as
 * when the base itself is red), not a failed hand-off, so the ticket goes back to `verified`
 * for the release instead of through the hand-off checks or the no-change count (CREW-3774).
 * True when it did.
 */
export async function restoreVerifiedIfUnchanged(
  w: RestoreVerifiedWriter, ticket: Ticket, tip: string | null | undefined, contract: Contract, memberId: string,
  hold?: { column: string },
): Promise<boolean> {
  if (!w.events || !tip) return false;
  const [failures, pushes] = await Promise.all([w.events('build_failed'), w.events('pushed')]);
  if (!unansweredBuildFailure(ticket, [...failures, ...pushes])) return false;
  const verified = verifiedShaFor(ticket, contract.columns.verifiedSha, pushes);
  if (!verified || !(tip.startsWith(verified) || verified.startsWith(tip))) return false;
  await w.updateTicket(ticket.id, {
    status: contract.statuses.verified,
    [contract.columns.assignee]: null,
    ...(hold ? { [hold.column]: null } : {}),
  });
  await w.postEvent(
    ticket.id,
    `${BUILD_FAILURE_MARKER}\n\n**Back at \`${contract.statuses.verified}\`: the hand-back was answered with no change.** The branch is still at the commit QA verified (\`${verified.slice(0, 12)}\`), so nothing was handed on to QA again. The next release composes it with the current base.`,
    memberId, 'build_failed_unchanged',
  ).catch(() => undefined);
  return true;
}
