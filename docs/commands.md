# Command reference

Every command takes an optional `[route]` — a `workspace/project` slug pair.
It may be omitted when the ship has one route (or the command works fleet-wide).
`crew --help` prints the same list.

## Everyday

| Command | What it does |
| --- | --- |
| `crew connect [workspace[/project]]` | Resolve a workspace's ids into `crew.yaml`; on a first run, a setup wizard. |
| `crew repos add ROUTE PATH` | Attach a local checkout to a route in `crew.yaml` Creates the Repos row when the tracker has none (`--name`, `--project`, `--no-create`; `--dry-run` previews). |
| `crew repos list ROUTE` | The checkouts a route has, with the Repos row each matches. |
| `crew doctor [route] [--fix]` | Read-only preflight; `--fix` enables clean routes and offers `crew install`. |
| `crew install` / `crew uninstall` | Write and load, or unload and remove, this platform's scheduler unit. |
| `crew status [route] [--json]` | Paused/running state, plus any open ship-level attention items (a parked role, a hook command missing from the scheduler PATH, a stalled release timer) for this ship and, from the Ships table, for others; `--json` for a machine reader (`ship.attention`). |
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
| `crew sync [route]` | Fast-forward the checkout and its worktrees from the remote. |
| `crew ports [route]` | Which checkout owns which ports, and what is up. |
| `crew reap [route]` | Kill orphaned servers, drop worktrees for closed tickets. |
| `crew drop [route] NNN` | Remove a merged ticket's worktree and branch. |
| `crew unassign [route] NNN` | Hand back a session's ticket: clears the assignee so the next cycle picks it up. |

## Personas and skills

| Command | What it does |
| --- | --- |
| `crew agents sync [route] [--force]` | Push personas and skill files into the workspace's Agents and Agent Skills tables (`--force` overwrites a diverged persona). |
| `crew agents prompt ROLE [route]` | Print one persona's current prompt (e.g. `pair`, for a SessionStart hook). |
| `crew skills sync [route]` | Push only the skill files. |

## Host Passengers

| Command | What it does |
| --- | --- |
| `crew passengers [route]` | Sync Host Passengers containers and tunnels once. |
| `crew rotate-passenger-url [route]` | Force the tunnel to reconnect with a fresh public URL. |

See [Host Passengers](/host-passengers).

## Options on every command

- `--dry-run` decides everything and performs nothing.
