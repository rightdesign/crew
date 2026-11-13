---
name: Adopt Repository Contract
description: How the dev seat writes a repository's `.crew.yaml` from its checkout (hooks, release mode) and how QA verifies it by running the hooks and `crew repos check --strict`. Fetch when a ticket asks the crew to write or adopt a repository's contract.
---
# Adopting a repository: writing its `.crew.yaml`

A repository added from the app arrives with a setup ticket asking the crew to
write its contract: a `.crew.yaml` at the checkout root. The file is the only
thing that knows how this repository tests, builds and releases, so write it
from what the checkout shows, never from habit. The repo spec that ships with crew is the field
reference (`crew repos check` prints what it parsed); `crew repos prompt` is the
procedure; this skill is what a ticket adds to it.

## Dev: write the file

The procedure for working out and testing the file is a standalone prompt that
ships with crew, shared with people who set a repository up by hand. Run
`crew repos prompt` and follow it. Where it says "me", the ticket's operator
stands in: a question it tells you to ask goes through the lane's person-stop
rule (see "Nothing to detect"), not into a chat.

What the ticket adds to that procedure:

1. **The output is committed, not left for review.** The prompt ends with an
   uncommitted file; here you commit only `.crew.yaml` (and anything the ticket
   names) on the ticket's branch and hand off as usual. Never write hooks to a
   route (`--write route`): the contract belongs in the repository.
2. **Hook suggestions are a draft.** `crew repos hooks --json` (and `--agent`
   where the harness allows it) may help as a baseline. A `reason` such as
   `not_signed_in` or `unsupported_harness` is not a failure of the ticket:
   carry on from the checkout and say so. Where a suggestion and the repository's
   CI disagree, CI wins.
3. **A hook that fails because the repository itself is broken** is not yours to
   fix on this ticket: record it in the file's comment and file it as its own
   ticket. A hook you could not run (a tool missing on this machine) is stated
   in your comment, not assumed to work.
4. **Quote the `crew repos check --strict` summary** (exit 0) in your hand-off.

## Nothing to detect

If the checkout has no manifest, no CI and no README guidance, so that the test
or build command would be a guess, do not write one. Stop per the lane's
person-stop rule: `needs_info`, assigned to the operator, with the **specific**
question ("What command runs this repository's tests?", "Does a push to main
deploy it, and how do I see what is live?"). A partial file is fine only when
the missing part is optional.

## QA: verify the file

1. Cut the branch's worktree and run `crew repos check --strict` on it: exit 0.
2. Run the hooks the file declares, verbatim: `setup`, then `test` and `build`.
   Where the repository declares a `sandbox:` section, run them in the sandbox
   when the ship supports it. A hook that was only syntax-checked has not been verified.
3. Confirm the choices match the repository: the `release.mode` against the
   workflows actually present, a `released` hook for any `ci_*` mode, no
   `deploy` hook alongside `ci_auto`, no `sandbox:` section with nothing in it.
4. Bounce with the failing hook's output quoted. Do not edit the file yourself.
