/**
 * `crew periscope up --resume NNN` (EPIC-077, CREW-2856): bring back the
 * server of a periscope the idle pass stopped. The worktree, ticket and row
 * already exist, so this reruns `ports` (and `isolate` for an isolated
 * periscope, to get the same overrides back) and `preview`, then refreshes the
 * row and closes the `periscope_idle` item.
 */
import { PeriscopeError, parseEnvLines, previewUrlFrom, type HookResult } from './periscope-cmd.ts';
import type { PeriscopeRow } from './tracker.ts';

export interface ResumeDeps {
  /** The live row for this ticket number on this ship, with its ticket tag; undefined when there is none. */
  find(number: string): Promise<{ row: PeriscopeRow; tag: string } | undefined>;
  worktreeExists(path: string): boolean;
  caps: { idleMinutes: number };
  runHook(name: 'ports' | 'isolate' | 'preview', cwd: string, env: Record<string, string>): Promise<HookResult | null>;
  update(rowId: string, fields: Record<string, unknown>): Promise<void>;
  clearItem(ticketTag: string): void;
  now(): Date;
  say(event: string, message: string, data?: Record<string, unknown>): void;
}

export interface ResumeResult { ticket: string; worktree: string; url: string; periscopeRecordId: string }

const tail = (s: string, n = 20) => s.trimEnd().split('\n').slice(-n).join('\n');

export async function runPeriscopeResume(d: ResumeDeps, number: string): Promise<ResumeResult> {
  const found = await d.find(number);
  if (!found) throw new PeriscopeError(`no live periscope for ISSUE-${number} on this ship — open one with \`crew periscope up\``);
  const { row, tag } = found;
  if (!d.worktreeExists(row.worktree)) {
    throw new PeriscopeError(`the worktree of ${tag} is gone (${row.worktree}); there is nothing to resume`);
  }
  const env: Record<string, string> = { CREW_TICKET: tag };
  if (row.branch) env.CREW_BRANCH = row.branch;
  const ports = await d.runHook('ports', row.worktree, env);
  if (ports) Object.assign(env, parseEnvLines(ports.output));
  if (row.isolated) {
    const iso = await d.runHook('isolate', row.worktree, env);
    if (iso && iso.code !== 0) throw new PeriscopeError(`isolate failed (exit ${iso.code})\n${tail(iso.output)}`);
    if (iso) Object.assign(env, parseEnvLines(iso.output));
  }
  const preview = await d.runHook('preview', row.worktree, { ...env, CREW_PREVIEW_HOST: row.host || 'localhost' });
  if (!preview || preview.code !== 0) {
    throw new PeriscopeError(`preview exited ${preview?.code ?? 'without running'}\n${tail(preview?.output ?? '')}`);
  }
  const url = previewUrlFrom(preview.output);
  if (!url) throw new PeriscopeError(`preview printed no URL as its last line\n${tail(preview.output)}`);

  const now = d.now();
  await d.update(row.id, {
    url,
    last_activity_at: now.toISOString(),
    expires_at: new Date(now.getTime() + d.caps.idleMinutes * 60_000).toISOString(),
  });
  d.clearItem(tag);
  d.say('resumed', `preview at ${url}`, { url });
  return { ticket: tag, worktree: row.worktree, url, periscopeRecordId: row.id };
}
