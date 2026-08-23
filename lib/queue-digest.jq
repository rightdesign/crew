# Queue digest for one *building* lane — dev or design. The QA lane has its
# own program, queue-digest-qa.jq, because its queue is a different shape.
# Rendered by write_queue_digest() in bin/crew, which passes this lane's
# tickets on stdin plus $comments, $me, $roster, $watermark, $branches,
# $blocked and $blockerinfo.
#
# Emits markdown, and deliberately carries no description / repro_steps /
# resolution_note prose — the agent fetches the full record of the one
# ticket it picks up.

# Ordering lives in priority.jq so the digest's sort and bin/crew's
# lane choice cannot drift apart. Requires jq -L on this directory.
include "priority";
# Crew naming — see lib/roster.jq. Names come from the project's Crew table,
# so nothing here spells a crew member's name or assumes what it is.
include "roster";

# Authorship comes from team_member_id, never reporter_name: comments carry
# the *ticket's* reporter_name, so an agent's own comment can read as the
# name of whoever filed the ticket. Getting this backwards would make the
# loop treat its own notes as a reply from someone else.
def author:
  if   .team_member_id == $me   then "you"
  elif .team_member_id == null  then (.reporter_name // "anon") + " (no identity)"
  else (crewlabel($roster; .team_member_id) // "someone off this ship")
  end;

def lastcomment($cid):
  [ $comments[] | select(.ticket_id == $cid) ] | sort_by(.created_at) | last
  | if . == null then "—" else "\(.created_at[0:16])Z \(author)" end;

def newfromothers($cid):
  [ $comments[]
    | select(.ticket_id == $cid and .team_member_id != $me and .created_at > $watermark
        and (.kind // "comment") != "event") ]
  | length;

# A hold row is a person, or an interactive Claude session working a ticket
# beside one — either way a human is driving that ticket right now, so it is
# marked rather than merely named. The poll already excludes holds from what
# it counts as work; this label is what stops the agent acting on one that is
# still listed below.
def who:
  if   .assignee_id == null then "unassigned"
  elif .assignee_id == $me  then "you"
  else (crewlabel($roster; .assignee_id)) as $l
    | if   $l == null then "someone off this ship"
      elif isholdrow($roster; .assignee_id) then "**\($l) — HOLD**"
      else $l
      end
  end;

# Dependency-blocked, per the poll's own computation (ISSUE-187) — NOT the
# `blocked` status, which is only how the board renders it. Everything here
# keys off $blocked so that a ticket whose park or unpark write failed is
# still treated by its real dependency state rather than by a stale label.
def isblocked: .id | IN($blocked[]);

# "ISSUE-241 (accepted), ISSUE-9 (unknown)" — every blocker this ticket names,
# with the status that decides whether it still counts. $blockerinfo covers
# closed blockers too, which the lane payload itself does not contain.
def blockers:
  [ (.blocked_by // [])[]
    | "\($blockerinfo[.].issue_id // "?") (\($blockerinfo[.].status // "unknown"))" ]
  | if length == 0 then "—" else join(", ") end;

def row:
  "| \(.issue_id) | \(.status) | \(who) | \(.severity // "—") | \(.priority // "—") | p\(eff) | \(.updated_at[0:16])Z | \(lastcomment(.id)) | \(if newfromothers(.id) > 0 then "**\(newfromothers(.id)) new**" else "—" end) |";

def header:
  "| ticket | status | assignee | sev | pri | eff | updated | last comment | new since last poll |\n|---|---|---|---|---|---|---|---|---|";

def blockedrow:
  "| \(.issue_id) | \(.status) | \(who) | p\(eff) | \(blockers) |";
def blockedtable:
  if length == 0 then "\n_None._\n"
  else "\n| ticket | status | assignee | eff | blocked by |\n|---|---|---|---|---|\n"
       + (sort_by(rank) | map(blockedrow) | join("\n")) + "\n" end;

def sorted: sort_by(rank);
def table:  if length == 0 then "\n_None._\n" else "\n" + header + "\n" + (sorted | map(row) | join("\n")) + "\n" end;

# The lane's ticket array arrives on stdin; bind it so the sections below can
# each filter it independently.
. as $bugs |

"## Current queue — built for you by the poll\n",
"\nAlready filtered to your lane, and already ordered by the Step 2 rule.\nTicket bodies are deliberately omitted: fetch the full record of only the\nticket you actually pick up. **Do not re-fetch the whole tracker.** This\ndigest comes from the same API call the poll just made, moments ago.\n",
"\n\"new since last poll\" counts comments from someone other than you since\nthe poll watermark — the same signal that woke this run.\n",

"\n### Step 1 — open tickets that may be yours to act on\n",
"\n`fixed` tickets are deliberately absent: they belong to the QA lane.\n",
( [ $bugs[] | select(
      (.status=="in_progress" and (.assignee_id==$me or .assignee_id==null))
      or .status=="needs_info") ] | table ),

"\n### Step 2 — accepted tickets, in pick order\n",
"\nWork the first one you are not required to skip. Tickets waiting on an\nunresolved dependency are already out of this table — see Blocked below.\n",
( [ $bugs[] | select((.status=="accepted" or .status=="blocked") and (isblocked | not)) ] | table ),

"\n### Blocked — waiting on a dependency, not yours to start\n",
"\nListed rather than hidden so \"nothing to do\" stays distinguishable from\n\"everything is parked\". The loop parks and restores these itself, on every\npoll: an approved ticket whose `Blocked by` entries are unresolved moves to\n`blocked`, and back to `accepted` once the last one resolves. **Do not pick\none up, do not set or clear `blocked` by hand, and do not \"unblock\" one by\nediting its `Blocked by` field** — if a blocker looks wrong, say so in your\nrun summary. A blocker counts as resolved at `verified`, `closed_deployed`,\n`closed_wont_fix` or `closed_duplicate`; `fixed` is still an unmerged branch\nawaiting QA, so it does not count.\n",
( [ $bugs[] | select(isblocked) ] | blockedtable )
