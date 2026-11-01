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
`CREW_PREVIEW_HOST`, `CREW_TICKET` and `CREW_BRANCH`.

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

## Limits and settings

| Setting | Default | Meaning |
|---|---|---|
| `ship.maxPeriscopes` | 3 | Periscopes live at once on this ship. |
| `ship.periscopeIdleMinutes` | 120 | Idle time recorded as the periscope's expiry. |
| `ship.previewHost` | — | Host a Passenger reaches the ship by; required once a route hosts periscopes. |
| route `hostPeriscopes` | false | Lets Passengers open periscopes. |

The settings are described in the [command reference](/commands).
