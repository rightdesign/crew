# crew

A standing team of headless agents that picks work off a
[Tablation](https://tablation.com) board, does it on a machine you control,
and reports back on the board.

Each **seat** is a row in the board's Crew table that happens to be a robot,
with a brief (`prompts/<promptSet>/`, see "Prompt sets" below) and a slice
of the queue. A seat is named in that
table and answers to that name — call the dev seat "Trevor" and the crew will
call it Trevor, in the queue digest and in the comments it writes on tickets.
Everything the crew knows about a run — what to build, what is blocked, what
has shipped — is table data, and every step it takes is visible as a status
change or a comment on the ticket. There is no hidden state and no queue but
the board.

Every agent is handed a roster at the top of its prompt: who else is aboard,
what each of them is called, and which rows are **holds** — the people using
this ship, and the interactive sessions they work through. A ticket assigned
to a hold is off limits to every seat, whatever its status, which is how a
person takes something over without racing the crew for it.

Today's crew has four seats, described below under the `default` prompt
set (the three-lane dev/design/QA policy this repo ships with — see
"Prompt sets" below for others, and for writing your own):

| Seat | Owns | Brief |
| --- | --- | --- |
| **dev** | approved tickets that don't need design work | `prompts/default/lane-dev.md` |
| **design** | approved tickets flagged *Needs design* | `prompts/default/lane-design.md` |
| **qa** | everything at `fixed` or `qa`, whoever built it | `prompts/default/lane-qa.md` |
| **triage** | tickets assigned to the triage seat | `prompts/default/lane-triage.md` |

One role runs per cycle, whichever holds the most urgent actionable ticket
(`src/priority.ts` decides, and the same module sorts the digest that agent is
handed, so the two can never disagree). QA outranks the building roles whenever
it has anything to check. If the winning role turns out to have nothing it can
actually do, the cycle falls through to the runner-up rather than idling.

Merging and deploying are **not** an agent's job. After the agent phase, a
release phase takes whatever the remote has, squash-merges every QA-verified
branch, bumps the version, writes the changelog and runs the repo's deploy
hook. A headless session is never handed permission to push to production.

A branch that will not merge is **handed back**, not skipped. The release
rewinds it, merges the base into the branch in its own worktree, and returns
the ticket to the dev lane with the conflict left in place to look at — so the
seat that resolves it is one with the ticket's context, and QA checks the
resolution like any other change. A branch that was merely stale merges
cleanly at that point and nobody is woken at all. Conflicting a second time
stops at `needs_info` rather than looping.

## Prompt sets

The seats above and their briefs are policy, not mechanism — a fact about
*how* one particular workspace likes to work, not about what crew itself
can do. `prompts/` ships more than one of these as complete, ready-to-run
policies:

| Directory | Policy |
| --- | --- |
| `prompts/default/` | Three lanes — dev, design (gated by a *Needs design* flag), QA. |
| `prompts/dev-qa/` | Two lanes — dev builds everything, QA checks it. No design gate. |

A route picks one with `promptSet:` in `crew.yaml` (see
`crew.example.yaml`) — a bare name resolves under this repo's own
`prompts/`, defaulting to `default` when omitted. Different routes on the
same ship can run different prompt sets, since which workflow a workspace
wants is a fact about that workspace, not about the machine running it.

**Writing your own** is the expected path once a shipped preset doesn't
fit: copy a preset directory (`cp -r prompts/default ~/my-crew-policy`),
edit its prose, and point `promptSet` at the copy (`~/my-crew-policy` or a
relative path) — no fork of this repo required. A prompt set is a complete,
self-contained fork of `common.md` + one `lane-<role>.md` per seat, not a
diff against another one; each file is read as plain prose concatenated
ahead of the per-run roster/environment/queue sections
(`src/agent.ts`'s `assemblePrompt`), so there's no templating layer to
learn. `prompts/dev-qa/` is a worked example of trimming a lane out of
`default` cleanly, including the unused `lane-design.md` stub every
preset still needs today — see the next paragraph for why.

One current limit: **the four seats themselves (dev, design, qa, triage)
are fixed** — `src/config.ts`'s `RoleName` — so even a prompt set with no
real use for a seat (`dev-qa`'s `design`) still needs a `lane-<role>.md`
file, or `crew agents sync` and `planAgentRun` throw looking for it.
`prompts/dev-qa/lane-design.md` handles this by being a brief that just
says "do nothing, you shouldn't be staffed" — copy that pattern for any
seat your own policy doesn't use. Making the seat set itself
policy-defined, so a prompt set could add or drop a role outright, is a
larger change than prompt sets took and hasn't been done.

## What a workspace has to provide

The crew reads its meaning from the board, not from its own source. Statuses,
the priority order, and which column plays which role are **per-workspace
facts**, because a ship can be connected to several boards that each made
different choices. `docs/CONTRACT.md` documents the defaults and what a
workspace has to override if it names things differently.

## Install

```sh
git clone <this repo> crew
cd crew
cp crew.example.yaml ~/.config/crew/crew.yaml
chmod 600 ~/.config/crew/crew.yaml     # it holds an API key
$EDITOR ~/.config/crew/crew.yaml
bin/crew doctor                        # read-only preflight
```

The config lives in `~/.config/crew/` rather than in the checkout: it describes
the **machine**, so reinstalling or replacing the checkout does not lose it.
`crew` looks in `$CREW_CONFIG`, then `$XDG_CONFIG_HOME/crew`, then
`~/.config/crew/crew.yaml`, and only then beside the checkout.

`crew connect` resolves a workspace/project's ids into the state tree so you do
not have to look them up by hand. `doctor` then checks the config against
reality: the checkouts, the tools on PATH, the agent binary, the repo's hooks,
and whether the board answers. Nothing writes, wakes an agent or deploys until
a route has `enabled: true`.

Then put it on a timer:

```sh
bin/crew install           # writes and loads this platform's own unit
bin/crew install --dry-run # see what it would do first
bin/crew uninstall         # unload and remove it
```

`install` picks the mechanism itself: a launchd user agent on macOS, a
systemd **user** service+timer on Linux (falling back to a crontab line where
`systemctl` is not usable), or an error on Windows (not built yet). It always
uses an absolute interpreter path (`process.execPath`) and points the unit's
own log at a *different* file than the crew's own — pointing both at one file
was hit for real, and doubles every line. It never fires at load: the first
poll happens one interval after `install` runs, same as every one after it.
Each fire is a few API calls; a full agent session only starts when that
cheap check finds something worth waking for.

`launchd/com.tablation.crew.plist` is kept only as a reference for what
`install` generates — hand-editing and loading it directly still works, but
`crew install`/`crew uninstall` is the supported path now.

## Commands

```
crew poll [route]              decide a cycle and report it; writes nothing
crew run [route] [--role R]    run the winning role's session, then release
crew release [route]           merge what QA verified, version it, ship it
crew merge [route]             merge verified branches and stop
crew deploy [route]            release now, even with nothing new to merge
crew watch [route]             live view of what the crew is doing
crew status [route]            paused/running state
crew doctor [route]            read-only preflight
crew ports [route]             which checkout owns which ports, and what is up
crew reap [route]              kill servers left behind by removed worktrees
crew drop [route] NNN          remove a merged ticket's worktree and branch
crew sync [route]              fast-forward the checkout and its worktrees from the remote
crew pause|resume [route] [R]  pause everything, or one role
crew log [route]               tail the log
crew inbox [--member NAME]    your tickets across every workspace
crew connect WS[/PROJECT]     resolve a workspace/project's ids into the state tree
crew install                  write and load this platform's scheduler unit
crew uninstall                unload and remove it
```

Every command that could change something takes `--dry-run`.

## One ship, many boards

A ship connects to several workspaces at once, and ranks their queues against
each other — a P0 on one board outranks a P2 on another. The ship is identified
by `ship.name` matching a row in each board's Ships table; a crew member is
identified by email, so the same person is recognised across workspaces.

An area of development spans **several repositories**, so a checkout is a
property of the ticket, not of the route: `repos:` maps each name in the
board's Repos table to a directory on this machine. Naming even one repo
there makes it a closed list — several ships can divide a multi-repo area's
work between them, and anything not named is deliberately another ship's,
marked `NO CHECKOUT` in the digest rather than left blank (blank would read
as "work it here", which is the wrong directory).

Leaving `repos:` out entirely means the opposite: this ship serves
*everything* the board's Repos table lists, each checkout defaulting to
`<reposBasePath>/<workspace>/<repoName>` — `reposBasePath` is `~/Crew`
unless a `ship:` or route-level `reposBasePath:` says otherwise. A repo
that doesn't exist yet at its derived path is cloned there automatically
the first time a ticket actually needs it (from the Repos table's own
`remote` column, `owner/repo` over SSH) — not up front on `crew connect`,
which only discovers names and remotes, never fetches anything itself.

## What lives where

```
bin/crew          the entry point
src/              the implementation (Node, run directly via type stripping)
test/             its tests, including a fake board for integration runs
prompts/          prompt sets — prompts/<name>/common.md + lane-<role>.md
docs/             CONTRACT.md, REPO_SPEC.md, MIGRATION.md
launchd/          timer templates (edit the paths before installing)
crew.example.yaml copy to ~/.config/crew/crew.yaml
```

The crew carries no ids, no absolute paths, no project commands and no device
names. Anything specific to a **machine** belongs in `crew.yaml`; anything
specific to a **repository** belongs in that repository's own `.crew.yaml`
(`docs/REPO_SPEC.md`), which declares its platform, hooks, branch naming,
versioning and release mode:

| hook | required | what it is for |
| --- | --- | --- |
| `test` | yes | run the suite before a release |
| `build` | yes | build it |
| `deploy` | when `release.mode: local` | ship it |
| `setup` | no | prepare a fresh worktree |
| `ports` | no | print this checkout's port assignments |
| `version` | no | print the current version |
| `bump` | no | produce and print the next one |
| `merged` | no | ask the forge whether a branch actually landed |
| `released` | no | confirm a commit is live (a sha, or an exact version) |

The crew carries no commands of its own: everything it runs to test, build,
version or ship a repository comes from that repository's own file.

One hook is the exception and lives in `crew.yaml` instead: `notify`, which is
handed a level (`ok` / `warn` / `fail`), a headline and a detail line whenever a
release ships or is blocked. Where that should be *shown* — a desktop
notification, a status widget, a webhook, a push — is a fact about the machine
and the person watching it, not about the code. Define none and release state
simply goes to the log.

A repo's own `.crew.yaml` wins over anything repeated in `crew.yaml`, and
`crew doctor` reports the duplication as drift. The client can still configure
a repo that has no `.crew.yaml` of its own.

## Status

Live on macOS, driving this project's own board. Triage is a **seat**, not a
second process — there is one timer to install, not two.

The bash implementation this replaces has been deleted. Where its behaviour was
the only specification of something — the priority matrix, the QA digest, the
crew labels — it was captured as a fixture under `test/fixtures/` first, so the
tests still hold the port to what the original did.

Outstanding: Linux has not been exercised end to end, and the API key sits in
`crew.yaml` in plaintext until the device-code flow and keychain storage land.
