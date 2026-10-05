# Host Passengers

Host Passengers lets a ship — the machine running crew — offer its repo
checkouts, read-only, to agent sessions started by other people in the same
Tablation workspace. A **Passenger** is someone who takes part without being
crew: they can look at the code and file new work, but they never move
existing work. See [Using the agent chat as a Passenger](/passenger-chat) for
their side.

It is off by default. Turning it on says: this machine will hold a container
that a Passenger's session can board.

## What it exposes

One Docker container per workspace the ship hosts for, holding a dedicated,
crew-maintained checkout of every repo the ship is connected to in that
workspace. It is not a builder's worktree and not your own working checkout,
so a dirty or mid-branch tree on your side never leaks through, and crew keeps
it up to date each cycle.

The container serves a small tool surface: read a file, list a directory,
search files, `git log` and `git blame`. There is no write-shaped tool at
all, and each checkout is also bind-mounted read-only. Either layer alone
would hold; both are enforced.

A Passenger session needs no seat and takes no worktree, so many can board the
same ship at once; they cost it read I/O, not capacity for crewed work.

The container is reached through an outbound SSH tunnel to a relay, so the
ship needs no open inbound port. The relay assigns a public URL for the tunnel,
and requests are authenticated by the ship's own MCP server, not the relay.

## Prerequisites

- **Docker** with a running daemon (`docker info` must answer). Without it the
  setting stays recorded but nothing starts; `crew doctor` says so.
- **`ssh-keygen`** (OpenSSH), used to mint the ship's tunnel identity.
- Network access to Docker Hub the first time a ship starts a container. The
  container image is `tablation/crew-passenger-mcp`, tagged with the crew
  version the ship runs, so `crew install` pulls it up front and nothing needs
  a clone of the crew repo. `crew doctor` shows whether the image is present.
- `ship.relayHost` set in `crew.yaml`. With no relay host the container runs
  with no tunnel.

## Turning it on

`crew connect` asks "Host Passengers on this machine?" during the first-run
wizard (default no). To change it later, set it per route in `crew.yaml`:

```yaml
routes:
  - route: my-workspace/issues
    hostPassengers: true
```

Then run `crew connect` again for that workspace: it syncs the flag onto the
workspace's own Ships row. The config file is the truth, so editing the Ships
row by hand does not stick.

The container is per workspace: any one enabled route with `hostPassengers:
true` for a workspace is enough to host it, and the container's mounts cover
every repo the ship has connected there.

`crew doctor` prints the state: which routes host, whether Docker and
`ssh-keygen` are available, the container image and whether it is present, and
the relay host. `crew status` shows the same.

To run a locally built image instead, set `ship.passengerImage` in `crew.yaml`
(or export `CREW_PASSENGER_IMAGE`, which takes precedence). Build it from the
crew repo root with `docker build -f Dockerfile.passenger-mcp -t
crew-passenger-mcp:dev .`, then set `passengerImage: crew-passenger-mcp:dev`.

To sync containers and tunnels once by hand, run `crew passengers`; the
scheduler's passengers unit invokes the same command.

## The public URL, and rotating it

Each reconnect gets a fresh, random public URL. If one leaks, force a
reconnect:

```sh
crew rotate-passenger-url my-workspace/issues
crew rotate-passenger-url my-workspace/issues --dry-run
```

This kills the running tunnel and reconnects; the ship's SSH key is untouched.
The old URL stops working as soon as the new connection lands. The command
refuses when the route doesn't host Passengers, has no `relayHost`, or has no
container planned.

## Seeing the ship's status

The ship's row in the Ships table carries the tunnel's `tunnel_status`
(disconnected, connecting or connected). The settings View in the Issues app
shows it, so a Passenger can tell whether a ship is hosting before they try to
board.

The ship's URL is not on the Ships row. The ship registers its tunnel as a
workspace MCP endpoint under its own slug, so workspace admins find it in the
workspace's MCP endpoints list.

## Related

- [Getting started](/getting-started)
- [Command reference](/commands)
