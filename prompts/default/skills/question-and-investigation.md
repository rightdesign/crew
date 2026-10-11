---
name: Question and Investigation Tickets
description: The procedure for a ticket whose report_type is question or investigation — tickets that ask for an answer, not a fix, and end with the operator at needs_info rather than at fixed. Fetch when the ticket you picked up has either report_type.
---
# Question and Investigation tickets

These two `report_type` values ask for an answer, not a fix. Neither ever
reaches `fixed` or QA; both end with the operator at `needs_info`, for a
decision only they can make. Where this conflicts with the build steps in the
shared policy, this wins.

## `question` — discussion or research

No worktree and no code changes; only an answer.

1. Set `status` to `in_progress` and `assignee_id` to yourself, and post a
   short comment on what you are looking into.
2. Answer it. Read whatever it needs — code, docs, tracker history — directly
   from the primary checkout; that is fine here because you only ever read
   it. If answering genuinely requires running or changing code, the ticket
   has outgrown a Question: say so in your comment and stop rather than doing
   investigation-shaped work under a question's label.
3. Post the answer as its own comment, citing the files, lines or tickets it
   rests on, the way a closing comment cites what changed.
4. Set `status` to `needs_info`, `needs_planning` to true, and `assignee_id`
   to the operator's Crew row (see the roster). This is the designed ending
   for every Question — "answered, awaiting a person to decide what's next" —
   not a fallback for one that went wrong.

## `investigation` — a feasibility assessment

May genuinely need code to answer honestly: a prototype, a spike, a proof of
concept.

1. Follow the shared policy's Steps 3.1–3.4 as written: worktree, hooks as
   applicable, claim, opening comment.
2. Prototype only as much as the question needs. This code is evidence, not a
   candidate fix: it is never taken to `fixed`, this ticket never reaches QA,
   and the full-suite-clean gate is not the bar — run whatever slice of the
   suite is useful evidence. Still commit your work on the branch, so the
   operator can read the diff behind your conclusion.
3. Post your findings as a comment: what you tried, what you found, and a
   concrete assessment — worth doing, not worth it, or worth doing
   differently — rather than a hedge. If the answer is "yes, but as real
   work", name the follow-on ticket(s) and file them yourself (the
   `Filing a Ticket` skill) rather than folding the implementation into this
   ticket.
4. Set `status` to `needs_info`, `needs_planning` to true, and `assignee_id`
   to the operator's Crew row, as for a Question. Leave the worktree and
   branch in place — they are the evidence. They stay until the operator
   closes the ticket; the ordinary worktree sweep cleans up from there.

## Both

- `report_type` is not yours to change, however clearly mis-typed a ticket
  looks — say so in a comment.
- The shared policy's "skip a large or ambiguous feature" rule does not apply
  to an `investigation` for being open-ended: the scoping conversation is
  exactly what an Investigation already is.
