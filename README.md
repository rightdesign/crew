# crew

A standing team of headless agents that picks work off a
[Tablation](https://tablation.com) board, does it on a machine you control,
and reports back on the board.

Each **seat** is a row in the tracker's Crew table that happens to be a robot,
with a brief (`prompts/`) and a slice of the queue. A seat is named in that
table and answers to that name — call the dev seat "Trevor" and the crew will
call it Trevor, in the queue digest and in the comments they write on tickets. Everything the crew knows
about a run — what to build, what is blocked, what has shipped — is table
data, and every step it takes is visible as a status change or a comment on
the ticket. There is no hidden state and no queue but the board.

Every agent is handed a roster at the top of its prompt: who else is aboard,
what each of them is called, and which rows are **holds** — the people using
this ship, and the interactive sessions they work through. A ticket assigned
to a hold is off limits to every seat, whatever its status, which is how a
person takes something over without racing the crew for it.

Today's crew has four seats:

| Seat | Owns | Brief |
| --- | --- | --- |
| **dev** | approved tickets that don't need design work | `prompts/lane-dev.md` |
| **design** | approved tickets flagged *Needs design* | `prompts/lane-design.md` |
| **qa** | everything at `fixed` or `qa`, whoever built it | `prompts/lane-qa.md` |
| **triage** | tickets at `new` | `prompts/triage-prompt.md` |

One role runs per cycle, whichever holds the most urgent actionable ticket
(`lib/priority.jq` decides, and the same module sorts the digest the agent is
handed, so the two can never disagree). QA outranks the building roles
whenever it has anything to check.

Merging and deploying are **not** an agent's job. After the agent phase, a
release phase in plain shell squash-merges every QA-verified branch, bumps the
version, writes the changelog and runs the project's deploy hook. A headless
session is never handed permission to push to production.

## Install

```sh
git clone <this repo> crew
cd crew
cp crew.config.example.sh crew.config.sh
$EDITOR crew.config.sh          # project dir, tracker ids, crew member rows, hooks
bin/crew doctor          # read-only preflight — run this before arming anything
```

`doctor` checks the config against reality: the project checkout, this repo's
own files, the tools on PATH, the agent binary, the three project hooks, and
whether the tracker answers with an open-ticket list. Nothing writes, wakes an
agent or deploys until `CREW_ENABLED=true` in `crew.config.sh`.

Then put it on a timer:

```sh
$EDITOR launchd/com.tablation.crew.plist    # paths are placeholders
cp launchd/com.tablation.crew.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.tablation.crew.plist
```

Each fire is a few curl/jq calls against the tracker; a full agent session only
starts when that cheap check finds something worth waking for.

## Commands

```
bin/crew                 poll once, run the winning role if there is work
bin/crew doctor          read-only preflight (safe at any time)
bin/crew run [role]      force one agent session now
bin/crew status          paused/running state, unreleased commits
bin/crew pause [role]    pause everything, or just one role's poll
bin/crew resume [role]
bin/crew merge           merge verified branches now
bin/crew deploy          force the release check now
bin/crew ports           which checkout owns which ports, and what's up
bin/crew reap            kill dev servers left by removed worktrees
bin/crew drop NNN        remove a merged ticket's worktree and branch
bin/crew log -f          tail the log
bin/crew-triage             one triage pass (its own launchd timer)
```

## What lives where

```
bin/          the two entry points: the dev loop and the triage agent
lib/          jq programs — ticket ordering, and the queue digest each role reads
prompts/      the shared policy, plus one brief per role
launchd/      timer templates (edit the paths before installing)
crew.config.sh   this machine and this project. Gitignored; never committed.
.state/       locks, poll watermark, rendered digests. Gitignored.
```

The scripts carry no ids, no absolute paths, no project commands and no
device names. If a change would put your repo's — or your machine's — name
inside `bin/`, it belongs in `crew.config.sh` instead. The `crew_hook_*`
functions at the bottom of that file are the seam:

| hook | required | what it is for |
| --- | --- | --- |
| `crew_hook_test` | yes | run the project's suite before a release |
| `crew_hook_build` | yes | build it |
| `crew_hook_deploy` | yes | ship it |
| `crew_hook_notify` | no | show release state somewhere — a widget, a push, a webhook |

`crew_hook_notify` is handed a level (`ok` / `warn` / `fail`), a headline and a
detail line, and decides everything else. The crew has no icons, colours or
target devices in it; define no hook and release state simply goes to the log.

## Status

**Not yet portable, and not yet live.** This repo is a working copy of a crew
that currently runs from `synthesis/scripts/local/dev-loop`, extracted so that
changes to it can go on a branch and be reviewed like any other code
(ISSUE-321). Two things are still outstanding:

- The **prompts** are written for one repo, one workspace and one operator —
  paths, shell commands and names are baked into the prose. Generalizing them
  into hooks is ISSUE-293, and is a prerequisite for anyone else using this.
- The **cutover** has not happened; see `docs/MIGRATION.md`.
