# shellcheck shell=bash
# ---------------------------------------------------------------------------
# crew.config.sh — everything about THIS machine and THIS project.
#
# Copy to crew.config.sh (gitignored) and fill in. The scripts in bin/ carry
# no ids, no paths and no project commands of their own; if you find yourself
# editing one to name your repo, that belongs here instead.
#
# This file is sourced by bash, so it may define functions as well as
# variables — which is how the project hooks at the bottom work.
# ---------------------------------------------------------------------------

# --- The safety interlock --------------------------------------------------
# Nothing writes to the tracker, starts an agent, or deploys while this is
# false. `bin/crew doctor` still works, deliberately — check a config
# before you arm it. Exactly one installed crew should ever have this true
# for a given tracker workspace.
CREW_ENABLED=false

# --- The project the crew works in -----------------------------------------
# An ordinary git checkout. The crew cds here before doing anything, and
# every relative path in a prompt or hook resolves from here.
CREW_PROJECT_DIR="$HOME/src/my-project"

# Ticket worktrees are created as SIBLINGS of that directory, named
# <prefix><ticket-number> — e.g. my-project-issue-42. The prefix is also how
# the loop recognises one of its own worktrees, so changing it after the fact
# orphans the existing ones.
CREW_WORKTREE_PREFIX="my-project-issue-"

# Where runtime state lives: locks, the poll watermark, rendered queue
# digests, pause sentinels. Defaults to $CREW_HOME/.state (gitignored).
# CREW_STATE_DIR="$HOME/.local/state/crew"
CREW_LOG_FILE="/tmp/tablation-crew.log"

# --- The tracker -----------------------------------------------------------
CREW_BASE_URL="https://app.tablation.com"
CREW_WORKSPACE_ID=""          # workspace uuid
CREW_BUGS_MODEL_ID=""         # the Issues data model
CREW_COMMENTS_MODEL_ID=""     # the Comments data model

# The API key. Either set it directly, or point at a file with a KEY=value
# line (an existing .env is the usual answer, so the key lives in exactly one
# place on the machine).
# CREW_API_KEY="sk_..."
CREW_API_KEY_FILE="$CREW_PROJECT_DIR/.env"
CREW_API_KEY_VAR="TRIAGE_API_KEY"

# --- The crew --------------------------------------------------------------
# The Crew data model, and one record id per member. Each seat runs AS one of
# these rows; each hold row is off limits to every seat, whatever a ticket's
# status.
#
# Names are NOT configured here — they are read from the Crew table's Name
# field at run time and handed to every agent as a roster, so renaming a
# member is a data edit and never a config or prompt edit. A member may be
# named anything: give the dev seat a personal name and the agents will call
# it that, adding the role parenthetically ("<Name> (Dev)") only where a
# ticket or comment needs the role to be unambiguous.
CREW_MEMBER_MODEL_ID=""       # the Crew data model

# Seats — the agents this ship runs. Leave one empty and this ship simply
# does not crew that role.
CREW_MEMBER_DEV=""            # the dev seat
CREW_MEMBER_DESIGN=""         # the design seat
CREW_MEMBER_QA=""             # the verification seat
CREW_MEMBER_TRIAGE=""         # the triage seat (bin/crew-triage)

# The operator: this ship's owner. Final say on approval, and the one whose
# machine, dev stack and credentials the prompts refer to. Always a hold.
CREW_OPERATOR=""

# Any further rows that mean hands off — other people aboard, and the
# interactive-session rows they work through. One "<record id>|<role>" per
# line; the role is what appears in parentheses after the name, so leave it
# empty for someone whose name needs no qualifier.
#
# A ticket assigned to ANY of these, or to CREW_OPERATOR, is excluded from
# every count and pick: a human is driving it right now. Clearing assignee_id
# is what hands it back.
CREW_HOLDS=(
  # "dfe51880-...|live session"
  # "9c1f4b22-...|Reviewer"
)

# --- The agent ------------------------------------------------------------
CREW_CLAUDE_BIN="$HOME/.local/bin/claude"
CREW_AGENT_MODEL="claude-sonnet-5"
# CREW_USER_AGENT="Mozilla/5.0 TablationCrewAgent/1.0"

# --- Release detection (optional, but required for CI-driven releases) ------
# What the deploy target reports it is actually running — one line, a commit
# sha or a version. The release phase compares it against what it just shipped,
# so a restarted-but-stale service is caught rather than reported as success.
#
# Essential when the crew does NOT perform the deploy itself (a CI-driven
# release): without it the crew would call a release successful merely for
# having pushed. "What is live" is answered very differently per project — an
# HTTP health endpoint, `npm view <pkg> version`, a registry or cluster query —
# which is why it is a hook and not a URL.
#
# Prefer putting this in the repo's own .crew.yaml as `hooks.released`
# (docs/REPO_SPEC.md); this is the fallback for a repo that has no such file.
#
# crew_hook_released() {
#   curl -sf --max-time 10 https://example.com/api/health-check | jq -r '.commit // empty'
# }

# --- Notifications (optional) ----------------------------------------------
# Where release state gets seen. The crew reports SEMANTICS — a level, a
# headline and a detail line — and this hook decides everything about how (or
# whether) that is shown. Icons, colours, device names and brand marks are
# yours, which is why none of them are in this repo.
#
#   crew_hook_notify <level> <headline> <detail>
#     level  ok | warn | fail
#
# Define nothing and the crew just writes the same information to its log.
# Failures here are swallowed: a broken notifier must never change a release
# outcome.
#
# Example — a macOS status widget (TerminalWidget.app):
#
# crew_hook_notify() {
#   local level="$1" headline="$2" detail="$3" icon color
#   case "$level" in
#     ok)   icon="checkmark.seal.fill";          color="4ADE80" ;;
#     warn) icon="exclamationmark.triangle.fill"; color="FBBF24" ;;
#     fail) icon="xmark.octagon.fill";            color="F87171" ;;
#   esac
#   /Applications/TerminalWidget.app/Contents/MacOS/TerminalWidget \
#     --target my_status --icon "$icon" --fg "$color" \
#     --text "$headline"$'\n'"$detail" --fit-text --timestamp
# }
#
# Example — anything else: a chat webhook, `notify-send`, `ntfy`, a log file.
#
# crew_hook_notify() {
#   curl -sf -X POST -H 'Content-Type: application/json' \
#     -d "$(jq -n --arg t "$2 — $3" --arg l "$1" '{text: "[\($l)] \($t)"}')" \
#     "$MY_WEBHOOK_URL"
# }

# --- Toolchain ------------------------------------------------------------
# launchd hands a script a minimal PATH with no node, pnpm or homebrew on it.
# Anything the project's hooks need goes here.
CREW_EXTRA_PATH="/opt/homebrew/bin"
# Node from nvm, pinned by the project's .nvmrc. Set false if the project
# does not use nvm (or does not use node at all).
CREW_USE_NVM=true
# CREW_NVM_SH="/opt/homebrew/opt/nvm/nvm.sh"

# --- Release ---------------------------------------------------------------
# The file the release phase reads the current version from, and every file
# it writes the new version into.
CREW_VERSION_FILE="package.json"
CREW_VERSION_FILES=(package.json)
CREW_CHANGELOG="CHANGELOG.md"

# --- Project hooks ---------------------------------------------------------
# The three things the crew cannot know about your project. Each is a shell
# function; each must return non-zero on failure. These are what ISSUE-293
# turns into declared `crew.yaml` hooks — for now they are plain functions,
# which is the same contract with less ceremony.
#
# The labels are used in the ticket the loop files when a release fails, so a
# human reading it knows what to run by hand.

CREW_TEST_LABEL='pnpm test'
crew_hook_test() {
  # Every suite that must pass before a release. Return non-zero if ANY of
  # them fails — `set -e` is not in effect inside this function.
  local ok=0
  pnpm test || ok=1
  return "$ok"
}

CREW_BUILD_LABEL='pnpm build'
crew_hook_build() {
  # Anything that must compile before a release but is not a test: generated
  # clients, build scripts, typecheck.
  pnpm build
}

CREW_DEPLOY_LABEL='./deploy.sh'
crew_hook_deploy() {
  # Ship main to wherever it goes. Runs from CREW_PROJECT_DIR with a clean
  # tree on the main branch; its output is captured and attached to the
  # failure ticket if it exits non-zero.
  ./deploy.sh
}
