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

## [0.23.1] — 2026-10-09

- QA bounces in a `hybrid` project assign the building seat rather than clearing the assignee, so the bounced ticket stays workable (ISSUE-1498)

## [0.23.0] — 2026-10-09

- Sweeps, release phase and crew status honour project work mode: manual and project-less excluded, hybrid only agent-assigned (CREW-1496)
- Sweeps, release phase and `crew status` honour project work mode (CREW-1496)
- Work mode gains `hybrid` and `manual` now means no automation for any lane; hybrid projects are worked only for agent-assigned tickets (CREW-1493)

## [0.22.0] — 2026-10-09

- Hybrid-project hand-offs assign the next lane's seat instead of clearing the assignee, and the digest and prompts carry each ticket's project work mode (CREW-1495)
- Work mode gains `hybrid` and `manual` now means no automation for any lane; hybrid projects are worked only for agent-assigned tickets (CREW-1493)

## [0.21.0] — 2026-10-09

- Work mode gains `hybrid` and `manual` now means no automation for any lane; hybrid projects are worked only for agent-assigned tickets (CREW-1493)

## [0.20.2] — 2026-10-09

- Host Passengers image workflow logs in to Docker Hub before qemu/buildx setup so release pulls are not rate-limited (CREW-1492)

## [0.20.0] — 2026-10-08

- Crew lanes honor Projects.work_mode — manual projects yield only tickets explicitly assigned to the lane (CREW-1445)

## [0.19.5] — 2026-10-07

- CREW-1415 Release phase no longer takes the board lock for repos with nothing verified, and still warns about verified tickets with no repository.
- Release phase no longer takes the board lock for repos with nothing verified (CREW-1415)

## [0.19.4] — 2026-10-07

- Two ships serving one repo no longer cut endless zero-merge releases off each other's release commits; release tags are pushed in every mode and fetched by every ship (CREW-1412)

## [0.19.3] — 2026-10-07

- Daemon passes now persist the per-route attention set, so "needs a person" is announced once per transition instead of every cycle (CREW-1413).

## [0.19.2] — 2026-10-06

- Getting started no longer says connecting requires workspace admin (CREW-1410)

## [0.19.1] — 2026-10-06

- A verified branch another ship already squash-merged and released is now recognised and stamped instead of conflicting and being handed back (CREW-1408)

## [0.19.0] — 2026-10-06

- Environment stops (a missing hook tool, low disk) are raised and cleared by the poll, and stop the building lanes for the affected repo (ISSUE-1406)
- Missing-tool and low-disk ship attention now clears itself at poll time and skips the affected repo for the building lanes (ISSUE-1406)
- Building lanes skip a repo whose primary checkout is diverged, say why in the digest, and resume on their own once it is level (CREW-1403)

## [0.18.0] — 2026-10-06

- Per-run worktrees are cut from the remote branch (`crew worktree NNN`) and removed once the branch is pushed at hand-off, unless a `handoff` hook keeps a server up (CREW-1385)
- The crew can now push a verified branch for human review, open the pull request through hooks.pr, move the ticket to a reviewing status, and send it back to QA if the branch moves past verified_sha (CREW-1393)
- `crew status` now opens with a "to do" block listing what the operator owes: needs_info tickets assigned to them, needs_planning tickets and ships needing attention (CREW-1402)
- Building lanes skip a repo whose primary checkout is diverged, say why in the digest, and resume on their own once it is level (CREW-1403)
- `crew reap` and the release phase remove a handoff-hook-kept worktree once its ticket is `verified`, the runner removes the worktree a QA run cut when that run ends, neither ever removes a worktree holding commits missing from the remote, and `crew worktree` is listed in the README and docs/commands.md (CREW-1405)

## [0.17.0] — 2026-10-06

- Per-run worktrees are cut from the remote branch (`crew worktree NNN`) and removed once the branch is pushed at hand-off, unless a `handoff` hook keeps a server up (CREW-1385)
- The crew can now push a verified branch for human review, open the pull request through hooks.pr, move the ticket to a reviewing status, and send it back to QA if the branch moves past verified_sha (CREW-1393)
- The release phase now logs whether it took the cross-ship board lock or ran with exclusion off because the board has no Locks table (CREW-1399)
- Release board lock now creates its missing Locks row and logs whether cross-ship exclusion is on (CREW-1399)
- A quiet in_progress/fixed/qa ticket with nothing engaged on it now gets a one-time crew:stalled event comment, and its holding ship raises attention; an unheld ticket is never moved to needs_info (CREW-1401)
- Stalled in_progress/fixed/qa tickets get a `crew:stalled` event and raise ship attention on the holder, or go to the operator when nobody holds them (CREW-1401)
- `crew status` now opens with a "to do" block listing what the operator owes: needs_info tickets assigned to them, needs_planning tickets and ships needing attention (CREW-1402)
- Building lanes skip a repo whose primary checkout is diverged, say why in the digest, and resume on their own once it is level (CREW-1403)

## [0.16.0] — 2026-10-06

- The runner now enforces the push at hand-off — a `fixed` ticket whose branch is not on the remote at the worktree's HEAD is sent back to `in_progress`, and the pushed sha is recorded on the ticket for QA to verify against (CREW-1380)

## [0.15.0] — 2026-10-06

- A stop for a person is now written in data (needs_info plus operator assignee, or a ship attention flag that `crew sync` raises for a diverged base and clears when level), every stop comment names its un-park condition, and a ticket that is yours but has no worktree or branch is a fresh start (CREW-1388)
- A release now pushes to the base branch before running the deploy hook, so a ship that loses the race to another never deploys a build the base branch does not carry (CREW-1400)

## [0.14.1] — 2026-10-06

- A comment posted from the app by a person whose Crew row is on another ship is now attributed to them instead of reading "(no identity)", and `crew doctor` checks the operator's identity link (CREW-1390)

## [0.14.0] — 2026-10-06

- A repo can name the one ship that releases it (`release.ship`), `crew connect` provisions the release lock row, and a missing lock row now refuses the release instead of silently skipping the lock (CREW-1384)

## [0.13.2] — 2026-10-06

- A failed release setup, build or deploy now files its alert with the failing hook's name and last output lines instead of a fixed message (CREW-1396)

## [0.13.0] — 2026-10-06

- Ship affinity leftovers: QA verification is held per ship, ship names in seat comments, crew doctor warns on unheld in-flight tickets, and a dead-ship takeover leaves a comment (CREW-1389)
- Ship affinity leftovers: QA verification is held per ship (a second ship's QA skips a ticket already being verified), ship names replace uuids in the brief and digest, `crew doctor` warns about in-flight tickets with no live ship hold, and taking over a dead ship's ticket leaves a comment (ISSUE-1389)

## [0.12.1] — 2026-10-06

- CREW-1394 — a QA resume no longer overwrites another live ship's hold on a qa/fixed ticket; the ticket is verified without re-stamping the hold.

## [0.12.0] — 2026-10-06

- Ship affinity: a ticket held by a dead ship is taken over cleanly, so the returning ship cannot resume it a second time (ISSUE-1386)
- Ship affinity (CREW-1386): a ticket held by one live ship is off-limits to every other ship's building lanes, the hold lives in its own `held_by_ship_id` column and survives an operator's re-`accepted` and a QA bounce, and it is released by the runner when the ticket reaches `fixed`/`verified`.
- A ticket claimed by one ship is now off-limits to every other live ship, even if the operator sets it back to accepted, so a QA bounce or hand-back can no longer lead two ships to build the same ticket (CREW-1386)
- A ticket claimed by one ship is now off-limits to every other live ship, so a QA bounce or hand-back can no longer lead two ships to build the same ticket (CREW-1386)

## [0.11.0] — 2026-10-06

- A release now refuses to deploy if another ship's release landed on origin meanwhile, cleans up checkouts a crashed release left behind, rebuilds the primary checkout's dist/ after releasing, and names hand commits that make the base unsafe (CREW-1383)
- The release phase cuts each release in a temporary checkout of the remote base and pushes it fast-forward, so a failed push leaves nothing behind on the primary checkout, and ticket worktrees are cut from the remote base (CREW-1383)

## [0.10.2] — 2026-10-06

- crew install, uninstall --all and doctor now also find loaded launchd crew jobs whose plist is already gone, whatever checkout hash they carry (CREW-1381)

## [0.10.1] — 2026-10-06

- Released persona prompt changes now reach the lanes on the next run without a manual `crew agents sync`; a workspace admin's own edit to a persona row still takes precedence (ISSUE-1382)

## [0.10.0] — 2026-10-06

- A release no longer proceeds on a base branch carrying local commits its remote lacks; it stops and says how to reconcile (CREW-1379)
- A diverged or ahead base branch is a hard stop for cutting ticket worktrees: `crew sync` exits 1, and `crew status`/`crew doctor` report it (CREW-1379)

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
