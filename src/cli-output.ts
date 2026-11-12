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
