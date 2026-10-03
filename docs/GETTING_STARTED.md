# Getting started with crew

This walks a new engineer from "no account" to a running crew seat polling a
real workspace's issue tracker on Tablation. It assumes nothing already
exists on your machine or your Tablation account.

There are two halves to this:

1. **Get into Tablation** — an account and workspace access.
2. **Install and connect crew** — the CLI that turns that access into a
   running, polling seat. Four commands do the core of it:
   `npm install -g @tablation/crew`, `crew connect`, `crew repos add`,
   `crew doctor --fix`.

## Contents

- [Part 1 — Get into Tablation](#part-1-get-into-tablation)
  - [1.1 Get invited](#_1-1-get-invited)
  - [1.2 Confirm you're a workspace admin](#_1-2-confirm-you-re-a-workspace-admin)
  - [1.3 Your machine's Ships row](#_1-3-your-machine-s-ships-row)
- [Part 2 — Install and connect crew](#part-2-install-and-connect-crew)
- [Part 3 — crew-macos (optional menu bar front end)](#part-3-crew-macos-optional-menu-bar-front-end)
- [Attaching a checkout to a route](#attaching-a-checkout-to-a-route)
- [Connecting a repo that has no `.crew.yaml`](#connecting-a-repo-that-has-no-crew-yaml)
- [Advanced: an existing `crew.yaml`](#advanced-an-existing-crew-yaml)
- [If something's stuck](#if-something-s-stuck)

Hosting other people's agent sessions on your machine is a separate, optional
capability: see [Host Passengers](/host-passengers).

---

## Part 1 — Get into Tablation

### 1.1 Get invited

Access to a workspace is invite-only today. Ask whoever administers the
workspace you're joining (a **workspace admin**) to send you an invite from
their **Users** panel (Settings → Users → *Invite by email*). You'll get a
link shaped like:

```
https://app.tablation.com/accept-invite?token=<token>
```

Open it, set a password, and you're in. If you don't have a link, ask the
admin to resend one rather than guessing at a signup URL — there's no public
self-serve signup.

### 1.2 Confirm you're a workspace admin

Connecting a machine — signing in from `crew connect`, adding it to the Ships
table, seeing the Crew/Issues tables — requires **workspace admin** on the
workspace you're connecting to, not just membership. If Settings shows no
"Users" tab, you're a plain member: ask the workspace admin to promote you.

### 1.3 Your machine's Ships row

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

## Part 2 — Install and connect crew

### 2.1 Prerequisites

- **Node 22 or newer** (`node -v`). The `claude` agent binary is separate; crew
  asks where it is during `crew connect`.
- **git**, and a checkout of each repo you want this machine to work.
- Docker, only if you will [host Passengers](/host-passengers).

No other checkout is needed: crew installs from npm, and its tracker client
(`@tablation/client`) comes with it.

### 2.2 Install

```sh
npm install -g @tablation/crew
crew --help
```

### 2.3 Connect to a workspace

```sh
crew connect my-workspace
```

The workspace is normally the only thing you need to name — `crew connect`
defaults the project to the `issues`-slugged project (the workspace's
install of the `crew.issues` Library template, i.e. the tracker itself). If
that project isn't there yet, it offers to install it from the Library on a
real terminal (say yes, or decline and set one up in the app first). Only
pass a project explicitly (`crew connect my-workspace/my-product`, or
`--project`) when you deliberately want a different, non-default tracker
project.

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

`connect` also records you, by identity, as the owner of this ship's row in the
Ships table, when that table has an `owner_id` column (a workspace that has not
taken the latest Issues template update just skips it and says so).

Either way, it looks up the workspace (and project) by slug, resolves their
internal ids (and the Issues/Comments/Crew/Ships table ids inside them), and
writes the result to a local state file — nothing here starts polling or
touches the tracker's data beyond reading it. Re-running it later only asks
about anything genuinely new.

### 2.4 Attach your repo checkouts

```sh
crew repos add my-workspace/issues ~/src/my-product
```

See [Attaching a checkout to a route](#attaching-a-checkout-to-a-route) for what
it matches and writes. Repeat for each repo this machine should work.

### 2.5 Sync personas and skills

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

### 2.6 Register the Tablation MCP server

The polled seats (dev/design/QA/triage) talk to the tracker entirely
through crew's own REST calls — this step is for anyone driving a live,
interactive Claude Code session against the tracker: the **Pair** persona,
or a session invoked via an Epic's `grill_link` to run the `Grill-Me`
skill (§2.5). Neither works well without the `mcp__tablation__*` tools —
Pair's own brief and the `Grill-Me` skill both assume they're available,
and fall back to slower, error-prone raw `curl` calls without them.

Tablation exposes an MCP server at `/api/mcp` on the same backend as the
REST API, using the Streamable HTTP transport, authenticated the same way
as everything else — a workspace `sk_...` API key, presented as a Bearer
token when the MCP session starts:

```sh
claude mcp add --transport http tablation https://app.tablation.com/api/mcp \
  --header "Authorization: Bearer sk_..." \
  --scope local
```

Notes:

- **Hostname**: Modify `app.tablation.com` to match the hostname for any dev
  instance you're using.
- **The key**: MCP needs a workspace `sk_...` API key. `crew connect` keeps its
  own credential in the keychain rather than showing you one, so mint a key
  for this from **Settings → API Keys** (workspace admins). There is no
  scope-narrowing mechanism today, so the key can reach everything its holder
  can reach over the REST API.
- **`--scope local`** stores this in your own `~/.claude.json`, not shared
  with anyone else or checked into a repo — right for a key. `--scope
  project` writes a shared `.mcp.json`, which is fine for the *server URL*
  but never commit a raw key in it; use that scope only with env-var
  expansion (`"Authorization": "Bearer ${TABLATION_API_KEY}"`) and an
  `export` in your own shell profile.
- This has to be run once per machine (or per project, at `project` scope)
  — there's no `crew connect`-driven auto-registration for it today (a
  filed idea, not built).
- The server is plain HTTP, not HTTPS, when the backend is running on
  `localhost` — swap in whatever host you're actually pointed at.

### 2.7 Run the preflight

```sh
crew doctor my-workspace/my-product
```

This is entirely read-only. It checks: the config parses, your machine's
`ship.name` matches a Ships row, the repo checkout(s) for this route exist
and have working hooks (`.crew.yaml` or the fallback in `crew.yaml`), the
tools it needs are on `PATH`, the agent binary exists, and the tracker
actually answers with that API key. Fix anything it flags before continuing.

### 2.8 Turn the route on

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
prompts and never changes anything. It prints every change it made.

Nothing writes to the tracker, wakes an agent, or deploys anything until
this is `true` — it's the one switch that matters most, so leave it `false`
during all of the above.

### 2.9 Try it by hand first

Before putting it on a timer, run one cycle manually and watch what it does:

```sh
crew poll my-workspace/my-product     # decides what it WOULD do; writes nothing
crew run my-workspace/my-product      # actually runs the winning role's session
crew watch my-workspace/my-product    # live view while it's running
```

### 2.10 Put it on a timer

```sh
crew install             # writes and loads this platform's own scheduler unit
crew install --dry-run   # see what it would do first
```

This picks the right mechanism itself — a launchd user agent on macOS, a
systemd user timer on Linux (crontab as a fallback) — and never fires
immediately; the first poll happens one interval after `install` runs.

Useful day-to-day commands once it's running:

```sh
crew status my-workspace/my-product   # paused/running state
crew log my-workspace/my-product      # tail the log
crew inbox                            # your own tickets, across every workspace
crew pause my-workspace/my-product    # stop it without uninstalling
```

---

## Part 3 — crew-macos (optional menu bar front end)

`crew-macos` is a macOS menu bar app that sits on top of everything in Part
2 — it shows which seat is working, on what ticket, in which repo, and how
far through the cycle it is, plus a live log window and two switches
(pause the crew; stop the timer). It writes nothing itself: every action it
offers goes through your existing `crew`, so it can't drift from what
the CLI would do.

It only makes sense **after** Part 2 — specifically after `crew install`
(2.10) — because it locates your checkout by reading the installed
launchd job, not by asking you for a path.

### 3.1 Requirements

macOS 14+ and Xcode 16+ (Swift 6). No package dependencies to install
separately. There's no App Store listing or downloadable build — it's built
from source.

### 3.2 Clone and build

```sh
git clone <crew-macos remote> crew-macos
cd crew-macos
make app        # builds Crew.app in this directory
make run        # builds it and launches it
```

`make app` signs the build **ad-hoc** by default (no certificate, no
notarisation) — fine for trying it out. If you're keeping it installed
long-term, sign it with a real identity instead, so macOS doesn't treat a
later rebuild as a different app and re-ask for permissions it already
granted:

```sh
make identities     # lists what this machine can sign with
make install SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
```

`make install` (with or without `SIGN_IDENTITY`) copies the built app into
`/Applications`.

### 3.3 How it finds your setup

You don't configure this app separately — it reuses what you already set up
in Part 2:

- **Config**: the same search order as the CLI (`$CREW_CONFIG`, then
  `$XDG_CONFIG_HOME/crew`, then `~/.config/crew/crew.yaml`), so the app and
  `crew` can never disagree about which file is in force.
- **Checkout**: read out of the launchd plist that `crew install`
  wrote — the interpreter path and `crew`'s absolute path, exactly as
  the timer invokes them. This is why 2.10 has to happen first; without an
  installed timer there's no plist for it to read.

Both can be overridden in the app's own Settings if you need to point it
somewhere nonstandard.

### 3.4 Check it's seeing the right thing

```sh
./Crew.app/Contents/MacOS/Crew --probe
```

This prints, as plain text, exactly what the menu is built from: which
config file it found, which `crew`/interpreter it's invoking, whether
`crew status --json` answered, the current pause/lock state, and the
worktrees it sees on disk with the repo each one belongs to. Run this first
if the menu shows nothing, or shows something stale — it's a menu bar app,
so there's no console output to check otherwise.

If it's still unclear, turn on verbose logging and watch the log directly:

```sh
defaults write com.tablation.crew.menubar debugLogging -bool true   # then relaunch
tail -f ~/Library/Logs/Crew.log
```

---

## Attaching a checkout to a route

`crew repos add <workspace/project> <path>` points a route at a local checkout
without editing `crew.yaml` by hand. It checks that `<path>` is a git checkout,
reads its `origin`, and matches that against the route's Repos table (the ids
`crew connect` resolved). A match records the checkout under the Repos row's
name; no match warns that the tracker has no Repos row for that remote, and
adds it anyway, in case you are about to create the row.

- A route's first checkout is written as `dir:`. Adding a second turns `dir:`
  into a `repos:` map holding both. Comments and other routes are left alone.
- Adding a path the route already has is refused. `--dry-run` prints the
  resulting route block instead of writing.
- `crew repos list <workspace/project>` prints what is configured, with the
  Repos row each checkout matches, so you can confirm the add.

Neither command adds hooks: a repo's own `.crew.yaml` still supplies those.

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
  table in the workspace (1.3) rather than guessing at the name.
- Tracker calls fail with something that looks like a bot-blocking page
  rather than JSON → check `userAgent` in `crew.yaml`; the default already
  works around Cloudflare blocking bare tool user agents, so this usually
  means it was overridden to something that doesn't start with `Mozilla/5.0`.
