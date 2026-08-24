#!/usr/bin/env bash
# Tablation ticket-implementation loop — local (launchd) headless agent that
# picks up accepted tickets from the tracker and implements them on
# their own issue-<number> branch (see prompts/common.md
# for the full policy). Runs on this Mac because the dev/test toolchain and
# git worktree live here, not on the deploy target.
#
# Split into two tiers so a full agent session doesn't spin up every timer
# fire just to find nothing to do:
#   - poll (default, launchd-invoked): a few cheap curl/jq calls against the
#     tracker API. Triggers an agent only if there's an accepted ticket, or
#     a new (non-self) comment on a ticket we're tracking (in_progress/fixed
#     assigned to us, or any needs_info).
#   - run: the actual headless `claude -p` agent session.
#
# The agent phase has three *lanes*. Status decides QA's slice; the Bug
# Reports `needs_design` boolean that triage sets splits the other two:
#   - qa     — tickets at `fixed` (built, unchecked) or `qa` ("Verification",
#              mid-check), from either building lane. Identity: the QA
#              seat's Crew row. It tests the fix in the builder's own
#              worktree and either passes it to `verified`, bounces it back
#              to `in_progress` with the reason, or asks the operator via
#              `needs_info`. It never writes code.
#   - dev    — tickets that don't need UI/UX design (needs_design false or
#              null). Identity: the dev seat's Crew row.
#   - design — tickets flagged needs_design. Identity: the design seat's
#              Crew row; the session designs the surface (mockups + screenshots
#              posted to the ticket) before implementing it.
# All three share common.md and differ only by the lane brief
# appended to it (lane-dev.md / lane-design.md / lane-qa.md).
#
# ONE lane runs per cycle (ISSUE-177). All are polled, but the lane holding
# the most urgent actionable ticket wins the cycle and the others stay
# pending for the next one — see lane_top_rank. Before this, each lane with
# work got its own session every cycle, so design drew roughly half the
# agent cycles for a tenth of the queue. Ordering comes from priority.jq,
# the same module that sorts the queue digest the agent is handed. QA
# outranks both building lanes whenever it has anything to check: a fix
# nobody has verified is what the whole pipeline is waiting on.
#
# After the agent phase, every cycle also runs a *release* phase, and that
# phase — not any agent — is what touches `main`:
#   1. merge_verified_branches squash-merges every QA-`verified` ticket's
#      issue-<n> branch onto main, oldest first, bumps the version once for
#      the whole batch, writes the CHANGELOG section, and drops each merged
#      worktree. A branch that no longer merges cleanly is bounced back to
#      its building lane as in_progress with a comment.
#   2. If `main` has commits past the last-released ref, run the test gate
#      and the project's deploy hook, advance the ref, and stamp the tickets the
#      release shipped: released_version/released_at, and `verified` ->
#      `closed_deployed`.
# Merging and deploying are done here, in plain shell, rather than by an
# agent — a headless session shouldn't be handed permission to push to
# production, and neither step needs judgement.
#
# Usage:
#   crew/bin/crew            # poll once; run the agent if something's pending (called by launchd)
#   crew/bin/crew run [lane] # force a full agent run, bypassing the poll check (lane: dev (default) | design | qa)
#   crew/bin/crew deploy     # force the release check now, even for a commit a prior deploy failed on
#   crew/bin/crew deploy --skip-tests   # ... and skip the test gate (hotfix over a red suite)
#   crew/bin/crew pause      # pause future iterations (poll and run alike)
#   crew/bin/crew resume     # resume
#   crew/bin/crew pause design    # pause just one lane's poll; the other lanes and releases carry on
#   crew/bin/crew resume design   # ... and put it back
#   crew/bin/crew merge      # force the verified-branch merge now, without waiting for a cycle
#   crew/bin/crew status     # show paused/running state
#   crew/bin/crew ports      # which checkout owns which ports, and what's up
#   crew/bin/crew reap       # kill dev servers left over from removed worktrees
#   crew/bin/crew drop NNN   # remove a merged ticket's worktree + branch for good (kills its processes first)
#   crew/bin/crew log [args] # tail the log (args passed to tail, e.g. -f, -n 200)
#   crew/bin/crew doctor  # read-only preflight: config, files, tools, tracker reachability
#
# Install on a timer (optional):
#   cp crew/launchd/com.tablation.crew.plist ~/Library/LaunchAgents/  # after editing its paths
#   launchctl load ~/Library/LaunchAgents/com.tablation.crew.plist
# Remove:
#   launchctl unload ~/Library/LaunchAgents/com.tablation.crew.plist
#
# Logs: /tmp/tablation-crew.log
set -euo pipefail

# CREW_HOME is this repo; CREW_PROJECT_DIR is the checkout the crew works in.
# They are two different places — that separation is the whole point of this
# repo existing (ISSUE-321). Everything machine- or project-specific lives in
# crew.config.sh, which is gitignored; crew.config.example.sh documents it.
CREW_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREW_CONFIG="${CREW_CONFIG:-$CREW_HOME/crew.config.sh}"
if [[ ! -f "$CREW_CONFIG" ]]; then
  echo "FATAL: no config at $CREW_CONFIG — copy crew.config.example.sh and fill it in" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CREW_CONFIG"

for _required in CREW_PROJECT_DIR CREW_BASE_URL CREW_WORKSPACE_ID CREW_BUGS_MODEL_ID \
                 CREW_COMMENTS_MODEL_ID CREW_MEMBER_DEV CREW_MEMBER_DESIGN CREW_MEMBER_QA \
                 CREW_MEMBER_MODEL_ID CREW_OPERATOR CREW_WORKTREE_PREFIX; do
  if [[ -z "${!_required:-}" ]]; then
    echo "FATAL: $_required is not set in $CREW_CONFIG" >&2
    exit 1
  fi
done
unset _required

CREW_STATE_DIR="${CREW_STATE_DIR:-$CREW_HOME/.state}"
mkdir -p "$CREW_STATE_DIR"

# Every path below this line is relative to the PROJECT, not to this repo.
cd "$CREW_PROJECT_DIR"

# launchd hands this script a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin)
# with no node, pnpm, or homebrew on it — nothing like the PATH a login
# shell builds. The deploy scripts shell out to `pnpm` directly, so without
# this the release phase fails instantly with `pnpm: command not found`
# (exit 127) even though the same deploy works by hand in a terminal.
#
# Node comes from nvm, and `.nvmrc` is the single source of truth for which
# one (it matches the deploy target). Rather than resolve a "close enough"
# version here, source nvm and let `nvm use` read that file — nvm is a shell
# function, not a binary, so it has to be sourced rather than exec'd.
# Guessing is what this replaces: the previous version globbed for the
# highest installed patch of the .nvmrc *major*, and silently fell back to
# the newest installed Node of any major when that missed. .nvmrc now pins a
# full version (22.23.2), which that glob could never match — so every cycle
# would have run the tests and the release gate on whatever Node happened to
# be newest. That matters: Node 26 fails 48 frontend tests (jsdom/localStorage
# under vitest, ISSUE-105) and would have blocked every deploy for a reason
# having nothing to do with the code being released.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NVM_SH="${CREW_NVM_SH:-/opt/homebrew/opt/nvm/nvm.sh}"
if [[ "${CREW_USE_NVM:-true}" != "true" ]]; then
  NVM_SH=""
elif [[ ! -s "$NVM_SH" ]]; then
  echo "FATAL: nvm not found at $NVM_SH — \`brew install nvm\`, or set CREW_USE_NVM=false" >&2
  exit 1
fi
# nvm.sh is not written to survive `set -euo pipefail` (it reads unset vars
# and expects non-zero returns to be recoverable), so relax those for the
# source and the version switch only.
set +eu
if [[ -n "$NVM_SH" ]]; then
\. "$NVM_SH"
if ! nvm use >/dev/null; then
  # First run against a newly-pinned version: install it rather than leave
  # the loop dead until someone notices. `nvm install` reads .nvmrc too.
  echo "Node $(tr -d ' \n' < .nvmrc) not installed under $NVM_DIR — installing it" >&2
  if ! nvm install >/dev/null; then
    echo "FATAL: nvm install failed for the version in .nvmrc" >&2
    set -eu
    exit 1
  fi
fi
fi
set -eu
# Homebrew *after* nvm's bin: /opt/homebrew/bin has its own (newer) node,
# which must not win, but it is where pnpm comes from.
export PATH="$PATH${CREW_EXTRA_PATH:+:$CREW_EXTRA_PATH}"

PAUSE_FILE="$CREW_STATE_DIR/.crew-paused"
LOCK_FILE="$CREW_STATE_DIR/.crew.lock"
# The release phase gets its own lock, deliberately separate from the agent
# lock: an agent session can be busy implementing a ticket for a long time,
# and pending changes on main shouldn't sit unreleased behind it. Two
# releases must still never overlap, hence a lock rather than none.
RELEASE_LOCK_FILE="$CREW_STATE_DIR/.crew-release.lock"
WATERMARK_FILE="$CREW_STATE_DIR/.poll-watermark"
# Commit last successfully released by the deploy hook. A real git ref
# (not a file of text) so it's a proper commit pointer: `git log
# $LAST_RELEASE_REF..main` works, and it survives under refs/ rather than in
# a gitignored dotfile that a worktree prune or a clean could take out. Kept
# outside refs/heads so it never shows up as a branch.
LAST_RELEASE_REF="refs/tablation/last-release"
# HEAD that the most recent deploy attempt failed on. Blocks re-attempting
# the same broken commit every cycle (and re-filing its ticket); a new
# commit on main clears the block automatically, as does `crew
# deploy`.
DEPLOY_FAILED_SHA_FILE="$CREW_STATE_DIR/.deploy-failed-sha"
LOG_FILE="${CREW_LOG_FILE:-/tmp/tablation-crew.log}"
BASE_URL="$CREW_BASE_URL"
WORKSPACE_ID="$CREW_WORKSPACE_ID"
BUGS_MODEL_ID="$CREW_BUGS_MODEL_ID"
COMMENTS_MODEL_ID="$CREW_COMMENTS_MODEL_ID"
# The dev seat's Crew row — distinct from the live-session row an
# interactive Claude session uses when someone is working a ticket in chat.
# Without that split, this poll's "new comment from someone else" check
# couldn't tell the dev seat's own comments apart from an interactive
# session's progress notes on a shared identity, and would wake the full
# agent over its own kind's chatter — which is what actually caused the
# ISSUE-023 collision this identity split fixes.
DEV_TEAM_MEMBER_ID="$CREW_MEMBER_DEV"
# The design seat's Crew row — the UI/UX design lane's identity, a
# third distinct one for the same reason. The two lanes are partitioned by
# the Bug Reports `needs_design` boolean (set by triage): design takes
# needs_design == true, dev takes everything else, and neither ever counts
# or touches the other's tickets. Separate identities are what let this poll
# tell "my own unfinished work" apart from "the other lane is mid-ticket."
DESIGN_TEAM_MEMBER_ID="$CREW_MEMBER_DESIGN"
# The QA seat's Crew row — the verification lane's identity. QA's
# slice is decided by status, not by needs_design: every ticket at `fixed`
# or `qa` is QA's, whichever lane built it. A `fixed` ticket is therefore no
# longer a reason for a building lane to wake, and `verified` (QA's pass) is
# what queues a branch for the merge phase below.
QA_TEAM_MEMBER_ID="$CREW_MEMBER_QA"
# The operator's own Crew row — this ship's owner. Only ever an *assignee*
# check (an assignee of this row is an active human hold) and a name in the
# roster and queue digest; never an identity this script writes as.
OPERATOR_TEAM_MEMBER_ID="$CREW_OPERATOR"
# Every row that means HANDS OFF: the operator, plus whatever CREW_HOLDS adds
# — other people aboard this ship, and the interactive-session rows they work
# through (a Claude session driving a ticket live in chat is a human hold in
# every respect that matters here). A ticket assigned to any of them is
# excluded from every count and pick below, whatever its status, so that work
# a person is doing at a keyboard can be parked on a ticket without a seat
# grabbing it out from under them. Clearing assignee_id is what hands it back.
#
# This is a list rather than the two fixed slots it replaced because a ship
# may carry any number of people, and nothing here should assume one.
HOLD_TEAM_MEMBER_IDS=("$CREW_OPERATOR" ${CREW_HOLDS[@]+"${CREW_HOLDS[@]%%|*}"})
# Where the poll leaves each lane's queue digest for the agent to read, and
# the jq program that renders it. The agent used to fetch the whole tracker
# itself at the top of every run — ~691 KB of JSON across 176 tickets, ~275
# KB of it case-history prose for tickets it would never touch, re-read on
# every run. The poll has already fetched exactly that data to decide
# whether to wake at all, so it now hands over a digest instead: same rows,
# no prose, ~6 KB.
QUEUE_DIGEST_PREFIX="$CREW_STATE_DIR/.queue-digest-"
QUEUE_DIGEST_JQ="$CREW_HOME/lib/queue-digest.jq"
# QA's queue is one list of fixed/qa tickets rather than a building lane's
# three sections, so it gets its own program rather than a branch inside the
# other one.
QUEUE_DIGEST_QA_JQ="$CREW_HOME/lib/queue-digest-qa.jq"
# A digest older than this (seconds) is treated as absent — a stale queue is
# worse than none, since the agent would act on tickets that have since
# moved. `crew run <lane>` bypasses the poll, so this is the path
# that keeps a manual run from reading a queue built hours ago.
QUEUE_DIGEST_MAX_AGE=900
# Consecutive-skip counter for the release phase (ISSUE-174). Both release
# guards — "not on main" and "working tree is dirty" — are correct and stay
# exactly as they are; what was wrong is that refusing was SILENT, one line
# in a log nobody tails. Eight commits once sat unreleased behind a single
# untracked markdown file, among them the CALL_WEBHOOK SSRF fix, and nothing
# said so. After this many consecutive blocked cycles the block becomes
# loud: status widget, and a tracker ticket filed once per episode. One
# blocked cycle is normal (someone is mid-edit), so the alarm starts at two.
RELEASE_BLOCK_FILE="$CREW_STATE_DIR/.release-blocked"
RELEASE_BLOCK_ALARM_AFTER=2
# Per-lane pause sentinels, one file per paused lane — the same mechanism as
# the whole-loop PAUSE_FILE, one level down, so `pause`/`resume` work the
# same way with or without a lane argument. A paused lane still has its
# tickets sitting in the tracker with needs_design true; nothing is
# reassigned or re-flagged, so resuming picks the queue back up exactly
# where it left off. `crew run <lane>` still works — pausing governs
# the automatic poll, not a deliberate manual run.
LANE_PAUSE_PREFIX="$CREW_STATE_DIR/.lane-paused-"
USER_AGENT="${CREW_USER_AGENT:-Mozilla/5.0 TablationCrewAgent/1.0}"
# The open working set: every ticket whose status is not terminal. Nothing in
# the poll path can act on a `closed_*` ticket, and they are the large
# majority of the table (215 of 300 at the time this landed), so fetching
# them was pure freight — and freight that had silently pushed the old
# `?limit=200` fetch into truncation: six open tickets, ISSUE-059 among them,
# had fallen below the window and were invisible to every poll. Filtering
# server-side rather than raising the limit is what stops that recurring.
# `stamp_release_tickets` deliberately does NOT use this: it is the one read
# that genuinely needs terminal rows. See ISSUE-247.
OPEN_TICKETS_FILTER='%5B%7B%22columnName%22%3A%22status%22%2C%22operator%22%3A%22NOT_LIKE%22%2C%22value%22%3A%22closed%25%22%7D%5D'
# A blocker counts as RESOLVED — i.e. stops blocking — only once its code is
# on main, or it is closed. `fixed` and `qa` deliberately do NOT count: since
# the QA lane landed, `fixed` means an unmerged branch that QA can still
# bounce back to in_progress, and a dependent ticket branches off main, so a
# merely-`fixed` blocker is not there for it. `closed_wont_fix` and
# `closed_duplicate` DO count: they are resolutions, and waiting on them is
# pointless — the dependent may still be unbuildable, which is what the
# restore comment is for. See ISSUE-187.
BLOCKER_RESOLVED_STATUSES='["verified","closed_deployed","closed_wont_fix","closed_duplicate"]'
# Set by sweep_blocked_tickets() to the ticket payload with its own park /
# unpark writes applied, so the rest of the cycle sees the statuses it just
# wrote rather than the ones it fetched. A global rather than stdout because
# that function also logs.
SWEPT_BUGS=""
# Set by file_deploy_failure_ticket() so the status widget can name the
# ticket it just filed.
FILED_TICKET_ID=""

log() { echo "$(date -u +%FT%TZ) $*"; }

# Locks held by THIS process, released together on exit. A single EXIT trap
# (rather than one per acquire) because a second `trap ... EXIT` would
# silently replace the first and leak the earlier lock.
HELD_LOCKS=()
cleanup_locks() {
  local f
  # bash 3.2 (what launchd gives us) errors on "${arr[@]}" for an empty array
  # under `set -u`, hence the +-guard.
  for f in ${HELD_LOCKS[@]+"${HELD_LOCKS[@]}"}; do rm -f "$f"; done
}
trap cleanup_locks EXIT

# Overlap guard. Never run two copies of the same phase concurrently —
# concurrent writes to the shared dist/ build and git working tree is exactly
# what caused an earlier crash-loop incident, and a second deploy racing the
# first would be worse still. The agent and release phases take separate
# locks so a long agent run doesn't hold up releases.
acquire_lock() {
  local file="$1" label="$2"
  if [[ -f "$file" ]] && kill -0 "$(cat "$file" 2>/dev/null)" 2>/dev/null; then
    log "$label: previous run (pid $(cat "$file")) still active, skipping"
    return 1
  fi
  echo $$ > "$file"
  HELD_LOCKS=(${HELD_LOCKS[@]+"${HELD_LOCKS[@]}"} "$file")
  return 0
}

# Runs one lane's agent session. A lane's prompt is the shared policy
# (common.md) with that lane's brief appended — the brief names the
# tracker identity, the slice of the queue that lane owns, and any extra
# workflow steps. Both lanes share one policy document deliberately: the
# worktree/branch/merge protocol is the delicate part and must not drift
# between them.
run_agent() {
  local lane="${1:-dev}"
  local brief="$CREW_HOME/prompts/lane-$lane.md"
  if [[ ! -f "$brief" ]]; then
    log "agent: no lane brief at $brief — refusing to run an unscoped session"
    return 1
  fi

  # The roster goes FIRST: the prompt below refers to seats and to the
  # operator generically, and this is what binds those words to the names
  # this ship's crew actually answer to.
  local prompt roster
  roster=$(crew_roster_markdown "$lane")
  prompt=$(printf '%s\n\n%s' "$roster" "$(cat "$CREW_HOME/prompts/common.md" "$brief")")

  # Append this lane's queue digest, if the poll left a fresh one. Freshness
  # matters more than presence: acting on a stale queue is worse than
  # rebuilding it, so anything past QUEUE_DIGEST_MAX_AGE is dropped and the
  # prompt's own fallback (fetch the tracker yourself) takes over.
  local digest="${QUEUE_DIGEST_PREFIX}${lane}" age
  if [[ -f "$digest" ]]; then
    age=$(( $(date +%s) - $(stat -f %m "$digest") ))
    if (( age <= QUEUE_DIGEST_MAX_AGE )); then
      prompt="$prompt"$'\n\n'"$(cat "$digest")"
      log "agent: attached queue digest (${age}s old, $(wc -c < "$digest" | tr -d ' ') bytes)"
    else
      log "agent: queue digest is ${age}s old (> ${QUEUE_DIGEST_MAX_AGE}s), ignoring it"
    fi
  else
    log "agent: no queue digest for lane $lane, agent will fetch the tracker itself"
  fi

  # The prompt goes in on stdin, not as an argv string. `claude -p` reads it
  # either way, but an argument is world-readable in `ps` output for the whole
  # run — the full policy document, including the dev seed login it tells the
  # agent to provision, sat in every process listing on this machine. It also
  # keeps the loop clear of ARG_MAX (macOS: 1MB; the prompt is ~24KB today but
  # has only ever grown, a lesson at a time).

  # The design lane needs Skill (to load the `design` skill and `shadcn`)
  # and Artifact (to publish a design canvas) on top of the dev toolset.
  # In headless mode --allowedTools is the whole permission grant, so a tool
  # missing here is simply denied mid-run rather than prompted for.
  #
  # QA gets no Edit: it verifies, it never fixes (lane-qa.md's first hard
  # limit). That is not a real sandbox — Bash can write files, and QA needs
  # Bash for git, the dev servers and Playwright — but withholding the
  # editing tool makes "don't fix it yourself, bounce it back" the path of
  # least resistance rather than a rule to remember. Write stays for
  # throwaway verification scripts.
  local tools
  if [[ "$lane" == "qa" ]]; then
    tools=(Bash Read Write Grep Glob)
  else
    tools=(Bash Read Edit Write Grep Glob)
    [[ "$lane" == "design" ]] && tools+=(Skill Artifact)
  fi

  log "starting crew agent run (lane: $lane)"
  # Force the operator's claude.ai subscription auth regardless of global
  # ~/.claude/settings.json — that file has flipped to Vertex/Console
  # billing before (env vars, not shell config, so a bare `env -u` here
  # can't be shadowed by this repo's local settings override alone).
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_USE_VERTEX \
      -u ANTHROPIC_VERTEX_PROJECT_ID -u ANTHROPIC_VERTEX_REGION -u CLOUD_ML_REGION \
      -u ANTHROPIC_MODEL \
    "$CREW_CLAUDE_BIN" -p \
    --allowedTools "${tools[@]}" \
    --model "$CREW_AGENT_MODEL" <<<"$prompt"
  log "crew agent run finished (lane: $lane)"
  # Building lanes only: the reconcile reads evidence (a worktree with real
  # work in it) that a QA run never produces.
  case "$lane" in
    dev)    reconcile_ticket_status dev "$DEV_TEAM_MEMBER_ID" ;;
    design) reconcile_ticket_status design "$DESIGN_TEAM_MEMBER_ID" ;;
  esac
}

# Safety net for the lane brief's Step 3 (set status `in_progress`, assign
# to yourself). An agent that goes straight to implementing leaves the
# ticket `accepted` and unassigned: the board shows nothing in progress,
# and — the part that actually costs work — a later cycle re-picks that
# same ticket and redoes what is already sitting in its worktree. The flip
# is what makes a run crash-safe, so it should not depend on the agent
# remembering one API call. Observed on ISSUE-156: the agent posted its
# Step 4 progress comment and then implemented for 40 minutes with the
# ticket still reading `accepted`.
#
# Reconciles from evidence an agent cannot forget to leave behind: an
# `issue-NNN` worktree that exists AND holds real work (dirty tree, or
# commits ahead of main). Deliberately conservative — only a ticket that is
# still `accepted` AND unassigned is touched, so work already assigned to
# a hold row or the other lane is never restamped, and a stale
# worktree over an untouched ticket is left alone. Runs after every agent
# run, so it also covers a run that died before reaching Step 3.
reconcile_ticket_status() {
  local lane="$1" me="$2"
  local api_key; api_key=$(tracker_api_key)
  if [[ -z "$api_key" ]]; then
    log "reconcile[$lane]: no tracker API key, skipping"
    return 0
  fi

  local bugs
  bugs=$(fetch_open_tickets "$api_key") || {
    log "reconcile[$lane]: tracker GET failed, skipping"
    return 0
  }

  local wt name num row id status assignee
  while read -r wt; do
    [[ -z "$wt" ]] && continue
    name="$(basename "$wt")"
    # Worktrees may be named with or without zero padding (see `ports`), so
    # match the ticket numerically rather than on the literal string.
    [[ "$name" =~ ^${CREW_WORKTREE_PREFIX}0*([0-9]+)$ ]] || continue
    num="${BASH_REMATCH[1]}"

    [[ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]] \
      || [[ "$(git -C "$wt" rev-list --count main..HEAD 2>/dev/null || echo 0)" != "0" ]] \
      || continue

    row=$(echo "$bugs" | jq -c --argjson n "$num" \
      'map(select((.issue_id // "") | ltrimstr("ISSUE-") | (tonumber? // -1) == $n)) | .[0] // empty')
    [[ -z "$row" ]] && continue
    status=$(echo "$row" | jq -r '.status // empty')
    assignee=$(echo "$row" | jq -r '.assignee_id // empty')
    [[ "$status" == "accepted" ]] || continue
    [[ -z "$assignee" ]] || continue

    id=$(echo "$row" | jq -r '.id')
    if curl -sf --max-time 20 -X PATCH \
        -H "Authorization: Bearer $api_key" \
        -H "User-Agent: $USER_AGENT" \
        -H "Content-Type: application/json" \
        -d "{\"status\":\"in_progress\",\"assignee_id\":\"$me\"}" \
        "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records/$id" >/dev/null; then
      log "reconcile[$lane]: ISSUE-$num has a worktree with real changes but was still 'accepted' -> set in_progress, assigned to $lane lane (agent skipped Step 3)"
    else
      log "reconcile[$lane]: FAILED to update ISSUE-$num (tracker PATCH rejected)"
    fi
  done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')
}

# Roster and credential helpers.
. "$CREW_HOME/lib/crew.sh"

# Every non-terminal ticket, in one call (see OPEN_TICKETS_FILTER). Every
# read in the poll/reconcile/merge path goes through this rather than
# fetching the whole table and filtering in jq.
fetch_open_tickets() {
  local api_key="$1"
  curl -sf --max-time 30 -H "Authorization: Bearer $api_key" \
    -H "User-Agent: $USER_AGENT" \
    "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records?filters=$OPEN_TICKETS_FILTER&limit=500"
}

# ---------------------------------------------------------------------------
# Blocked-by: park approved-but-blocked tickets, restore them when the
# blockers clear (ISSUE-187).
#
# Blocked-ness is COMPUTED from the `blocked_by` field on every poll and is
# never read back off the `blocked` status. The status is how the board shows
# it — swimlanes are status-defined, so there is no Blocked lane without one —
# but nothing here branches on it to decide whether a ticket is startable.
#
# The invariant that makes writing a status safe: `blocked` is strictly a
# sub-state of *approved*. The loop parks only `accepted -> blocked` and
# restores only `blocked -> accepted`, and writes no other transition. The
# operator's approval therefore happens exactly once, up front, and every
# restore hands back a status they already set. A ticket that has never been approved is
# already outside every count below, so parking it would buy nothing and
# would break that invariant — it waits at `new` for triage.
#
# A one-way park is deliberately not an option: parking without restoring is
# exactly what `needs_info` did to ISSUE-138 and ISSUE-134, which sat
# invisible for weeks after their blocker shipped.
# ---------------------------------------------------------------------------

# {id: {issue_id, status}} for every ticket in the open set PLUS every ticket
# any of them names in `blocked_by`. The second group needs its own fetch
# because a blocker is usually already closed and so is not in the open set —
# that is the one consumer that genuinely needs terminal rows. Bounded to the
# ids actually referenced (~20), not the whole closed archive.
#
# An id in neither call is a genuinely dangling reference (the record was
# hard-deleted). It is logged and treated as NOT blocking: parking a ticket
# forever on a row nobody can ever resolve is the worse failure.
blocker_info_map() {
  local api_key="$1" bugs="$2"
  local known missing extra_json filter
  known=$(echo "$bugs" | jq -c 'map({key: .id, value: {issue_id, status}}) | from_entries')
  missing=$(echo "$bugs" | jq -c --argjson known "$known" \
    '[ .[] | (.blocked_by // [])[] ] | unique | map(select($known[.] == null))')
  if [[ "$(echo "$missing" | jq 'length')" != "0" ]]; then
    filter=$(echo "$missing" | jq -r '[{columnName: "id", operator: "IN", value: .}] | tojson | @uri')
    extra_json=$(curl -sf --max-time 20 -H "Authorization: Bearer $api_key" \
      -H "User-Agent: $USER_AGENT" \
      "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records?filters=$filter&limit=200") || extra_json="[]"
    known=$(jq -nc --argjson a "$known" \
      --argjson b "$(echo "$extra_json" | jq -c 'map({key: .id, value: {issue_id, status}}) | from_entries')" \
      '$a + $b')
  fi
  echo "$known"
}

# The ids of tickets with at least one UNRESOLVED direct blocker.
#
# Depth 1 only, and deliberately so: if A blocks B blocks C, then B is parked,
# so B never reaches a resolved status, so C stays blocked — transitivity
# comes free through iteration. A mutual block parks both permanently, which
# is the correct answer and terminates trivially, so there is no cycle
# detection here beyond the log line in sweep_blocked_tickets.
compute_blocked_ids() {
  local bugs="$1" info="$2"
  echo "$bugs" | jq -c --argjson info "$info" --argjson resolved "$BLOCKER_RESOLVED_STATUSES" \
    '[ .[]
       | select(
           [ (.blocked_by // [])[]
             | ($info[.].status // null) as $s
             | select($s != null and ($resolved | index($s)) == null) ]
           | length > 0 )
       | .id ]'
}

# Posts one comment on a ticket as an `event`, i.e. bookkeeping rather than
# something anyone must reply to. `kind: "event"` matters: the digest's
# "new since last poll" count excludes events, so the loop cannot wake itself
# up over its own park/unpark notes. No team_member_id, same as the tracker's
# own status-change events.
post_event_comment() {
  local api_key="$1" ticket_id="$2" body="$3"
  jq -nc --arg t "$ticket_id" --arg b "$body" '{ticket_id: $t, body: $b, kind: "event"}' \
    | curl -sf --max-time 20 -X POST \
        -H "Authorization: Bearer $api_key" \
        -H "User-Agent: $USER_AGENT" \
        -H "Content-Type: application/json" \
        --data-binary @- \
        "$BASE_URL/api/data-models/$COMMENTS_MODEL_ID/records" >/dev/null
}

# Park and restore, in both directions, and leave $SWEPT_BUGS holding the
# payload with those writes applied. Only ever accepted -> blocked and
# blocked -> accepted; an `in_progress` ticket is never parked (a dependency
# discovered mid-build is a judgement call for the agent — needs_info, or
# ride it out), and no other status is touched at all.
sweep_blocked_tickets() {
  local api_key="$1" bugs="$2" info="$3" blocked_ids="$4"
  SWEPT_BUGS="$bugs"

  local dangling
  dangling=$(echo "$bugs" | jq -r --argjson info "$info" \
    '.[] | . as $t | (.blocked_by // [])[] | select($info[.] == null) | "\($t.issue_id) -> \(.)"')
  if [[ -n "$dangling" ]]; then
    while read -r d; do
      log "blocked: DANGLING blocked_by reference, ignored: $d"
    done <<< "$dangling"
  fi

  # Worth one cheap line and nothing more: a self-block parks a ticket
  # forever, which is the correct answer to "this depends on itself" but is
  # almost always a data-entry slip.
  local selfblocked
  selfblocked=$(echo "$bugs" | jq -r \
    '[ .[] | . as $t | select(($t.blocked_by // []) | index($t.id)) | .issue_id ] | join(", ")')
  if [[ -n "$selfblocked" ]]; then
    log "blocked: ticket(s) blocking themselves, parked permanently: $selfblocked"
  fi

  local rows id issue status blockers changed
  changed=0

  # Park: approved, and something it names is unresolved.
  rows=$(echo "$bugs" | jq -r --argjson ids "$blocked_ids" --argjson info "$info" \
    '.[] | select(.status == "accepted" and (.id | IN($ids[])))
     | [ .id, .issue_id,
         ([ (.blocked_by // [])[] | "\($info[.].issue_id // "?") (\($info[.].status // "unknown"))" ] | join(", ")) ]
     | @tsv')
  while IFS=$'\t' read -r id issue blockers; do
    [[ -z "$id" ]] && continue
    if curl -sf --max-time 20 -X PATCH \
        -H "Authorization: Bearer $api_key" -H "User-Agent: $USER_AGENT" \
        -H "Content-Type: application/json" -d '{"status":"blocked"}' \
        "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records/$id" >/dev/null; then
      log "blocked: parked $issue (waiting on $blockers)"
      post_event_comment "$api_key" "$id" \
        "Parked as **Blocked** by the dev loop — waiting on: $blockers.

This is automatic and reversible: an approved ticket whose \`Blocked by\` entries are not all resolved is parked out of the queue, and restored to **Approved** on the first poll after the last one resolves. Nothing else about the ticket changes. A blocker counts as resolved at \`verified\`, \`closed_deployed\`, \`closed_wont_fix\` or \`closed_duplicate\` — not at \`fixed\`, which is still an unmerged branch awaiting QA." || \
        log "blocked: parked $issue but the comment POST failed"
      SWEPT_BUGS=$(echo "$SWEPT_BUGS" | jq -c --arg id "$id" 'map(if .id == $id then .status = "blocked" else . end)')
      changed=$((changed + 1))
    else
      log "blocked: FAILED to park $issue (tracker PATCH rejected)"
    fi
  done <<< "$rows"

  # Restore: parked, and nothing it names is unresolved any more.
  rows=$(echo "$bugs" | jq -r --argjson ids "$blocked_ids" --argjson info "$info" \
    '.[] | select(.status == "blocked" and (.id | IN($ids[]) | not))
     | [ .id, .issue_id,
         ([ (.blocked_by // [])[] | "\($info[.].issue_id // "?") (\($info[.].status // "unknown"))" ] | join(", ")) ]
     | @tsv')
  while IFS=$'\t' read -r id issue blockers; do
    [[ -z "$id" ]] && continue
    if curl -sf --max-time 20 -X PATCH \
        -H "Authorization: Bearer $api_key" -H "User-Agent: $USER_AGENT" \
        -H "Content-Type: application/json" -d '{"status":"accepted"}' \
        "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records/$id" >/dev/null; then
      log "blocked: restored $issue to accepted (blockers resolved: ${blockers:-none})"
      post_event_comment "$api_key" "$id" \
        "Restored to **Approved** by the dev loop — every blocker has resolved${blockers:+ ($blockers)}.

This restores the status it was approved at before being parked; it is back in the queue and a lane may pick it up. If a blocker resolved as \`closed_wont_fix\` or \`closed_duplicate\` this ticket may still not be buildable as written — that is a call for a human, not the loop." || \
        log "blocked: restored $issue but the comment POST failed"
      SWEPT_BUGS=$(echo "$SWEPT_BUGS" | jq -c --arg id "$id" 'map(if .id == $id then .status = "accepted" else . end)')
      changed=$((changed + 1))
    else
      log "blocked: FAILED to restore $issue (tracker PATCH rejected)"
    fi
  done <<< "$rows"

  # Failure mode this ticket was filed for, in its other half: a ticket parked
  # in needs_info whose blockers have all since resolved is invisible, because
  # needs_info only ever wakes on a new comment from a human. The loop must
  # not promote it — needs_info means a person owes an answer — so it says so
  # in the log and leaves it alone.
  local stranded
  stranded=$(echo "$SWEPT_BUGS" | jq -r --argjson ids "$blocked_ids" \
    '[ .[] | select(.status == "needs_info" and ((.blocked_by // []) | length) > 0
                     and (.id | IN($ids[]) | not)) | .issue_id ] | join(", ")')
  if [[ -n "$stranded" ]]; then
    log "blocked: needs_info with all blockers resolved (the operator's call, not the loop's): $stranded"
  fi

  if [[ "$changed" -gt 0 ]]; then
    log "blocked: swept $changed ticket(s)"
  fi
  return 0
}

# Release gate: the backend and frontend test suites must both pass against
# what's about to ship. Releases are unattended, so without this the only
# thing standing between a red suite and the deploy target is an agent's self-report —
# and agents have reported "full suite clean" while 48 frontend tests were
# failing (ISSUE-105), because they ran the suite in a worktree branched
# before the breakage. This runs in the primary checkout, against exactly
# the merged tree being released.
#
# Tests, plus one narrow typecheck. Broad typechecks stay excluded because a
# stale generated Prisma client fails `tsc` in a checkout that hasn't run
# `prisma generate` since the last schema change, which would block releases
# for a local-environment reason rather than a real defect. `build:scripts`
# is worth the exception, with that failure mode defused by regenerating the
# client first (see below):
#
#   - It compiles the standalone backfill/migration scripts, which are only
#     ever run by hand against real data. A break in one is otherwise
#     invisible until the moment it matters — as happened with the ISSUE-049
#     migration, which failed on the target *after* a green release.
#   - tsconfig.scripts.json is the only config that includes `src/**/*.ts`,
#     so it is the one place spec files get typechecked at all. `build` uses
#     tsconfig.build.json, which excludes them, and jest does not typecheck.
#     That combination let four stale RecordsService constructor calls ship.
#
# `prisma generate` (client only — NOT `db:generate`, which also rewrites the
# tracked prisma/schema.prisma and could dirty the tree the release gate
# requires to be clean) refreshes the generated client into the gitignored
# apps/backend/generated/, so the stale-client failure the comment above
# describes cannot block a release here.
run_release_tests() {
  local output_file="$1"
  local ok=0
  log "release: running test suites before deploying"
  set +e
  # Two project hooks, defined in crew.config.sh: `crew_hook_test` must
  # return non-zero if ANY suite it runs fails, and `crew_hook_build` covers
  # whatever else has to compile before a release (generated clients, build
  # scripts). Splitting them keeps the failure legible in the log without
  # this script needing to know what a suite is.
  {
    echo "=== tests: ${CREW_TEST_LABEL:-crew_hook_test}"
    crew_hook_test 2>&1
    echo "tests exit: $?"
    echo "=== build: ${CREW_BUILD_LABEL:-crew_hook_build}"
    crew_hook_build 2>&1
    echo "build exit: $?"
  } | tee "$output_file" | grep -E '^(===|tests exit|build exit|Tests:|Test Files|Tests |error TS)' | while read -r l; do log "  $l"; done
  # Exit codes travel through the pipeline in the file, not $? — read them back.
  grep -q '^tests exit: 0$' "$output_file" || ok=1
  grep -q '^build exit: 0$' "$output_file" || ok=1
  set -e
  return "$ok"
}

# Files a `new` bug-tracker ticket for a failed deploy, so a broken release
# lands in the same queue as everything else (triage promotes it to
# accepted, and a later loop cycle picks it up like any other ticket).
# `issue_id` is an AUTO_NUMBER field — assigned server-side, never sent.
file_deploy_failure_ticket() {
  local sha="$1" output_file="$2" kind="${3:-deploy}"
  local api_key payload response title body repro
  if [[ "$kind" == "blocked" ]]; then
    title="Release blocked $RELEASE_BLOCK_ALARM_AFTER+ cycles — the deploy target is not receiving merged work"
    body="The dev loop's release phase has refused to deploy for $RELEASE_BLOCK_ALARM_AFTER consecutive cycles, so **commits merged to \`main\` are sitting undeployed**. The guard itself is working as intended — a dirty tree or a non-main checkout must never be released, since the deploy builds from the working tree. This ticket exists because the refusal used to be silent (ISSUE-174).\n\nClearing the condition named below lets the very next cycle deploy on its own; nothing needs to be retried by hand."
    repro="1. Read the detail line at the top of the output below.\n2. Commit, stash, or remove what it names (or return the primary checkout to \`main\`).\n3. The next release cycle deploys with no further action."
  elif [[ "$kind" == "tests" ]]; then
    title="Test suite red on $(git log -1 --format=%h "$sha") — release blocked"
    body="The dev loop's release phase ran the project test hook against \`main\` at commit \`$sha\` and something failed, so **the deploy was skipped and the target still runs the previous release**. Filed automatically. The loop will not retry this commit — it retries once a new commit lands on \`main\`, or when \`crew deploy\` is run by hand (\`crew deploy --skip-tests\` releases without the gate, for a hotfix that can't wait on a red suite)."
    repro="1. \`git checkout main && git reset --hard $sha\`\n2. Run ${CREW_TEST_LABEL:-the crew_hook_test command}\n3. Observe the failure above."
  else
    title="Deploy failed on $(git log -1 --format=%h "$sha")"
    body="\`${CREW_DEPLOY_LABEL:-the deploy hook}\` failed while releasing \`main\` at commit \`$sha\` ($(git log -1 --format=%s "$sha")).\n\nFiled automatically by the dev loop release phase. The loop will not retry this commit — it retries once a new commit lands on \`main\`, or when \`crew/bin/crew deploy\` is run by hand. **The target may be left in a partially-deployed state.**"
    repro="1. \`git checkout main && git reset --hard $sha\`\n2. Run \`${CREW_DEPLOY_LABEL:-the deploy hook}\`\n3. Observe the failure above."
  fi
  api_key=$(tracker_api_key)
  if [[ -z "$api_key" ]]; then
    log "release: no tracker API key, cannot file deploy-failure ticket"
    return 1
  fi

  # Tail only — a deploy log is mostly successful build noise, and the
  # failing step is at the end.
  payload=$(jq -n \
    --arg title "$title" \
    --arg body "$body" \
    --arg repro "$repro" \
    --arg out "$(tail -n 80 "$output_file")" \
    '{
      title: $title,
      description: ($body + "\n\nLast 80 lines of output:\n\n```\n" + $out + "\n```"),
      repro_steps: $repro,
      report_type: "bug",
      product_area: "other",
      severity: "s2",
      reporter_name: "Devloop agent",
      contact_email: "brad@rightdesign.com"
    }')

  response=$(curl -sf -X POST \
    -H "Authorization: Bearer $api_key" \
    -H "User-Agent: $USER_AGENT" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records") || {
    log "release: FAILED to file deploy-failure ticket (tracker POST rejected)"
    return 1
  }
  # Exposed for the status widget line — the ticket id is the single most
  # useful thing to see on a phone when a deploy has broken.
  FILED_TICKET_ID=$(echo "$response" | jq -r '.issue_id // empty')
  log "release: filed deploy-failure ticket ${FILED_TICKET_ID:-(id not returned)}"
}

# What the deploy target reports it is actually running — a commit sha or a
# version, on one line. Empty when the target is unreachable, the hook is
# undefined, or it fails.
#
# This is `crew_hook_released` in crew.config.sh, because "what is live" is a
# fact about the PROJECT, not about the crew. An earlier version hardcoded one
# project's `/api/health-check` and reached it through $BASE_URL — the
# *tracker's* host — which worked only because that project's app and its
# tracker happen to share a hostname. Nothing about that generalises.
#
# The Node runner reads the same thing from the repo's own `.crew.yaml`
# (`hooks.released`, see docs/REPO_SPEC.md); this is the bash equivalent.
released_commit() {
  declare -F crew_hook_released >/dev/null || return 0
  ( crew_hook_released 2>/dev/null | head -1 | tr -d ' \n' ) || true
}

# Announces one piece of release state to wherever this installation wants it
# seen — a desktop widget, a phone push, a chat webhook, a log line, nothing.
#
# The crew has no opinion about any of that, so this reports SEMANTICS and
# lets `crew_hook_notify` in crew.config.sh decide on presentation:
#
#   crew_hook_notify <level> <headline> <detail>
#     level    ok | warn | fail   — what happened, not how to draw it
#     headline one short line, e.g. "v0.56.2 live"
#     detail   one shorter line, e.g. "8d11925 · 3 commit(s) released"
#
# Icons, colours, brand marks and the name of the target device are the
# operator's business and live in their config, which is why none of them
# appear in this repo. An installation that defines no hook simply logs.
#
# Never fatal: a hook that is missing, slow or broken must not change the
# release outcome, so failures are logged and swallowed.
notify() {
  local level="$1" headline="$2" detail="$3"
  if ! declare -F crew_hook_notify >/dev/null; then
    log "notify[$level]: $headline / $detail"
    return 0
  fi
  if crew_hook_notify "$level" "$headline" "$detail" >/dev/null 2>&1; then
    log "notify[$level]: $headline / $detail"
  else
    log "notify[$level]: $headline / $detail (hook failed, non-fatal)"
  fi
}

# Release phase: merge what QA has verified, then deploy main if it has
# commits the last successful deploy didn't include. Runs after the agent
# phase and on its own lock — no agent touches main at all any more (see
# merge_verified_branches, and common.md Step 4).
# Clears the consecutive-blocked-cycle counter. Called the moment the
# release phase gets past both guards, whether or not it then deploys —
# "not blocked" is the thing being tracked, not "deployed".
clear_release_block() {
  if [[ -f "$RELEASE_BLOCK_FILE" ]]; then
    local was
    was=$(cut -d' ' -f2 "$RELEASE_BLOCK_FILE" 2>/dev/null || echo "?")
    rm -f "$RELEASE_BLOCK_FILE"
    log "release: unblocked after $was cycle(s)"
    notify ok "Release unblocked" "was stuck $was cycle(s)"
  fi
}

# Records one blocked cycle and escalates once it has happened
# $RELEASE_BLOCK_ALARM_AFTER times in a row for the SAME reason. Counting
# per-reason matters: a tree that goes from dirty to on-a-branch is still
# blocked, but it is a different problem and starts its own count.
#   $1 — reason slug, stable across cycles (dirty | branch)
#   $2 — human detail naming what to fix
note_release_block() {
  local reason="$1" detail="$2"
  local prev_reason="" count=0
  if [[ -f "$RELEASE_BLOCK_FILE" ]]; then
    prev_reason=$(cut -d' ' -f1 "$RELEASE_BLOCK_FILE" 2>/dev/null || echo "")
    count=$(cut -d' ' -f2 "$RELEASE_BLOCK_FILE" 2>/dev/null || echo 0)
  fi
  [[ "$prev_reason" == "$reason" ]] || count=0
  count=$((count + 1))
  echo "$reason $count" > "$RELEASE_BLOCK_FILE"

  # How many commits are actually waiting — this is what conveys urgency,
  # far more than the fact of a skip.
  local last unreleased=0
  last=$(git rev-parse -q --verify "$LAST_RELEASE_REF^{commit}" || true)
  [[ -n "$last" ]] && unreleased=$(git rev-list --count "$last..main" 2>/dev/null || echo 0)

  local msg="release blocked $count cycle(s): $unreleased commit(s) unreleased, $detail"
  log "release: $msg"

  if (( count < RELEASE_BLOCK_ALARM_AFTER )); then
    return 0
  fi

  notify warn "Release BLOCKED ${count}x · $unreleased waiting" "$detail"

  # File once per episode, on the cycle the alarm first trips — the widget
  # keeps reporting every cycle after that, but a ticket per cycle would be
  # its own kind of noise.
  if (( count == RELEASE_BLOCK_ALARM_AFTER )); then
    local out
    out=$(mktemp -t crew-release-blocked)
    {
      echo "Reason: $reason"
      echo "$detail"
      echo
      echo "git status --porcelain:"
      git status --porcelain
      echo
      echo "Unreleased commits ($unreleased):"
      [[ -n "$last" ]] && git log --oneline "$last..main"
    } > "$out"
    file_deploy_failure_ticket "$(git rev-parse HEAD)" "$out" blocked || true
    rm -f "$out"
  fi
}

# Stamps `released_version` / `released_at` on every ticket the commits in
# this release name, and closes out the ones QA had verified: `verified` ->
# `closed_deployed` ("Deployed"), which is the status that means the fix is
# running on the deploy target rather than merely finished. This is the only place that
# status is ever set — the release is the fact it records, so nothing before
# a successful deploy may claim it.
#
# Tickets are identified the way the repo already labels them: the
# `(ISSUE-NNN)` suffix the agent puts on every squash-merge subject. The
# whole commit body is scanned, not just the subject, so a commit that
# closes several tickets stamps all of them.
#
# First release wins — a ticket that already carries a `released_version`
# is left alone. A later commit touching the same ticket (a follow-up fix,
# a revert-and-redo) shouldn't rewrite the version the fix first shipped
# in, which is the fact this field exists to preserve.
#
# Never fatal: this runs *after* a successful deploy, and a tracker that is
# down or slow must not turn a good release into a failed one.
stamp_release_tickets() {
  local from="$1" to="$2" version="$3"
  local api_key; api_key=$(tracker_api_key)
  if [[ -z "$api_key" ]]; then
    log "release: no tracker API key, not stamping released_version"
    return 0
  fi

  local ids
  ids=$(git log --format='%B' "$from..$to" | grep -oE 'ISSUE-[0-9]+' | sort -u)
  if [[ -z "$ids" ]]; then
    log "release: no ISSUE-NNN ids in the released commits, nothing to stamp"
    return 0
  fi

  local bugs
  bugs=$(curl -sf --max-time 30 -H "Authorization: Bearer $api_key" \
    -H "User-Agent: $USER_AGENT" \
    "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records?limit=1000") || {
    log "release: tracker GET failed, not stamping released_version"
    return 0
  }

  # One timestamp for the whole release: every ticket in it shipped at the
  # same moment, and a per-request `date` would spread them by seconds for
  # no reason.
  local stamped_at; stamped_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local iid row id prev status patch stamped=0 skipped=0 missing=0 deployed=0
  while read -r iid; do
    [[ -z "$iid" ]] && continue
    row=$(echo "$bugs" | jq -c --arg iid "$iid" \
      'map(select((.issue_id // "") == $iid)) | .[0] // empty')
    if [[ -z "$row" ]]; then
      missing=$((missing + 1))
      continue
    fi
    prev=$(echo "$row" | jq -r '.released_version // empty')
    status=$(echo "$row" | jq -r '.status // empty')
    # Only a ticket the work actually resolved gets stamped. Commit bodies
    # also name tickets they merely mention ("follow-up to ISSUE-105",
    # "blocked by ISSUE-220"), and stamping one of those as released would
    # be a plain lie about a ticket that is still open. `closed_duplicate`
    # and `closed_wont_fix` shipped nothing either.
    case "$status" in
      fixed|qa|verified|closed_deployed) ;;
      *) skipped=$((skipped + 1)); continue ;;
    esac
    # Two independent halves, either of which may already be done: the
    # version stamp (first release wins — a later follow-up commit must not
    # rewrite the version a fix first shipped in) and the close-out (only a
    # ticket QA actually passed; one still at fixed/qa is mid-verification
    # and stays there even though its code rode along).
    patch=$(jq -n --arg v "$version" --arg t "$stamped_at" --arg s "$status" --arg prev "$prev" \
      '(if $prev == "" then {released_version: $v, released_at: $t} else {} end)
       + (if $s == "verified" then {status: "closed_deployed"} else {} end)')
    if [[ "$patch" == "{}" ]]; then
      skipped=$((skipped + 1))
      continue
    fi
    id=$(echo "$row" | jq -r '.id')
    if curl -sf --max-time 20 -X PATCH \
        -H "Authorization: Bearer $api_key" \
        -H "User-Agent: $USER_AGENT" \
        -H "Content-Type: application/json" \
        -d "$patch" \
        "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records/$id" >/dev/null; then
      stamped=$((stamped + 1))
      [[ "$status" == "verified" ]] && deployed=$((deployed + 1))
    else
      log "release: FAILED to stamp $iid (tracker PATCH rejected)"
    fi
  done <<< "$ids"

  log "release: stamped v$version / $stamped_at on $stamped ticket(s)$( ((deployed)) && echo ", $deployed moved verified -> Deployed")$( ((skipped)) && echo ", $skipped skipped (already released, or not resolved by this work)")$( ((missing)) && echo ", $missing not found in the tracker")"
}

# --- merge phase -------------------------------------------------------
#
# Squash-merges every QA-verified ticket onto `main`. This used to be Step 4
# of the agent prompt, done by whichever lane happened to win the cycle;
# moving it here is what the QA lane made possible and necessary:
#
#   - No agent needs the primary checkout any more. A lane session lives
#     entirely in its own worktree, so it can never collide with a merge,
#     and `main` is only ever written under the release lock.
#   - A verified ticket ships on the next cycle regardless of which lane is
#     busy, rather than waiting for its own lane to win one.
#   - The version bump happens once per *release* instead of once per
#     ticket, so `released_version` finally names the version a fix actually
#     shipped in when several land together.
#
# Called from release_if_unreleased, after its on-main/clean-tree guards and
# before it decides whether there is anything to deploy — so anything merged
# here goes out in the same cycle.

# New version string for a bump size, from main's current $CREW_VERSION_FILE.
next_version() {
  local size="$1" cur major minor patch
  cur=$(jq -r '.version' "$CREW_VERSION_FILE")
  IFS=. read -r major minor patch <<< "$cur"
  if [[ "$size" == "minor" ]]; then
    minor=$((minor + 1)); patch=0
  else
    patch=$((patch + 1))
  fi
  echo "$major.$minor.$patch"
}

# Writes `version` into every $CREW_VERSION_FILES entry with a targeted
# substitution rather than a jq rewrite — jq would reformat the whole file.
write_version() {
  local new="$1"
  python3 - "$new" "${CREW_VERSION_FILES[@]}" <<'PYEOF'
import re, sys
new = sys.argv[1]
for path in sys.argv[2:]:
    src = open(path).read()
    out, n = re.subn(r'("version"\s*:\s*")[^"]*(")', r'\g<1>' + new + r'\g<2>', src, count=1)
    if n != 1:
        raise SystemExit(f"no version field in {path}")
    open(path, 'w').write(out)
PYEOF
}

# Prepends this release's section to $CREW_CHANGELOG, newest first, directly
# under `## [Unreleased]` when that heading exists and above the newest
# version section otherwise. Entries arrive one per line on stdin.
write_changelog() {
  local version="$1" entries_file="$2"
  python3 - "$version" "$entries_file" "$CREW_CHANGELOG" <<'PYEOF'
import datetime, sys
version, entries_file, path = sys.argv[1], sys.argv[2], sys.argv[3]
entries = [l.strip() for l in open(entries_file) if l.strip()]
section = f"## [{version}] — {datetime.date.today().isoformat()}\n\n"
section += "".join(f"- {e}\n" for e in entries) + "\n"
lines = open(path).read().split("\n")
for i, line in enumerate(lines):
    if line.startswith("## [Unreleased]"):
        # after the heading and the blank line that follows it
        j = i + 1
        while j < len(lines) and lines[j].strip() == "":
            j += 1
        lines.insert(j, section.rstrip("\n") + "\n")
        break
    if line.startswith("## ["):
        lines.insert(i, section.rstrip("\n") + "\n")
        break
else:
    raise SystemExit("no version section found in CHANGELOG.md")
open(path, "w").write("\n".join(lines))
PYEOF
}

# Hands a ticket back to the lane that built it, in_progress with a comment
# saying why. Used when its branch no longer merges cleanly — the conflict
# is real work, and the branch's own worktree is where it gets done.
bounce_ticket_to_lane() {
  local api_key="$1" id="$2" iid="$3" needs_design="$4" body="$5"
  local lane_id="$DEV_TEAM_MEMBER_ID"
  [[ "$needs_design" == "true" ]] && lane_id="$DESIGN_TEAM_MEMBER_ID"

  curl -sf --max-time 20 -X PATCH \
    -H "Authorization: Bearer $api_key" -H "User-Agent: $USER_AGENT" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg a "$lane_id" '{status: "in_progress", assignee_id: $a}')" \
    "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records/$id" >/dev/null \
    || log "merge: FAILED to bounce $iid back to its lane (tracker PATCH rejected)"

  curl -sf --max-time 20 -X POST \
    -H "Authorization: Bearer $api_key" -H "User-Agent: $USER_AGENT" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$id" --arg m "$QA_TEAM_MEMBER_ID" --arg b "$body" \
          '{ticket_id: $t, team_member_id: $m, body: $b}')" \
    "$BASE_URL/api/data-models/$COMMENTS_MODEL_ID/records" >/dev/null \
    || log "merge: FAILED to comment on $iid"
}

merge_verified_branches() {
  local api_key; api_key=$(tracker_api_key)
  if [[ -z "$api_key" ]]; then
    log "merge: no tracker API key, skipping merge phase"
    return 0
  fi

  local bugs
  bugs=$(fetch_open_tickets "$api_key") || {
    log "merge: tracker GET failed, skipping merge phase"
    return 0
  }

  # Oldest ticket first, so the changelog section reads in filing order and
  # the older branch is the one that merges against the cleaner tree.
  local rows
  rows=$(echo "$bugs" | jq -r \
    '[.[] | select(.status=="verified")]
     | sort_by((.issue_id // "ISSUE-0") | split("-") | .[1] | tonumber)
     | .[] | [.id, .issue_id, (.needs_design == true), (.title // "")] | @tsv')
  [[ -z "$rows" ]] && return 0

  local last_released; last_released=$(git rev-parse -q --verify "$LAST_RELEASE_REF^{commit}" || true)
  local entries_file; entries_file=$(mktemp -t tablation-changelog)
  local size="patch" merged=0 skipped=0
  local id iid nd title num branch msgs lines subject body

  while IFS=$'\t' read -r id iid nd title; do
    [[ -z "$iid" ]] && continue
    num="${iid#ISSUE-}"
    branch=$(git branch --list "issue-$num" --format='%(refname:short)')
    if [[ -z "$branch" ]]; then
      branch=$(git branch --list "issue-$((10#$num))" --format='%(refname:short)')
    fi

    if [[ -z "$branch" ]]; then
      # Two very different cases wear the same shape. If the ticket is
      # already named in a commit past the last release, it was merged on an
      # earlier cycle whose deploy hasn't succeeded yet — normal, and the
      # stamp after that deploy is what will close it out. Otherwise nobody
      # ever wrote code for it, which is worth saying out loud every cycle.
      if [[ -n "$last_released" ]] && git log --format='%B' "$last_released..HEAD" | grep -q "$iid"; then
        log "merge: $iid is verified and already merged, waiting on a successful release"
      else
        log "merge: $iid is verified but has no local branch and nothing on main names it — nothing to merge"
      fi
      skipped=$((skipped + 1))
      continue
    fi

    # Read the branch's Bump:/Changelog: lines while its history is still
    # reachable — the squash is about to flatten it.
    msgs=$(git log "main..$branch" --format='%B')
    lines=$(echo "$msgs" | grep -E '^Changelog:' | sed -E 's/^Changelog:[[:space:]]*//' || true)
    if [[ -z "$lines" ]]; then
      lines="${title:-$iid} ($iid)"
      log "merge: $iid has no Changelog: line in its commits — falling back to its title"
    fi

    if ! git merge --squash "$branch"; then
      log "merge: $iid ($branch) does not squash-merge cleanly onto main — bouncing it back to its lane"
      git merge --abort >/dev/null 2>&1 || true
      git reset --hard HEAD >/dev/null 2>&1 || true
      git clean -fdq >/dev/null 2>&1 || true
      if [[ -n "$(git status --porcelain)" ]]; then
        log "merge: FATAL — the primary checkout is still dirty after aborting $iid's merge; stopping the merge phase"
        rm -f "$entries_file"
        return 1
      fi
      bounce_ticket_to_lane "$api_key" "$id" "$iid" "$nd" \
"Merge blocked: \`$branch\` no longer squash-merges cleanly onto \`main\` — \
another ticket has since changed the same code.

The release phase aborted the merge and left \`main\` untouched, so this \
ticket is back with you rather than with QA. Rebase the branch (or redo the \
change against current \`main\`) in its own worktree, re-verify, and set it \
to \`fixed\` again — it'll come back through verification and merge on the \
next cycle.

_Posted automatically by the dev loop's release phase._"
      skipped=$((skipped + 1))
      continue
    fi

    if git diff --cached --quiet; then
      log "merge: $iid ($branch) had nothing to merge — main already contains it; retiring the branch"
    else
      subject=$(echo "$lines" | head -1)
      [[ "$subject" != *"$iid"* ]] && subject="$subject ($iid)"
      body=$(echo "$lines" | tail -n +2 | sed 's/^/- /')
      {
        echo "$subject"
        echo
        [[ -n "$body" ]] && { echo "$body"; echo; }
        echo "Squash-merged by the dev loop's release phase after the QA lane"
        echo "verified $iid. The version bump and CHANGELOG entry for this"
        echo "release are in the commit that follows."
      } | git commit -q -F -
      log "merge: $iid merged onto main as $(git log -1 --format=%h) — $subject"
    fi

    echo "$lines" >> "$entries_file"
    # Only a ticket that actually landed may size the release's bump. Read
    # before the merge, a `Bump: minor` on a branch that then conflicted and
    # bounced would still have pushed the whole release to a minor version
    # for work it didn't contain.
    if echo "$msgs" | grep -qiE '^Bump:[[:space:]]*minor'; then size="minor"; fi
    merged=$((merged + 1))
    # The worktree has done its job: the code is on main and QA has already
    # tested it. drop kills anything still running inside it first — see
    # drop_worktree.
    drop_worktree "$num" || log "merge: could not drop $iid's worktree (continuing)"
  done <<< "$rows"

  if (( merged == 0 )); then
    rm -f "$entries_file"
    (( skipped > 0 )) && log "merge: nothing merged this cycle ($skipped verified ticket(s) skipped)"
    return 0
  fi

  # One version for the whole batch. Every ticket in it ships at the same
  # moment, in the same build, so giving each its own number would only make
  # released_version a lie for all but the last.
  local version; version=$(next_version "$size")
  write_version "$version"
  write_changelog "$version" "$entries_file"
  git add -A
  git commit -q -F - <<EOF
Release v$version

$(sed 's/^/- /' "$entries_file")

Version bump and CHANGELOG entry for the $merged ticket(s) squash-merged
above, all verified by the QA lane. Written by the dev loop's release phase.
EOF
  rm -f "$entries_file"
  log "merge: $merged ticket(s) merged, version bumped to $version ($(git log -1 --format=%h))"
}

release_if_unreleased() {
  local force="${1:-}" skip_tests="${2:-}"

  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$branch" != "main" ]]; then
    note_release_block branch "primary checkout is on '$branch', not main"
    return 0
  fi
  # Deploy builds from the working tree, so anything uncommitted here would
  # ship. That's a hold row's in-flight work, never
  # ours to release.
  if [[ -n "$(git status --porcelain)" ]]; then
    # Name the files. The count conveys urgency; the filenames are what make
    # it a ten-second fix. Untracked is called out separately because that is
    # the case that surprises people — a scratch file, or the tracked
    # schema.prisma that a routine `pnpm db:generate` rewrites.
    local n_all n_untracked names detail
    n_all=$(git status --porcelain | wc -l | tr -d ' ')
    n_untracked=$(git status --porcelain | grep -c '^??' || true)
    # paste -d takes a *list* of delimiters and cycles through them, so
    # -d', ' joins with comma, then space, then comma... Join on one
    # character and widen it afterwards.
    names=$(git status --porcelain | head -3 | sed 's/^...//' | paste -sd',' - | sed 's/,/, /g')
    (( n_all > 3 )) && names="$names, +$((n_all - 3)) more"
    detail="working tree has $n_all change(s)"
    (( n_untracked > 0 )) && detail="$detail ($n_untracked untracked)"
    detail="$detail: $names"
    note_release_block dirty "$detail"
    return 0
  fi

  clear_release_block

  # Merge whatever QA has verified BEFORE deciding whether there is anything
  # to release — a ticket verified this cycle should ship this cycle.
  merge_verified_branches || log "release: merge phase reported a problem; continuing with whatever is already on main"

  local head last
  head=$(git rev-parse HEAD)
  last=$(git rev-parse -q --verify "$LAST_RELEASE_REF^{commit}" || true)

  if [[ -z "$last" ]]; then
    # First run after installing this: seed the ref rather than deploying an
    # unbounded backlog of history nobody asked to release. Prefer the commit
    # the target says it is actually running (truthful — if it is genuinely
    # behind main, the next cycle releases the difference, which is the point) and
    # fall back to HEAD only when that can't be resolved to a local commit.
    local seed seed_src
    seed=$(released_commit)
    if [[ -n "$seed" ]] && git rev-parse -q --verify "$seed^{commit}" >/dev/null; then
      seed_src="the deploy target's reported running commit"
    else
      seed="$head"
      seed_src="local HEAD (target unreachable or running an unknown commit)"
    fi
    git update-ref "$LAST_RELEASE_REF" "$seed"
    last="$seed"
    log "release: no $LAST_RELEASE_REF yet — seeded at $(git log -1 --format=%h "$seed") from $seed_src"
    # Deliberately no early return: a seed taken from the target's own reported
    # commit is a fact, so anything past it is genuinely unreleased and can
    # go out this cycle. The HEAD fallback needs no special case — it makes
    # head == last, so the check below returns anyway.
  fi

  if [[ "$head" == "$last" ]]; then
    return 0
  fi

  if [[ -z "$force" && "$(cat "$DEPLOY_FAILED_SHA_FILE" 2>/dev/null)" == "$head" ]]; then
    log "release: $(git log -1 --format=%h "$head") already failed to deploy (ticket filed) — not retrying; run 'crew deploy' to force"
    return 0
  fi

  # Whether this exact commit already has a deploy-failure ticket. Only
  # reachable via `deploy force` (the plain path returns above), but a
  # forced retry that fails again shouldn't file a duplicate.
  local prev_failed
  prev_failed=$(cat "$DEPLOY_FAILED_SHA_FILE" 2>/dev/null || true)

  local count
  count=$(git rev-list --count "$last..$head")
  log "release: $count unreleased commit(s) on main ($(git log -1 --format=%h "$last") -> $(git log -1 --format=%h "$head")), deploying"
  git log --format='  %h %s' "$last..$head" | while read -r line; do log "$line"; done

  local output_file
  output_file=$(mktemp -t tablation-deploy)

  if [[ -z "$skip_tests" ]]; then
    if ! run_release_tests "$output_file"; then
      local tshort; tshort=$(git log -1 --format=%h "$head")
      log "release: test suites FAILED — not deploying $tshort, the target stays on the previous release"
      echo "$head" > "$DEPLOY_FAILED_SHA_FILE"
      local tticket=""
      if [[ "$prev_failed" == "$head" ]]; then
        log "release: ticket already filed for this commit, not filing another"
      else
        file_deploy_failure_ticket "$head" "$output_file" tests || true
        tticket="$FILED_TICKET_ID"
      fi
      notify fail "Tests RED · $tshort not shipped" "${tticket:-see crew log}"
      rm -f "$output_file"
      return 0
    fi
    log "release: test suites clean, deploying"
  else
    log "release: --skip-tests given, deploying WITHOUT running the suites"
  fi

  # tee so the deploy output lands in the loop log live AND is kept for a
  # failure ticket. PIPESTATUS[0], not $?, since $? here is tee's.
  local status
  set +e
  crew_hook_deploy 2>&1 | tee "$output_file"
  status=${PIPESTATUS[0]}
  set -e

  local short version
  short=$(git log -1 --format=%h "$head")
  version=$(jq -r '.version' "$CREW_VERSION_FILE")

  if [[ "$status" -eq 0 ]]; then
    git update-ref "$LAST_RELEASE_REF" "$head"
    rm -f "$DEPLOY_FAILED_SHA_FILE" "$output_file"
    log "release: deploy succeeded, $LAST_RELEASE_REF now at $short"

    stamp_release_tickets "$last" "$head" "$version" || true

    # Ask the target what it is actually running rather than assuming the deploy
    # landed — a restarted-but-stale backend is exactly the failure the
    # status widget exists to surface. This also confirms the backend came
    # back up at all.
    local running
    running=$(released_commit)
    if [[ -z "$running" ]]; then
      notify warn "v$version · $short deployed" "target not responding"
      log "release: deployed, but the released hook returned nothing"
    elif [[ "$running" == "$head" ]]; then
      notify ok "v$version live" "$short · $count commit(s) released"
    else
      notify warn "v$version · $short deployed" "target running $(echo "$running" | cut -c1-7)"
      log "release: deployed $short but the target reports running $running"
    fi
  else
    log "release: deploy FAILED (exit $status) — leaving $LAST_RELEASE_REF unchanged"
    echo "$head" > "$DEPLOY_FAILED_SHA_FILE"
    local ticket=""
    if [[ "$prev_failed" == "$head" ]]; then
      log "release: deploy-failure ticket already filed for this commit, not filing another"
    else
      file_deploy_failure_ticket "$head" "$output_file" || true
      ticket="$FILED_TICKET_ID"
    fi
    notify fail "Deploy FAILED · $short" "${ticket:-see crew log}"
    rm -f "$output_file"
  fi
}

# Is this lane paused? Poll-level switch only (see LANE_PAUSE_PREFIX) —
# run_agent itself stays lane-agnostic.
lane_paused() {
  [[ -f "${LANE_PAUSE_PREFIX}$1" ]]
}

# Renders one lane's queue digest to $QUEUE_DIGEST_PREFIX<lane>. Called from
# the poll, which already holds both payloads. Carries no description /
# repro_steps / resolution_note prose by design: the agent fetches the full
# record of the single ticket it picks up.
#
# The effective-priority arithmetic in queue-digest.jq MUST stay in step
# with the Step 2 ordering rule in common.md. It is stated twice
# deliberately — the agent still needs the rule in prose to reason about
# skips — but the digest is what actually orders the table, so if the two
# ever disagree, fix the prose to match.
# `--format='%(refname:short)'` rather than stripping decoration by hand:
# `git branch --list` prefixes a branch checked out in a LINKED WORKTREE with
# "+ ", not "* " (asterisk is only this checkout's current branch). The old
# `sed 's/^[* ]*//'` left that "+ " in place, so every ticket branch that
# still had its worktree — i.e. every recently finished one — became the
# literal "ISSUE-+ issue-144" and matched no ticket. That silently zeroed the
# verified-but-unmerged count in all three places it is used (this digest,
# the poll's wake check, and the lane priority rank), so squash-merges never
# fired and seven verified tickets sat unshipped. See ISSUE-189.
write_queue_digest() {
  local lane="$1" bugs="$2" comments="$3" me="$4" watermark="$5"
  local blocked_ids="${6:-[]}" blocker_info="${7:-}"
  if [[ -z "$blocker_info" ]]; then blocker_info='{}'; fi
  local branches tmp program
  branches=$(git branch --list 'issue-*' --format='%(refname:short)' | paste -sd$'\n' -)
  tmp="${QUEUE_DIGEST_PREFIX}${lane}.tmp"
  program="$QUEUE_DIGEST_JQ"
  [[ "$lane" == "qa" ]] && program="$QUEUE_DIGEST_QA_JQ"
  # -L is required: both programs do `include "priority"`, and jq resolves
  # modules only from the -L search path, never relative to the program file
  # passed to --from-file.
  if echo "$bugs" | jq -L "$CREW_HOME/lib" -r --argjson comments "$comments" --arg me "$me" \
      --argjson roster "$(crew_roster_json)" \
      --arg watermark "$watermark" --arg branches "$branches" \
      --argjson blocked "$blocked_ids" --argjson blockerinfo "$blocker_info" \
      --from-file "$program" > "$tmp" 2>/dev/null; then
    mv "$tmp" "${QUEUE_DIGEST_PREFIX}${lane}"
  else
    # A digest that failed to render must not leave a stale one behind
    # looking fresh — drop both and let the agent fall back to fetching.
    rm -f "$tmp" "${QUEUE_DIGEST_PREFIX}${lane}"
    log "poll[$lane]: queue digest failed to render, agent will fetch the tracker itself"
  fi
}

# Everything the poll wakes a BUILDING lane's agent for (dev/design; QA has
# its own, qa_lane_has_work), evaluated against a pre-filtered slice of the
# ticket list. `bugs` is already narrowed to this
# lane's tickets, so every count below is lane-local by construction —
# including the branch sweep, which can only match a branch whose ticket is
# in this slice.
lane_has_work() {
  local lane="$1" me="$2" bugs="$3" comments="$4" watermark="$5" blocked_ids="${6:-[]}"

  # `held` is the assignee-based hold: any row the roster marks `hold` — the
  # operator, anyone else aboard, or an interactive Claude session working at
  # someone's shoulder. Any of them means a
  # human is actively driving that ticket right now, so it is not work this
  # lane can pick up — excluded here rather than only in the prompt, so a
  # held ticket can't be the sole reason a whole agent cycle wakes up and
  # then finds nothing it is allowed to touch.
  #
  # A dependency-blocked ticket is not startable either, so it cannot be the
  # sole reason a cycle wakes — same argument as the hold above. Membership in
  # $blocked_ids is what decides that, never the `blocked` status: the status
  # is presentation, and a ticket still showing `blocked` whose blockers have
  # cleared (a failed park/unpark write, say) is startable and must count.
  local accepted_count
  accepted_count=$(echo "$bugs" | jq --argjson blocked "$blocked_ids" \
    --argjson holds "$(crew_hold_ids_json)" \
    '[.[] | select((.status=="accepted" or .status=="blocked")
                   and (.id | IN($blocked[]) | not)
                   and (.assignee_id | IN($holds[]) | not))] | length')

  # Tickets we're actively watching for a reply: our own in_progress
  # tickets, an unassigned in_progress one (a hold clearing assignee_id is the
  # "back up for grabs" signal — see unassigned_count below, which triggers
  # on the ticket itself; this covers a *comment* landing on one too), plus
  # any needs_info ticket regardless of assignee (older ones predate
  # consistent assignee-setting). Deliberately excludes tickets assigned to
  # anyone else (i.e. a hold, or another lane's agent) — that's an active
  # hold, not ours to watch.
  #
  # `fixed` is deliberately absent everywhere in this function: a fixed
  # ticket is QA's, and counting it here would wake a building lane for work
  # it is no longer allowed to touch. A ticket comes back to us as
  # in_progress (reassigned by QA, with the reason in a comment), which the
  # counts below already catch.
  local watched_ids
  watched_ids=$(echo "$bugs" | jq --arg me "$me" \
    --argjson holds "$(crew_hold_ids_json)" \
    '[.[] | select(((.status=="in_progress" and (.assignee_id==$me or .assignee_id==null)) or .status=="needs_info") and (.assignee_id | IN($holds[]) | not)) | .id]')

  local new_comment_count
  new_comment_count=$(echo "$comments" | jq --arg wm "$watermark" --arg me "$me" --argjson ids "$watched_ids" \
    '[.[] | select(.created_at > $wm and .team_member_id != $me and (.kind // "comment") != "event" and (.ticket_id as $t | $ids | index($t) != null))] | length')

  # A hold row clears assignee_id when done iterating on a ticket it had
  # taken over — see common.md's
  # Step 1 note on the assignee-based hand-off protocol. An in_progress
  # ticket with no assignee is "back up for grabs," worth a run even with no
  # new comment.
  local unassigned_count
  unassigned_count=$(echo "$bugs" | jq \
    '[.[] | select(.status=="in_progress" and .assignee_id==null)] | length')

  # Our own unfinished work. Without this, a ticket that is in_progress AND
  # assigned to us matches none of the checks above — not accepted, not
  # unassigned, and its newest comment is usually our own progress note, which
  # the "from someone else" filter excludes. That combination stranded
  # ISSUE-049 for hours: it could only ever be restarted by someone commenting on
  # it, which is not a dependency long multi-phase tickets should have. A
  # ticket we started stays a reason to run until it reaches fixed (done) or
  # needs_info (genuinely waiting on a person).
  local own_in_progress_count
  own_in_progress_count=$(echo "$bugs" | jq --arg me "$me" \
    '[.[] | select(.status=="in_progress" and .assignee_id==$me)] | length')

  if [[ "$accepted_count" -gt 0 || "$new_comment_count" -gt 0 || "$unassigned_count" -gt 0 || "$own_in_progress_count" -gt 0 ]]; then
    log "poll[$lane]: $accepted_count accepted ticket(s), $new_comment_count new comment(s), $unassigned_count unassigned in_progress ticket(s), $own_in_progress_count own in_progress ticket(s) -> triggering agent"
    return 0
  fi
  return 1
}

# The QA lane's version of the above, and deliberately much simpler: every
# ticket in QA's slice IS work by definition — `fixed` means nobody has
# checked it, `qa` means a check is half-done — so there is no comment
# watermark or assignee dance to evaluate. `bugs` arrives already narrowed
# to that slice.
qa_lane_has_work() {
  local bugs="$1"
  local n
  n=$(echo "$bugs" | jq --argjson holds "$(crew_hold_ids_json)" \
    '[.[] | select(.assignee_id | IN($holds[]) | not)] | length')
  if [[ "$n" -gt 0 ]]; then
    log "poll[qa]: $n ticket(s) awaiting or in verification -> triggering agent"
    return 0
  fi
  return 1
}

# How urgent is this lane's most urgent actionable ticket, as a single
# integer (lower = more urgent)? Used to decide which ONE lane runs this
# cycle. The lanes no longer each get a session per cycle: with 26 accepted
# dev tickets against 3 design, design was drawing roughly half the agent
# cycles for a tenth of the queue (ISSUE-177). They share one ordered queue
# now, and `needs_design` decides which brief the winning session runs
# under rather than whether a second session happens at all.
#
# Ordering comes from priority.jq — the same module queue-digest.jq sorts
# with — so the lane that wins is always the lane holding the ticket that
# would have sorted first.
lane_top_rank() {
  local bugs="$1" me="$2" blocked_ids="${3:-[]}"

  # The best rank among tickets this lane could actually start or resume,
  # which is narrower than the set that WAKES the lane:
  #   - accepted                          — available to pick up
  #   - in_progress, ours or unassigned   — resume our own unfinished work
  # `fixed` is not here (nor anywhere else in a building lane's arithmetic):
  # it is QA's. Merges no longer rank at all — the release phase merges
  # verified branches on its own lock, so a lane that loses every cycle can
  # no longer strand finished work.
  # A needs_info ticket with a new reply from a hold is a genuine wake reason
  # this doesn't rank (it would need the comments payload). That only costs
  # precision when both lanes are pending at once: lane_has_work has already
  # decided the lane is awake, and this ranks it on its next-best item.
  # 999999999999 means "nothing actionable" and loses to any lane that has
  # something.
  echo "$bugs" | jq -L "$CREW_HOME/lib" -r --arg me "$me" --argjson blocked "$blocked_ids" \
    --argjson holds "$(crew_hold_ids_json)" 'include "priority";
    [ .[] | select(
        ( ((.status == "accepted" or .status == "blocked") and (.id | IN($blocked[]) | not))
          or (.status == "in_progress" and (.assignee_id == $me or .assignee_id == null)) )
        and (.assignee_id | IN($holds[]) | not)
      ) ]
    | if length == 0 then 999999999999
      else (min_by(rank) | rank | (.[0] * 1000000000 + .[1] * 10000000 + .[2]))
      end'
}

# Lanes with work, set by poll_for_work; read by the agent phase below.
PENDING_LANES=""
# The single lane chosen to run this cycle (see lane_top_rank).
SELECTED_LANE=""

# Cheap check (no agent involved): is there anything worth waking an agent
# up for, and for which lane(s)? Returns 0 if any lane has work (the lanes
# themselves land in $PENDING_LANES), 1 if none does.
poll_for_work() {
  PENDING_LANES=""

  local api_key
  api_key=$(tracker_api_key)
  if [[ -z "$api_key" ]]; then
    log "poll: no API key (CREW_API_KEY / $CREW_API_KEY_VAR in $CREW_API_KEY_FILE), cannot poll"
    return 1
  fi

  local bugs comments
  bugs=$(fetch_open_tickets "$api_key") || {
    log "poll: tracker fetch failed (bugs), skipping this cycle"
    return 1
  }
  comments=$(curl -sf -H "Authorization: Bearer $api_key" -H "User-Agent: $USER_AGENT" \
    "$BASE_URL/api/data-models/$COMMENTS_MODEL_ID/records?limit=200") || {
    log "poll: tracker fetch failed (comments), skipping this cycle"
    return 1
  }

  local watermark
  watermark=$(cat "$WATERMARK_FILE" 2>/dev/null || echo "1970-01-01T00:00:00.000Z")

  # Blocked-by, computed once from the WHOLE payload before any lane slicing
  # below — a blocker can live in the other lane, so a per-lane computation
  # would read a cross-lane dependency as resolved. The park/unpark writes
  # happen here too, and $SWEPT_BUGS is the payload with them applied, so
  # every count and digest below sees the statuses this cycle just wrote.
  local blocker_info blocked_ids
  blocker_info=$(blocker_info_map "$api_key" "$bugs")
  blocked_ids=$(compute_blocked_ids "$bugs" "$blocker_info")
  sweep_blocked_tickets "$api_key" "$bugs" "$blocker_info" "$blocked_ids"
  bugs="$SWEPT_BUGS"

  # Split the queue: status first (QA owns fixed + qa, from either building
  # lane), then needs_design for the rest. Tickets predating that field have
  # it null, which reads as false (dev), same as the prompt tells the agents
  # to read it. The building slices are NOT status-filtered here — their own
  # counts already ignore fixed/qa — so the digests keep showing a lane its
  # whole world minus QA's part of it.
  local dev_bugs design_bugs qa_bugs
  dev_bugs=$(echo "$bugs" | jq '[.[] | select(.needs_design != true)]')
  design_bugs=$(echo "$bugs" | jq '[.[] | select(.needs_design == true)]')
  qa_bugs=$(echo "$bugs" | jq '[.[] | select(.status=="fixed" or .status=="qa")]')

  # Both lanes are evaluated against the same watermark, so advance it only
  # after — bumping it inside the first lane's check would hide that lane's
  # new comments from the second.
  # `if` rather than `cmd && assign`: a bare `false && x=y` statement makes
  # the whole list return non-zero, which `set -e` at the top of this script
  # would take as a fatal error the moment a lane has nothing to do.
  # QA is evaluated first so that a tie in the rank loop below falls to it.
  if lane_paused qa; then
    log "poll[qa]: lane paused, not waking — $(echo "$qa_bugs" | jq 'length') ticket(s) awaiting verification"
  elif qa_lane_has_work "$qa_bugs"; then
    PENDING_LANES="qa"
  fi
  if lane_paused dev; then
    log "poll[dev]: lane paused, not waking"
  elif lane_has_work dev "$DEV_TEAM_MEMBER_ID" "$dev_bugs" "$comments" "$watermark" "$blocked_ids"; then
    # Appends rather than assigns: QA is evaluated before this and would
    # otherwise be silently dropped from the pending list here.
    PENDING_LANES="${PENDING_LANES:+$PENDING_LANES }dev"
  fi
  if lane_paused design; then
    # Logged with a count so a paused lane's backlog stays visible rather
    # than silently accumulating — this is the number to watch when deciding
    # to unpause.
    log "poll[design]: lane paused, not waking — $(echo "$design_bugs" | jq '[.[] | select(.status == "accepted")] | length') accepted ticket(s) waiting"
  elif lane_has_work design "$DESIGN_TEAM_MEMBER_ID" "$design_bugs" "$comments" "$watermark" "$blocked_ids"; then
    PENDING_LANES="${PENDING_LANES:+$PENDING_LANES }design"
  fi

  # One queue, one session per cycle: whichever lane holds the most urgent
  # actionable ticket runs. Ties go to dev over design — the faster lane, so
  # a tie shouldn't put the cycle behind a design session's mockup-and-
  # screenshot pass — and QA beats both outright at rank -1, whatever it is
  # holding. That is deliberate and not a priority comparison: a `fixed`
  # ticket is finished work that cannot ship, cannot be merged, and cannot
  # be deployed until someone checks it, and the check is minutes where the
  # build was an hour. Starving QA would fill the board with unverified
  # work while the release phase had nothing to merge.
  SELECTED_LANE=""
  local l rank best=999999999999
  for l in $PENDING_LANES; do
    case "$l" in
      qa)     rank=-1 ;;
      dev)    rank=$(lane_top_rank "$dev_bugs" "$DEV_TEAM_MEMBER_ID" "$blocked_ids") ;;
      design) rank=$(lane_top_rank "$design_bugs" "$DESIGN_TEAM_MEMBER_ID" "$blocked_ids") ;;
      *)      continue ;;
    esac
    log "poll[$l]: top actionable rank $rank"
    if (( rank < best )); then
      best="$rank"
      SELECTED_LANE="$l"
    fi
  done

  if [[ -n "$SELECTED_LANE" ]]; then
    if [[ "$PENDING_LANES" != "$SELECTED_LANE" ]]; then
      log "poll: lanes with work: $PENDING_LANES -> '$SELECTED_LANE' wins this cycle (rank $best); the rest stay pending for the next"
    fi
    # Digest is written only for the lane about to run — rendering one for a
    # lane that isn't waking would leave a file that looks current to a later
    # manual `run`.
    case "$SELECTED_LANE" in
      qa)     write_queue_digest qa "$qa_bugs" "$comments" "$QA_TEAM_MEMBER_ID" "$watermark" "$blocked_ids" "$blocker_info" ;;
      dev)    write_queue_digest dev "$dev_bugs" "$comments" "$DEV_TEAM_MEMBER_ID" "$watermark" "$blocked_ids" "$blocker_info" ;;
      design) write_queue_digest design "$design_bugs" "$comments" "$DESIGN_TEAM_MEMBER_ID" "$watermark" "$blocked_ids" "$blocker_info" ;;
    esac
  fi

  local new_watermark
  new_watermark=$(echo "$comments" | jq -r '[.[].created_at] | max // empty')
  [[ -n "$new_watermark" ]] && echo "$new_watermark" > "$WATERMARK_FILE"

  [[ -n "$PENDING_LANES" ]]
}

# Kills dev servers left listening on a ticket worktree's derived ports after
# that worktree is gone — a crashed or killed agent run never gets to stop its
# own server, and before ports were per-ticket that leak blocked every later
# run (one such process sat on the old shared :3901 for hours, silently
# costing ISSUE-093 its live verification). Only ports in the derived ranges
# are touched, and only when no `../<worktree-prefix><n>` directory claims them,
# so nothing belonging to a live worktree — or to the operator's own :3000/:5173 stack
# — is ever a candidate.
reap_orphan_ports() {
  local dry_run="" ; [[ "${1:-}" == "--dry-run" ]] && dry_run=1
  local parent; parent="$(cd .. && pwd)"
  local found=0
  local pid port n role
  while read -r pid port; do
    [[ -n "$pid" ]] || continue
    if (( port >= 30000 && port < 31000 )); then n=$((port - 30000)); role=backend
    elif (( port >= 40000 && port < 41000 )); then n=$((port - 40000)); role=frontend
    else continue
    fi
    # The worktree may be named with or without zero padding. Test for the
    # `.git` file, not just the directory: a removed worktree whose leaked
    # server rebuilt `apps/backend/dist` leaves a directory behind that is no
    # longer a worktree at all, and matching on `-d` alone let that skeleton
    # shield the very process that recreated it from being reaped.
    if [[ -e "$parent/${CREW_WORKTREE_PREFIX}$n/.git" ]] || compgen -G "$parent/${CREW_WORKTREE_PREFIX}0*$n/.git" >/dev/null; then
      continue
    fi
    found=$((found + 1))
    if [[ -n "$dry_run" ]]; then
      echo "orphan: $role :$port (pid $pid) — ISSUE-$n worktree is gone; clear with: $0 reap"
    else
      log "reap: killing orphaned $role on :$port (pid $pid) — no worktree for ISSUE-$n"
      kill "$pid" 2>/dev/null || true
    fi
  done < <(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {split($9,a,":"); print $2, a[length(a)]}' | sort -u)
  [[ -z "$dry_run" && "$found" -eq 0 ]] && log "reap: nothing to clean up"
  return 0
}

# Removes a merged ticket's worktree for good: kills anything still running
# inside it FIRST, then removes it, then verifies the directory is gone.
#
# The kill has to come first. `git worktree remove --force` does delete the
# whole directory, ignored files included, but a `nest start --watch` left
# over from a crashed earlier run of the same ticket keeps its cwd inside
# the worktree and rebuilds `apps/backend/dist` the moment its next
# recompile fires — recreating the tree seconds after git deleted it. That
# is exactly how 10 skeleton directories holding nothing but
# `apps/backend/dist` (~1,288 files each) accumulated by 2026-08-21 despite
# Step 4 running `--force` correctly every time. Worse, the resurrected
# directory then shields its own leaked server from reap_orphan_ports,
# which skips any port whose `../<worktree-prefix><n>` directory exists.
drop_worktree() {
  local n="$1"
  [[ -n "$n" ]] || { echo "drop: need a ticket number" >&2; return 2; }
  local parent; parent="$(cd .. && pwd)"
  local wt="$parent/${CREW_WORKTREE_PREFIX}$n"
  local num=$((10#$n))
  local branch="issue-$n"

  # Anything with a foot in this worktree: dev servers on its derived ports,
  # plus any process whose command line mentions the path (watchers, test
  # runners, a stray tsc). SIGTERM, a moment to unwind, then SIGKILL.
  local pids=""
  local port pid
  for port in $((30000 + num)) $((40000 + num)); do
    pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    [[ -n "$pid" ]] && pids+="$pid "
  done
  pids+="$(pgrep -f "$wt/" 2>/dev/null | grep -v "^$$\$" || true)"
  pids="$(echo "$pids" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')"
  if [[ -n "${pids// /}" ]]; then
    log "drop: killing processes still inside $wt: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 2
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi

  git worktree remove --force "$wt" 2>/dev/null || true
  git branch -D "$branch" 2>/dev/null || true
  git worktree prune

  # Belt and braces: whatever git left (or a watcher re-wrote in the last
  # second) goes. A merged ticket's worktree is disposable — its work is in
  # main — so there is nothing here worth preserving.
  if [[ -d "$wt" ]]; then
    log "drop: $wt survived git worktree remove — rm -rf"
    rm -rf "$wt"
  fi
  if [[ -d "$wt" ]]; then
    echo "drop: FAILED to remove $wt" >&2
    return 1
  fi
  log "drop: ISSUE-$n worktree and branch removed"
  return 0
}

# ---------------------------------------------------------------------------
# Safety interlock. This repo is currently a COPY of a loop that is already
# running from synthesis/scripts/local/dev-loop (ISSUE-321) — two copies
# polling the same tracker would hand the same ticket to two agents and merge
# into each other's tree. Nothing here writes to the tracker, starts an agent,
# or deploys until crew.config.sh sets CREW_ENABLED=true, which is the cutover
# switch and should be flipped in exactly one place at a time.
#
# `doctor` is exempt — checking a config before arming it is the point — as
# are the local-maintenance commands (`status`, `ports`, `reap`, `drop`,
# `log`), which act on this machine's worktrees and processes rather than on
# the tracker, and are only ever run by hand. Note that `status` reads THIS
# installation's state dir, so before cutover it reports on this copy, not on
# whichever crew is actually running.
# ---------------------------------------------------------------------------
crew_enabled_or_exit() {
  if [[ "${CREW_ENABLED:-false}" != "true" ]]; then
    echo "crew: CREW_ENABLED is not true in $CREW_CONFIG — refusing to run." >&2
    echo "      This copy is inert until cutover; see docs/MIGRATION.md." >&2
    exit 0
  fi
}

# Read-only preflight: does this config actually describe a working crew?
# Nothing here writes, wakes an agent, or touches the project's git state.
crew_doctor() {
  local ok=0 key
  echo "crew doctor — $CREW_CONFIG"
  echo
  printf '%-28s %s\n' "crew home" "$CREW_HOME"
  printf '%-28s %s\n' "state dir" "$CREW_STATE_DIR"
  printf '%-28s %s\n' "log file" "$LOG_FILE"
  printf '%-28s %s\n' "enabled" "${CREW_ENABLED:-false}"
  echo

  if [[ -d "$CREW_PROJECT_DIR/.git" ]]; then
    printf 'OK   project dir      %s (branch %s)\n' "$CREW_PROJECT_DIR" \
      "$(git -C "$CREW_PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  else
    printf 'FAIL project dir      %s is not a git checkout\n' "$CREW_PROJECT_DIR"; ok=1
  fi

  local f
  for f in "$CREW_HOME/lib/priority.jq" "$CREW_HOME/lib/queue-digest.jq" \
           "$CREW_HOME/lib/queue-digest-qa.jq" "$CREW_HOME/lib/roster.jq" \
           "$CREW_HOME/lib/crew.sh" "$CREW_HOME/prompts/common.md" \
           "$CREW_HOME/prompts/lane-dev.md" "$CREW_HOME/prompts/lane-design.md" \
           "$CREW_HOME/prompts/lane-qa.md"; do
    if [[ -f "$f" ]]; then printf 'OK   file             %s\n' "${f#$CREW_HOME/}"
    else printf 'FAIL file             %s is missing\n' "${f#$CREW_HOME/}"; ok=1; fi
  done

  for f in jq curl python3 git; do
    if command -v "$f" >/dev/null 2>&1; then printf 'OK   tool             %s\n' "$f"
    else printf 'FAIL tool             %s not on PATH\n' "$f"; ok=1; fi
  done
  if [[ -x "$CREW_CLAUDE_BIN" ]]; then printf 'OK   agent binary     %s\n' "$CREW_CLAUDE_BIN"
  else printf 'FAIL agent binary     %s is not executable\n' "$CREW_CLAUDE_BIN"; ok=1; fi

  if declare -F crew_hook_test >/dev/null && declare -F crew_hook_build >/dev/null \
     && declare -F crew_hook_deploy >/dev/null; then
    printf 'OK   hooks            crew_hook_test / crew_hook_build / crew_hook_deploy defined\n'
  else
    printf 'FAIL hooks            crew.config.sh must define crew_hook_test, crew_hook_build and crew_hook_deploy\n'; ok=1
  fi
  # A missing released hook is not fatal, but it silently downgrades every
  # deploy verification to "we ran the deploy and it exited 0", so it is
  # called out rather than left to be discovered.
  if declare -F crew_hook_released >/dev/null; then
    local live; live=$(released_commit)
    if [[ -n "$live" ]]; then
      printf 'OK   released hook    reports %s\n' "$(echo "$live" | cut -c1-12)"
    else
      printf 'note released hook    defined, but returned nothing (target unreachable?)\n'
    fi
  else
    printf 'note released hook    none — deploys cannot be verified, only run\n'
  fi
  # Optional by design: no notifier just means release state goes to the log.
  if declare -F crew_hook_notify >/dev/null; then
    printf 'OK   notify hook      crew_hook_notify defined\n'
  else
    printf 'note notify hook      none defined — release state goes to the log only\n'
  fi

  key=$(tracker_api_key)
  if [[ -z "$key" ]]; then
    printf 'FAIL tracker key      not found (CREW_API_KEY, or %s in %s)\n' \
      "$CREW_API_KEY_VAR" "$CREW_API_KEY_FILE"; ok=1
  else
    local n
    n=$(curl -sf --max-time 20 -H "Authorization: Bearer $key" -H "User-Agent: $USER_AGENT" \
        "$BASE_URL/api/data-models/$BUGS_MODEL_ID/records?filters=$OPEN_TICKETS_FILTER&limit=500" \
        | jq 'length' 2>/dev/null) || n=""
    if [[ -n "$n" ]]; then printf 'OK   tracker          %s reachable, %s open ticket(s)\n' "$BASE_URL" "$n"
    else printf 'FAIL tracker          %s did not answer with an open-ticket list\n' "$BASE_URL"; ok=1; fi
  fi

  # The roster is what every agent learns its shipmates' names from, so a
  # seat whose Crew row has no Name — or a whole table that doesn't answer —
  # is worth catching here rather than in a run's prompt.
  local roster nameless
  roster=$(crew_roster_json 2>/dev/null)
  if [[ -z "$roster" || "$roster" == "{}" ]]; then
    printf 'FAIL crew roster      Crew model %s returned nothing\n' "$CREW_MEMBER_MODEL_ID"; ok=1
  else
    nameless=$(jq -r '[ to_entries[] | select(.value.name == .value.role) | .value.role ] | join(", ")' <<<"$roster")
    printf 'OK   crew roster      %s aboard: %s\n' \
      "$(jq 'length' <<<"$roster")" \
      "$(jq -r '[ to_entries[] | .value.name ] | join(", ")' <<<"$roster")"
    [[ -n "$nameless" ]] && printf 'note crew roster      no Name in the Crew table for: %s (falling back to the role)\n' "$nameless"
  fi

  # A worktree prefix that matches nothing is not an error on a quiet day, so
  # this is reported rather than graded.
  local parent wt_count
  parent="$(cd "$CREW_PROJECT_DIR/.." && pwd)"
  wt_count=$(find "$parent" -maxdepth 1 -name "${CREW_WORKTREE_PREFIX}*" 2>/dev/null | wc -l | tr -d ' ')
  printf 'note worktrees        %s existing %s* dir(s) beside the project\n' "$wt_count" "$CREW_WORKTREE_PREFIX"

  echo
  if [[ "$ok" == "0" ]]; then echo "doctor: all checks passed"
  else echo "doctor: something above needs fixing before CREW_ENABLED=true"; fi
  return "$ok"
}

case "${1:-}" in
  doctor)
    crew_doctor
    exit $?
    ;;
  run)
    crew_enabled_or_exit
    lane="${2:-dev}"
    if [[ "$lane" != "dev" && "$lane" != "design" && "$lane" != "qa" ]]; then
      echo "unknown lane '$lane' — expected 'dev', 'design' or 'qa'" >&2
      exit 2
    fi
    if lane_paused "$lane"; then
      log "run: lane '$lane' is paused — running anyway (explicit request)"
    fi
    acquire_lock "$LOCK_FILE" "agent" || exit 0
    run_agent "$lane"
    acquire_lock "$RELEASE_LOCK_FILE" "release" && release_if_unreleased
    exit 0
    ;;
  merge)
    crew_enabled_or_exit
    # The merge half of the release phase on its own, for when a verified
    # ticket needs to land now (or a bounced one needs re-checking) without
    # waiting for the next cycle. Takes the release lock, since it writes to
    # main exactly as the cycle's own merge does.
    acquire_lock "$RELEASE_LOCK_FILE" "release" || exit 0
    branch=$(git rev-parse --abbrev-ref HEAD)
    if [[ "$branch" != "main" ]]; then
      echo "merge: primary checkout is on '$branch', not main" >&2
      exit 1
    fi
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "merge: working tree is dirty — commit or stash first" >&2
      exit 1
    fi
    merge_verified_branches
    exit 0
    ;;
  deploy)
    crew_enabled_or_exit
    # `deploy --skip-tests` is the hotfix escape hatch: ship even though the
    # suite is red. Everything else about the release path is unchanged.
    skip=""
    [[ "${2:-}" == "--skip-tests" ]] && skip="skip"
    acquire_lock "$RELEASE_LOCK_FILE" "release" || exit 0
    release_if_unreleased force "$skip"
    exit 0
    ;;
  pause|resume)
    # With no lane, pauses/resumes the whole loop (poll, both lanes, and the
    # release phase). With a lane, only that lane's poll — the other lane and
    # the release phase carry on.
    lane="${2:-}"
    if [[ -n "$lane" && "$lane" != "dev" && "$lane" != "design" && "$lane" != "qa" ]]; then
      echo "unknown lane '$lane' — expected 'dev', 'design' or 'qa'" >&2
      exit 2
    fi
    target="$PAUSE_FILE"
    [[ -n "$lane" ]] && target="${LANE_PAUSE_PREFIX}$lane"
    if [[ "$1" == "pause" ]]; then
      touch "$target"
      echo "Paused${lane:+ lane '$lane'}. Resume with: $0 resume $lane"
    else
      rm -f "$target"
      echo "Resumed${lane:+ lane '$lane'}."
    fi
    exit 0
    ;;
  status)
    for l in dev design qa; do
      lane_paused "$l" && echo "lane $l: paused (resume with: $0 resume $l)"
    done
    if [[ -f "$PAUSE_FILE" ]]; then
      echo "paused"
    elif [[ -f "$LOCK_FILE" ]] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
      echo "agent: running (pid $(cat "$LOCK_FILE"))"
    else
      echo "agent: idle"
    fi
    if [[ -f "$RELEASE_LOCK_FILE" ]] && kill -0 "$(cat "$RELEASE_LOCK_FILE")" 2>/dev/null; then
      echo "release: deploy in progress (pid $(cat "$RELEASE_LOCK_FILE"))"
    fi
    last=$(git rev-parse -q --verify "$LAST_RELEASE_REF^{commit}" || true)
    if [[ -z "$last" ]]; then
      echo "release: $LAST_RELEASE_REF not set yet (next cycle seeds it at HEAD)"
    else
      echo "release: last released $(git log -1 --format='%h %s' "$last"), $(git rev-list --count "$last..main") unreleased commit(s) on main"
    fi
    if [[ -f "$DEPLOY_FAILED_SHA_FILE" ]]; then
      echo "release: last deploy FAILED on $(git log -1 --format=%h "$(cat "$DEPLOY_FAILED_SHA_FILE")") — retry with: $0 deploy"
    fi
    exit 0
    ;;
  ports)
    # What's listening where, per checkout. Ports are derived from the
    # directory name by scripts/dev-ports.sh — no lookup table to drift.
    # Same formula as scripts/dev-ports.sh (canonical), derived here rather
    # than shelled out to so that worktrees branched before that script
    # existed still report correctly.
    git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
      local_name="$(basename "$wt")"
      if [[ "$local_name" =~ ^${CREW_WORKTREE_PREFIX}0*([0-9]+)$ ]]; then
        be_port=$((30000 + BASH_REMATCH[1])); fe_port=$((40000 + BASH_REMATCH[1]))
      else
        be_port=3000; fe_port=5173
      fi
      be="down"; fe="down"
      lsof -nP -iTCP:"$be_port" -sTCP:LISTEN >/dev/null 2>&1 && be="UP"
      lsof -nP -iTCP:"$fe_port" -sTCP:LISTEN >/dev/null 2>&1 && fe="UP"
      printf '%-26s backend :%-6s %-5s frontend :%-6s %s\n' \
        "$local_name" "$be_port" "$be" "$fe_port" "$fe"
    done
    reap_orphan_ports --dry-run
    exit 0
    ;;
  reap)
    reap_orphan_ports
    exit 0
    ;;
  drop)
    drop_worktree "${2:-}"
    exit $?
    ;;
  log)
    shift
    exec tail "$@" "$LOG_FILE"
    ;;
esac

crew_enabled_or_exit

if [[ -f "$PAUSE_FILE" ]]; then
  exit 0
fi

# Sweep leaked dev servers from worktrees that no longer exist before doing
# anything else — cheap, and it keeps a crashed run from stranding a port.
reap_orphan_ports

# Agent phase — skipped entirely if a prior run's agent is still working.
# When both lanes have work they run one after the other under the SAME
# lock, never concurrently: the two sessions share this primary checkout,
# and Step 4's squash-merge has to check out `main` here. Two agents doing
# that at once would merge into each other's tree. Dev goes first so the
# faster lane isn't stuck behind a design session's mockup-and-screenshot
# pass; whichever lane doesn't get reached this cycle is still pending on
# the next poll, since none of the poll's triggers are consumed by running.
if acquire_lock "$LOCK_FILE" "agent"; then
  if poll_for_work; then
    # One lane per cycle (ISSUE-177). The lane that didn't win is still
    # pending on the next poll — none of the poll's triggers are consumed by
    # running, so nothing is lost by deferring it two minutes.
    [[ -n "$SELECTED_LANE" ]] && run_agent "$SELECTED_LANE"
  fi
fi

# Release phase runs every cycle on its own lock, INCLUDING cycles where the
# agent above was skipped as busy: an agent session can run for a long time,
# and commits already merged to main shouldn't wait on it to finish. The
# check itself is two local git commands. It also picks up the case where a
# previous cycle merged something but the deploy was skipped (dirty tree,
# wrong branch) or failed on a commit since superseded.
if acquire_lock "$RELEASE_LOCK_FILE" "release"; then
  release_if_unreleased
fi
