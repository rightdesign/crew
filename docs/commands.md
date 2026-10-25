# Command reference

Every command takes an optional `[route]` — a `workspace/project` slug pair.
It may be omitted when the ship has one route (or the command works fleet-wide).
`crew --help` prints the same list.

## Everyday

| Command | What it does |
| --- | --- |
| `crew connect [workspace[/project]]` | Resolve a workspace's ids into `crew.yaml`; on a first run, a setup wizard. A secondary workspace is `<primary>:<slug>`; see [Getting started](/getting-started#a-secondary-workspace). Scriptable with [wizard flags and `--json`](#non-interactive-crew-connect). |
| `crew repos add ROUTE PATH` | Attach a local checkout to a route in `crew.yaml` Creates the Repos row when the tracker has none (`--name`, `--project`, `--no-create`; `--dry-run` previews). |
| `crew repos clone [ROUTE] NAME` | Clone a Repos row's remote (`https://github.com/<owner>/<repo>`, or SSH with `ship.cloneScheme: ssh`) into `<reposBasePath>/<workspace>/NAME` (or `--dir PATH`) and attach it as `crew repos add` would. Refuses a row with no remote or a repo already attached; a failed clone leaves `crew.yaml` untouched. `--dry-run` previews, `--json` emits progress events. |
| `crew repos list ROUTE` | The checkouts a route has, with the Repos row each matches. `--json` prints `{ route, repos: [{ name, remote, repoRowId, attached, dir, exists, origin, matchedRow, hooksSource }] }`: every Repos row the route knows (attached or not), then each configured checkout that matches no row (`repoRowId: null`). `origin` is the checkout's origin URL when it differs from the row's `remote`; `hooksSource` is `repo` (a `.crew.yaml` with hooks), `route` or `none`. The text output is unchanged. |
| `crew repos hooks [ROUTE] NAME` | Propose `test`/`build` (and `version`/`bump`) hooks by reading the checkout (`package.json`, `Package.swift`, `pyproject.toml`, `Makefile`; first match wins). `--write route` adds them under the route's entry in `crew.yaml` without overwriting hooks already set; `--write route --replace` overwrites the values it names (keys it does not name stay) and `--json` reports them under `written.replaced`; `--clear route` deletes the route-level `hooks:` map for that repo (comments, other routes and the repo's own `.crew.yaml` are untouched; `--json` reports `cleared.removed`, and `repos list` then shows `hooksSource: none` unless a `.crew.yaml` supplies hooks), and cannot be combined with `--write`, `--suggest` or `--agent`. `--write repo` writes a starter `.crew.yaml` at the checkout root for review and commit, and refuses to overwrite an existing one. `--json` prints the proposal, including `recipes`: named bundles detected from the checkout (a `.github/workflows/` directory offers "Releases run in GitHub Actions", which sets `release.mode: ci_auto` with a `released` hook, and an opt-in "Check CI status before hand-off" recipe that sets `hooks.ci_status`); `--recipes ID,ID` with `--write` applies the ones named (none by default; `release:` settings only land with `--write repo`). `--hook KEY=CMD` (repeatable, with `--write`) overrides the detected value for `test`, `build`, `version`, `bump`, `released` or `ci_status`, or adds one the sniff did not find; the same no-overwrite rules apply (unless `--replace`) and an unknown key is refused with the valid keys named. `--agent` also runs the configured Claude toolchain read-only over the checkout and prints its proposed hooks, the files it read and which values differ from the file sniff; it writes nothing (Ctrl-C cancels), and on failure exits non-zero with a `reason` (`not_signed_in`, `not_installed`, `unsupported_harness`, `timeout`, `cancelled`, `modified_checkout`, `bad_output`, `failed`) while the file sniff stays in the output. |
| `crew reload [--now]` | Make the running `crew daemon` pick up a changed `crew.yaml`. The daemon also notices an edit to `crew.yaml` or a route's `apiKeyFile` on its own and relaunches on its next idle pass. `reload` writes a `reload-requested` marker in the state directory so a busy daemon finishes its in-flight run first; `--now` also restarts the unit immediately, interrupting any run in progress. With no daemon unit running it says so and exits 0. `crew doctor` warns when the config is newer than the daemon's start. |
| `crew doctor [route] [--fix] [--offline] [--json]` | Read-only preflight; for each checkout it runs `git push --dry-run` against a probe branch (non-interactive) and reports `push auth` ok or the failure with a `gh auth login` / `gh auth setup-git` (HTTPS) or `ssh-add` (SSH) hint, and reports `gh` (required only for PR-based repos), `node` and `docker` (required only with host passengers) with install hints. `--offline` skips the push probes and labels them; `--json` prints just the push-auth and tool results; a repo directory missing on disk (or one git cannot check) is reported under that repo and fails the run instead of aborting the report; `--fix` enables clean routes and offers `crew install`. |
| `crew selftest [route] [--toolchain NAME] [--json]` | Launch each configured toolchain through its adapter as a run would (scheduler `PATH`, scrubbed environment, the dev seat's key as `CREW_API_KEY`, a fresh temp directory) and ask it to read the workspace's name through the tracker MCP tool. Passes when the reply names the workspace; otherwise names the failure (binary not on the scheduler PATH, vendor login missing, MCP tool unavailable, seat key refused, keychain locked, timeout) with its remedy. Reports tokens and cost, writes nothing to the tracker, leaves no worktree or temp directory. Exits 1 if any toolchain fails; `--json` prints one result object per toolchain. `crew doctor` shows the last stored result without re-running it. |
| `crew sample-ticket [route] [--remove] [--dry-run] [--json]` | Create `<dir of the route's first checkout>/crew-sample` if absent (`git init`, a README, a `.crew.yaml` whose test and build hooks always pass, `release.mode: integrate`, `versioning: none`, one initial commit on `main`, and **no remote**: the release phase never pushes for a repo with none), reuse or create its Repos row, attach the checkout to the route, and file one approved, unassigned ticket asking for a small documented function with a test. The description opens with `sample: true`, which is how `--remove` and the app recognize it. Running again reuses the sandbox and files another ticket. `--remove` closes open sample tickets as won't-fix, detaches the route entry, deletes the Repos row and the sandbox directory. `--json` prints one event object per line. |
| `crew install [--replace]` / `crew uninstall [--all]` | Write and load, or unload and remove, this platform's scheduler unit. On macOS, `install` first clears launchd units left by a crew installed from another path: stale ones are removed, and a unit still running a live other checkout stops the install unless `--replace`. `uninstall --all` removes every `com.tablation.crew*` unit, whichever path it came from. |
| `crew --version [--json]` / `crew version` | Print the version (the `version` in the `package.json` crew resolves for itself, `CREW_HOME` for the compiled binary) alone on one stdout line and exit 0. `--json` prints `{"version", "home", "compiled"}`. Answered before any config is read, so it works with no `crew.yaml` and never touches the tracker. Any other unknown flag still prints usage and exits 2. |
| `crew status [route] [--json]` | Paused/running state, plus any open ship-level attention items (a parked role, a hook command missing from the scheduler PATH, a stalled release timer) for this ship and, from the Ships table, for others; `--json` for a machine reader (`ship.attention`). |
| `crew projects [--route R] [--json]` | The Projects rows each route's connection can read: `id`, `name`, `issuePrefix`, `workMode` and whether it is the route's current `area`. `--json` is `{ routes: [{ route, areaId, projects }] }`; a route whose key fails reports `{ route, areaId, error }`, and the exit code is non-zero only when every route failed. The data source for crew-macos's Project popup. |
| `crew whoami [route] [--json]` | Who each route is signed in as: one `/auth/me` call with the route's key, printing the identity (id, email, name), the key's role in the workspace, the operator Crew row `connect` linked (id, name) and where the credential comes from (`keychain`, `apiKeyFile`, `CREW_API_KEY` or `inline`; never the key itself). `--json` prints an array with one object per route (a single object when a route is named); a route whose key is rejected or unreachable reports `ok: false` with a one-line `error` (a 401/403 names the expired or revoked key), and the exit code is 1 when any route failed. Writes nothing. |
| `crew pause\|resume [route] [ROLE\|release]` | Pause or resume everything, one role, or releases only. `crew pause` stops agents (both one-shot `run` and `crew daemon` claim nothing) and the release timer (merge, deploy, release). `crew pause release` stops only shipping and leaves agents running. Passengers keep running through both. `crew resume` clears only the whole-crew pause, so a release pause stays until `crew resume release`, the same as a role pause. |
| `crew inbox [--member NAME] [--by-route] [--all]` | Your tickets across every workspace, or a colleague's. |

## Running the crew

| Command | What it does |
| --- | --- |
| `crew poll [route]` | Decide a cycle and report it; writes nothing. |
| `crew run [route] [--role R]` | Run the winning role's session (`--role` forces one and disables fall-through; `--max-roles N` sets how many to try). |
| `crew watch [route]` | Live view (`--role`, `--ticket`, `--level warn`, `--tail N`); space pauses, `q` quits. |
| `crew log [route]` | Tail the log. |
| `crew logbook list [route]` | Recent Agent Log entries, filterable by `--role` / `--ticket`. |
| `crew logbook show [route] ID [--prompt]` | One entry; `--prompt` reconstructs and verifies its prompt. |

## Releasing

| Command | What it does |
| --- | --- |
| `crew release [route]` | Merge what QA verified, version it, ship it (`--skip-tests` skips the gate). |
| `crew merge [route]` | Merge verified branches and stop. |
| `crew deploy [route]` | Release now, even with nothing new to merge. |

## Housekeeping

| Command | What it does |
| --- | --- |
| `crew sync [route]` | Fast-forward the checkout and its worktrees from the remote. A base branch that is diverged, ahead of the remote, or cannot fast-forward prints `DO NOT CUT A WORKTREE FROM THIS BASE` and exits 1; `crew status` and `crew doctor` report the same state, and each fetches once per repo to do so. |
| `crew ports [route]` | Which checkout owns which ports, and what is up. |
| `crew reap [route]` | Kill orphaned servers, drop worktrees for closed tickets and for `verified` ones whose branch is fully on the remote. |
| `crew drop [route] NNN` | Remove a merged ticket's worktree and branch. |
| `crew worktree [route] NNN [dev\|design\|qa]` | Cut, or refresh, this run's worktree for a ticket from the remote branch (fresh from the base when nothing is pushed yet) and print its path on stdout. The route is optional: with none named, a one-route ship uses its route and a multi-route ship takes the route whose tracker has the ticket and whose checkout serves its repo; if none does, or the ticket is on no route, it exits 2 (not 1, which means "left alone" below) naming the ticket's repo and the routes it looked on. It only ever cuts from `<remote>/<branch>` or `<remote>/<base>`, so a stacked branch can only come from a hand-cut worktree. A worktree with uncommitted changes or unpushed commits is left alone: nothing is printed and the exit code is 1. The runner removes a run's worktree when the run ends — after a verified push for dev/design, after the run for QA — unless it is dirty, holds unpushed commits, or the repo's `handoff` hook serves from it; `crew reap` and the release phase then remove a kept one once its ticket is `verified` or closed. |
| `crew disconnect [--reset [--remove-checkouts] [--dry-run] [--json]]` | Bare `disconnect` removes only the Pair/MCP entries `connect` added. `--reset` removes everything `connect` and `install` wrote on this machine, in this order: every scheduler unit for this checkout; the Pair/MCP entries for every route; this ship's seat keys (revoked on the server, then cleared from the keychain); each route's workspace credential in the keychain; with `--remove-checkouts`, the checkouts crew cloned itself; the resolved ids, connect-written key files, sentinels and locks in the state directory (logs and events stay); and `crew.yaml` last, so an interrupted reset can be run again. Server rows (Ships, Crew, Repos) are never deleted. `--remove-checkouts` only touches directories crew recorded when it cloned them, never one attached from elsewhere, and keeps (and names) any checkout with uncommitted changes or linked worktrees. Each removal is printed; `--dry-run` prints the plan and changes nothing; `--json` prints `{dryRun, ok, steps}`. Exits 1 when a seat key could not be revoked or a checkout was kept, since the machine is then not fully clean. A seat key minted before key ids were recorded cannot be revoked from here and stays on the server until revoked from its Agents row. |
| `crew ship rename NAME [--json]` | Rename this ship: writes `ship.name` in `crew.yaml` (comments kept) and renames this machine's row on every workspace's Ships table, then records the name each route last saw agree. A route whose key may not edit the table (403) is reported and the local rename still happens; the exit code is 1 then. `--json` prints `{name, previous, configFile, routes: [{route, status}]}`. |
| `crew unassign [route] NNN` | Hand back a session's ticket: clears the assignee so the next cycle picks it up. |

### Ship name sync

The ship's name lives in two places: `ship.name` in `crew.yaml` and the `name` of this machine's Ships row in each workspace. Each pass of the daemon (and each `crew run`/`poll` cycle), and `crew connect`, compares them against the name that route last saw agree (`shipName` in its resolved file):

- the row changed, `crew.yaml` did not: `crew.yaml` adopts the row's name, with one `ship_renamed` event;
- `crew.yaml` changed (a hand edit), the row did not: the row takes the new name;
- both changed and disagree: the Ships row wins, and a warning event names both values.

The row is matched by `machine_id`. A workspace whose Ships table has no `machine_id` column has nothing to compare, so nothing syncs there; the name in `crew.yaml` stays the name. `crew status --json` reports `ship.name`, `ship.rowName` and `ship.nameDrift` (`none`, `row`, `local` or `both`) without writing anything.

## Personas and skills

| Command | What it does |
| --- | --- |
| `crew agents sync [route] [--force] [--revoke-seat-keys]` | Push personas and skill files into the workspace's Agents and Agent Skills tables (`--force` overwrites a diverged persona; `--revoke-seat-keys` revokes this ship's seat keys on the server and clears them from the keychain, so the next sync mints fresh ones). A row with "Customize prompt" on is never synced, with or without `--force`; the command reports it as an override and still exits 0. |
| `crew agents prompt ROLE [route]` | Print one persona's current prompt (e.g. `pair`, for a SessionStart hook). |
| `crew skills sync [route]` | Push only the skill files. |

A row's "Additional instructions" (`prompt_additions`) are appended, after a fixed divider, to the persona brief and to each included skill at run time, with or without "Customize prompt". `crew agents prompt` and `crew logbook show --prompt` print that composed text.

## Host Passengers

| Command | What it does |
| --- | --- |
| `crew passengers [route]` | Sync Host Passengers containers and tunnels once. |
| `crew rotate-passenger-url [route]` | Force the tunnel to reconnect with a fresh public URL. |

See [Host Passengers](/host-passengers).

## Non-interactive `crew connect`

A first-run connect needs no terminal when every answer is a flag, and `--json` turns its progress into events a program can read. This is how the Crew app drives setup, and the scriptable path on Linux and CI. The interactive wizard is unchanged for a person at a terminal.

**Wizard answers as flags** (used on a first run, when no `crew.yaml` exists anywhere crew looks):

| Flag | Meaning | Default |
| --- | --- | --- |
| `--ship-name NAME` | How this machine appears on the board | the hostname |
| `--machine-id ID` | Override the stable machine id (hashed) used to find this machine's Ships row before its name; for tests and containers | the hardware id, hashed |
| `--agent-bin PATH` | Absolute path to the agent binary | the `claude` on `PATH`, else in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.volta/bin` and `--extra-path` |
| `--extra-path DIRS` | `ship.extraPath` for scheduled runs | derived from where `node`, `pnpm` and (with Host Passengers) `docker` live |
| `--host-passengers` | Host Passengers on this machine | off |
| `--no-wizard` | Never prompt: take every answer from flags and defaults | |

On a terminal the wizard still runs unless `--no-wizard` is given. Off a terminal, any one of the answer flags selects the flag path. An `--agent-bin` that is not executable is a `problem` event and exit 2, never a prompt. A `claude` that cannot be found fails only a real run (after sign-in, naming every directory searched); a `--dry-run` succeeds and its `done` event reports `agentBin: null` with an `agentBinNote`. With a `--key`, the key is written to a 0600 key file (there is no sign-in to put it in the keychain) so `crew.yaml` can name it.

**`--json`** writes one JSON object per line on stdout, each `{event, message, ...data}`; all human text stays on stderr (including the route block). Device authorization needs no terminal under `--json`: the code arrives as a `device_code` event and crew keeps polling.

| Event | Data |
| --- | --- |
| `device_code` | `userCode`, `verificationUri`, `verificationUriComplete`, `expiresIn` (seconds) |
| `signed_in` | `identity` (`id`, `email`, `name` when known), `workspaces`, `session` (`device` for a fresh approval, `keychain` for a resumed one, `key` for a key given on the command line with a workspace named; with no workspace named, a key from `--key` or `CREW_CONNECT_KEY` reports `flag` and a key from a `crew.yaml` route reports `config`, so a client handles those two spellings in addition to `key`). `signed_in` always precedes any `choice` event, including the `workspace` question, so a client knows who is signed in before it is asked anything. With `--dry-run` and no workspace named, a keychain session stored by an earlier run on this host is reused when the server still accepts it, so no `device_code` event is emitted; a missing or rejected one falls back to device approval. With `--dry-run`, a key from `crew.yaml`, no workspace named and exactly one workspace across its routes, that workspace is used without a `workspace` choice: the `signed_in` message says so and `workspace_resolved` follows it. With several workspaces (or none) the `workspace` choice follows `signed_in` as before |
| `workspace_resolved` | `workspaceId`, `slug`, `name`, `role` |
| `project_options` | `options`: each qualifying project (`id`, `name`, `slug`) when several qualify |
| `template_missing` | `canInstall`: no project has the tables a route needs; `true` when the key's role can install the Issues template |
| `template_installed` | `projectSlug` |
| `ship_row` | `id`, `name`, `action` (`created` or `matched`) |
| `operator_row` | `id`, `action` (`matched`, `linked`, `created`, or `previous` for one carried from an earlier connect), `name`, `email` (the row's, else its linked member's; omitted when unknown) |
| `seat` | one per lane: `role`, `id` (empty for `would-create`), `ship_id` (the Ships row the matched row belongs to; empty when none), `action` (`matched`, `claimed`, `created`, or `would-create`: a dry run found no row this machine could claim, so a real run would create one), `key` (the seat-key outcome: `minted`, `already_stored`, `no_agent`, `failed`, `forbidden`, or `none` when none was attempted) |
| `mcp_registered` | `harness`, `bin`, `url`, and for Claude Code `action` (`registered`, `replaced` or `kept`); `message` is the line crew prints |
| `pair_installed` | `harness`; `message` is the line crew prints |
| `capabilities` | reserved for the member capability checklist (ISSUE-2240) |
| `choice` | `key`, `options` (`value`, `label`), `answer`: a decision a terminal would have asked; see below |
| `problem` | `stage` and, for an HTTP failure, `status` and `path`; the run is stopping, or (stage `discover`) the route is written with a gap |
| `done` | `route`, `resolvedPath`, `configPath`, `wroteConfig`, `operator`, `dryRun`, `unresolved` (count) |

**Choices.** Where the wizard would ask, crew emits a `choice` event and exits **3** without writing anything past what is already idempotent. The caller asks, then runs the same command again adding `--choose KEY=VALUE` (repeatable). Re-running is safe: provisioning finds the rows it made.

| Key | Asked when | Values |
| --- | --- | --- |
| `workspace` | no workspace named and the key sees several | a workspace slug |
| `project` | several projects have the tables a route needs | a project slug |
| `install-template` | no project qualifies and the key can install the Issues template | `yes` or `no` |
| `operator` | no Crew row matches the key's identity | a Crew row id, or `new` to create one |
| `status.<value>` | the Issues table has a status the default contract does not know; one event per value | `yes` (resolved/terminal) or `no` |

Exit codes: 0 connected, 2 stopped on a problem, 3 stopped on a `choice`.

## Minimum crew version

A project can set a minimum crew version. A crew below it claims no ticket, keeps its heartbeat, and raises a `crew_outdated` attention item (shown by `crew status`) naming both versions; it clears itself once crew is updated. Tracker writes from an older crew are refused with HTTP 426. The Crew app updates its built-in crew; on the CLI, update with `npm install -g @tablation/crew` or the newest binary release. See [If something's stuck](/getting-started#if-something-s-stuck).

## Options on every command

- `--dry-run` decides everything and performs nothing.
