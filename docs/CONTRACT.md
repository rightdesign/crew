# The contract — what a workspace's choices mean

A crew reads work out of a Tablation project it did not design. To do that it
has to know which column is the status, which value means *approved*, and
whether `p0` beats `p3`. That knowledge is **the contract**.

**A ship connects to several workspaces at once and follows each one's rules.**
So the contract is resolved per route, never held as a constant in the
runner. Two routes on one machine may disagree about every value below
and both be right.

This document is the **default** — what an unmodified Issue Tracker template
means by its own choices. A workspace that has not said otherwise is assumed
to mean exactly this, and needs no configuration at all.

## The default

### Which column plays which part

The tables and columns crew reads, with their default names, shapes and what goes wrong without each, are the [work tracker reference](/work-tracker), generated from the interface definition in `src/tracker-interface.ts` (CREW-3579). An app that implements the interface declares its own names in a mapping and crew reads it through that; an app that declares nothing is read by the default names in that reference. Version 1.2 adds optional roles the platform reads (Repos, Crew membership, ticket description and needs-planning; CREW-3633). Version 1.1 adds an optional questions part (a Questions and an Answers table): an app that maps it lets a seat's park also write the question as a record with proposed answers, and an app at 1.0 still conforms and gets the comment alone (CREW-3588). A `contract:` override in `crew.yaml` is for an app that cannot declare; once the app does declare, the declaration wins and the override is reported as ignored.

Notes on specific columns:

- **work mode** (`work_mode`, on the Projects row): `automatic` (default; missing column or null) means every lane works by status. `manual` (`manualWorkMode`): no lane selects or claims the project's tickets. `hybrid` (`hybridWorkMode`): a lane considers a ticket only when its assignee is a Crew row linked to an Agent and not a hold of this ship; dev/design/QA only, triage works automatic projects alone. A ticket with no project is treated as manual.
- **attachments** is a reference into the workspace's Media Library, holding record ids. Crew never writes it; it reads the field type's target table so the Environment section can name the table and the download recipe (CREW-1558).
- **report type**: `coordinating` marks a coordinating parent (ISSUE-354); `coordinating`, `question` and `investigation` are all exempt from needing a Repo (ISSUE-387), but only `coordinating` rolls up children.
- **epic** is only rendered when the workspace has an `Epics` table (ISSUE-384).
- **comment public reply / author name** (CREW-1811): a reply from a public intake form carries no `team_member_id`, so the digest labels a flagged comment `<author_name or anonymous> (public reporter)` and never resolves it through the roster. A Comments table without the column is read as having no public replies; `crew doctor` reports which case applies.

**Optional columns on Issues** (a table without one has simply not adopted the
feature, and the crew writes around it): `held_by_ship_id` (the ship holding a
ticket), `verified_sha` (the branch head QA verified — written by QA with the
move to `verified`) and `pr_ref` (the pull request a ticket was handed off
under — a number or URL, written by the crew). The last two belong to the
review hand-off (`statuses.reviewing`, see `docs/REPO_SPEC.md`). `branch_url`
and `pr_url` (CREW-3255) are web links to the code under review. `branch_url`
is the forge's page for the pushed branch (`branch.push`, not the local name),
built from the Repos row's `remote` and `forge_host` and written where the
`pushed` event is posted; it is cleared when the sweep deletes the remote
branch after release. `pr_url` is always a full URL: what `hooks.pr` printed
(a number is built into a URL for the repo's forge), or, when a person opened
the pull request, the one crew discovers each cycle — for an open ticket with a
`pushed` event, an empty `pr_url` and a forge crew holds a token for, the open
pull request whose head is the pushed branch, else the newest created after the
ticket's first `pushed` event (so a reused branch name never attaches an old
one); `pr_ref` is filled too when its column exists and is empty, so
`hooks.merged` receives `CREW_PR`. Discovery skips quietly without a token or
on a forge error, and `pr_url` is kept after release as the record of the
review. `crew doctor` notes whether each column exists and which repos have no
forge token. `position`
(a nullable NUMBER, `columns.position`, CREW-1552) is a manual order: within
one effective-priority band a lower position goes first and an unpositioned
ticket goes after any positioned one. It is a tiebreak, never an override — it
beats the severity and epic tiebreakers but can never move a ticket across an
effective-priority band.

`crew_assisted` (a Yes/No, `columns.crewAssisted`, CREW-3258) records that the
crew's building or verifying lane worked the ticket. When a run of a role in
the route's `assistedRoles` (default `[dev, qa]`; `[]` turns it off; see
`crew.example.yaml`) is about to launch on a ticket, the crew sets it true with
one update, skipped when the row already says true. It is never set by any other
role and never set back to false, and a table without the column is not written
to. `crew doctor` reports whether the column is present. The write is separate
from the claim, so a run refused after the claim (a lost hold) does not mark it;
a run that turns out signed out is only detected after launch and has already
marked it.

The run-spend counters (CREW-2580) are optional numbers on Issues:
`agent_runs`, `tokens_in`, `tokens_out`, `cache_read_tokens`,
`cache_write_tokens` (Integer) and `cost_usd` (Float), named in the contract as
`columns.agentRuns`, `columns.tokensIn`, `columns.tokensOut`,
`columns.cacheReadTokens`, `columns.cacheWriteTokens` and `columns.costUsd`.
After every run that reports an Agent Log row, the crew adds that run's own
usage to the ticket the row cites with Tablation's atomic `{ "$op":
"increment" }` write, so two ships never lose an update. A figure the harness
did not report (`cost_usd` on codex and gemini) is left out, never written as
0; a run with no ticket changes nothing; a table without a column is written
around, silently. The write is best effort: a failure warns on the run log and
never fails the run. The same Agent Log row also carries `workItemTable` and
`workItemRecordId` pointing at the ticket's record.

### The order of choice values

```
priority:  p0  p1  p2  p3      (most urgent first)
severity:  s1  s2  s3  s4
```

Nothing about the values themselves conveys this. A workspace using
`high`/`medium`/`low`, or `P1`..`P5`, is equally valid and equally unrankable
until it says which end is urgent.

**This half is usually free.** Tablation's CHOICE options carry a `position`,
so the crew reads the order straight from the field's own definition — reorder
priority in the UI and the crew follows. Only the *meanings* below need
stating.

### What each status means

The status meanings, which values are open and which are resolved, are in the [work tracker reference](/work-tracker#status-meanings).

**`fixed` is open but NOT resolved**, and that is the single most load-bearing
line in this document. `fixed` means an unmerged branch awaiting QA, so a
ticket blocked by one is still genuinely blocked. A contract that called it
resolved would have the crew build on unverified work. No naming convention
conveys that; it has to be stated.

**`verified` resolves a blocker only once it has landed (CREW-1549).** A
blocker at `verified` in the **same repository** as the blocked ticket is still
just an unmerged branch until the release phase squash-merges it, so the
dependent stays `blocked` until the blocker's `merged_at`/`commit_sha` is
stamped or it reaches a closed status. Otherwise the dependent gets built
stacked on the blocker's branch and diverges when the squash lands. A blocker
in a **different** repository keeps the plain rule (`verified` or any closed
status): the dependent cannot stack on a branch in another repo. The release
phase's own `blocked_by` hold keeps the plain rule too, since it merges a batch
oldest-first.

**Parking on a dependency.** When a ticket needs work in another repository,
its lane files that work as its own ticket, adds it to the waiting ticket's
`blocked_by`, comments, and returns the ticket to `accepted` (keeping its
branch and worktree). The poll's sweep parks it at `blocked` and restores it
once every blocker is in a resolved status. QA bounces a hand-off that names
needed work no ticket covers.

**Parking on a shared file (CREW-3387).** Tickets that would change the same
files should not be built at the same time: they conflict one release at a time.
Nothing is configured for this. Every ticket in flight has a **footprint**, the
repo-relative files it is expected to change, kept in the Issues event log so
every ship sees it:

- *Predicted:* before it cuts a worktree, the dev lane reads the ticket and the
  code and runs `crew footprint NNN <path>...`, which records a
  `footprint_declared` event once and answers `PROCEED` or `YIELD`. A ticket is
  not asked again; the lane digest lists the recorded footprints so a resumed run
  does not declare twice.
- *Actual:* every `pushed` event records the paths the branch changes against
  the base (`metadata.paths`, both sides of a rename).
- *In force:* while `in_progress`, the declared paths plus the newest push's
  paths; from `fixed` on, the newest push's paths only. The changelog, the
  version files (`release.changelog`, `release.versionFiles`) and package manager
  lockfiles never count.

A ticket waits when its footprint shares an exact path (no globs, no
directories) with an active ticket of the same repository: `in_progress`,
`fixed`, `qa`, or `verified` and not yet merged. `needs_info`, `blocked`,
closed and released tickets hold nothing, so tickets waiting on one start on the
next poll. The lane that gets `YIELD` sets the ticket back to `accepted`, clears
the assignee and ends the run without a worktree; the poll's sweep then parks it
at `blocked` with a note naming the ticket and files, exactly as for a
dependency, and restores it when nothing holds its files. A parked ticket is not
offered to a lane, so waiting costs one short run per ticket. When several wait on
the same files the oldest is restored first and the others wait on it. `crew
status` lists each waiting ticket, what it waits for and the files.

Only starts are held: a ticket in flight is never stopped because a push grows
into another footprint (right of way after a conflict hand-back, CREW-3386,
handles that). A ticket with no declaration, an empty one, or one from a ship
that cannot declare simply runs.

Several ships agree because the decision is a pure function of the board and the
log. Two ships that pick up overlapping tickets in the same moment both declare
before either sees the other; `crew footprint` re-reads the log after recording,
and of two overlapping tickets that are both newly declared (in progress,
nothing pushed) the later declaration yields, an exact tie going to the lower
ticket number, so exactly one proceeds.

*Mixed versions:* a ship on a crew without this feature neither declares nor
yields, and its pushes carry no paths. Its tickets have no footprint until a
newer ship's push records one, so they are treated as fail-open. Nothing breaks;
the benefit is partial until every ship is upgraded.

`approved` matters for the opposite reason: the runner must know which status
it may **never** set, because that is the one where a person authorises work.

### What each epic status means

Only on a workspace with an `Epics` table. An epic's status is its own CHOICE
field on its own table, so it is named separately from a ticket's.

| role | value | |
| --- | --- | --- |
| planned | `planned` | |
| building | `in_progress` | also what the epic-in-progress ranking tiebreaker reads (ISSUE-385) |
| done | `done` | |
| cancelled | `cancelled` | a person's call — the runner never moves an epic into or out of it |

The status lives in the epic's `status` column, and `epic_id` is what it is
called in the log; both are overridable as `epics.statusColumn` /
`epics.keyColumn`, the values as `epics.statuses`.

**The runner keeps an epic's status in step with its tickets (CREW-1255)**,
every poll, across the whole epic rather than one route's area:

- every ticket closed (`resolved` minus `verified` — verified work has not
  shipped) → `done`;
- any ticket being worked (`building`, `handoff`, `verifying`, `verified`,
  `reviewing`) → `building`, whether the epic said `planned` or had already
  been marked `done`.

An epic with no tickets, a `cancelled` one, one at a status not named here,
and one whose remaining tickets are open but untouched are all left as they
are. See `src/epics.ts`.

### The optional Maps table (CREW-3444)

An epic's requirements document ("Map") is a row of a `Maps` table linked to
the epic. A ticket filed from it cites it ("Map v1 §11"), and the document is
in no repository, so the run's brief carries it: after the ticket banner, a
`Map for <epic>` section. `crew connect` finds the table by name like Epics;
a workspace without it, and a ticket without an epic, get the same brief as
before.

| column | default | meaning |
| --- | --- | --- |
| `maps.epicColumn` | `epic_id` | the epic's row id, matching the ticket's `columns.epic` |
| `maps.titleColumn` | `title` | |
| `maps.contentColumn` | `content` | the document, Markdown |
| `maps.conversationColumn` | `conversation` | the interview record; pointed at, never included |
| `maps.statusColumn` | `status` | |
| `maps.versionColumn` | `version` | the highest active version wins |
| `maps.activeStatus` | `active` | the one status whose document is supplied |

Only the active Map is supplied: an epic with only draft or superseded Maps is
told it has no active Map, and a seat the tracker refuses (403) is told it may
not read it. A document over 20,000 characters is cut to the sections the
ticket cites (headings numbered `## 11.` or `## §11`), an outline, and the
`records_controller_find_one` call that reads the rest. See `src/map-brief.ts`.

### The optional Periscopes table (EPIC-077)

A workspace may have a table named `Periscopes`, found by name the way `Epics`
is and recorded as `resolved.periscopesModelId` by `crew connect`. A workspace
without it simply cannot host periscopes; nothing else changes. One row is one
periscope (a live view of a ticket's worktree). The crew writes these columns,
which are fixed rather than contract-overridable:

| column | type | meaning |
| --- | --- | --- |
| `issue_id` | reference to Issues | the issue the periscope shows |
| `ship_id` | reference to Ships | the ship hosting it |
| `url` | text | where the periscope is reached |
| `host`, `worktree`, `branch` | text | the machine, checkout and branch it serves |
| `state` | choice: `live`, `kept`, `discarded` | `live` is being served; `kept` is retained after its run ended; `discarded` is torn down |
| `isolated` | yes/no | whether it runs against state of its own rather than the shared one |
| `started_at` | date and time | when it first came up |
| `last_activity_at` | date and time | the last time it was used or refreshed |
| `expires_at` | date and time | when a `live` periscope is torn down if left unused |

`crew doctor` prints one `periscopes:` line per route: absent (not a fault), present,
or present with the columns it lacks named, as it does for a missing Comments column.

On Ships, an optional yes/no `host_periscopes` column mirrors the route's
`hostPeriscopes` setting, synced by `crew connect` alongside `host_passengers`.
A Ships table without the column is written as before, with no error.

The ship's control API serves a periscope's lifecycle over `/periscopes`. It
accepts the ship key, a member key, or the workspace's tunnel secret (for its
own workspace only), and `GET /periscopes` also reports `hosting`: per hosting
route, `route`, `workspaceId`, `previewHostSet`, `maxPeriscopes`, `live` and
`repos` (repositories whose `.crew.yaml` declares a `preview` hook). See
[Host Passengers](/host-passengers).

`POST /streams/<run>/messages` with `{ text, author? }` sends a note to a live run
(CREW-3119). Crew records it on the run's Agent Log row as a `user` cycle, writes it to
the harness when the run still reads input (`acceptsInput` in each `crew status --json`
run entry, true only for a Claude run on the host whose final result has not arrived),
and answers `{ cycleId, state, acceptsInput }`, `state` being `delivered` or
`carried_forward`. A run that is unknown or has finished answers 404 and names the
carry-forward path: a note posted to the work item reaches its next run's brief.

`POST /seats/<role>/notes` with `{ text, ticket?, author? }` leaves a note for a seat with no
live run (CREW-3249), for an idle or paused seat. Crew spools it on the ship and the seat's
next run reads it in its brief under "Notes left for this seat", then discards it. With
`ticket` the note waits for a run on that ticket; without, for the role's next run of any
ticket. It answers `{ id, state: "carried_forward", carriedForward: true }`; an unknown role,
empty text or a non-string `ticket` is a 400.

## Overriding it

An org that renames its statuses, adds one, or orders priority differently
supplies its own contract. It belongs **in one place per org**, and it is
tracker data — it describes choices configured there, and only that workspace
knows them.

A route may carry the differences inline in `crew.yaml`, or (once `crew
connect` has resolved a route at all) in the resolved state file's own
`contract` field — see `resolvedPathFor` in config.ts. Anything omitted keeps
the default, so an override states only what actually differs:

```yaml
routes:
  - route: acme/issues
    contract:
      statuses:
        approved: triaged          # this org calls it that
        open: [new, triaged, blocked, doing, waiting, built, checking, done]
        resolved: [done, shipped, wontfix, duplicate]
        deployed: shipped
      priorityOrder: [urgent, high, normal, low]
```

**`statuses.resolved` is discovered, not just authored.** A workspace-added
terminal status (a `closed_escalated`, say) can't be inferred from its name
alone, so `crew connect` reads the Issues table's own status CHOICE options,
compares them against this document's default names, and — on a real
terminal — asks once per value it doesn't recognise whether it means
resolved/terminal. A "yes" folds it into `contract.statuses.resolved` in the
resolved state file; a "no" (or a value nobody has answered about yet) is
left unclassified, same as before this existed, rather than guessed into
`open` or any other role. (`draft` — the epic grill-me flow's holding state
for Issues not yet ready to act on, promoted to `new` or closed as
`closed_wont_fix` — used to be exactly this case; it is now the default
contract's `statuses.draft` role, so it is recognised and never asked about.
It is neither open nor resolved: never polled, and a ticket blocked by a
`draft` one stays blocked.) Re-running `crew connect` only
asks about values it
hasn't asked about before (`reviewedStatuses`, alongside `contract` in the
same file) — it never re-asks, and never overwrites what a hand-authored
override already said about columns, priority order, or anything else.

## Rules

- **Anything absent keeps the default.** An override is a diff, not a
  replacement, so adding a status later does not mean restating the rest.
- **The contract is validated, and every problem is reported at once** rather
  than one run at a time. The checks are the ones a workspace can genuinely
  fail: a role naming a status that is not in `open`; `deployed` missing from
  `resolved`; `parked` and `approved` being the same value (parking would be a
  no-op); duplicate entries in an order.
- **`handoff` appearing in `resolved` is refused outright**, with the reason,
  because that specific mistake makes the crew build on unverified work.
- **Order comes from the tracker where it can.** Prefer letting the CHOICE
  field's own `position` speak, and override the order only when it genuinely
  differs from what the UI shows.
- **The runner holds no workspace's rules as a constant.** Where a default is
  referenced in code it is `DEFAULT_CONTRACT`, and it is a starting point for
  a merge rather than an assumption.

## State kept per route

A few files under `<stateDir>` are scoped to one route (`State.safe(route)`
in state.ts) rather than shared across the whole ship: `.fairness-<route>-*`
(ISSUE-382, starvation), `.release-blocked-<route>`/`.deploy-failed-sha-<route>`
(release bookkeeping), and `.attention-<route>.json` (ISSUE-928) — the
previous cycle's `{ ticketId: [reason, ...] }` set the poll diffs against to
emit a one-shot "needs a person" event only on a NEW (ticket, reason)
transition, never on every cycle a ticket happens to still be waiting.
