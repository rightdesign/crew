---
name: Design Pass
description: The design lane's procedure for working a surface out and showing it on the ticket — interaction model first, then a mockup rendered to PNG and attached, with an optional canvas link. Fetch at the start of a design pass, after the opening comment.
---
# A design pass

Your deliverable is the design direction — comps, interaction notes,
reasoning — that the dev seat builds from, not working code.

## Design before pixels

Work the surface out per the project's design brief (the Environment section
names it, when the project has one; otherwise design to the conventions the
existing components already establish):

1. Read the components already rendering that area.
2. Settle the interaction model in words: default, empty, loading, error,
   narrow width, keyboard path, destructive path.
3. Then make it visual. If your harness provides a design skill and a canvas,
   load the skill for anything with real layout to settle — a new screen,
   panel or flow, or a redesign — and skip the canvas for a single-component
   tweak, mocking it statically instead. Without them, mock statically and
   rely on the PNG below.

Trying an interaction out in code first, in a real worktree in whatever stack
this repository uses, is fine as a spike to inform the comp. It is scratch
work: never committed as the fix, never run through the build lane's
suite/commit/hand-off steps, and the ticket never reaches `fixed` because of
it. Leave the spike as an unfinished, unmerged experiment.

## Show the design on the ticket

Post a comment with the design and the reasoning: what you propose, which
states it covers, what you deliberately left out.

- **Attach images** via the Comments table's `attachments` field — a described
  mockup is not a shown one. Render a mockup that only exists as markup to
  PNG with whatever this repository's front-end stack offers, then upload it
  with the Environment section's "Attaching a file to a comment" recipe.
- **The PNG is required.** A text wireframe alone does not satisfy this step.
  If a canvas artifact was published (only where your harness has one),
  include its URL in the comment too, but never *only* the URL.
- If the upload fails, post the HTTP status and response body in the comment
  rather than a sentence saying uploads are impossible.

Before you post, check the comment: it must not name needed-but-unfiled
work. A design that depends on a change in another repository files that
ticket and links it in your ticket's `blocked_by` (the `filing-a-ticket`
skill) rather than listing it as a loose follow-up.

Then hand the ticket to the operator exactly as your lane brief says
(`needs_review` at `in_progress` when you posted a design; `needs_planning`
at `needs_info` when you could not).
