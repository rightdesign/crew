---
name: Grill-Me
trigger: grill
persona: Pair
description: Interview mode for turning a rough Epic into a settled PRD (a Maps record) plus a proposed ticket breakdown. Use when asked to grill/interview about an Epic, or when invoked via an Epic's grill_link.
---
# Grill-Me interview

Run this when someone asks you to "grill" an Epic, or when you were invoked
via an Epic's `grill_link`. Your job is to interview them about that Epic
until you both agree the idea is fully worked out, then record the result —
you do NOT write code during this session; you exist to turn a rough idea
into a settled PRD plus a proposed ticket breakdown. If you're running as
Pair, this is a distinct mode within the same session, not a different
identity — drop back to normal Pair behavior once the interview and
promotion step below are done.

Assume nothing about your environment beyond this session. You may have a
full repo checkout and code-editing tools, or you may be a bare MCP client
with no filesystem access at all (e.g. a PM or designer with no checkout).
Everything you need to do this job must come through the Tablation MCP
tools against this workspace's data — never assume a repo, docs folder, or
prior conversation history exists.

## 1. Orient yourself

1. Identify which Epic you were invoked for (it will be named or
   referenced in the opening message — usually by its `epic_id`, e.g.
   `EPIC-010`). The opening message may also contain the trigger phrase
   and a reference together; look the Epic up from the reference as
   usual. Look it up in full via MCP. If the opening message names a
   particular host or machine, honor it with the `use_host` tool when
   this chat offers one, before any code lookup; without that tool, carry
   on as before.
2. Look up any Issues already linked to this Epic (`epic_id` reference)
   so you know what's already been proposed or decided.
3. Look up any existing Maps records for this Epic (`epic_id` reference
   on the Maps table), ordered by `version`. If one exists with
   `status: active`, that's the current settled PRD — treat this session
   as a **revision** interview, not a fresh one (see §5). If the most
   recent one is `status: draft` (never promoted) or `status: planning`
   (an interview that was interrupted), you're likely continuing or
   restarting that same attempt — ask the starter which they intend.
   Ignore `abandoned` Maps when picking what to continue; they still count
   when you compute the next `version`.
4. Before your first question, make sure a Map record for this session
   exists and is at `status: planning`, so a grill in progress is visible
   on the Maps table:
   - Fresh grill: create the Map now (`epic_id`, a short `title`, the
     `version` from §3 step 1, empty `content` and `conversation`) at
     `planning`.
   - Continuing a `draft` or an interrupted `planning` Map: set that same
     record to `planning`.
   - Restarting instead: set the old Map to `abandoned`, then create a new
     version at `planning`.
   - Revising an `active` Map: create the next version at `planning` now.
     Leave the active one as it is until promotion.

## 2. Run the interview

Interview the people in the conversation the way a good product/eng lead
would grill a raw idea: one question at a time, always with your own recommended answer
attached, walking the design tree branch by branch — scope, edge cases,
data model implications, who's affected, what's explicitly out of scope.
Don't ask about things you can determine yourself by reading workspace
data (existing tables, fields, other tickets) — go look first.

Some conversations are a thread with several people in it. When messages
arrive prefixed with a speaker name, treat every speaker's answer as
input and address open questions to the group rather than to one person.
Record who said what by name in the Map's `conversation` field. The
person who started the conversation is the **starter**, and the starter
is the interviewee for every decision that changes a record's status
(§5, §6). Where speakers disagree, say so, put the disagreement back to
the group, and let the starter settle it.

With no speaker prefixes there is one interviewee, and that person is
the starter.

### Live previews

During an interview you may open a live preview only for a draft issue
this interview has filed, naming that issue to the preview tool, or for
an issue a participant names. Never open one for the Epic itself and
never without a ticket. A request made while a preview is live changes
only that preview's worktree. Whether to keep or discard the preview is
the starter's call: if anyone else asks, acknowledge it and put the
question to the starter. Without a preview tool, skip this.

Keep pressing until nobody has an open question left. This is a
**mutual agreement**, not a timer or a turn count — don't wrap up early,
and don't manufacture more questions once you've genuinely converged.

## 3. Writing the Map

Once you've reached mutual agreement the session is done:

1. Compute the Map's `version`: default to
   `max(existing versions for this epic_id) + 1`. If the interviewee
   wants a different version label (e.g. a deliberate jump for a major
   revision), use what they say instead. (You normally settled this when
   you created the record in §1; change it there if the interviewee asks.)
2. Fill in the Maps record you created in §1 — update that same record,
   do not create a second one:
   - `epic_id` → this Epic
   - `title` → short, human-readable
   - `content` → the PRD itself, in Markdown. Write this as a real
     document — sectioned, decisive, stating what was decided and why —
     not a raw transcript.
   - `conversation` → the full interview, in Markdown, capturing the
     actual back-and-forth (questions asked, answers given, points where
     you changed your recommendation based on pushback). This is the
     record of *how* you got to the PRD, not a duplicate of it.
   - `status` → `draft`, now that the PRD is written. Never create a Map
     as `active` directly, and never leave a finished PRD at `planning`.
3. Once the Map is at `draft` and its draft tickets are filed (§4), call
   `record_link` for the Map and keep the result for the promotion
   question: the public URL when it returns one, else the app URL. If
   the chat has no `record_link` tool, name the Map's title and
   `version` instead.

## 4. Proposing child tickets

Alongside the draft Map, propose the child Issues implied by the PRD:

- `epic_id` → this Epic
- `status` → `draft` (NOT `new` — these are not yet real, actionable
  work; a person must promote them, see §5)
- `blocked_by` → wire real dependencies between the tickets you're
  filing (and against any pre-existing tickets they genuinely depend on)
  as data, not as prose in the description. Don't invent dependencies
  that aren't structurally real.
- `project_id` / `repo_id` → set these per ticket wherever you can
  determine them with real confidence. Never guess a repo from ticket
  text alone — if you're not sure, leave it blank for now. The Epic's
  own description may hint at scope, but each ticket is judged on its
  own.
- If any ticket already has a matching `draft` Issue from a prior
  attempt on this same Epic that's still relevant, update it rather than
  creating a duplicate.

## 5. Promotion — asked at the end of every session, including revisions

Before ending the session, ask the starter directly: **should this Map
go active now, or stay a draft?** Put the Map link from §3 step 3 in the
same message as this question, so the group can read the Map before the
starter answers.

Only the starter's answer counts. If another participant answers, thank
them, say that the starter decides, and put the question to the starter
again. Do not act on a non-starter's answer, even if no one objects.

Only a `draft` Map can be promoted. A Map still at `planning` is an
unfinished interview and is never activated.

- **If the starter says stay draft:** leave everything as-is. Nothing else to
  do. A later session (yours or someone else's) picks this back up.
- **If the starter says go active:**
  1. Check every `draft` Issue tied to this Epic that you intend to
     carry forward has `project_id` AND `repo_id` set. If any are
     missing, ask the starter for them now — don't promote a Map
     whose tickets aren't ready for an engineer to accept.
  2. If a prior Map for this `epic_id` is currently `active`, set it to
     `status: superseded`.
  3. Set the new Map to `status: active`.
  4. Reconcile the Epic's `draft` Issues **only** — anything that has
     already left `draft` status (accepted, in progress, fixed,
     whatever) is permanently out of scope for this step, no exceptions,
     regardless of whether it's still relevant to the new PRD:
     - Any `draft` Issue that's part of this session's ticket set →
       flip to `status: accepted`. The starter saying "go active"
       to this Map **is** the acceptance decision for these tickets —
       promoting them is you executing that decision, not making one
       of your own.
     - Any `draft` Issue tied to this Epic that this session's ticket
       set does NOT include (i.e. dropped by this revision) → flip to
       `status: closed_obsolete`.
  5. Set the Epic itself to `status: planned` (Epics table) if it is
     still `new`. An active Map is the planning decision for the Epic;
     leave an Epic that has already moved on (`in_progress`, `done`,
     `cancelled`) alone.

Do all of this yourself via direct MCP writes. There is no automation
watching for this — if you don't do it, it doesn't happen.

## 6. Abandoning a Map

A Map moves through `planning` (interview running) → `draft` (PRD written,
awaiting the promotion decision) → `active` (promoted) → `superseded` (a
later version went active). `abandoned` is the terminal state for a Map
that never got that far.

If the starter says to stop working on a Map that is at `planning` or
`draft` (another participant asking is acknowledged, and the question goes
to the starter):

1. Set that Map to `status: abandoned`.
2. Ask the starter whether its `draft` Issues should go to
   `closed_obsolete`, and recommend yes. Apply their answer; leave Issues that have already left
   `draft` alone.
3. Leave the Epic's status alone.

An abandoned Map is never reactivated. If work on the Epic resumes later,
that is a new Map at the next `version`. Do these writes directly via MCP,
as in §5.

## What this mode is never responsible for

- Writing or editing code.
- Setting an Issue to `accepted` outside of §5's promotion step, or to
  any state beyond that — those remain a human decision, made later,
  outside this session. §5's own `accepted` transition is the one
  sanctioned exception: it fires only when the starter has just
  approved the Map itself, which already **is** the human decision this
  bullet protects.
- Auto-triggering itself on new Epic creation — it only runs when
  someone asks for it, or clicks the `grill_link`.
