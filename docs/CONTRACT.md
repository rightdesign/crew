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

| part | column | on |
| --- | --- | --- |
| key | `issue_id` | Issues |
| title | `title` | |
| status | `status` | |
| assignee | `assignee_id` | |
| priority | `priority` | |
| severity | `severity` | |
| slice (the area) | `project_id` | |
| repo | `repo_id` | |
| parent | `parent_id` | |
| blocked by | `blocked_by` | |
| updated at | `updated_at` | |
| needs design | `needs_design` | |
| report type | `report_type`, with `coordinating` marking a coordinating parent (ISSUE-354); `coordinating`, `question` and `investigation` are all exempt from needing a Repo (ISSUE-387), but only `coordinating` rolls up children |
| epic | `epic_id` | only rendered when the workspace has an `Epics` table (ISSUE-384) |
| comment parent | `ticket_id` | Comments |
| comment body / author | `body` / `team_member_id` | |
| comment kind | `kind`, with `event` meaning the runner's own audit trail | |
| crew name / ship | `name` / `ship_id` | Crew |

**Optional columns on Issues** (a table without one has simply not adopted the
feature, and the crew writes around it): `held_by_ship_id` (the ship holding a
ticket), `verified_sha` (the branch head QA verified — written by QA with the
move to `verified`) and `pr_ref` (the pull request a ticket was handed off
under — a number or URL, written by the crew). The last two belong to the
review hand-off (`statuses.reviewing`, see `docs/REPO_SPEC.md`).

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

| role | value | |
| --- | --- | --- |
| open | `new` `accepted` `blocked` `in_progress` `needs_info` `fixed` `qa` `verified` | everything a poll considers live |
| resolved | `verified` `closed_deployed` `closed_wont_fix` `closed_duplicate` `closed_completed` `closed_cant_reproduce` | a blocker stops counting only at these. `closed_completed` is done-but-not-deployed (investigation-report-shaped tickets with no build to ship); `closed_cant_reproduce` is closed as written, unreproducible |
| approved | `accepted` | **only a human sets this.** The runner never does |
| parked | `blocked` | the sub-state of approved the runner parks into and out of |
| building | `in_progress` | |
| handoff | `fixed` | built, not yet checked |
| verifying | `qa` | |
| verified | `verified` | |
| deployed | `closed_deployed` | |
| needs a human | `needs_info` | the runner surfaces these, never moves them |

**`fixed` is open but NOT resolved**, and that is the single most load-bearing
line in this document. `fixed` means an unmerged branch awaiting QA, so a
ticket blocked by one is still genuinely blocked. A contract that called it
resolved would have the crew build on unverified work. No naming convention
conveys that; it has to be stated.

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
