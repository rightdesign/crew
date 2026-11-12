/**
 * Terse-output helpers for the CLI commands (CREW-3267). CREW-3266 gave the
 * Emitter a routine/verbose split; these cover what it does not reach: a
 * series of per-item outcome lines collapsed into one summary, and an error
 * line that ends with the command to run next.
 */

/**
 * Describe a series of outcomes, collapsing the uneventful ones. Outcomes for
 * which `isRoutine` is true are replaced by one line (`3 personas already in
 * sync`) unless `verbose`, so what remains is what happened.
 */
export function summarizeOutcomes<T>(
  outcomes: readonly T[],
  describe: (o: T) => string,
  isRoutine: (o: T) => boolean,
  noun: string,
  verbose: boolean,
): string[] {
  if (verbose) return outcomes.map(describe);
  const lines = outcomes.filter((o) => !isRoutine(o)).map(describe);
  const routine = outcomes.length - lines.length;
  if (routine > 0) lines.push(`${routine} ${noun}${routine === 1 ? '' : 's'} already in sync`);
  return lines;
}

/** An error message that ends with what to try next (`crew doctor` or the specific subcommand). */
export function withFix(message: string, fix: string): string {
  return `${message.replace(/[.\s]+$/, '')} — try: ${fix}`;
}

export interface JobResult {
  job: string;
  mechanism: string;
  /** What `crew install`/`crew uninstall` did to this scheduler job. */
  action: 'installed' | 'replaced' | 'removed' | 'unchanged';
}

/**
 * CREW-3284: the lines `crew install` / `crew uninstall` print for the scheduler
 * jobs. A job that changed gets its own line naming the job and mechanism; jobs
 * that did not collapse into one line (`all 3 jobs already installed`). Under
 * `--verbose` every job is listed. A dry run lists every job as not applied,
 * since nothing was compared against disk.
 */
export function summarizeJobs(results: readonly JobResult[], o: { uninstall?: boolean; dryRun: boolean; verbose: boolean; host: string }): string[] {
  const state = o.uninstall ? 'not installed' : 'installed';
  const mark = o.dryRun ? ' (dry run, not applied)' : '';
  const line = (r: JobResult): string => {
    if (o.dryRun) return `would ${o.uninstall ? 'remove' : 'install'} ${r.job} via ${r.mechanism} for ${o.host}${mark}`;
    if (r.action === 'unchanged') return `${r.job} already ${state} (${r.mechanism})`;
    return `${r.action} ${r.job} via ${r.mechanism} for ${o.host}`;
  };
  if (o.dryRun || o.verbose) return results.map(line);
  const lines = results.filter((r) => r.action !== 'unchanged').map(line);
  const same = results.filter((r) => r.action === 'unchanged');
  if (same.length > 0) {
    const names = same.map((r) => r.job).join(', ');
    lines.push(same.length === results.length
      ? `all ${same.length} jobs already ${state} (${names})`
      : `${same.length} job${same.length === 1 ? '' : 's'} already ${state} (${names})`);
  }
  return lines;
}

export interface RunOutcomeInput {
  role: string;
  route: string;
  /** The ticket the run worked, when it had one. */
  ticket?: string | null;
  /** The harness result (`spawnAgent`). */
  run: { code: number; handoffPending?: boolean; killed?: { limitMinutes: number } };
  /** What the hand-off guard found, when it checked. */
  handoff: { kind: 'not-handed-off' | 'pushed' | 'unverified' | 'bounced' | 'failed'; why?: string } | null;
}

/**
 * CREW-3285: the one line `crew run` prints at a terminal when a run ends: handed off,
 * parked or not handed off with the reason, or failed with the reason and the command
 * to run next. Console only (`Emitter.echo`): the event stream keeps its own
 * `agent run finished` event, unchanged.
 */
export function describeRunOutcome(o: RunOutcomeInput): string {
  const who = `${o.role}${o.ticket ? ` on ${o.ticket}` : ''}`;
  const status = `crew status ${o.route}`;
  if (o.run.killed) return withFix(`${who}: run stopped at its ${o.run.killed.limitMinutes} min limit`, `\`${status}\``);
  if (o.run.code !== 0) return withFix(`${who}: run failed (exit ${o.run.code})`, `\`${status}\` and the run's stream under the state directory`);
  if (o.run.handoffPending) return `${who}: finished; the hand-off write is pending and replays next cycle`;
  const h = o.handoff;
  if (!h) return `${who}: finished`;
  switch (h.kind) {
    case 'pushed': return `${who}: handed off`;
    case 'bounced': return `${who}: hand-off bounced, set back to in_progress`;
    case 'unverified': return `${who}: parked, ${h.why ?? 'hand-off not verified'}`;
    case 'failed': return withFix(`${who}: hand-off failed, ${h.why ?? 'unknown reason'}`, `\`${status}\``);
    default: return `${who}: finished without a hand-off`;
  }
}
