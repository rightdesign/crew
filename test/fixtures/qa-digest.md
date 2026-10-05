## Current queue — built for you by the poll


Already filtered to your lane: every ticket at `qa` ("Verification" —
yours, unfinished) or `fixed` (nobody has checked it yet), from both
building lanes. Ticket bodies are deliberately omitted: fetch the full
record and the comments of the one ticket you actually pick up. **Do not
re-fetch the whole tracker.** This digest comes from the same API call the
poll just made, moments ago.


"new since last poll" counts comments from someone other than you since
the poll watermark — the same signal that woke this run.


**`repo` is the checkout the ticket's work happens in** — an area spans
several repositories, so the worktree you verify in sits beside THAT
directory, not beside whichever one this session started in. A ticket
marked **NO CHECKOUT** is not yours: this ship has no clone of its
repository, and another ship may serve it.

**`branch` is that repository's own branch for the ticket**, found there
rather than derived. **`<name> (on origin only)`** means another ship built it
and pushed it: it is testable — cut a worktree from the remote branch
(`git worktree add <worktree> <name>`). **MISSING** means the branch is gone
locally AND on the remote, so there is nothing left to verify — say so on the ticket. A `—` means the branch
could not be looked for at all, because the repo has no checkout here.

**`worktree` is where that branch should be checked out**, `<repo>/../<worktree>`
— rendered the same way the dev/design digest computes it, so you land in
the same directory the building lane used.


### Still in verification — yours, unfinished (take these first)


| ticket | repo | status | built by | assignee | filed by | sev | pri | eff | branch | worktree | updated | last comment | new since last poll |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ISSUE-11 | /w/api | qa | dev | you | — | — | — | p2 | issue-0011 | api-issue-11 | 2026-08-23T12:00Z | — | — |


### Awaiting verification, in pick order


| ticket | repo | status | built by | assignee | filed by | sev | pri | eff | branch | worktree | updated | last comment | new since last poll |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ISSUE-12 | /w/api | fixed | dev | **Brad C. (Operator) — HOLD** | — | s1 | — | p0 | **MISSING** | api-issue-12 | 2026-08-23T12:00Z | — | — |
| ISSUE-10 | /w/api | fixed | design | unassigned | — | s2 | — | p1 | issue-10 | api-issue-10 | 2026-08-23T12:00Z | 2026-08-23T10:00Z Developer agent | **1 new** |

