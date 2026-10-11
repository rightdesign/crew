---
name: Filing a Ticket
description: How a lane files a new ticket for something it notices mid-task, and how it records in-scope work that lives in another repository as a filed, linked dependency instead of shipping a stand-in. Fetch when you spot out-of-scope breakage or discover your ticket depends on a change elsewhere.
---
# Filing a ticket for something you spot along the way

Something broken that is out of scope for the ticket you are working — a
failing build, a flaky test, an unrelated bug in code you passed through —
is **not fixed inline.** File it as its own new ticket in the Issues table and
keep working the one you were on.

The Environment section's "Filing a new ticket" block names the exact
`project` and `repo` column values to set. **Always set both.** A ticket
filed without them has nowhere to route to — it sits unclaimed until a person
notices and fixes it by hand, however urgent its priority.

If that block also lists `filed_by_id` (your own Crew row) or `ship_id` (the
ship you are running on), set those too, and `ship_id` on every comment you
post. The block lists a column only when this workspace has it; a column it
does not name is not yours to set.

Name the ticket you were working when you noticed it in the new ticket's
description. Only add the new ticket to **your own ticket's** `blocked_by`
if your own ticket genuinely cannot proceed without the new one being fixed
first — merely having noticed it nearby is not a dependency. The dependency
always points from the ticket that waits to the ticket it waits on, never
the other way round.

### Work your ticket needs in another repository

Out-of-scope breakage and **in-scope work that lives somewhere else** are
different things. If your ticket's acceptance depends on a change in another
repository (or on a change this repository cannot make), do not ship a
stand-in for the missing piece and hand the ticket off. A stand-in whose UI,
docs or hints promise behaviour the dependency has not delivered is a defect
that QA passes and the release phase ships. Instead:

1. File that work as its own ticket in the owning repository's project (the
   Environment section names the projects and repos; if the owning repo is
   not listed there, file it against the project and say which repo in the
   description), setting the same filing columns as above and naming your
   ticket in its description.
2. Add the new ticket's id to **your own ticket's** `blocked_by`.
3. Post a comment on your ticket naming each dependency and what it must
   deliver.
4. Set your ticket back to `accepted`. The poll's sweep parks it at
   `blocked` and restores it to `accepted` once every blocker resolves. In a
   `hybrid` project keep `assignee_id` as your own seat (an unassigned
   hybrid ticket is off limits to every lane); in an `automatic` project
   clear it as for any other re-queue.
5. Leave the branch and worktree in place, committed and pushed if they hold
   work, so the lane that resumes the ticket continues from them.

Hand a ticket off as `fixed` only when the branch works against dependencies
that are already released. A hand-off comment that says "worth separate
tickets" for work the ticket needs is a hand-off that is not ready.
