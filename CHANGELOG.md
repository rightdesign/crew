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

## [0.79.6] — 2026-10-28

- CREW-2611 The docs site's top bar no longer lists "Install" twice.

## [0.79.5] — 2026-10-28

- CREW-2610 The repo-spec field reference table fits the page on wide screens with field names intact, and still scrolls on narrow ones.

## [0.79.4] — 2026-10-28

- CREW-2606 `crew selftest` names the actual keychain read failure (exit code and reason) and distinguishes a locked keychain from other keychain errors.

## [0.79.3] — 2026-10-28

- CREW-2605 `crew selftest` no longer prints the keychain-locked remedy twice.

## [0.79.2] — 2026-10-28

- CREW-2602 The release phase and `crew doctor` name the table, method and grant when a seat is refused (Ships, Locks, Epics, Repos included), and the seat-read probe now uses the real records route instead of one that always returned 404.

## [0.79.1] — 2026-10-28

- CREW-2603 (CREW-2603) A dirty or off-base primary checkout no longer blocks a release run in a temporary checkout; the release decision reads the remote base instead.

## [0.79.0] — 2026-10-28

- CREW-2600 The dev hand-off comment must quote each Acceptance line with the check that exercised it, and the hand-off guard bounces one that does not.

## [0.78.1] — 2026-10-28

- CREW-2593 The Agent Log now receives each run's turn count and first-turn prefix tokens, shown in the run sidecar and `crew logbook`.
- CREW-2598 Run attribution no longer credits a run to a ticket merely listed under "Other tickets" in the closing summary.

## [0.78.0] — 2026-10-28

- CREW-2590 `crew repos check [PATH]` validates a checkout's .crew.yaml (parse errors, release readiness, hook syntax, shadowed ship settings) before the repo is attached to a route.

## [0.77.0] — 2026-10-28

- CREW-2580 Each run's token spend is added to its ticket's counters, and an increment the tracker could not take is queued and sent later instead of being lost.

## [0.76.0] — 2026-10-28

- CREW-2579 The hand-off guard now completes a missing or behind push itself (plain fast-forward) instead of bouncing the ticket, and still bounces with git's error when the remote moved or the push is refused.

## [0.75.6] — 2026-10-28

- CREW-2578 The dev lane brief and the hand-off bounce note now say plainly that pushing the ticket branch is authorized, so a seat no longer parks a ticket asking permission to push.

## [0.75.5] — 2026-10-27

- CREW-2573 crew connect --dry-run on a brand-new Crew table now reports the operator row it would create instead of stopping with "cannot determine the operator".

## [0.75.4] — 2026-10-27

- CREW-2558 `crew connect --json` now emits a `config` event saying whether crew.yaml was written or left alone, and why.

## [0.75.3] — 2026-10-27

- CREW-2557 First-run `crew connect` now writes a crew.yaml in the plain block dialect: no `repos: {}`, no folded `extraPath`, no default `baseUrl`, and no maintainer-facing comments.

## [0.75.2] — 2026-10-26

- CREW-2548 The sweep warns once per ticket that has no repository, with a one-line summary each cycle, instead of repeating every warning every two minutes.

## [0.75.1] — 2026-10-26

- CREW-2549 crew doctor, connect and agents sync now flag seat keys that cannot read Issues, and the release phase reports a 403 once as an attention item

## [0.75.0] — 2026-10-26

- CREW-2542 `crew doctor --json` now lists every blocker, attention item and release-readiness note as a structured `problems` array, plus a `passed` count.
- CREW-2544 crew connect no longer hangs when the Docker daemon is installed but unresponsive.

## [0.74.0] — 2026-10-26

- CREW-2539 A Claude toolchain can set `auth: subscription` to force the subscription login over a Vertex or API-key setup in ~/.claude/settings.json; `crew doctor` and `crew selftest` report the resolved auth.

## [0.73.4] — 2026-10-25

- CREW-2537 crew doctor --fix now enables a route and offers the scheduler when a repository lacks a deploy hook; release-readiness gaps are listed separately and no longer block setup.

## [0.73.3] — 2026-10-25

- CREW-2529 Release hand-backs name the sibling branch a conflict comes from, and the tests-failed alert directs a composition-only fix onto an owning branch instead of a fresh one.

## [0.73.2] — 2026-10-25

- CREW-2528 A ticket branch cut fresh from the base no longer tracks it or blocks the release once another ship pushes the real branch; a skipped release is now noted on the ticket.

## [0.73.1] — 2026-10-25

- CREW-2524 The connect-json tests no longer hang on a macOS keychain prompt, and a stuck test child is killed instead of stalling the suite.

## [0.73.0] — 2026-10-25

- CREW-2523 `crew repos hooks` gains `--write route --replace` to overwrite existing route hooks and `--clear route` to remove them.

## [0.72.3] — 2026-10-25

- CREW-2514 crew connect now updates the Claude Code MCP entry it registered earlier when the route key rotates, instead of leaving it as foreign.

## [0.72.2] — 2026-10-25

- CREW-2516 First-run `crew connect` no longer writes a placeholder `dir:` that is never a checkout; `crew repos add`/`clone` drop a leftover one and `repos list --json` reports it as `cloneBase`.
- CREW-2521 `crew selftest --toolchain NAME` and `crew connect --machine-id ID` no longer read the option's value as the route or workspace, so the app's Verify step can pass.

## [0.72.1] — 2026-10-25

- CREW-2498 `crew connect` with no workspace now reuses the remembered keychain session on a real run instead of starting a new device approval.

## [0.72.0] — 2026-10-25

- CREW-2495 `crew ship rename` and two-way ship name sync between crew.yaml and the Ships table.

## [0.71.13] — 2026-10-25

- CREW-2492 An unknown command is rejected before any config is loaded, so the suite passes without a crew.yaml and npm publishes can succeed again.

## [0.71.12] — 2026-10-25

- CREW-2480 crew recognizes tablation.issues as the tracker template and follows identifier supersession, keeping crew.issues installs working

## [0.71.11] — 2026-10-25

- CREW-2471 `crew connect --dry-run` no longer reports another machine's seat rows as matched; it previews `would-create` seats and seat events carry `ship_id`.

## [0.71.10] — 2026-10-24

- CREW-2447 connect --json now emits signed_in before any workspace choice when the key comes from a flag or crew.yaml, and a dry run with a single-route crew.yaml no longer asks which workspace.

## [0.71.9] — 2026-10-24

- CREW-2443 `crew connect --sign-out` and `crew disconnect --reset` no longer fail with "no config found" on a machine without crew.yaml.

## [0.71.8] — 2026-10-24

- CREW-2440 Added `crew connect --sign-out` and made `crew disconnect --reset` clear host sessions stored by dry-run connects; signed_in events now name the host.

## [0.71.7] — 2026-10-24

- CREW-2431 crew connect's operator_row event now includes the matched Crew row's name and email.

## [0.71.6] — 2026-10-24

- CREW-2423 `crew connect` now offers only people as the operator's Crew row, matches by identity or email, and shows each option's email instead of a UUID.

## [0.71.5] — 2026-10-24

- CREW-2416 `crew connect --no-wizard` no longer requires the agent binary before sign-in or on a dry run, and finds `claude` in its usual install directories.

## [0.71.4] — 2026-10-23

- ISSUE-2411 A release lock held by a dead process on the same ship is reclaimed on the next cycle, and a failed lock release is retried and logged instead of silently leaving the row held until its TTL.
- ISSUE-2412 `crew doctor` now warns when a Locks row is held by this ship's own process that no longer runs, so a stale claim is visible before the next release cycle reclaims it.

## [0.71.3] — 2026-10-23

- CREW-2410 `crew --help`, `crew -h` and `crew help` now print usage to stdout and exit 0; an unknown command or flag still exits 2, with a first line naming it.

## [0.71.2] — 2026-10-23

- CREW-2404 `crew --version` and `crew version` print the version and exit 0 instead of printing help and exiting 2.

## [0.71.1] — 2026-10-23

- ISSUE-2390 A release's changelog now lists each ticket once, using the newest Changelog line from its branch, and spells the ticket reference with the project's prefix.

## [0.71.0] — 2026-10-23

- ISSUE-2392 Tagged releases now attach a universal macOS crew binary (Apple Silicon and Intel in one file) as crew-<version>-darwin-universal.tar.gz.

## [0.70.0] — 2026-10-23

- ISSUE-2383 A tracker restart no longer raises an error event on every failed daemon pass; it warns, backs off, and escalates once after about three minutes.

## [0.69.1] — 2026-10-23

- ISSUE-2379 A second merge conflict caused by main moving after a hand-back was answered is handed back to the dev lane instead of escalating to a person; the third in a row still escalates.

## [0.69.0] — 2026-10-23

- ISSUE-2363 A run that pushed its branch while the tracker was down keeps its hand-off and replays it when the tracker is back, instead of exiting as a success with the hand-off undone.
- CREW-2363 A hand-off that fails while the tracker is down is kept and replayed, runs are marked "hand-off pending", and the next run recognizes its own pushed work.

## [0.68.1] — 2026-10-23

- CREW-2364 Run attribution follows the ticket a run claimed or handed off instead of the most-mentioned one.

## [0.68.0] — 2026-10-22

- ISSUE-2350 crew whoami [route] [--json] reports the signed-in identity, key role, operator Crew row and credential source

## [0.67.2] — 2026-10-22

- CREW-2349 Two ships releasing one route no longer mint a new version every cycle while a deploy is failing; only a non-release commit lifts the not-retrying guard.

## [0.67.1] — 2026-10-22

- ISSUE-2260 Getting started now leads with the Crew app on a Mac and keeps the CLI as the Linux and scripting route, with a new short Install page and troubleshooting for the minimum crew version, push auth and self-test failures.

## [0.67.0] — 2026-10-22

- ISSUE-2320 `crew repos hooks --write` takes repeatable `--hook KEY=CMD` to write edited hook commands instead of only the detected ones.

## [0.66.0] — 2026-10-22

- ISSUE-2318 Added a `hooks.ci_status` repo-spec hook (exit 0 = CI green) that the dev lane runs after pushing and before hand-off, and made the `github-actions-ci-status` recipe from `crew repos hooks --suggest` writable.

## [0.65.0] — 2026-10-22

- ISSUE-2319 `crew repos list ROUTE --json` prints every Repos row the route knows (attached or not) plus unmatched checkouts, with remote, origin, existence and hooks source; text output is unchanged.

## [0.64.0] — 2026-10-22

- ISSUE-2317 `crew repos hooks --suggest` lists recipes and gains an optional read-only `--agent` review mode; `--write` accepts `--recipes ID,ID` and Ctrl-C cancels `--agent`.
- CREW-2317 crew repos hooks --suggest now returns detected recipes (GitHub Actions release) and an optional read-only --agent review mode.

## [0.63.2] — 2026-10-22

- ISSUE-2315 `crew connect --dry-run` with no workspace named now reuses the keychain session from an earlier dry-run sign-in instead of asking for a new device approval, so the macOS wizard can resume after a relaunch.

## [0.63.1] — 2026-10-22

- ISSUE-2313 `crew connect --dry-run` now works on a machine with no crew.yaml, so the macOS app can run device approval and discovery before anything is written.

## [0.63.0] — 2026-10-22

- ISSUE-2249 crew connect finds this machine's Ships row by a stable hashed machine id before its name, so a renamed host no longer creates a second ship; crew doctor reports which way the row matched.

## [0.62.0] — 2026-10-22

- CREW-2248 crew stops picking tickets and raises a crew_outdated attention item when it is below the workspace's minimum crew version; doctor and status --json show both versions.

## [0.61.0] — 2026-10-22

- ISSUE-2240 crew connect reports which permissions the signed-in member is missing before provisioning, and crew doctor repeats them until granted.
- CREW-2243 `crew disconnect --reset` removes everything connect and install wrote on this machine (scheduler units, Pair/MCP entries, seat keys, keychain credential, resolved state, crew.yaml), with --remove-checkouts, --dry-run and --json.

## [0.60.0] — 2026-10-21

- ISSUE-2238 `crew repos hooks <name>` proposes test/build (and version/bump) hooks for a checkout without a `.crew.yaml`, and can write them to `crew.yaml` (`--write route`) or as a starter `.crew.yaml` (`--write repo`).

## [0.59.0] — 2026-10-21

- ISSUE-2239 crew doctor probes push auth per repo and reports gh, Node and Docker with install hints; a repo with an invalid .crew.yaml is reported as failed instead of dropping the other repos' results.
- CREW-2239 crew doctor now checks push auth per repo and reports gh, Node and Docker with install hints; --offline and --json added.
- ISSUE-2241 crew connect runs agents sync for an admin automatically; members get a plain next step, and its --json events are emitted before done.
- ISSUE-2241 `crew connect` runs the persona/skill sync and seat key mint for an admin key; members get a plain next step; `--no-agents-sync` skips it.

## [0.58.0] — 2026-10-21

- ISSUE-2242 Add `crew sample-ticket`, a throwaway sandbox repo and one ticket that walks the full dev, QA and release loop.

## [0.57.0] — 2026-10-21

- ISSUE-2235 `crew connect` can run without a terminal: wizard answers as flags, `--json` progress events, and `--choose` to answer the questions it would have asked.
- ISSUE-2236 `crew selftest` launches each configured toolchain as a real run would and proves it can read the workspace through the tracker, naming the failure class when it cannot; `crew doctor` shows the last result.
- ISSUE-2237 `crew repos clone [route] <name>` clones a Repos row's remote into the route directory and attaches it to crew.yaml (`--dir`, `--dry-run`, `--json`).

## [0.56.0] — 2026-10-21

- ISSUE-2234 Tagged releases now attach compiled crew binaries (darwin and linux, arm64 and x64) and a SHA256SUMS file to the GitHub Release; scripts/publish-binaries.sh does the same by hand.

## [0.55.0] — 2026-10-21

- ISSUE-2211 A release failure alert now closes itself when the same route's release next passes the stage that failed.

## [0.54.4] — 2026-10-21

- CREW-2210 The tests-failed failure alert now shows the failing test names, output, candidate and base shas and merged branches.

## [0.54.3] — 2026-10-21

- ISSUE-2208 A release with a single verified branch that fails the test or build gate now hands that branch back to the dev lane instead of failing the whole release.

## [0.54.2] — 2026-10-21

- ISSUE-2209 The lane digest now surfaces a build_failed hand-back from the release gate as direction until a push answers it, and shows gate_red as status only.

## [0.54.1] — 2026-10-20

- ISSUE-2149 Docs now explain connecting to a secondary workspace with `crew connect <primary>:<slug>`, including its route, keychain entry, repos directory, how Finder displays the colon and the `--dir` override.

## [0.54.0] — 2026-10-20

- ISSUE-2132 crew connect accepts the `<primary>:<slug>` workspace segment for secondary workspaces.

## [0.53.7] — 2026-10-20

- ISSUE-2148 Lane agents now check whether a tracker create that failed with a session or transport error actually landed before filing or posting it again, so a restart no longer produces duplicate tickets and comments.

## [0.53.6] — 2026-10-20

- ISSUE-2142 Crew tracker posts open with a styled callout header instead of an HTML-comment marker that showed as raw text.

## [0.53.5] — 2026-10-20

- ISSUE-2120 The Grill-Me skill sets a Map to planning while an interview runs, draft once the PRD is written and abandoned when work on it stops.

## [0.53.4] — 2026-10-20

- ISSUE-2051 A worktree the sweep refuses to remove now warns once and shows in `crew status`/`crew doctor` as a ship attention item, instead of warning every cycle.

## [0.53.3] — 2026-10-20

- ISSUE-2050 The worktree sweep now clears hand-back merges and suffixed QA worktrees of deployed tickets, reports failed removals, and warns about orphaned worktree directories.

## [0.53.2] — 2026-10-18

- ISSUE-1973 A run that lost its ticket to another ship (taken over) or never built it no longer bounces that ship's valid hand-off back to in_progress.

## [0.53.1] — 2026-10-16

- ISSUE-1811 The digest labels a public reporter's reply as "(public reporter)" instead of attributing it to the operator.

## [0.53.0] — 2026-10-16

- CREW-1807 `{issue}` is now valid in branch.name / branch.push, and a new `branch.lowercase` switch lowercases rendered branch names.

## [0.52.0] — 2026-10-16

- ISSUE-1802 Non-admin keys with the "Mint agent keys" capability can now mint seat keys from `crew agents sync`; a refused mint is reported once, `--revoke-seat-keys` rotates a ship's keys, and `crew doctor` shows whether the key can mint.

## [0.51.1] — 2026-10-16

- ISSUE-1800 Seat key minting no longer prints raw API keys when the keychain write fails; the keychain is probed before minting and a key that cannot be stored is revoked.

## [0.51.0] — 2026-10-16

- ISSUE-1798 `crew connect` now links your own Crew row to your account (or creates one) instead of leaving `user_id` for `crew doctor` to flag.

## [0.50.3] — 2026-10-16

- ISSUE-1797 `crew agents sync` no longer fails for a non-admin key: it links seats to the workspace's existing persona rows and reports what an admin must sync; `crew doctor` shows the key role and role-aware hints.

## [0.50.2] — 2026-10-16

- ISSUE-1796 `crew doctor` now reports a repo directory that is missing on disk (and any base-branch check that fails) instead of aborting with `spawnSync git ENOENT`.

## [0.50.1] — 2026-10-16

- ISSUE-1776 Run streams and the meta sidecar follow the ticket a run actually claims instead of the poll's hint, and an interrupted run still leaves a sidecar naming it.
- ISSUE-1776 Test expectation follows the stream mapper's new tool input field.
- ISSUE-1776 Run streams and meta sidecars are labelled with the ticket the run actually claimed, with a hint-to-claimed marker, and the sidecar is written at spawn so interrupted runs are still attributable.

## [0.50.0] — 2026-10-16

- ISSUE-1775 A daemon exit no longer takes the in-flight agent run down with it: agents run in their own process group, a restarted daemon adopts or reports them (interrupted event on the ticket, meta and Agent Log row), and `crew worktree` resumes the seat's own dirty worktree.

## [0.49.6] — 2026-10-16

- ISSUE-1774 The crew daemon no longer exits when a tracker read fails with a 502 or an HTML error page; the pass degrades, logs a warning and the next pass runs.

## [0.49.5] — 2026-10-15

- CREW-1761 The dev digest shows runner direction events (conflict hand-backs, requeues, bounces) so a handed-back ticket is no longer invisible, and a conflict escalates only after a hand-back was acted on.

## [0.49.4] — 2026-10-15

- ISSUE-1759 A dev run that hands off a ticket it never claimed is now caught: the ticket is bounced if another ship holds it, or its push is verified, without disturbing other ships' valid hand-offs.
- ISSUE-1759 A run that hands off a ticket it did not claim is now caught: a ticket held by another ship is bounced back, and an unheld one has its push verified.

## [0.49.3] — 2026-10-15

- ISSUE-1758 A verified ticket whose local branch diverged from the remote is reported and skipped by the release instead of being requeued forever with a false `pushed` event.

## [0.49.2] — 2026-10-15

- ISSUE-1730 A release that requeues a ticket whose branch moved now records the new tip as the hand-off, so one missed `pushed` event no longer loops the ticket through QA forever.

## [0.49.1] — 2026-10-15

- ISSUE-1729 A dev hand-off that QA claims before the run ends still records its `pushed` event.

## [0.49.0] — 2026-10-15

- ISSUE-1718 Lane runs now append a workspace Agent or Agent Skill row's Additional instructions after the persona brief and after each included skill, with or without Customize prompt.

## [0.48.0] — 2026-10-13

- CREW-1637 The release holds back a verified branch that gained commits after QA verified it and returns the ticket to QA, instead of shipping untested work.

## [0.47.3] — 2026-10-13

- ISSUE-1636 The release no longer squash-merges a stale local copy of a ticket branch held by a worktree; it fast-forwards a clean worktree to the pushed tip, or skips the ticket with an error.

## [0.47.2] — 2026-10-13

- ISSUE-1633 Fixed empty crew-release-* directories piling up in the temp directory after releases.

## [0.47.1] — 2026-10-13

- ISSUE-1632 Release failure alerts are filed under the failing repo's project so its lanes can pick them up.

## [0.47.0] — 2026-10-13

- ISSUE-1605 Release-phase comments, failure tickets and stamps are now written as the release seat's own agent principal instead of the ship's key.

## [0.46.1] — 2026-10-13

- ISSUE-1414 Host Passengers clones now show git's real error, use HTTPS when the repo's origin is HTTPS (or ship.cloneScheme says so), and a failing clone is reported once instead of every cycle.

## [0.46.0] — 2026-10-13

- CREW-1603 Seats write to the tracker as their own agent principal using per-seat agent API keys, with a ship-key fallback and a doctor line per seat.

## [0.45.4] — 2026-10-13

- ISSUE-1601 Lane agents now know how to react when the tracker's Issues table refuses a write under a status rule, and the getting-started guide describes those rules.

## [0.45.3] — 2026-10-12

- ISSUE-1593 — the worktree and branch sweep resolves only the tickets it has a worktree or branch for, so deployed tickets are no longer missed once the board holds more than 500 closed tickets; a truncated lookup now warns
- ISSUE-1593 — The worktree and remote-branch cleanup no longer miss deployed tickets once the board holds more than 500 closed tickets; it looks up only the tickets it has a worktree or pushed branch for, and warns if a lookup is truncated.

## [0.45.2] — 2026-10-12

- ISSUE-1592 (CREW-1592) The worktree sweep now runs on every release cycle, including ones where nothing was released, and removes the leftover local branch of a deployed ticket whose worktree is already gone.

## [0.45.0] — 2026-10-12

- ISSUE-1574 The runner records its audit events (pushed, blocked sweeps, stalls, conflict hand-backs, gate-red notes) in the tracker's Issues event log instead of Comments, and reads its own markers back from there.
- ISSUE-1574 Crew records its audit trail (pushed tips, claims, bounces) in the Issues table's event log instead of as Comments rows; the Issues table must have Event log turned on.

## [0.44.0] — 2026-10-12

- ISSUE-1581 A failed combined release build now finds the one verified branch that broke it, hands it back to the dev lane with the build output, and ships the rest

## [0.43.4] — 2026-10-11

- ISSUE-1577 The Grill-Me skill now sets the Epic to `planned` when its Map goes active.

## [0.43.3] — 2026-10-11

- CREW-1560 The digest's last-comment cell no longer shows a status-change event, so an operator's reply from the app is attributed to them instead of "(no identity)".

## [0.43.2] — 2026-10-11

- ISSUE-1559 `crew agents sync` no longer reports false local edits when two ships sync the same workspace, stamps unmanaged persona/skill rows as crew-managed, and `--force` now covers skills.

## [0.43.1] — 2026-10-11

- Dev, design and QA runs open ticket attachments reliably — the Environment section now names the workspace's Media Library table and the record-then-file download recipe, and the lane policy spells the steps out instead of pointing at a skill (CREW-1558)

## [0.43.0] — 2026-10-11

- CREW-1551 `crew worktree NNN` no longer reads the ticket number as a route name; on a multi-route ship it picks the route whose tracker has the ticket and whose checkout serves its repo.
- CREW-1551 `crew worktree NNN` no longer reads the ticket number as a route name, and `crew worktree NNN <role>` works without a route.
- CREW-1551 `crew worktree NNN` now works without a route argument (it failed with `no route "NNN"`), picking the route from the ticket's repo on a multi-route ship.
- `launcher: omlx` runs a harness against a local oMLX server, with provider `local` and doctor checks for the server and model (CREW-1554)
- `launcher: omlx` runs a harness against a local oMLX server, with provider `local` and doctor checks for the server and model (CREW-1554)

## [0.42.0] — 2026-10-11

- ISSUE-1552 Optional `columns.position` contract column: a manual order that breaks ties inside an effective-priority band, never across bands, and shows in the digest.

## [0.41.0] — 2026-10-11

- CREW-1549 A same-repo blocker now counts as resolved only once merged, so dependent tickets are no longer restored early and stacked on unmerged branches

## [0.40.1] — 2026-10-11

- CREW-1550 — Lane skill and QA brief now say a stale or conflicting pushed branch is fixed by merging the base into it and pushing fast-forward, never by rebasing

## [0.40.0] — 2026-10-11

- ISSUE-1544 `crew agents sync` and `crew skills sync` now skip Agents/Agent Skills rows with "Customize prompt" on (even with `--force`), report the override, and record prompt_source/prompt_baseline on the rows they write.

## [0.39.1] — 2026-10-11

- `crew agents sync --force <route>` no longer syncs the wrong route; sync prints the route it used and requires a route name on multi-route ships (CREW-1539)

## [0.39.0] — 2026-10-11

- Persona briefs can include a skill with a {{skill: Name}} marker expanded at run time, so the shared lane policy is a separate Agent Skill that an admin edit to a lane brief no longer forks (ISSUE-1534)

## [0.38.0] — 2026-10-11

- The building lanes' situational procedures (worktree setup, running the suite, question/investigation tickets, filing a ticket, ticket attachments, workspace-change authorization, the design pass) ship as Agent Skills that a run fetches only when the step applies, cutting the assembled dev/QA/design prompts roughly in half (CREW-1533)
- Triage and pair persona prompts are self-contained — common.md is prefixed only to the dev, design and QA briefs — and every persona prompt is shorter, generic across projects, toolchains and harnesses, with the incident history behind each rule moved to docs/prompt-rationale.md (CREW-1533)

## [0.37.0] — 2026-10-11

- `crew reload` and automatic daemon relaunch when crew.yaml changes (CREW-1532)

## [0.36.0] — 2026-10-11

- Codex is now a supported harness: `harness: codex` toolchains run `codex exec --json` with sandbox-mapped capabilities, tracker MCP registration and Agent Log cycles/tokens (CREW-1520)

## [0.35.0] — 2026-10-11

- A route's `repos.<name>.toolchain` runs tickets in that repo on a different ship toolchain (e.g. Codex) while the route stays on Claude (CREW-1529)

## [0.34.1] — 2026-10-11

- `crew repos add` creates the Repos row on a keychain-only route instead of failing with "no API key" (CREW-1528)

## [0.34.0] — 2026-10-10

- Gemini CLI harness adapter: headless runs, capability mapping, MCP registration and stream mapping, with assistant text fragments coalesced into one Agent Log cycle per turn (CREW-1521)
- Gemini CLI is now a toolchain harness (`harness: gemini`): headless runs with capability mapping, tracker MCP registration, Google env scrub and stream mapping (CREW-1521)

## [0.33.0] — 2026-10-10

- `crew connect` can install Pair for GitHub Copilot in VS Code (`ship.pair: [copilot]`): the tracker MCP in the user-profile `mcp.json` and a managed user-level instructions file; `crew doctor` warns when VS Code would not see `CREW_API_KEY` (CREW-1527)

## [0.32.0] — 2026-10-10

- A toolchain with `launcher: ori` now records `provider: openrouter`, accepts an optional `launcherBin`, and `crew doctor` flags that Ori's headless auth under the scheduler is unverified (CREW-1522)

## [0.31.0] — 2026-10-10

- `crew disconnect` no longer removes a Pair `tablation` MCP server crew did not install (CREW-1517)
- Pair now installs for Codex and Gemini CLI via `ship.pair` (a managed instructions block plus a key-by-env-var MCP entry in their user-level files), with `crew connect`/`doctor` support and a new `crew disconnect` (CREW-1517)

## [0.30.1] — 2026-10-10

- Persona prompts no longer assume Claude Code: wording is harness-neutral, and the design lane's Skill/canvas steps apply only where the harness provides them, with an edit-profile fallback (CREW-1526)

## [0.30.0] — 2026-10-10

- Run identity: harness, provider and toolchain are recorded in the sidecar, finished event and Agent Log, and shown by `crew logbook` (CREW-1516)
- Each agent run now records which harness, provider and toolchain served it (sidecar, finished event, Agent Log), `crew logbook` shows harness and provider beside the model, and an Agent Log report no longer fails against a server that predates the new fields (CREW-1516)

## [0.29.0] — 2026-10-10

- Seat resolution reads each persona's vendor, tier and model: the vendor picks the ship toolchain that serves it (default plus a warning when none does), the tier picks the model and reasoning setting through the toolchain's tiers map, an explicit model is honored only for the toolchain's vendor, `--dry-run` prints the resolution chain and `crew doctor` lists seats whose vendor has no toolchain (CREW-1515)

## [0.28.0] — 2026-10-10

- Toolchain abstraction: Claude is the first adapter behind a harness-neutral seam, with a `toolchains:` map, ship default and per-route override (CREW-1511)

## [0.27.0] — 2026-10-10

- Run `crew reap` (not a nonexistent `crew clean`) once to rotate an existing oversized events.jsonl (CREW-1509)
- The shared events.jsonl now rotates by size (`ship.eventsRotateBytes`, default 64 MB) and rotated files are swept by `streamRetentionDays`; run `crew clean` once to rotate an existing oversized log, and `crew doctor` warns when rotation isn't running (CREW-1509)

## [0.26.0] — 2026-10-10

- Worktree directory names are configurable with a `worktrees.name` template (`{dir}`, `{issue}`, `{number}`, `{key}`, `{slug}`), overridable per route repo via `worktreeName` (CREW-1504)

## [0.25.0] — 2026-10-10

- Routes with no configured API key now fall back to the CREW_API_KEY environment variable, and the missing-key error names every source checked (CREW-1503)
- Lane prompts treat work needed in another repo as a filed, linked dependency and QA bounces hand-offs that list unfiled needed work (CREW-1505)
- blocked_by now holds past accepted — QA skips blocked fixed/qa tickets and the release phase holds blocked verified ones, reported once and shown in crew status (CREW-1506)

## [0.24.0] — 2026-10-10

- `crew projects [--route R] [--json]` lists the Projects rows each route can read (id, name, issue prefix, work mode, current area) for the macOS Project popup (CREW-1502)

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
