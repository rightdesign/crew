# Periscope

A **periscope** is a throwaway, running preview of a repository, served from a
ship, so someone can look at a change taking shape before it is a ticket.
Pair offers one when a conversation is about how something should look or
behave rather than what the code says. It costs the ship a worktree and a dev
server, and nothing else on the board moves until the periscope is ended.

Ending is always explicit: crew never decides for you whether the work was
worth keeping. See [`periscope down`](#ending-a-periscope).

## Opening one

```sh
crew periscope up my-workspace/issues my-repo --topic "Compact table rows"
```

`start` is an alias of `up`. The command:

1. Files a **draft** ticket named `Periscope: <topic>`, held by the Pair row
   (or the row given with `--assignee`), so no lane picks it up.
2. Cuts a worktree for that ticket from the remote base, copies the
   repository's `worktrees.copy` files and runs its `setup` hook, then
   `ports`, `isolate` (only with `--isolate`) and `handoff`.
3. Runs the repository's `preview` hook. Its last line of output is the URL.
4. Records a `live` row in the workspace's Periscopes table and posts a
   progress comment on the ticket with the URL.

It refuses, before filing anything, when the repository declares no `preview`
hook, the workspace has no Periscopes table, or the ship already hosts
`ship.maxPeriscopes` live periscopes. `--dry-run` reports those refusals and
the plan and writes nothing. If `preview` fails or prints no URL, crew stops
what it started, removes the worktree and closes the draft.

`crew periscope list` shows the live periscopes on the ship with the minutes
since each was last active and whether its server is listening.

## From the chat

In an agent chat (the app or Slack), start a message with the word
`periscope` and name an issue: "periscope for ISSUE-123 on my machine". The
Periscope skill, which runs as Pair, looks the issue up, refuses one that is
held or has a run in flight, pins the host if you named one, opens the preview
on that issue and posts the URL. Anyone in the thread can ask for changes,
which are applied in the preview's worktree only; whether to keep or discard
it is up to the person who started the conversation. When no ship offers
previews the agent says so and stops; it does not file a ticket instead.

## Ending a periscope

```sh
crew periscope down my-workspace/issues 123 --keep
crew periscope down my-workspace/issues 123 --discard
```

`end` is an alias of `down`. Exactly one of the two flags is required.

| | `--keep` | `--discard` |
|---|---|---|
| Branch | Everything is committed and the branch is pushed. | Deleted locally; nothing is pushed. |
| Worktree and server | Server stopped, worktree removed. | Server stopped, worktree removed. |
| Ticket | Gains a `## Prototype` section listing the changed files, set to `new` and unassigned, so triage can size it. | Closed as `closed_obsolete` with a resolution note that the periscope was discarded. |
| Periscopes row | `kept` | `discarded` |

A kept branch began as a prototype and may be rewritten rather than treated as
reviewed work; the `## Prototype` section says so. `--keep` with nothing to
commit refuses and changes nothing unless you pass `--allow-empty`. Ending a
periscope that is already kept or discarded is reported and changes nothing.

An isolated periscope's database is left alone, as with `crew drop`.

## Opening one from a shell

A person at a terminal does not need to name anything: run `crew periscope up`
inside a configured checkout, or inside any git worktree of one, and the
working directory picks the route and repository (explicit `[route] REPO`
arguments still win). The topic is prompted for, or defaults to
`<repo>, <date>`; the URL is opened in the browser unless `--no-open` is given.
`crew periscope down --keep|--discard` with no ticket number, run from inside a
periscope's worktree, ends that periscope.

A process cannot change the directory of the shell that ran it, so the bare
command never moves you. To land in the worktree, install the shell function
once, in your rc file:

```sh
eval "$(crew shell-init)"        # zsh or bash; add --shell fish for fish
```

`periscope up` then runs the command, changes into the new worktree and opens
the URL; `periscope down` ends the periscope and changes back to the
repository's checkout; any other `periscope` subcommand passes through.

## Shared or isolated state

By default a periscope runs against the same state the repository's `ports`
and `setup` hooks point at, which is usually the ship's ordinary development
database. Anything the previewed code writes is written there. Pass
`--isolate` to run the repository's `isolate` hook, which should point the
worktree at state of its own; the row records that the periscope is
`isolated`. Use it for any change that touches a schema or writes data you
care about.

## What a repository must declare: the `preview` hook

A repository opts in by declaring `hooks.preview` in its
[`.crew.yaml`](/repo-spec). The hook starts this worktree's dev server and
prints its URL as the **last line of stdout**. It runs from the worktree
after `setup` and `ports`, with the `ports` output exported plus
`CREW_PREVIEW_HOST`, `CREW_TICKET`, `CREW_BRANCH`, and, for a periscope,
`CREW_PERISCOPE=1` and `CREW_POINTED_AT_FILE` (see
[Pointing at something](#pointing-at-something)).

Two rules follow from there being no stop hook:

- The server must outlive the hook, so start it detached (`nohup … &`).
- Crew stops it by killing whatever listens on the worktree's ports, so the
  server must listen on ports the `ports` hook reserved.

Bind to `CREW_PREVIEW_HOST` rather than `localhost`, or a viewer on another
machine cannot reach it. A dev server whose hot-reload socket runs on a
separate port needs both ports from `ports`, and the page it serves has to
point its socket at the same host:

```yaml
hooks:
  ports: scripts/dev-ports.sh      # prints APP_PORT=… and HMR_PORT=…
  preview: |
    nohup pnpm dev --host "${CREW_PREVIEW_HOST:-localhost}" \
      --port "$APP_PORT" --hmr-port "$HMR_PORT" >/dev/null 2>&1 &
    echo "http://${CREW_PREVIEW_HOST:-localhost}:$APP_PORT"
```

## Pointing at something

Every periscope's worktree has a drop file, `.crew/pointed-at.jsonl`, created
empty by `periscope up` (and by `--resume` for a periscope opened before it
existed). It is how a viewer says "this one" without describing it: each time
the viewer clicks something, a line is appended. By default crew writes it
itself, through the periscope proxy below. The preview hook still receives the
absolute path as `CREW_POINTED_AT_FILE`, together with `CREW_PERISCOPE=1`, for
a repository that keeps its own inspector (`periscope.inspector: repo`).

Each line is one JSON object: `path` (the source file, relative to the
worktree), `line` (1-based), `at` (an ISO timestamp), and optionally `column`,
`component` (a display name) and `url` (the page the click happened on). Lines
are appended, never rewritten.

- **Not part of the work.** `.crew/` is excluded from git through the
  repository's `info/exclude`, so `down --keep` never commits it.
- **Counts as activity.** A new line moves the file's modification time, which
  the idle check reads like an edit: the periscope's expiry moves forward.
- **Reading it.** `crew periscope list --json` and `crew status --json` carry
  `pointedAt`, the newest well-formed line, or `null` when nothing has been
  pointed at.
- **Clipboard fallback.** A repository with no source attributes has nothing
  to point at; the viewer pastes a file and line (or a description) into the
  chat instead.

## The proxy

`periscope up` starts a small reverse proxy in front of the URL the `preview`
hook printed, and the periscope's recorded URL (the row, `list`, what `up`
prints) is the proxy's. The dev server's own URL keeps working but is not
advertised. The proxy listens on the same address the hook was told to bind
(`CREW_PREVIEW_HOST`), on port 50000 plus the ticket number; `crew ports`
shows it as `proxy` next to the ticket, and `crew periscope list` marks the
URL `(proxy)`.

- **Injection.** For HTML responses the proxy adds one
  `<script type="module">` tag that loads the inspector overlay, which the
  proxy serves itself. Holding Alt/Option outlines the element under the
  pointer, and a click appends `{ path, line, component, url }` to the drop
  file and copies `path:line` to the clipboard. Only elements carrying a
  `data-source="<path>:<line>"` attribute can be pointed at; adding it at
  compile time stays the repository's job.
- **Pass-through.** Everything else is proxied unchanged, including the
  hot-reload websocket upgrade. A `Content-Security-Policy` header that would
  block the overlay gets `'self'` (the proxy's own origin) added to
  `default-src`, `script-src`, `script-src-elem` and `connect-src`, and nothing
  else; a policy set by a `<meta>` tag in the page is not rewritten. Compressed
  HTML is decompressed for injection and sent uncompressed.
- **Opting out.** A repository whose `.crew.yaml` sets
  `periscope.inspector: repo` serves its own overlay and drop-file route; the
  proxy is still in front, but injects nothing and serves no
  `/__periscope/` routes.
- **Lifecycle.** The proxy ends with the periscope: `down` and the idle check
  stop it with the dev server, and `up --resume` starts it again. It adds no
  authentication and no remote reach; it is the place a remote viewer's
  authentication will go.

## Periscopes for Passengers

A ship can let [Passengers](/passenger-chat) open periscopes from the agent
chat. Set `hostPeriscopes: true` on a route that already hosts Passengers, and
`ship.previewHost` to the name a Passenger reaches this ship by. What the flag
grants and does not grant is on [Host Passengers](/host-passengers#periscopes).

The preview URL is a plain address on the ship's network. It is reachable
over the LAN or a private network only; it is not relayed, and nothing about
it is public.

### The periscope's own MCP endpoint

A periscope opened through the ship's control API also gets an MCP endpoint, so
the chat agent can change the code it is previewing. The ship serves it for that
one worktree and registers it in the workspace when the periscope opens; ending
the periscope removes it.

| Tool | What it does |
|---|---|
| `read_file`, `list_directory`, `search_files` | Read the worktree (search lists files git tracks or would not ignore). |
| `write_file`, `edit_file`, `create_directory`, `delete_file` | Change files. `edit_file` replaces one exact string. |
| `run_hook` | Run `test`, `build`, `ports`, `handoff` or `preview` in the worktree with the periscope's environment, and return the output. `isolate` only for a periscope opened isolated. A hook the repository does not declare is refused. |
| `git_status`, `git_diff`, `git_commit` | Inspect and commit on the ticket branch. |

Every path is checked against the worktree's real location, so `..` and a
symlink that leaves the worktree are refused, and `.git` is never reachable.
There is no push, no checkout, no other worktree and no shell: the branch only
leaves the ship when someone ends the periscope with `--keep`. The Passenger's
own read-only server, and its container, are unchanged.

Each periscope has its own secret, minted when it opens and kept in the ship's
state directory (never in `crew status`). A request with no secret, a wrong
one, another periscope's, or for a periscope that has ended gets the same
`404`. Every tool call counts as activity for the idle expiry. The endpoint is
registered under the label `Periscope: <ship> <ticket>` with the ship's relay URL
(`<relay url>/control/periscopes/<ticket>/mcp`), which needs the route's key to
hold `REGISTER_MCP_ENDPOINTS`; the control API's `up` answer carries
`mcpEndpointId`, or `mcpWarning` when registering failed (the periscope still
opens, and the daemon retries each cycle). The registration is sent with
`discoverable: false`, so a workspace chat's general endpoint discovery never
connects to it; only the chat that opened the periscope attaches. `crew doctor`
lists the live endpoints as `periscope mcp:` and marks them `attached only`. Opening a periscope from a terminal does not
create one unless `crew periscope up --serve-mcp` is passed.

## Code tools: the repository's symbol service

When the repository declares an `intel` hook, `periscope up` runs it after `preview` and probes the URL it prints with an
MCP `initialize` request, for up to `ship.intelStartupSeconds`. The URL and the tool names the service advertised are
recorded in the periscope's sidecar (`intelUrl`, `intelTools`).

When the service answers, crew registers it as a second MCP server named `code` in the worktree's project-level harness
configuration: `.mcp.json` (Claude), `.codex/config.toml` (Codex) and `.gemini/settings.json` (Gemini). A file the
repository already has is merged, never replaced, and only the `code` entry is added; a file that cannot be merged (for
example, invalid JSON) is left alone and reported. The files are hidden from git through the worktree's `info/exclude`, so
`down --keep` never commits them, and they go away with the worktree: `down` has nothing extra to clean up. A harness that
asks the person to approve a project-scoped server once is behaving as designed.

`periscope up` prints a "Code tools" paragraph after the URL block. It is the Pair session's brief for the periscope and
has three forms: the registered service with the tools it advertised, one line saying no symbol service is available (no
hook), or one line with the reason the hook failed. A failing hook never stops the periscope from coming up.

**Known limit.** The session that ran `periscope up` from the main checkout does not get the `code` server, because a
harness reads its project configuration when it starts. A session started in the worktree does. Lane runs, where crew builds
the session itself, are a separate piece of work (CREW-2912).

## Limits and settings

| Setting | Default | Meaning |
|---|---|---|
| `ship.maxPeriscopes` | 3 | Periscopes live at once on this ship. |
| `ship.periscopeIdleMinutes` | 120 | Idle time recorded as the periscope's expiry. |
| `ship.intelStartupSeconds` | 20 | How long `periscope up` waits for the repository's `intel` symbol service. |
| `ship.previewHost` | — | Host a Passenger reaches the ship by; required once a route hosts periscopes. |
| route `hostPeriscopes` | false | Lets Passengers open periscopes. |

The settings are described in the [command reference](/commands).
