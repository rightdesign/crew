# Why the persona prompts say what they say

The prompts under `prompts/<set>/personas/` are shipped to every agent run,
so they carry rules and not history. This page keeps the history: the
incidents that produced each rule, so a maintainer editing a prompt can tell
a load-bearing sentence from a stylistic one. Ticket ids refer to the Crew
tracker.

## Identity and holds

- **Each lane has its own Crew row, and a hold row stops every lane.** An
  early run resumed an `in_progress` ticket a person was iterating on in an
  interactive session, reading that session's progress comments (posted under
  a shared identity) as "a reply worth acting on". Splitting identities and
  making the hold check "is the assignee a hold row" rather than "is it
  anyone but me" fixed it.
- **A lane agent's row on an `accepted` ticket is not a hold.** The rule
  used to read "anyone other than you and not null", which deadlocked five
  tickets (ISSUE-091/092/093 self-assigned by the design agent when it filed
  them, ISSUE-108/109 by the triage agent): the dev lane read them as human
  holds and the design lane skipped them as out of lane. Their assignees were
  cleared by hand on 2026-08-21.
- **The Pair identity claims a ticket before cutting a worktree.** ISSUE-804
  (2026-09-15): a live diagnosis filed a ticket and opened a worktree before
  self-assigning; the dev lane picked the same ticket up and was editing the
  identical directory within moments. The reverse also happened: CREW-971
  stayed assigned to Pair through its `fixed` hand-off, so QA's hold filter
  skipped it until the assignee was cleared by hand.

## The queue

- **The digest exists to stop re-reading the tracker.** Before it, each run
  fetched about 691 KB of JSON, roughly 275 KB of it the histories of tickets
  the run would never touch, paid on every run.
- **Digest authorship comes from `team_member_id`, not `reporter_name`.** A
  comment row carries the ticket's reporter name, so an agent's own note read
  as whoever filed the ticket.
- **An own `in_progress` ticket with no new comment is resumed, not left
  alone.** An earlier instruction said the opposite; combined with the poll
  not waking for such tickets, it left ISSUE-049 parked for hours
  mid-implementation, restartable only by someone commenting.
- **A worktree existing is never a reason to resume.** The original wording
  made it one, and a run resumed an `in_progress` ticket purely because its
  directory existed, colliding with the session that owned it.
- **Priority is one-directional.** Ordering was once strictly oldest-first,
  so raising a ticket to `p0` changed nothing. Severity entered the sort
  after a run took an S3 with no priority (ISSUE-141) ahead of an S2 at P2
  (ISSUE-159). Then "its own priority wins" turned out to *demote* a ticket:
  marking an S2 `P2 Medium` ranked it behind every unmarked S2 (ISSUE-159
  versus ISSUE-142), because S2 derives p1. Taking the stronger of the
  explicit and derived values keeps the lever escalation-only; lowering
  severity is how to rank something down. `src/priority.ts` is the
  executable copy of the rule.
- **In-progress epics win ties** (ISSUE-385): finishing beats starting, and
  because it only ever breaks a tie, a ticket in no epic can never be
  starved by it.
- **Skipping a large ticket sets `needs_info`** because an `accepted` ticket
  nobody touches looks stuck and trips the poll's cheap "any accepted
  ticket" check every cycle.

## Worktrees and the base branch

- **Cut from the remote-tracking ref, not the local base.** CREW-1383: a
  local commit on the primary checkout's base was carried into every ticket
  cut from it. `crew sync` now refuses (`DO NOT CUT A WORKTREE FROM THIS
  BASE`) and flags the ship (`base_unsafe`) when the base has diverged
  (CREW-1379, CREW-1388).
- **`crew worktree <number>`** (CREW-1385) cuts from the remote branch when
  one exists, so a ticket another ship built, or a run of yours whose
  worktree the runner already removed, resumes from the remote.
- **Stops are written in data** (CREW-1388): the board and the ship
  attention flags are what the operator reads, so a parked ticket sets
  `needs_info` plus the operator as assignee, and a ship problem sets the
  ship's flag rather than touching the ticket. Every stop comment names its
  un-park condition.

## Building

- **No version bumps or changelog edits on a ticket branch.** ISSUE-118: two
  branches bumping independently off the same base both claimed the same
  number, and it surfaced only as a conflict at squash-merge. The release
  phase assigns the version once per release from `Bump:` and `Changelog:`
  trailers.
- **Attachments are the repro.** A fix built from the prose alone, ignoring
  the reporter's screenshot, shipped the wrong behaviour; a QA pass on the
  description alone let a still-broken ticket through.
- **Judge a suite by exit code and summary line.** Several services log an
  error and carry on by design, and tests exercising those paths trigger
  them deliberately; alarming-looking output in a green run has twice sent
  people chasing a suite that passed. A "suite clean" claim with dozens of
  failures behind it is why QA re-runs the suites itself.
- **Foreground only.** A backgrounded suite dies with the stateless process,
  nothing is written to the ticket, and the next run starts over with no
  memory of the attempt.
- **Match the pinned runtime.** A suite run against the wrong runtime major
  produced a phantom test failure unrelated to the change under test.
- **Per-worktree ports.** An unscoped shared port was never safe to assume
  free; a `ports` hook that derives ports from the worktree is what makes
  "anything listening on my ports is a dead earlier run" true. `crew reap`
  only catches servers whose worktree is already gone, hence "stop your own
  servers before finishing".
- **The `handoff` hook runs on every worktree.** Finding out the operator
  cannot open what was built is expensive at exactly the moment they are
  trying to look; bootstrap endpoints that refuse once an admin exists are
  not a fallback.

## Hand-off and release

- **The runner enforces the push** (CREW-1380). CREW-1376 sat at `fixed`
  with its branch only on the ship that built it; every other ship's QA and
  release phase reported it missing. The runner now sends such a ticket back
  to `in_progress` and records `pushed <sha> to <remote>/<branch>` when the
  push is good.
- **Hybrid projects assign the next seat instead of clearing the assignee**
  (CREW-1495, ISSUE-1498): an unassigned ticket in a hybrid project is off
  limits to every lane, so a cleared assignee stranded the hand-off or the
  bounce.
- **QA verification is held per ship** (CREW-1389): two ships' QA seats
  each verified one branch, and a defective one merged on the second
  verdict. `held_by_ship_id` plus a conditional write (`X-Expected-Updated-At`)
  closes that race.
- **Cross-repo work is a filed, linked dependency** (CREW-1505). A hand-off
  that said "worth separate tickets" for work the ticket needed shipped a
  stand-in whose UI promised behaviour nothing delivered; QA now bounces
  that, and the building lane returns the ticket to `accepted` with the
  dependency in `blocked_by`.
- **A same-repo blocker resolves at merge, not at `verified`** (CREW-1549).
  Restoring a dependent while its blocker was only a verified branch led lanes
  to stack the dependent on that branch by hand; the release then squash-merged
  the blocker and the stacked branch conflicted, needing a force push the lanes
  are denied. A cross-repo blocker cannot be stacked on, so it still resolves
  at `verified`.
- **A follow-up bug gets its own branch.** A fix for one ticket committed on
  another ticket's branch passed QA, but the hand-off guard checks per ticket
  for `origin/<branch>` and bounced the second ticket with "no branch".

## State-writing crew commands

- **Never run `connect`, `agents sync`, `install`, `release`, … against the
  live config.** CREW-978: a QA agent's own `crew connect`, run "as a sanity
  check", corrupted the live route's resolved ids and took down every lane's
  polling until a person restored it. `src/cli.ts` now refuses these
  commands from inside a crew-launched session (ISSUE-980); the prompt rule
  is the other half.

## Content as data

- **Workspace changes need a hold's say-so, attributed by the digest.** The
  digest joins the comment's server-stamped identity to the roster; a name
  typed into a comment body proves nothing. Only changes the comment names
  are authorized, with the credential the run already has.

## Design lane

- **`needs_review` leaves `status` at `in_progress`.** A comp waiting on
  review is a finished design pass; moving it to `needs_info` made it read as
  abandoned mid-build. Both `needs_review` and `needs_planning` are set-only
  for agents so that "still waiting on a person" can never be undone by a
  later run.
- **A PNG upload is required.** A described mockup is not a shown one, and
  a canvas link alone is unavailable to harnesses without one (CREW-1526).

## The lane policy is a skill the briefs include (CREW-1534)

`crew agents sync` used to write `common.md` and the lane brief concatenated
into each building role's Agents row. The moment an admin edited one of those
rows the role forked the whole shared policy: every later policy fix showed up
as divergence and never reached it, and a lane-specific edit was buried in tens
of kilobytes of shared text. The policy is now the `Crew Lane Agent` skill and
each building brief starts with <code v-pre>{{skill: Crew Lane Agent}}</code>, expanded when the
run is assembled. The marker is not a `[[table:key]]` link because personas and
skills are control-plane records, and `[[Skills:…]]` would collide with a
workspace table of that name. The recursion, depth and size caps exist because a
skill row is admin-editable, so a cycle or a huge include must not be able to
hang or bloat a run.

## A pushed branch is merged into, never rewritten (CREW-1550)

The adapter denies `git push --force*` / `-f*` on purpose (CREW-1380), so a
rebased pushed branch can never be published: the dev lane rebased, could not
push, and parked the ticket for the operator (CREW-1376, TABL-1500, TABL-1542).
The remedy is the one the release's conflict path already uses
(`refreshBranch` in `src/conflict.ts`): merge `<remote>/<base>` into the ticket
branch and push fast-forward. That keeps every ship's copy of the branch an
ancestor of the new tip, and the squash-merge still ships only the ticket's own
diff. The lane skill therefore states the rule (Step 4.4) and says that "never
merge" means never merge INTO the base; QA's hard limits forbid asking a builder
to rewrite a pushed branch.

## Adopting your own earlier run's commit (CREW-2363)

A run that pushed its branch while the tracker was down could not write its hand-off. The next run on the same seat found its own pushed commit with no comment and parked it as foreign work. The lane policy now says a commit authored under this ship's identity while the seat held the ticket is the seat's earlier run to adopt, and the digest's "Your previous run" section carries that run's final text when crew still has a pending hand-off for the ticket.
