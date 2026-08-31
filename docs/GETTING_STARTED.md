# Getting started with crew

This walks a new engineer from "no account" to a running crew seat polling a
real workspace's issue tracker on Tablation. It assumes nothing already
exists on your machine or your Tablation account.

There are two halves to this:

1. **Get into Tablation** — an account, workspace access, and an API key.
2. **Install and connect crew** — the CLI that turns that access into a
   running, polling seat.

## Contents

- [Part 1 — Get into Tablation](#part-1--get-into-tablation)
  - [1.1 Get invited](#11-get-invited)
  - [1.2 Confirm you're a workspace admin](#12-confirm-youre-a-workspace-admin)
  - [1.3 Create an API key](#13-create-an-api-key)
  - [1.4 Make sure your machine has a Ships row](#14-make-sure-your-machine-has-a-ships-row)
- [Part 2 — Install and connect crew](#part-2--install-and-connect-crew)
  - [2.1 Prerequisites](#21-prerequisites)
  - [2.2 Clone and build](#22-clone-and-build)
  - [2.3 Write your machine config](#23-write-your-machine-config)
  - [2.4 Resolve the workspace](#24-resolve-the-workspace)
  - [2.5 Run the preflight](#25-run-the-preflight)
  - [2.6 Turn the route on](#26-turn-the-route-on)
  - [2.7 Try it by hand first](#27-try-it-by-hand-first)
  - [2.8 Put it on a timer](#28-put-it-on-a-timer)
- [Part 3 — crew-macos (optional menu bar front end)](#part-3--crew-macos-optional-menu-bar-front-end)
  - [3.1 Requirements](#31-requirements)
  - [3.2 Clone and build](#32-clone-and-build)
  - [3.3 How it finds your setup](#33-how-it-finds-your-setup)
  - [3.4 Check it's seeing the right thing](#34-check-its-seeing-the-right-thing)
- [Connecting a repo that has no `.crew.yaml`](#connecting-a-repo-that-has-no-crewyaml)
- [If something's stuck](#if-somethings-stuck)

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

Everything below — creating an API key, adding your machine to the Ships
table, seeing the Crew/Issues tables — requires **workspace admin** on the
workspace you're connecting to, not just membership. If Settings shows no
"API Keys" or "Users" tab, you're a plain member: ask the workspace admin to
promote you (or have them do the steps in 1.3–1.4 and hand you the values).

### 1.3 Create an API key

In the app: **Settings → API Keys** (only visible to workspace admins) →
give it a name → **Create**. The raw key (`sk_...`) is shown exactly once —
copy it somewhere safe immediately. If you lose it, revoke it and make a new
one; it can't be recovered.

This key is bound to both the workspace and your user — crew acts as you
when it uses it.

### 1.4 Make sure your machine has a Ships row

crew identifies "this machine" by a name that must match a row in the
workspace's **Ships** table. If you're setting up a brand-new machine, add a
row there (name it something recognizable, e.g. `"Brad's MacBook"`) before
moving on — `crew connect` and `crew doctor` will complain if it's missing.
An existing team usually already has a convention for this; ask before
inventing your own.

---

## Part 2 — Install and connect crew

### 2.1 Prerequisites

- **Node 24.19.0** (crew's `.nvmrc`). If you use nvm, `nvm use` in the crew
  checkout picks it up; nvm itself may live at `~/.local/share/nvm` rather
  than `~/.nvm` — check both if `nvm` isn't found.
- **pnpm** (crew is a pnpm workspace).
- `crew`'s `package.json` depends on `@tablation/client` via a local
  `link:../tablation-js/packages/client` — you need a sibling checkout of
  **tablation-js** one directory up from `crew`, or `pnpm install` will fail
  to resolve it.

### 2.2 Clone and build

```sh
# both checkouts live side by side
git clone <tablation-js remote> tablation-js
git clone <crew remote> crew

cd crew
pnpm install
```

`bin/crew` runs straight off `src/cli.ts` (Node's native type-stripping) if
there's no `dist/`, so you don't strictly need a build step to try it. For a
long-lived install, build it once:

```sh
pnpm run build
```

### 2.3 Write your machine config

The config describing **this machine** lives outside the checkout, so
reinstalling or moving the checkout never loses it:

```sh
mkdir -p ~/.config/crew
cp crew.example.yaml ~/.config/crew/crew.yaml
chmod 600 ~/.config/crew/crew.yaml     # it holds an API key in plaintext
$EDITOR ~/.config/crew/crew.yaml
```

(`crew` looks in `$CREW_CONFIG`, then `$XDG_CONFIG_HOME/crew`, then
`~/.config/crew/crew.yaml`, and only then beside the checkout — the file
above is the normal path.)

Fill in at minimum:

```yaml
ship:
  name: "Brad's MacBook"             # MUST match a row in the Ships table (1.4)
  agent:
    bin: "/usr/local/bin/claude"     # absolute path — a timer runs with a minimal PATH
    model: "claude-sonnet-5"
  extraPath: "/opt/homebrew/bin"     # wherever pnpm/node/etc. actually live for hooks
  useNvm: true

routes:
  - route: my-workspace/my-product   # the workspace/project slug pair you were invited to
    enabled: false                   # leave false until `doctor` is clean (see 2.5)
    area: "My Product"
    apiKey: "sk_..."                 # the key from 1.3 (or set ship.apiKey once, covering every route)
```

Everything else in `crew.example.yaml` is commented with what it does and
when you'd need it — repo checkout paths, a custom `promptSet`, per-route
`baseUrl` for a self-hosted tracker, etc. Leave what you don't need
commented out; unknown keys are a hard error, not a warning, so don't add
things speculatively.

### 2.4 Resolve the workspace

```sh
bin/crew connect my-workspace/my-product
```

This looks up the workspace and project by slug, resolves their internal ids
(and the Issues/Comments/Crew/Ships table ids inside them), and writes the
result to a local state file — nothing here starts polling or touches the
tracker's data beyond reading it. Re-running it later only asks about
anything genuinely new; it won't re-ask what it already resolved.

### 2.5 Run the preflight

```sh
bin/crew doctor my-workspace/my-product
```

This is entirely read-only. It checks: the config parses, your machine's
`ship.name` matches a Ships row, the repo checkout(s) for this route exist
and have working hooks (`.crew.yaml` or the fallback in `crew.yaml`), the
tools it needs are on `PATH`, the agent binary exists, and the tracker
actually answers with that API key. Fix anything it flags before continuing.

### 2.6 Turn the route on

Once `doctor` is clean, flip the route live:

```yaml
routes:
  - route: my-workspace/my-product
    enabled: true
```

Nothing writes to the tracker, wakes an agent, or deploys anything until
this is `true` — it's the one switch that matters most, so leave it `false`
during all of the above.

### 2.7 Try it by hand first

Before putting it on a timer, run one cycle manually and watch what it does:

```sh
bin/crew poll my-workspace/my-product     # decides what it WOULD do; writes nothing
bin/crew run my-workspace/my-product      # actually runs the winning role's session
bin/crew watch my-workspace/my-product    # live view while it's running
```

### 2.8 Put it on a timer

```sh
bin/crew install             # writes and loads this platform's own scheduler unit
bin/crew install --dry-run   # see what it would do first
```

This picks the right mechanism itself — a launchd user agent on macOS, a
systemd user timer on Linux (crontab as a fallback) — and never fires
immediately; the first poll happens one interval after `install` runs.

Useful day-to-day commands once it's running:

```sh
bin/crew status my-workspace/my-product   # paused/running state
bin/crew log my-workspace/my-product      # tail the log
bin/crew inbox                            # your own tickets, across every workspace
bin/crew pause my-workspace/my-product    # stop it without uninstalling
```

---

## Part 3 — crew-macos (optional menu bar front end)

`crew-macos` is a macOS menu bar app that sits on top of everything in Part
2 — it shows which seat is working, on what ticket, in which repo, and how
far through the cycle it is, plus a live log window and two switches
(pause the crew; stop the timer). It writes nothing itself: every action it
offers goes through your existing `bin/crew`, so it can't drift from what
the CLI would do.

It only makes sense **after** Part 2 — specifically after `bin/crew install`
(2.8) — because it locates your checkout by reading the installed
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
  `bin/crew` can never disagree about which file is in force.
- **Checkout**: read out of the launchd plist that `bin/crew install`
  wrote — the interpreter path and `bin/crew`'s absolute path, exactly as
  the timer invokes them. This is why 2.8 has to happen first; without an
  installed timer there's no plist for it to read.

Both can be overridden in the app's own Settings if you need to point it
somewhere nonstandard.

### 3.4 Check it's seeing the right thing

```sh
./Crew.app/Contents/MacOS/Crew --probe
```

This prints, as plain text, exactly what the menu is built from: which
config file it found, which `bin/crew`/interpreter it's invoking, whether
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

## Connecting a repo that has no `.crew.yaml`

A repo tells crew how to test/build/deploy/version it via a `.crew.yaml` at
its root (see `docs/REPO_SPEC.md` for the full field reference). If a repo
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
  `docs/REPO_SPEC.md`'s "Rules" section for the full list of checks.
- **Prefer adding the real `.crew.yaml` to the repo when you can.** It's the
  durable fix: the hooks live under review, next to what they build, instead
  of on one person's machine. The route-level escape hatch exists for repos
  you can't (or haven't yet) sent a PR to.

---

## If something's stuck

- `bin/crew doctor <route>` first, always — it's read-only and points at the
  specific thing that's wrong (bad key, missing Ships row, missing hook,
  unreachable tracker).
- Config file rejected outright with an "unknown key" error → you likely
  mistyped a field name; check the exact key names in `crew.example.yaml`
  or `docs/REPO_SPEC.md`.
- `doctor` says your `ship.name` doesn't match anything → check the Ships
  table in the workspace (1.4) rather than guessing at the name.
- Tracker calls fail with something that looks like a bot-blocking page
  rather than JSON → check `userAgent` in `crew.yaml`; the default already
  works around Cloudflare blocking bare tool user agents, so this usually
  means it was overridden to something that doesn't start with `Mozilla/5.0`.
