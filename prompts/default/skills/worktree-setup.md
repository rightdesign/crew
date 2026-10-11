---
name: Worktree Setup
description: How a building lane cuts, prepares and tears down a ticket's worktree — crew worktree and crew sync behaviour, the setup/isolate/handoff hooks, dev servers and ports. Fetch when starting or resuming a ticket's worktree.
---
# Setting up a ticket's worktree

Every ticket is built in its own git worktree, cut from the base branch's
**remote-tracking ref**, never from the primary checkout's local base (that
copy is a cache of the remote and may carry a stray local commit that would
ride into every ticket cut from it). The digest's `worktree` and `branch`
columns give this ticket's directory and branch — use them verbatim; the
Environment section's worked example is illustrative only.

## `crew worktree <number>` — the preferred route

It runs `crew sync` first, then:

- cuts from `<remote>/<branch>` when the branch is already pushed (another
  ship built it, or an earlier run of yours whose worktree was removed);
- cuts fresh from `<remote>/<base>` when no branch exists anywhere;
- fast-forwards a clean, stale worktree already at the same path;
- re-cuts a worktree whose branch is gone from the remote and which holds no
  work of its own;
- prints the worktree's path on stdout.

It exits 1 and leaves the directory alone when the worktree has uncommitted
changes or commits that are not on the remote — someone may be editing it by
hand. Say so in a ticket comment and continue from a fresh path only if a
person says so. **A missing worktree is never a reason to stop.**

## By hand

1. From the primary checkout, run `crew sync` (name the route if this ship
   serves more than one). It fetches the remote and fast-forwards the primary
   checkout's base branch, and every worktree branch that tracks a remote,
   doing nothing else to them. It is quiet about a checkout that is not cleanly
   on the base — something else may be mid-edit there; that is expected.
2. If it prints `DO NOT CUT A WORKTREE FROM THIS BASE` and exits non-zero, the
   base has diverged from the remote: **hard stop.** Do not `git worktree
   add`, do not reconcile it yourself; `crew sync` has already flagged the
   ship (`crew status` shows it). Comment on the ticket naming the repository
   and the counts it printed, in the "Resumes automatically when the primary
   checkout's base is level with the remote. No status change needed." form,
   leave the ticket as you found it, and end the run.
3. Otherwise `git worktree add <dir> -b <branch> <remote>/<base>` from the
   primary checkout, or `git worktree add <dir> <branch>` when
   `<remote>/<branch>` already exists (git creates the tracking branch).
4. `cd` into the worktree and do everything else there.

When resuming an existing worktree, run `crew sync` first; if it reports your
branch as diverged (local commits not on the remote *and* the remote has
moved), stop, comment with what it printed, and park the ticket for a person
(`needs_info`, operator as assignee). A branch that is only stale or conflicts
with the base is a different case: merge `<remote>/<base>` into it, per the lane
policy, and push fast-forward.

## Making the worktree runnable

A worktree is a clean checkout, so it lacks exactly the files git ignores —
usually the ones without which nothing runs. Copy the files the Environment
section lists from the primary checkout, then run the **`setup`** hook inside
the worktree. The Environment section's hooks table is the only source of
commands for this repository; a command you invented is wrong even when it
works.

- **`isolate`** — run it, and export what it prints, whenever the ticket
  touches stored state: a schema change, a migration, a destructive backfill.
  A migration against the operator's working data is not something you can
  undo. If the repository declares no `isolate` hook, say so in your progress
  comment and do not invent an isolation scheme.
- **`handoff`** — run it on every worktree, not only isolated ones, and never
  skip it as "not needed for this ticket". Its purpose is to leave the
  operator able to open what you built; discovering they cannot is expensive
  at exactly the moment they are trying to look. Put what it prints — the
  URL, the account, which database it is on — in your progress comment. If
  you seed another database or point the worktree somewhere else mid-ticket,
  run it again there.

## Dev servers and ports

A CLI, a library or a batch pipeline has nothing to boot. If this repository
runs as a live server, **get your ports from the `ports` hook** — `eval` its
output from this worktree. What it prints is this repository's own
convention (one project derives ports from the worktree's directory name;
another prints entirely different variables for a different stack); read this
repository's own configuration for what its hook gives you.

- Anything already listening on ports this worktree considers its own is a
  dead process from an earlier run of this same ticket — kill it.
- **Always stop your own servers before finishing the run.** A stateless
  invocation has no later chance to clean up, and `crew reap` only catches
  servers whose worktree is already gone.
- Put how the operator reaches what you built (URL and login, or a command)
  and which database it is on in your progress comment.

## Tearing down

Do not remove the worktree by hand. When your session ends at a verified
push, the runner removes it — except in a repository with a `handoff` hook,
where it stays because a server you left running serves from it; the runner
records that on the ticket, and QA on another ship cuts its own worktree from
the remote. Never touch any worktree other than the one for the ticket you
are working.
