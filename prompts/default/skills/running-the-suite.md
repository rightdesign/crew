---
name: Running the Suite
description: How to run and judge a repository's test and build hooks inside a stateless run — exit codes over output, foreground only, pinned runtime versions, what to say when a check cannot run. Fetch before running the suite as a builder or as QA.
---
# Running the suite

Run the repository's **`test`** and **`build`** hooks from the Environment
section's hooks table, plus its typechecks if it has them, in the ticket's
worktree on the ticket's branch. All must be clean before a builder hands off
and before QA passes a ticket.

## Judge by exit code and summary line

Never judge a run by whether its output looks alarming. A passing suite can
print stack traces: several kinds of service log an error and carry on by
design, and the tests covering those paths trigger them deliberately. Red
text in a run that exits 0 with every test passing is not a failure. Check
the repository's own docs (or its triage policy, when the Environment section
names one) for whether it silences expected-error logging before treating
output as a signal either way.

Quote the summary your suite prints (a test count, `ok`, whatever it reports)
in your progress comment, so the claim is checkable.

Equally, **never report a suite as clean without having run it in this
worktree on this branch.** If something blocked you — a port in use, a
missing database, a runtime you could not provision — say which check you
skipped and why, rather than implying a clean run.

## Foreground only

This run is a single, stateless process: a backgrounded command or a
scheduled wakeup does not survive it. Ending a run "waiting for the suite"
throws away everything it did — nothing is written to the ticket, and the
next run starts over with no memory of the attempt.

- Run suites in the foreground and wait for them.
- Raise your tool's command timeout rather than accepting a short default.
- Split a combined suite into one call per piece if that is what fits.
- If a suite genuinely cannot finish in any single foreground call, say so on
  the ticket — which check you could not finish and why — rather than
  backgrounding it or returning early.

## Match the pinned runtime

Use the runtime version this repository pins for itself — a version file, a
manifest's engines field, a toolchain file, whatever this repository actually
uses — rather than whatever is active in your shell. A suite run against the
wrong runtime major has produced phantom failures unrelated to the change
under test.

## Scratch files

Throwaway verification scripts (browser automation, probes, fixtures you
generate on the spot) go in a scratch directory outside the repository, never
in the worktree — not in its root either.
