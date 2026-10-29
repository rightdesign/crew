# Getting started with crew

This walks a new engineer from "no account" to a running crew seat polling a
real workspace's issue tracker on Tablation. It assumes nothing already
exists on your machine or your Tablation account.

There are three parts, and you do Part 1 and then **one** of the other two:

1. **Get into Tablation** — an account and workspace access.
2. **On a Mac: the Crew app** — download the app and follow its setup wizard.
   No terminal needed.
3. **On Linux or by script: the CLI** — install `crew` and run
   `crew connect`, `crew repos add` and `crew doctor --fix` yourself. This is
   also the route for CI and any scripted setup.

The two routes produce the same thing: a `crew.yaml`, a keychain credential, a
Ships row for the machine and a scheduler unit. The app is a front end over the
CLI, so everything it does can be checked with `crew doctor`.

For the shortest version, see [Install](/install).

## Contents

- [Part 1 — Get into Tablation](#part-1-get-into-tablation)
  - [1.1 Get into a workspace](#_1-1-get-into-a-workspace)
  - [1.2 Your machine's Ships row](#_1-2-your-machine-s-ships-row)
- [Part 2 — On a Mac: the Crew app](#part-2-on-a-mac-the-crew-app)
- [Part 3 — On Linux or by script: the CLI](#part-3-on-linux-or-by-script-the-cli)
- [Attaching a checkout to a route](#attaching-a-checkout-to-a-route)
- [Connecting a repo that has no `.crew.yaml`](#connecting-a-repo-that-has-no-crew-yaml)
- [Advanced: an existing `crew.yaml`](#advanced-an-existing-crew-yaml)
- [If something's stuck](#if-something-s-stuck)

Hosting other people's agent sessions on your machine is a separate, optional
capability: see [Host Passengers](/host-passengers).

---

## Part 1 — Get into Tablation

### 1.1 Get into a workspace

You need an account on Tablation and access to the workspace whose board the
crew will work. There are two ways in.

**Be invited.** Ask whoever administers the workspace you're joining (a
**workspace admin**) to send you an invite from their **Users** panel
(Settings → Users → *Invite by email*). You'll get a link shaped like:

```
https://app.tablation.com/accept-invite?token=<token>
```

Open it, set a password, and you're in. If you don't have a link, ask the
admin to resend one rather than guessing at a URL.

**Register your own workspace.** If you are starting fresh rather than joining
a team, sign in at <https://app.tablation.com> and create a workspace for
yourself from the app (a new organization is created with it). You become its
admin, and the Issues project the crew reads is installed into it for you the
first time you connect (see 2.2 and 3.3). Whichever way you came in, the rest
of this guide is the same.

### 1.2 Your machine's Ships row

crew identifies "this machine" by a name (`ship.name` in `crew.yaml`).
`crew connect` (§2.3) provisions this for you the first time it runs — it
finds-or-creates a row on the workspace's **Ships** table under that name,
and one **Crew** row per lane (dev/design/qa/triage), scoped to it, the
first time it needs one. Nothing to do here by hand: this section used to
say to add the Ships row yourself before continuing, which is no longer
necessary.

If your workspace already has a Ships row for this machine from before
`crew connect` did this automatically (or a teammate added one by hand), it
just gets matched by name and reused — nothing is duplicated. An existing
team usually already has a naming convention for this (e.g.
`"Brad's MacBook"`); ask before inventing your own.

---
## Part 2 — On a Mac: the Crew app

The Crew app is a macOS menu bar app. Its first launch opens a setup wizard
that takes a Mac from nothing to a running crew in seven screens, and after
that it shows which seat is working on what, with a live log window and
switches to pause the crew or the timer. It needs macOS 14 or later.

### 2.1 Download

Get it from the [Developers page](https://tablation.com/developers) (the
**Download Crew for macOS** button), which serves
<https://tablation.com/downloads/crew/Crew-latest.zip>. The build is signed
and notarized, so it opens without a Gatekeeper warning. Unzip it, drag
`Crew.app` to `/Applications` and open it.

The app carries its own compiled `crew`, so you do not install Node or npm.
It installs that copy under `~/Library/Application Support` on first launch,
and keeps using a `crew` it finds elsewhere on your Mac if you already have
one.

### 2.2 The setup wizard

The wizard has a step track across the top; you can see which steps are done
and which is current. Each step is one screen. Under the hood each runs the
same `crew` commands as Part 3, so the "writes" column below is what to look
for in `crew doctor`.

| # | Step | What it does | What it writes |
| --- | --- | --- | --- |
| 1 | **Requirements** | Checks for `git` and at least one agent CLI (Claude Code is the default). A missing tool shows its install command with **Copy** and **Run in Terminal**; missing Command Line Tools offer **Install Command Line Tools…**. **Recheck** re-runs the check. Whether the agent CLI is *signed in* is checked later, in Verify. | Nothing |
| 2 | **Sign in** | Signs you in to Tablation with device authorization: your browser opens, you approve, and the app picks it up. | The workspace credential in the macOS keychain |
| 3 | **Workspace** | Lists the workspaces you can reach and the projects in them that have the tracker tables; pick one. If none qualifies and your role can install it, it offers to install the Issues template. | The resolved ids, in crew's state directory |
| 4 | **This machine** | Names this Mac on the board (default: its hostname), confirms the agent binary, derives the scheduler `PATH` (`ship.extraPath`) and asks whether to host Passengers. | `~/.config/crew/crew.yaml` (mode 0600) with the `ship:` block and the route (`enabled: false`); your Ships row and one Crew row per lane in the workspace; your own Crew row; the Tablation MCP server in `~/.claude.json`; per-seat agent keys in the keychain |
| 5 | **Repositories** | For each repository the project lists, clones it or attaches an existing checkout, proposes `test` and `build` hooks from what it finds (with named recipes, and an optional read-only review by Claude Code), and checks that `git push` works. A push failure shows the exact fix with **Fix in Terminal…** and **Copy**. | The route's `dir:` / `repos:` entries, and hooks in `crew.yaml` or a starter `.crew.yaml` in the checkout; a Repos row when the tracker has none |
| 6 | **Verify** | Runs the agent self-test for every configured toolchain, one row each: running, passed (with the workspace name it read, tokens and cost) or failed with the reason and its remedy. **Retry** per row. **Continue** is enabled when at least one passes; a failure on another toolchain shows as a warning. | Nothing in the tracker; the last result for `crew doctor` |
| 7 | **Start** | Turns the crew on: enables the route and installs the scheduler. If a blocking problem remains it is shown with a link to Setup health instead of installing. | `enabled: true` on the route; this platform's scheduler units (a launchd user agent) |

The wizard has a **Back** button where it is safe to go back, and **Cancel**
anywhere. Quitting part-way and reopening continues from what is already
written; each step finds the rows it made earlier rather than creating
duplicates.

A `crew://connect?host=…&workspace=…` link opens the wizard with the host and
workspace filled in, or, on a Mac that is already set up, offers to add that
route.

### 2.3 Verify, and the sample ticket

Verify is the point of no surprises: it proves an agent run works on this Mac
before anything is scheduled. The failure classes and what to do about each are
in [If something's stuck](#if-something-s-stuck).

When Start finishes, the completion panel offers **Run a sample ticket**. It
shows the token cost first, then runs `crew sample-ticket`: a throwaway
repository (`crew-sample`, beside your first checkout, with no remote) and one
approved ticket asking for a small documented function with a test. You can
watch the dev seat take it, QA verify it and the release phase merge it in the
menu and the log window. **Remove the sample** afterwards closes the sample
ticket, detaches the route entry and deletes the Repos row and the sandbox
directory. The same action is available from Setup health later.

### 2.4 Updating

- **The app** updates itself (Sparkle): it checks on launch and daily, and the
  menu has **Check for Updates…** and, when one is waiting, an **Update
  available** item. Permissions you granted survive the update.
- **The built-in crew** updates from crew's published releases. Settings shows
  the version in use and the workspace's **minimum crew version**, with an
  **Update** button when a newer one exists. A crew below the workspace's
  minimum stops picking tickets until it is updated; see
  [If something's stuck](#if-something-s-stuck).

### 2.5 Setup health

**Setup health** (from the menu) shows the same report as `crew doctor`: the
config, your Ships row, each checkout and its hooks, push auth per repository,
the tools crew needs, the tracker answering with your key. It also lists the
versions of the app, the built-in crew and the crew in use, and the last
self-test. **Recheck** runs it again; **Copy report** puts it on the clipboard
for a bug report.

### 2.6 Start over

Settings → **Advanced** has **Start over** and **Uninstall**. Both name the ship
and ask you to confirm. Start over removes everything this Mac's setup wrote
(the same as `crew disconnect --reset`: scheduler units, MCP entries, seat keys
revoked then cleared from the keychain, the workspace credential, resolved
state and `crew.yaml`) so you can run the wizard again. Uninstall does that and
removes the app. Rows on the board (Ships, Crew, Repos) are never deleted, and a
checkout is only removed when crew cloned it and it has no uncommitted work.

If the menu shows nothing or something stale, `Crew.app/Contents/MacOS/Crew
--probe` prints, as plain text, what the menu is built from.

---

## Part 3 — On Linux or by script: the CLI

Use this on Linux, on CI, or on a Mac where you would rather work in a
terminal. Everything in it also works on macOS; the app is a front end over
these commands.

### 3.1 Prerequisites

- **Node 22 or newer** (`node -v`). The `claude` agent binary is separate; crew
  asks where it is during `crew connect`.
- **git**, and a checkout of each repo you want this machine to work.
- Docker, only if you will [host Passengers](/host-passengers).

No other checkout is needed: crew installs from npm, and its tracker client
(`@tablation/client`) comes with it.

### 3.2 Install

```sh
npm install -g @tablation/crew
crew --help
```

#### Without Node: the compiled binary

Every tagged release also attaches a self-contained build for macOS and Linux
to its GitHub Release: `crew-<version>-<target>.tar.gz` for `darwin-universal` (one binary for both
Apple Silicon and Intel Macs, the macOS download to pick if you are unsure),
`darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64`, plus a
`SHA256SUMS` file. Check
the download against it, unpack it anywhere, and run the `crew` inside:

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS
mkdir crew && tar -xzf crew-<version>-darwin-universal.tar.gz -C crew
crew/crew doctor
```

The binary resolves its prompts and `package.json` from its own directory
(`CREW_HOME`, see `src/runtime-info.ts`), so keep the archive's files together.
Maintainers can publish the same assets by hand with
`scripts/publish-binaries.sh` when Actions is unavailable.

The same tarball is what the Crew app carries inside it. Releases are also
listed on the [Install](/install) page.

### 3.3 Connect to a workspace

```sh
crew connect my-workspace
```

The workspace is normally the only thing you need to name — `crew connect`
defaults the project to the `issues`-slugged project (the workspace's
install of the `tablation.issues` Library template, i.e. the tracker itself;
installs made from the earlier `crew.issues` identifier keep working). If
that project isn't there yet, it offers to install it from the Library on a
real terminal (say yes, or decline and set one up in the app first). Only
pass a project explicitly (`crew connect my-workspace/my-product`, or
`--project`) when you deliberately want a different, non-default tracker
project.

#### A secondary workspace

A workspace nested under another one (a secondary) is addressed as
`<primary>:<slug>`: the primary workspace's slug, a colon, then the
secondary's own slug.

```sh
crew connect acme:design-team
crew connect acme:design-team/my-product   # with an explicit project
```

Everything `connect` derives from the workspace carries that full address:

- **Route.** The route is `<primary>:<slug>/<project>`, for example
  `acme:design-team/issues`. Only `/` separates the project, so the colon is
  part of the workspace half.
- **Keychain entry.** The credential is stored in the OS keychain under the
  tracker host and the full address (`<host>/acme:design-team`), separate from
  any entry for the primary itself. Connecting to both keeps two independent
  keys.
- **Repos directory.** On a first run the wizard sets the route's directory to
  `~/Crew/<primary>:<slug>`, and each repo's checkout goes under it as
  `~/Crew/<primary>:<slug>/<repo>`. The colon is a literal character in the
  directory name.
- **Finder.** Finder shows that colon as a slash, so the folder reads
  `acme/design-team`. In a terminal, and in `crew.yaml`, the name keeps the
  colon. Don't rename the folder from Finder to "fix" it.
- **`--dir`.** `crew connect --dir PATH` overrides the directory in the route
  block, for a secondary or a primary alike. Use it to keep checkouts somewhere
  without a colon in the path.

The template's Issues table carries status rules: a close as won't fix, can't
reproduce or completed needs a resolution note, and a close as duplicate needs
a duplicate target. A write a rule refuses comes back as a 422 whose `message`
is the rule's text and whose `fieldErrors` names the field. Later template
versions may add rules that depend on who is writing.

`connect` signs you in with device authorization: it prints a code and a link,
you approve it in the browser, and the resulting credential is stored in your
OS keychain. You never copy an API key by hand.

**On a first run** — a real terminal and no `crew.yaml` anywhere `crew` looks —
`crew connect` is a wizard. It asks for the ship name (default: the hostname),
confirms the `claude` it found on your `PATH` (or asks for one), works out
`ship.extraPath` from where `node` and `pnpm` live, and asks whether this
machine should [host Passengers](/host-passengers). After signing in and
resolving the workspace it writes `~/.config/crew/crew.yaml` (mode 0600) with
the `ship:` block and the route, `enabled: false`, then prints what to do
next. An existing `crew.yaml` is never rewritten — `connect` prints the route
block for you to paste instead — and neither is a non-terminal run. If the
credential could not be stored in the keychain or a key file (a plain `--key`
connect), it prints the block instead of writing a file with no key in it.

`connect` also makes sure you have your own Crew row, linked to the account you
signed in with (`user_id`, and `email` when blank), so your comments in the app
read as you rather than "(no identity)". It matches by identity first, then by
email, then takes the only non-seat row; a row already linked to another account
is never touched or relinked. If nothing matches it creates a row from your
account (name, email, `user_id`), so a fresh workspace needs no hand-made
Crew row before you connect; on a terminal with several candidate rows it asks,
and offers "create a new row" as the last choice. A workspace that refuses the
write (no WRITE on the Crew table) is reported, connect still completes, and
`crew doctor` keeps flagging the missing `user_id` until a workspace admin sets
it or you re-run `crew connect`. `--dry-run` says what it would link or create.

`connect` also records you, by identity, as the owner of this ship's row in the
Ships table, when that table has an `owner_id` column (a workspace that has not
taken the latest Issues template update just skips it and says so).

If the Ships table also has an `attention` column (JSON), the ship writes its
open ship-level problems there on every heartbeat — a role parked after repeated
failed starts, a repo hook whose command is not on the scheduler PATH, a release
timer that has stopped firing — so they are visible from the workspace and from
`crew status` on any other ship, whether or not that ship runs a menu-bar client.
A workspace without the column just skips it.

Either way, it looks up the workspace (and project) by slug, resolves their
internal ids (and the Issues/Comments/Crew/Ships table ids inside them), and
writes the result to a local state file — nothing here starts polling or
touches the tracker's data beyond reading it. Re-running it later only asks
about anything genuinely new.

#### Without a terminal prompt: `--json` and flags

On a headless machine or in a script, give `connect` every answer as a flag and
read its progress as JSON lines:

```sh
crew connect my-workspace --no-wizard --json \
  --ship-name ci-runner-1 --agent-bin /usr/local/bin/claude
```

A decision a terminal would have asked comes back as a `choice` event and exit
code 3; run the same command again with `--choose KEY=VALUE`. The flags, events
and exit codes are in the [command reference](/commands#non-interactive-crew-connect).

### 3.4 Attach your repo checkouts

If the project's Repos table already lists the repository, let crew clone it
and attach it in one step:

```sh
crew repos clone my-workspace/issues my-product
```

It clones into `<reposBasePath>/<workspace>/my-product` (or `--dir PATH`), over
HTTPS by default or SSH with `ship.cloneScheme: ssh`. For a checkout you already
have, attach it:

```sh
crew repos add my-workspace/issues ~/src/my-product
```

See [Attaching a checkout to a route](#attaching-a-checkout-to-a-route) for what
it matches and writes. Repeat for each repo this machine should work. For a checkout with no
`.crew.yaml`, `crew repos hooks my-workspace/issues my-product` proposes
`test`/`build` hooks (see
[Attaching a checkout to a route](#attaching-a-checkout-to-a-route)).

### 3.5 Sync personas and skills

```sh
crew agents sync my-workspace/my-product
```

This pushes crew's built-in personas (Developer, Design, QA, Triage, Pair)
into the workspace's `Agents` table, and its skill files (e.g. `grill-me`,
under `prompts/<promptSet>/skills/`) into the `Agent Skills` table — both
`syncPersonas` and `syncSkills` run in one pass, since "agents" here means
every agent-shaped resource crew owns, not just the Agents table. It's safe
to re-run any time you edit a persona or skill file locally: unchanged rows
are left alone, and a row a workspace admin edited by hand is reported
`diverged` rather than overwritten. `crew skills sync my-workspace/
my-product` does the skills half alone, if you only touched `skills/`.

The persona and skill rows, and the seat keys below, belong to a **workspace
admin**: only an admin key writes the `Agents` / `Agent Skills` tables or mints
agent keys. A member's `crew agents sync` therefore does the one part a member
can: it links this ship's seats (and the release seat) to whichever persona rows
already exist, prints that personas, skills and seat keys were not synced, and
exits 0. A missing row, or a Crew table with no `Agent` field yet, is reported
(the seat keeps writing as the ship) and fixed by an admin's sync; run yours
again afterwards to link. `crew doctor` prints the key's role (`api key role:`).

### 3.6 Register the Tablation MCP server

The polled seats (dev/design/QA/triage) talk to the tracker entirely
through crew's own REST calls — this step is for anyone driving a live,
interactive Claude Code session against the tracker: the **Pair** persona,
or a session invoked via an Epic's `grill_link` to run the `Grill-Me`
skill (§3.5). Neither works well without the `mcp__tablation__*` tools.

**`crew connect` does this for you.** After it resolves a route, it checks
whether Claude Code already has a server named `tablation` and, if not,
registers one at user scope (`~/.claude.json`) using the key it just
resolved, so the tools are available from any directory. Re-running it makes
no second entry. A `tablation` server that points elsewhere (a dev instance)
or carries another key is reported and left alone; `crew connect --mcp
replace` overwrites it, and `crew connect --no-mcp` skips the step if you
manage `~/.claude.json` another way. With no `claude` on the PATH it prints
the manual command instead. `crew doctor` reports whether the server is
registered for the route.

The manual form, for project scope or a different key:

```sh
claude mcp add --transport http tablation https://app.tablation.com/api/mcp \
  --header "Authorization: Bearer sk_..." \
  --scope user
```

Notes:

- **Hostname**: Modify `app.tablation.com` to match the hostname for any dev
  instance you're using.
- **The key**: the key in `~/.claude.json` is stored in plaintext. There is no
  scope-narrowing mechanism today, so it can reach everything its holder can
  reach over the REST API.
- **Scopes**: `--scope local` is keyed to the directory you ran the command in.
  `--scope project` writes a shared `.mcp.json`, which is fine for the *server
  URL* but never commit a raw key in it; use that scope only with env-var
  expansion (`"Authorization": "Bearer ${TABLATION_API_KEY}"`) and an
  `export` in your own shell profile.
- The server is plain HTTP, not HTTPS, when the backend is running on
  `localhost` — swap in whatever host you're actually pointed at.

### 3.7 Pair on Codex, Gemini CLI and Copilot (VS Code)

Claude Code gets Pair from a session-start hook that runs `crew agents prompt
pair`. Codex, Gemini CLI and Copilot have no such hook, so `crew connect` installs the
same two things into their **user-level** files instead (never into a repo):

```yaml
ship:
  pair: [claude, codex, gemini, copilot]   # default: [claude]
```

| harness | instructions block | MCP entry |
| --- | --- | --- |
| Codex | `~/.codex/AGENTS.md` | `[mcp_servers.tablation]` in `~/.codex/config.toml` (`bearer_token_env_var = "CREW_API_KEY"`) |
| Gemini CLI | `~/.gemini/GEMINI.md` | `mcpServers.tablation` in `~/.gemini/settings.json` (`Authorization: Bearer $CREW_API_KEY`) |
| Copilot (VS Code) | `prompts/crew-pair.instructions.md` (`applyTo: "**"`) in VS Code's user directory | `servers.tablation` in `mcp.json` in the same directory (`Authorization: Bearer ${env:CREW_API_KEY}`) |

The block sits between `<!-- crew:pair start -->` and `<!-- crew:pair end -->`
and tells the agent to run `crew agents prompt pair --harness <name>` first and
follow what it prints. The key is **never written** — only the variable name —
so `CREW_API_KEY` must be in the environment the CLI starts from. Re-running
`crew connect` changes nothing; the block is replaced in place and the
operator's other content and servers are kept. A different `tablation` server
is left alone unless `--mcp replace`. `crew doctor` verifies each listed
harness and `crew disconnect` removes exactly what was added (and the files, if
they would be left empty).

For Claude Code, crew remembers what it registered in `<stateDir>/mcp-registrations.json`
(URL and a short fingerprint of the key, never the key). When a later sign-in mints a
new key, `crew connect` replaces an entry it recognizes as its own without asking.
An entry crew did not write is left alone, and the message names the URL it points
at; `--mcp replace` overwrites it anyway.

**Copilot specifics.** VS Code's user directory is `~/Library/Application
Support/Code/User` on macOS, `~/.config/Code/User` on Linux and
`%APPDATA%\Code\User` on Windows; `Code - Insiders` is installed too when its
directory exists. The instructions file goes in the default profile's `prompts/`
folder (what `Chat: New Instructions File` ▸ User offers); other profiles are not
touched. An `mcp.json` that contains comments is not rewritten — `crew connect`
says so and leaves it. VS Code started from the Dock does not inherit a shell's
`CREW_API_KEY`: start it from a terminal (`code .`), or run `launchctl setenv
CREW_API_KEY <key>` once per login. `crew doctor` warns on macOS when the key is
absent from the login environment.

### 3.8 Run the preflight and the self-test

```sh
crew doctor my-workspace/my-product
```

This is entirely read-only. It checks: the config parses, your machine's
`ship.name` matches a Ships row, the repo checkout(s) for this route exist
and have working hooks (`.crew.yaml` or the fallback in `crew.yaml`), the
tools it needs are on `PATH`, the agent binary exists, and the tracker
actually answers with that API key. Fix anything it flags before continuing.

Then prove an agent run works here:

```sh
crew selftest my-workspace/my-product
```

It launches each configured toolchain exactly as a scheduled run would and asks
it to read the workspace's name through the tracker. It passes when the reply
names the workspace, and otherwise names what failed; see
[If something's stuck](#if-something-s-stuck). It writes nothing to the
tracker. `--json` prints one result per toolchain, and `--toolchain NAME`
tests one.

### 3.9 Turn the route on

Once `doctor` is clean, flip the route live:

```yaml
routes:
  - route: my-workspace/my-product
    enabled: true
```

Or let `crew doctor --fix` do it: for every route that passes all checks, has
a checkout and is still `enabled: false` it asks (one yes/no per route) and
writes just that key; then, if no scheduler is installed for this ship, it
offers to run `crew install`. Run in a terminal with no flag, `doctor` offers
the same at the end of its report; piped or scripted, a plain `doctor` never
prompts and never changes anything. It prints every change it made. A route
runs without release hooks (deploy, released, CI): those gaps are listed as
"release readiness", `--fix` notes them when it enables the route, and a
release stops at the first missing hook. A route it does not enable is named
with its first blocking problem.

Nothing writes to the tracker, wakes an agent, or deploys anything until
this is `true` — it's the one switch that matters most, so leave it `false`
during all of the above.

### 3.10 Try it by hand first

Before putting it on a timer, run one cycle manually and watch what it does:

```sh
crew poll my-workspace/my-product     # decides what it WOULD do; writes nothing
crew run my-workspace/my-product      # actually runs the winning role's session
crew watch my-workspace/my-product    # live view while it's running
```

### 3.11 Put it on a timer

```sh
crew install             # writes and loads this platform's own scheduler unit
crew install --dry-run   # see what it would do first
```

This picks the right mechanism itself — a launchd user agent on macOS, a
systemd user timer on Linux (crontab as a fallback) — and never fires
immediately; the first poll happens one interval after `install` runs.

**API key from the environment.** A route with no `apiKey` and no
`apiKeyFile`/`apiKeyVar` falls back to the `CREW_API_KEY` environment
variable (explicit config always wins). The scheduled job does not inherit
your interactive shell, so the variable must be in the job's own environment
(for launchd, an `EnvironmentVariables` entry in the plist), not just
exported in your shell profile.

**Seat identity.** The ship key above is a person's key. For each seat persona
(dev, design, QA, triage) that `crew agents sync` has linked to an Agents row,
`crew connect` and `crew agents sync` use the ship key once to mint a separate
agent API key for that seat and keep it in the OS keychain, keyed by workspace
and agent. A lane's own tracker writes (claim, status, assignee, comments) and
the `CREW_API_KEY` its harness receives then use the seat's key, so the event
log records `actor_kind: agent` and table rules can tell a seat from a person.
The ship key stays for connect, admin commands and Pair sessions. A seat with no
stored key (an older install, a refused mint, no keychain) still runs as the
ship, with a warning line on the run log naming why. `crew doctor` prints the
identity each seat will write as. Minting needs an unlocked login keychain (run from the console session, or `security unlock-keychain` first over SSH): the keychain is probed before any key is minted, and a key that cannot be stored is revoked rather than left live. Seat keys are minted by whoever runs `crew agents sync` on that ship, with either a workspace admin key or a project role that grants the "Mint agent keys" capability; the server decides, and a refused mint is reported once ("your role does not grant Mint agent keys") with the seats staying on the ship key. Each ship holds its own keys, and `crew agents sync --revoke-seat-keys` revokes them server-side and clears the keychain so the next sync mints fresh ones. `crew doctor` prints `can mint agent keys: yes/no`. The agent's workspace membership needs a role
on the project, assigned once by a workspace admin the same way as for a
human member.

Useful day-to-day commands once it's running:

```sh
crew status my-workspace/my-product   # paused/running state
crew log my-workspace/my-product      # tail the log
crew sample-ticket my-workspace/my-product   # watch one throwaway ticket go dev -> QA -> release
crew inbox                            # your own tickets, across every workspace
crew pause my-workspace/my-product    # stop it without uninstalling
```

---

## Attaching a checkout to a route

`crew repos add [workspace/project] [name] [path]` points a route at a local
checkout without editing `crew.yaml` by hand. Every argument is optional: run
from inside the checkout, `crew repos add` alone uses the current directory,
the only configured route (several routes: name one), and a repo name taken
from the checkout's `origin` remote. A single trailing argument is a path if it
is an existing directory, otherwise a repo name. It checks that the path is a git checkout,
reads its `origin`, and matches that against the route's Repos table (the ids
`crew connect` resolved). A match records the checkout under the Repos row's
name. With no match, it creates the Repos row for you: `name` is the `--name` / `name` argument, else the
remote's repo name, else the folder name, `remote` the normalised `owner/repo`, and
`platform` / `release_mode` / `ci_provider` come from the checkout's own
`.crew.yaml` when it has one (else `unix` / `local` / `none`). The row's project
is `--project <name>` if given, else the route's area, else the tracker's only
project; with several projects and none chosen the command stops and asks for
`--project`, leaving `crew.yaml` untouched. Pass `--no-create` to keep the old
warn-only behaviour, for a Repos table you manage by hand.

- A route's first checkout is written as `dir:`. Adding a second turns `dir:`
  into a `repos:` map holding both. Comments and other routes are left alone.
- Adding a path the route already has is refused. `--dry-run` prints the
  resulting route block, and the Repos row it would create, instead of writing.
- `crew repos list <workspace/project>` prints what is configured, with the
  Repos row each checkout matches, so you can confirm the add.

Neither command adds hooks: a repo's own `.crew.yaml` still supplies those.
For a checkout that has none, `crew repos hooks [workspace/project] <name>`
reads its `package.json`, `Package.swift`, `pyproject.toml` or `Makefile` and
prints proposed `test`/`build` hooks (plus `version`/`bump` for an npm package).
`--write route` stores them in `crew.yaml` for this machine, keeping any hook
the route already sets; `--write repo` writes a starter `.crew.yaml` into the
checkout for you to review and commit, which is the durable choice, and it
will not overwrite an existing file.

## Connecting a repo that has no `.crew.yaml`

A repo tells crew how to test/build/deploy/version it via a `.crew.yaml` at
its root (see [the repo spec](/repo-spec) for the full field reference). If a repo
you need to work hasn't adopted that file yet, you are **not** blocked —
declare the same things in your machine's `crew.yaml` instead, under that
route:

```yaml
routes:
  - route: my-workspace/my-product
    enabled: true
    dir: "/home/me/src/legacy-repo"    # single-repo route; use `repos:` for several

    hooks:
      test: "npm test"
      build: "npm run build"
      deploy: "./deploy.sh"            # only needed if release.mode is `local`
```

A few things worth knowing before you do this:

- **A repo's own `.crew.yaml`, if it ever gets one, wins outright.** Whatever
  you declared here becomes dead weight the moment the repo adopts the
  file — `crew doctor` will call this out as *drift* so you notice and clean
  it up, rather than silently ignoring your route-level hooks.
- **Precedence is repo > ship > default, per field**, so a repo can adopt the
  spec one field at a time. Declaring only `hooks.test` in the repo file
  still lets your route-level `build`/`deploy` keep working for the rest.
- **The merged result still has to be valid.** Even sourced entirely from
  `crew.yaml`, a route with `release.mode: local` still needs a `deploy`
  hook, `ci_manual`/`ci_auto` still need `hooks.released`, and so on — see
  [the repo spec](/repo-spec)'s "Rules" section for the full list of checks.
- **Prefer adding the real `.crew.yaml` to the repo when you can.** It's the
  durable fix: the hooks live under review, next to what they build, instead
  of on one person's machine. The route-level escape hatch exists for repos
  you can't (or haven't yet) sent a PR to.

---

## Advanced: an existing `crew.yaml`

The wizard only runs when no `crew.yaml` exists. If you already have one (a
second workspace, a config copied from another machine, or a hand-written
file), `crew connect <workspace>` resolves the ids and prints the route block
for you to paste under `routes:`, with `enabled: false`. Everything the file
may contain is commented in `crew.example.yaml`; unknown keys are a hard error,
not a warning.

crew looks for the file in `$CREW_CONFIG`, then `$XDG_CONFIG_HOME/crew`, then
`~/.config/crew/crew.yaml`, and only then beside the checkout. Keep it mode
`0600`: if a route carries an `apiKey` instead of the keychain credential, it
is stored in plaintext there.

---

## If something's stuck

- `crew doctor <route>` first, always — it's read-only and points at the
  specific thing that's wrong (bad key, missing Ships row, missing hook,
  unreachable tracker).
- Config file rejected outright with an "unknown key" error → you likely
  mistyped a field name; check the exact key names in `crew.example.yaml`
  or [the repo spec](/repo-spec).
- `doctor` says your `ship.name` doesn't match anything → check the Ships
  table in the workspace (1.2) rather than guessing at the name.
- Tracker calls fail with something that looks like a bot-blocking page
  rather than JSON → check `userAgent` in `crew.yaml`; the default already
  works around Cloudflare blocking bare tool user agents, so this usually
  means it was overridden to something that doesn't start with `Mozilla/5.0`.
- `crew_outdated` in `crew status` or the log, with "crew X is below this
  workspace's minimum Y — no ticket will be picked until it is updated" → the
  workspace sets a minimum crew version and this crew is older. Nothing is
  claimed and the heartbeat keeps running. Update (the Crew app's Settings has
  an **Update** button; on the CLI, `npm install -g @tablation/crew` or the
  newest binary tarball) and it resumes on its own. Tracker writes from an
  older crew are also refused with HTTP 426.
- `push auth <repo>: FAILED` in `crew doctor` (or a failed push check in the
  app's Repositories step) → a seat could build a branch but not push it. The
  line carries the fix: `gh auth login` then `gh auth setup-git` for an HTTPS
  remote, or `ssh-add` for an SSH one. `crew doctor --offline` skips the probe.
- **A ticket reaches `fixed` but the seat never pushed** → the runner completes
  the hand-off itself. When a build or design run ends at `fixed` and the ticket
  branch is missing on the remote, or the remote is strictly behind the local
  tip, the runner does a plain `git push --set-upstream` (never forced) and
  records `pushed <sha> to <remote>/<branch>` plus a note that it pushed on the
  seat's behalf. It does not run the repo's `ci_status` hook, and the note says
  so when the repo defines one. It still bounces the ticket back to
  `in_progress` when the remote has moved (its tip is not an ancestor of the
  local tip) or the push is refused, quoting git's error in the bounce comment.
  `crew run --dry-run` prints `would push <branch> to <remote>` and pushes
  nothing.
- **Self-test failures** (`crew selftest`, or the Verify step) each name a
  class and a remedy:

  | Class | Meaning | Remedy |
  | --- | --- | --- |
  | `binary-not-found` | The agent binary is not on the scheduler's `PATH` | Add its directory to `ship.extraPath` in `crew.yaml`, then `crew doctor` |
  | `login-missing` | The vendor CLI is not signed in | Log in to it in a terminal on this machine, then re-run `crew selftest` (the app's **Open Terminal** runs the command) |
  | `mcp-unavailable` | The tracker MCP tool was not available to the agent | Register the Tablation MCP server (`crew doctor` shows how), then re-run |
  | `key-refused` | The dev seat's key was refused | Ask a workspace admin to mint a fresh one with `crew agents sync` |
  | `keychain-locked` | The OS keychain is locked | Unlock it from a logged-in session (`security unlock-keychain`), then re-run |
  | `keychain-error` | Reading the seat key from the OS keychain failed for a reason other than a lock (the detail names the `security` exit code) | Run `security find-generic-password -s com.tablation.cli -g` by hand, and check `security list-keychains -d user` and `security default-keychain -d user` |
  | `keychain-error` (detail names `JSON Parse`) | The stored seat key could not be parsed. A hex `password:` line from `security find-generic-password -s com.tablation.cli -g` means the value holds non-ASCII text, for example a ship name with a typographic apostrophe | Update crew; the fixed `@tablation/client` reads the stored value as it is, so nothing is re-minted |
  | `timeout` | The harness did not answer in time | Run it by hand to see where it stalls |
  | `wrong-answer` | The agent answered but did not name the workspace | Run it by hand to see what it said |
