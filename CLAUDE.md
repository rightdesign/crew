# CLAUDE.md — crew

`crew` is the standalone device-runner/CLI that operates a configurable autonomous-agent workflow for Tablation-managed repos (synthesis, tablation-js, crew itself, crew-macos, ...) against a shared bug/issue tracker. It replaced the old `scripts/local/dev-loop` bash system that used to live inside the synthesis repo (fully cut over and deleted 2026-08-30 — never suggest `dev-loop.sh` for anything; the entry point is `bin/crew`).

## Runtime: Node, no bash

The bash-era loop is fully retired — **ISSUE-326** (port the loop from bash to Node, PRD Phase 1) is complete. There is no bash implementation left to maintain and none should be reintroduced; treat any old ticket or doc describing shell-script internals (`dev-loop.sh`, `stat -f %m`, `mktemp -t NAME`, `lsof`, bash-3.2 constraints) as historical context for *why* the rewrite happened, not current behavior.

**`docs/CREW_PRD.md` is the live plan; treat `CREWS_PLAN.md` §2–§3 as dead** when reading old tickets — the PRD's own header says it supersedes that section's platform-driven-execution design. The model is a **local device runner that polls**, server **oblivious** — not server-side workflow dispatch.

## Editing prompts/scripts safely

**Never edit a long-running script in place** (truncate + rewrite) while it may be executing. Bash reads a script incrementally by byte offset — an in-flight interpreter resumes at a stale offset in a file whose length just changed, producing a cryptic mid-file syntax error and silently skipping whatever that cycle was doing. Write the new version to a temp file and `mv` it into place — the rename swaps the inode, so a running process keeps reading the old file and finishes cleanly. The loop fires frequently and a session can run 10+ minutes, so "is it running right now" is usually yes; `bash -n` passing afterward proves nothing about a process already mid-file. Same rule applies to anything a scheduler (launchd/cron/systemd) may be executing.

## Prompt sets (forkable lane policy)

`prompts/` holds **multiple named, forkable presets** (`prompts/<name>/`) rather than one flat policy, since crew is meant to serve other organizations' processes, not just this one:

- `prompts/default/` — the original three/four-lane dev/design/QA/triage policy (`common.md` + `lane-<role>.md`).
- `prompts/dev-qa/` — a simpler two-lane example (dev + QA, no design gate), mechanically trimmed from `default`.
- A route's `promptsDir` (`src/config.ts`, `Route.promptsDir`) resolves what it actually loads from: a bare `promptSet: name` resolves under `<crewHome>/prompts/`; a path (`./x` or `~/x`) is expanded relative to the route's own config dir, so a fully custom policy never requires forking this repo.
- `personaDefaultPrompt`, `planAgentRun`, `syncPersonas`, `fetchDivergedPrompt` all read from `route.promptsDir`.

**Known real limit**: `RoleName` (`src/config.ts`) is a hardcoded 4-value union (`dev | design | qa | triage`) threaded through persona sync/planning. A prompt set can restyle any role's prose freely but can't drop a role outright — `crew agents sync` always provisions all four personas and throws if a role's `lane-<role>.md` is missing. `prompts/dev-qa/lane-design.md` works around this with a "do nothing, you shouldn't be staffed" stub. Making the seat set itself policy-defined (so a preset could omit `design`/`triage` entirely) is unscoped, bigger-than-prompt-sets-took work.

## Workflow definition = prompt set + tracker schema, not crew itself

**crew's engine is workflow-agnostic by design.** Ticket statuses, gating fields, and lane-routing rules are never hardcoded into `src/` — they're defined entirely by (a) a prompt set's `common.md`/`lane-<role>.md` prose (see "Prompt sets" above) and (b) the tracker schema (fields, status values, tables) that prompt set assumes exists in whatever workspace it's pointed at. This is deliberate: crew is meant to serve other organizations' processes, not just one hardcoded shape — don't add code in `src/` that special-cases a specific status name or field, and don't treat any one prompt set's process as *the* crew workflow.

**The concrete tracker schema is not part of this repo.** The `default` preset assumes a particular Issues-workspace schema (specific statuses, boolean gate fields, a `blocked_by` reference, a Comments table, etc.). That schema definition — the actual tables/fields/views a workflow like `default` expects to find — belongs in its own content repo: **`tablation-issues`** (planned, not yet created — see "Related sibling repos" below). Don't read this repo's own docs/tickets as the source of truth for that schema; once `tablation-issues` exists, it is.

**Known gap: no "how to author a workflow" doc exists yet.** Defining a new workflow means writing a `prompts/<name>/common.md` + `lane-<role>.md` set (see `prompts/dev-qa/` for the simplest worked example) *and* a tracker schema it assumes (statuses, gate fields, lane-routing signal) — but nothing currently documents that combined shape end-to-end for someone building a third preset from scratch. Worth writing as a `docs/WORKFLOW_AUTHORING.md`-style guide once there's a second real (non-`dev-qa`) example to generalize from.

## The `default` preset (reference implementation, not a universal rule)

`prompts/default/` is the most fully-built example of a crew workflow today — three-plus-one lanes (dev / design / QA / triage), a multi-state ticket lifecycle (new → needs_info/accepted → in_progress → fixed/qa → verified → closed_deployed), plus two human-only gating booleans (`needs_planning`, `needs_review`) and a `blocked_by` reference field computed into a `blocked` status each poll. All of that detail is specific to *this preset* and the schema it assumes — it says nothing about how `prompts/dev-qa/` or a future custom preset must behave. The detailed field/status-level behavior belongs in documentation living beside the preset itself (e.g. `prompts/default/README.md`) once written, not enumerated here in the root doc that every session loads regardless of which preset is active.

If working on the `default` preset specifically: read `prompts/default/common.md` and its `lane-*.md` files directly rather than relying on a paraphrase — they're the actual source of truth and change independently of this file.

## Branch/worktree/commit/merge conventions (across crew-managed repos)

- Each ticket's work happens in its own git worktree (`../<repo>-issue-<number>`) on its own `issue-<number>` branch, cut from `main`. All commits for that ticket happen there and nowhere else.
- A building lane (or a pair session) commits on its own ticket branch itself — "normal commits, no special permission needed" — but **never commits on `main` or in the primary checkout**. The primary checkout is what the release phase owns; a stray commit or a branch checked out there blocks every subsequent automated release until someone notices.
- Interactive/pair sessions get their own worktree exactly like lane agents — branch into it *before* the first commit, directory name matching the `<repo>-issue-NNN` convention or the CLI's drop/cleanup commands can't retire it.
- **No agent merges or deploys anything.** A building lane finishes and stops at whatever status its prompt set calls "done, awaiting QA"; QA tests in that same worktree and flips it to whatever status the prompt set treats as "approved for release" (`verified`, under `default`). That approved-for-release status is the release phase's trigger — it squash-merges every such branch onto `main` under a release lock, bumps the version once for the whole batch, writes one changelog section, drops each merged worktree, deploys, then stamps shipped tickets with a "deployed" status. A branch that no longer merges cleanly is bounced back to its building lane with a comment.
- A ticket branch's commits carry `Bump: patch|minor` (never `major` — that's the operator's) and one or more `Changelog: <line>` trailers with the ticket id — these are the *only* input the release phase has for version/changelog; never bump a version or edit a changelog file directly on a ticket branch.
- Landing a commit on `main` is what ships it — no session runs a deploy script by hand, in or out of the loop; doing so risks racing an in-flight automatic release (a hand run doesn't take the release lock).

Lanes (however many a given prompt set defines) are polled independently but a given host runs them sequentially under one lock, since they share a primary checkout for the merge step.

## Comment discipline (generic, applies under any prompt set)

Post comments on a ticket as work progresses — after scoping an approach, after a non-obvious finding, at completion — not just status flips at start/end. Each cycle must also check comments on tickets *already assigned* to the agent (any of that preset's "still open, still mine" status values — e.g. `in_progress`/`fixed`/`needs_info` under `default`), not just newly-pickable ones — this is how a human's answer to a blocked-on-input ticket, or a mid-flight direction change, actually gets seen and acted on rather than a ticket sitting stuck. A single agent run is a checkpoint, not a whole ticket: an own in-progress ticket with no new comment still means *resume*, not *leave alone* — only a terminal-for-this-lane status, or reassignment away from the agent, should park work. Use a `kind: "event"` comment for the crew's own audit trail so it doesn't wake itself on its own notes.

## Depersonalization

No script, lib, or prompt names its operator directly — **names come from data, roles are parenthetical qualifiers.** Each agent gets a `## Your crew` roster built at run time from the tracker's shared Crew table (Name + Email fields). A helper renders `"Trevor (Dev)"` but plain `"QA agent"` when the row's name already carries the role. The ship owner's role-agnostic term is **Operator**, not "Captain." Config, not prose, is the place for machine-specific ids/paths/keys — those don't travel with the repo.

## Workspace Agents plan (not yet built)

Design doc `docs/WORKSPACE_AGENTS_PLAN.md` (agreed 2026-08-25): two new workspace-level system tables on the platform side (same auto-provisioned pattern as the platform's Media Library) to stop persona prompts and run history from leaking into the tracker as project-scoped data:

- **Agents** — persona/prompt config, seeded by a crew subcommand but provisioning enacted by a workspace admin only (never unattended). Admin can edit the seeded prompt afterward; uses the platform's existing record-history feature for change tracking. Crew's own Crew table would gain a REFERENCE into Agents instead of embedding prompt/config.
- **Agent Log** (parent) / **Agent Log Cycles** (child) — one Log row per task run, one Cycle row per iteration with per-cycle thinking output. Read-only for everyone including workspace admins; writes only via a dedicated system path.
- **Drift model**: crew is the source of record for a persona's *default* prompt, but a workspace admin can edit it locally; crew caches the Agents row's `updatedAt` and never auto-overwrites a workspace copy newer than its last-known value — flags divergence instead of clobbering.

When picked up: migrate existing embedded Crew-table prompt/config data into Agents rows first.

## Related sibling repos

- **tablation-issues** (planned, not yet created) — will codify the Issues workspace that the `default` prompt set assumes: table/field/view definitions, installed into the platform's template library via `tablation-js`'s `tablation` CLI (`install` command). This is where the concrete tracker schema referenced under "Workflow definition" above belongs, once it exists — not in this repo. Deliberate isolation: crew's engine and the `synthesis` platform itself stay ignorant of any one workspace's concrete schema (see synthesis's own CLAUDE.md — platform code never special-cases a specific workspace).
- **crew-macos** — its own repo and its own tracker Project (not part of Crew's project). See that repo's own CLAUDE.md.
- **jira-tablation-sync** — a separate one-way Jira→Tablation mirror service (own repo) that feeds day-job tickets into a *different* tracker workspace (Paradium) for the crew to work — distinct ownership split (Jira owns title/description/`jira_*` columns; local/crew columns like `status`/`assignee_id`/`blocked_by` are written once at create and never overwritten by sync).
