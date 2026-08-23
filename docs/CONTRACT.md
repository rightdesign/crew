# The contract — what a workspace's choices mean

A crew reads work out of a Tablation project it did not design. To do that it
has to know which column is the status, which value means *approved*, and
whether `p0` beats `p3`. That knowledge is **the contract**.

**A ship connects to several workspaces at once and follows each one's rules.**
So the contract is resolved per connection, never held as a constant in the
runner. Two connections on one machine may disagree about every value below
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
| comment parent | `ticket_id` | Comments |
| comment body / author | `body` / `team_member_id` | |
| comment kind | `kind`, with `event` meaning the runner's own audit trail | |
| crew name / ship | `name` / `ship_id` | Crew |

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
| resolved | `verified` `closed_deployed` `closed_wont_fix` `closed_duplicate` | a blocker stops counting only at these |
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

## Overriding it

An org that renames its statuses, adds one, or orders priority differently
supplies its own contract. It belongs **in one place per org**, and it is
tracker data — it describes choices configured there, and only that workspace
knows them.

Until `crew connect` (ISSUE-285) reads it from the workspace, a connection may
carry the differences inline in `crew.yaml`. Anything omitted keeps the
default, so an override states only what actually differs:

```yaml
connections:
  - name: acme
    workspace: acme
    contract:
      statuses:
        approved: triaged          # this org calls it that
        open: [new, triaged, blocked, doing, waiting, built, checking, done]
        resolved: [done, shipped, wontfix, duplicate]
        deployed: shipped
      priorityOrder: [urgent, high, normal, low]
```

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
