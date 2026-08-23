# Cutover: from `synthesis/scripts/local` to this repo

**State as of 2026-08-23: this repo is a copy. The crew that is actually
running is still `synthesis/scripts/local/dev-loop`.** Nothing here writes to
the tracker while `CREW_ENABLED=false`.

The copy was deliberate (ISSUE-321). The loop drives itself — a cycle is in
flight most of the time, and it edits, tests, merges and deploys the very
checkout it lives in — so the move is done in two steps: stand up a working
copy, verify it against live data read-only, then switch the timer over in one
short window.

## Why this repo exists

`scripts/local/` is gitignored, so the crew's own code was the one body of
work in that repo with no pipeline: no branch, no worktree, no QA pass, no
squash-merge, no changelog entry, no version. Two things went wrong because of
it, both worth remembering:

- **ISSUE-187** was picked up by the dev role, which cut a worktree off `main`
  and found none of the files it was meant to change. It ended in `needs_info`
  asking how loop-infrastructure changes were supposed to ship, and was
  finally done by hand in the primary checkout.
- **ISSUE-247** reads `closed_deployed` and its fix had never been applied. A
  ticket about the loop can be marked shipped without anything shipping,
  because there is no diff for the release phase to notice. By the time anyone
  checked, six open tickets had fallen out of the poll's truncated window.

## Where the two copies now differ

The two are no longer line-for-line equivalent, and the difference is
deliberate — do not "fold it back" at step 2 below.

**This copy is depersonalised (ISSUE-293).** The live copy names its operator
in prompt prose and hardcodes two human rows in shell; this one reads the
project's **Crew** table at run time and hands every agent a roster naming its
shipmates, with holds as an arbitrary-length list rather than the two fixed
slots. Config changed shape with it: `CREW_MEMBER_HUMAN` and
`CREW_MEMBER_PAIR` are gone, replaced by `CREW_MEMBER_MODEL_ID`,
`CREW_MEMBER_TRIAGE`, `CREW_OPERATOR` and a `CREW_HOLDS` array. Selection,
holds and ranking behave identically — only the names in the rendered output
changed.

## While both copies exist

**Change one, change both**, for anything that is not the above. The live copy
is authoritative until cutover; this one is what gets reviewed. The safest habit is to make no loop changes at
all during the interim, and to do the cutover soon rather than carry two.

`bin/crew status` reads *this* installation's state dir, so before
cutover it describes this copy, not the crew that is running. `doctor` is the
command that tells you something useful in the meantime.

## Cutover checklist

1. `bin/crew doctor` — everything green.
2. Diff the two copies one last time; fold anything the live one has gained,
   ignoring the depersonalisation described above:
   ```sh
   diff -u ../synthesis/scripts/local/dev-loop/dev-loop.sh bin/crew | less
   diff -ru ../synthesis/scripts/local/dev-loop ./prompts ./lib
   ```
3. Stop the old timers and wait for any run in flight to finish. **These are
   the labels the live copy installed** — `com.tablation.devloop`, not this
   repo's `com.tablation.crew` — so unload them by their own names before
   step 6 installs the new ones:
   ```sh
   launchctl unload ~/Library/LaunchAgents/com.tablation.devloop.plist
   launchctl unload ~/Library/LaunchAgents/com.tablation.triage.plist
   ../synthesis/scripts/local/dev-loop/dev-loop.sh status   # agent: idle
   ```
   The old `com.tablation.devloop.plist` is then dead weight in
   `~/Library/LaunchAgents/` — delete it at step 8 with the rest of the live
   copy, or it will be reloaded on the next login and two crews will poll the
   same tracker.
4. Carry the runtime state across, so the poll does not re-notify on every
   comment it has already seen and any paused role stays paused:
   ```sh
   mkdir -p .state
   cp ../synthesis/scripts/local/dev-loop/.poll-watermark .state/
   cp ../synthesis/scripts/local/dev-loop/.lane-paused-* .state/ 2>/dev/null
   cp ../synthesis/scripts/local/dev-loop/.deploy-failed-sha .state/ 2>/dev/null
   # the global pause sentinel, if the loop is paused as a whole — note the
   # name changes with the entry point (.dev-loop-paused -> .crew-paused)
   [ -f ../synthesis/scripts/local/dev-loop/.dev-loop-paused ] && touch .state/.crew-paused
   ```
   Do **not** copy the live copy's `.dev-loop.lock` or
   `.dev-loop-release.lock`; a stale lock file naming a dead pid is exactly
   what the new installation should not inherit. (This repo names its own
   locks `.crew.lock` / `.crew-release.lock`, so they would not collide even
   if copied — but a dead pid is still a dead pid.)

   The log moves too: the live copy writes `/tmp/tablation-dev-loop.log`,
   this one writes `/tmp/tablation-crew.log`. Nothing reads the old file
   after cutover, and keeping them separate is what lets you tell which crew
   wrote a line while both exist.
5. Set `CREW_ENABLED=true` in `crew.config.sh`.
6. Point the timers here and load them. The dev-loop timer is renamed with
   the entry point (`com.tablation.crew`), so this installs a new label rather
   than replacing the old one — which is why step 3 unloaded it by hand:
   ```sh
   $EDITOR launchd/com.tablation.crew.plist launchd/com.tablation.triage.plist
   cp launchd/*.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.tablation.crew.plist
   launchctl load ~/Library/LaunchAgents/com.tablation.triage.plist
   ```
7. Watch one full cycle: `bin/crew log -f`. A healthy cycle logs a
   `poll[...]` line per role and either a lane winning or nothing pending.
8. Only once a cycle has run clean end to end — including one release —
   delete `synthesis/scripts/local/dev-loop` and `synthesis/scripts/local/triage`.
   Nothing references them from the synthesis repo; they are gitignored, so
   there is no commit to make, and equally no way to get them back except this
   repo.

## Not moved

- **`/opt/synthesis/triage` on the beta box.** The server-side triage sidecar
  is deployed by rsync and holds its own `.env` with an OAuth token. Its
  source is `bin/crew-triage` + `prompts/triage-prompt.md` here now, but
  re-pointing the box at this repo is a separate job on the server.
- **The triage policy document.** `docs/BUG_TRACKER_TRIAGE_POLICY.md` stays in
  the project it governs; the prompt reads it at run time from
  `CREW_PROJECT_DIR`.
