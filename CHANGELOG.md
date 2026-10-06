# Changelog

All notable changes to `@tablation/crew`. Versions are the `version` field in
`package.json`.

## How this file is maintained

Nobody edits this file or bumps `package.json` on a ticket branch. Each ticket
branch records, in its own commit message, a `Bump: patch|minor` trailer
(never `major`, that stays a manual call) and one or more `Changelog: <line>`
trailers worded as they should read here, each with its ticket reference.

Each cycle the release phase (`release.mode: ci_auto` in `.crew.yaml`)
squash-merges every verified ticket, then in one following commit adds one
`## [x.y.z] — YYYY-MM-DD` section here (newest first, a bullet per
`Changelog:` line across the batch) and bumps `package.json`, sized by the
largest `Bump:` in the batch. It pushes `main` and the annotated `v<x.y.z>`
tag; the tag triggers `.github/workflows/publish.yml`, which publishes to npm.

## [0.9.0] — 2026-10-06

- CREW-1376 — `crew install` refuses, rather than removes, a foreign launchd unit whose ProgramArguments it cannot read, unless `--replace`
- CREW-1376 — `crew install` clears launchd units left by a crew installed from another path (a stale one is removed; a live other install is refused unless `--replace`), `crew uninstall --all` removes every crew launchd unit, and `crew doctor` lists foreign units

## [0.8.0] — 2026-10-05

- `crew connect` registers the Tablation MCP server with Claude Code when it is missing, using the key it just resolved; `crew doctor` reports it, `--no-mcp` opts out (CREW-1378)

## [0.7.1] — 2026-10-05

- Host Passengers reports a `docker` missing from the scheduler PATH with the directory to add to `ship.extraPath`, in `crew doctor`, `crew install` and the passengers timer (CREW-1375)

## [0.7.0] — 2026-10-05

- CREW-1371 — tickets and comments record the seat and ship that wrote them, and the queue digest names who filed each ticket, once the workspace's Issues and Comments templates have the new columns
- Queue digest shows who filed each ticket (CREW-1371)
- CREW-1371 — release alerts and failure tickets are credited to a per-ship "Release agent" Crew row instead of the Developer agent, and agents record the seat and ship that filed a ticket when the workspace has those columns
- CREW-1371 — tickets and comments record the seat and ship that wrote them, once the workspace's Issues template has the new columns

## [0.6.1] — 2026-10-05

- `crew pause` now stops the release timer and `crew daemon` too; `crew pause release` pauses only shipping (CREW-1372)
- `crew daemon` honors `crew pause` too: a paused ship claims no tickets and posts no comments until resumed (CREW-1372)
- `crew pause` now stops the release timer as well (merge, deploy, release), and `crew pause release` pauses shipping alone (CREW-1372)

## [0.6.0] — 2026-10-05

- Host Passengers runs the container image published to Docker Hub for this crew version, so `crew install` no longer needs a crew repo checkout to start it (CREW-1369)
- `crew install` pulls the Host Passengers image up front and reports a failed pull; `crew doctor` shows the image and whether it is present (CREW-1369)
- `ship.passengerImage` (or CREW_PASSENGER_IMAGE) runs a locally built Host Passengers image instead of the published one (CREW-1369)

## [0.5.0] — 2026-10-05

- `crew doctor` checks that the agent binary and git resolve on the PATH the scheduler gives the daemon, and says where to fix it when they do not (CREW-1365)
- Daemon no longer retries a failed agent spawn with zero backoff. A role whose agent binary cannot start backs off, is parked after repeated failures, and writes no Agent Log error row per attempt (CREW-1365)
- Ship-level attention items (a parked role, a hook command missing from the scheduler PATH, a stalled release timer) are shown on the Ships row, in `crew status`, and announced where a client or `hooks.notify` exists (CREW-1373)

## [0.4.1] — 2026-10-05

- `crew doctor` checks that the agent binary and git resolve on the PATH the scheduler gives the daemon, and says where to fix it when they do not (CREW-1365)
- Daemon no longer retries a failed agent spawn with zero backoff. A role whose agent binary cannot start backs off, is parked after repeated failures, and writes no Agent Log error row per attempt (CREW-1365)

## [0.4.0] — 2026-10-05

- A verified ticket whose commit already shipped in an earlier release is stamped deployed instead of being parked as stranded, and a test gate that stays red for 3 cycles is reported on the tickets it holds back (CREW-1368)

## [0.3.0] — 2026-10-05

- Remote ticket-branch cleanup deletes only a deployed ticket's own branch (`issue-N`, `<prefix>-N`, optional `-slug`), never other branches whose name merely contains its number (CREW-1364)
- Ticket branches are now pushed at the `fixed` hand-off and found on the remote by QA and the release phase, so a ticket built on one ship can be verified and released from another; the pushed branch is deleted after release, and a stranded-verified flag waits 30 minutes (and a successful fetch) before escalating (CREW-1364)

## [0.2.0] — 2026-10-05

- `crew repos add` takes optional route, repo name and path — run from inside a checkout it uses the current directory, the only configured route, and the origin remote's repo name (CREW-1362)

## [0.1.7] — 2026-10-05

- `merged_at` now records the merge commit's own date instead of the stamp time, so it no longer mirrors `released_at` in ci_* modes (CREW-1361)
