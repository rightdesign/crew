---
name: Sandbox Setup
description: How a lane agent prepares and hands off from a sandboxed run — the checkout is already cut, then the setup, ports and handoff hooks and the push. Fetch where the brief names the Worktree Setup skill and your environment section says you are in a sandbox.
---
# Setting up inside a sandbox

A sandboxed run starts in a fresh clone on a fresh branch. Your working
directory is that clone. There is no primary checkout, no other worktree and no
`crew` command to cut one: skip every step of the lane policy that cuts a
worktree, copies files across from a main checkout, or runs `crew sync` or
`crew worktree`. The Environment section names the checkout's path.

## Branch

The clone starts on a throwaway branch. Create the ticket's branch from it —
the digest's `branch` column, verbatim — with `git checkout -b <branch>`, and
commit there. Never commit on the throwaway branch.

## Making it runnable

Run the **`setup`** hook from the checkout, verbatim. Nothing installs from a
network at run time: the toolchains and packages are already in the image, and
a download that is not is blocked. If setup needs something the image lacks,
that is the repository's `sandbox:` declaration to fix, not yours: say so on
the ticket and stop.

- **Services.** A service the tests need (a database, a queue) is a process the
  `setup` hook starts inside this sandbox. The sandbox has no container engine:
  `docker` and `podman` exit at once naming this pattern. Use the ports the
  **`ports`** hook prints and export what the **`isolate`** hook prints; both
  are the same hooks a host run uses.
- **`isolate`** — run it, and export what it prints, whenever the ticket touches
  stored state. The sandbox's own services are already private to this run,
  but the hook is where the repository says which settings point at them.
- **`handoff`** — a preview server cannot be reached from outside a sandbox, so
  there is nothing to leave running. Skip it unless the repository's own
  instructions say otherwise, and say in your progress comment that you did.

## Running the suite

Run the **`test`** and **`build`** hooks in the foreground, as the lane policy
says. Stop every process `setup` started before you finish; the sandbox is
deleted when the run ends, so nothing outlives it, but a service still writing
when the push happens makes the result harder to judge.

## Handing off

Commit on the ticket's branch and push it as a plain fast-forward to `origin`,
exactly as the lane policy says: `git push --set-upstream origin <branch>`.
Push credentials are already in place. The sandbox is deleted at the end of the
run, so **anything not pushed is gone**; there is no worktree for QA to pick up
and QA cuts its own from the remote branch you pushed. Put which hooks you ran,
and their results, in your progress comment.
