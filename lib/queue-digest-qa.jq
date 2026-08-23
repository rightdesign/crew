# Queue digest for the QA lane. Rendered by write_queue_digest() in
# bin/crew, which passes QA's slice of the tickets on stdin plus
# $comments, $me, $roster, $watermark and $branches.
#
# QA's queue is a different shape from a building lane's — one list, not
# three, and what matters per row is which lane built the ticket and
# whether its worktree is still there to test — so it is a separate
# program rather than a branch inside queue-digest.jq.

# Ordering lives in priority.jq so this sort and bin/crew's lane choice
# cannot drift apart. Requires jq -L on this directory.
include "priority";
# Crew naming — see lib/roster.jq.
include "roster";

# Authorship comes from team_member_id, never reporter_name — see the note
# in queue-digest.jq.
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

def who:
  if   .assignee_id == null then "unassigned"
  elif .assignee_id == $me  then "you"
  else (crewlabel($roster; .assignee_id)) as $l
    | if   $l == null then "someone off this ship"
      elif isholdrow($roster; .assignee_id) then "**\($l) — HOLD**"
      else $l
      end
  end;

# Which lane built it — that's who a bounce goes back to.
def builtby: if .needs_design == true then "design" else "dev" end;

# Is the ticket's branch still here? No branch means no worktree to test.
def hasbranch:
  (.issue_id // "") as $i
  | if ($branches | split("\n") | map("ISSUE-" + ltrimstr("issue-")) | index($i)) != null
    then "yes" else "**MISSING**" end;

def row:
  "| \(.issue_id) | \(.status) | \(builtby) | \(who) | \(.severity // "—") | \(.priority // "—") | p\(eff) | \(hasbranch) | \(.updated_at[0:16])Z | \(lastcomment(.id)) | \(if newfromothers(.id) > 0 then "**\(newfromothers(.id)) new**" else "—" end) |";

def header:
  "| ticket | status | built by | assignee | sev | pri | eff | branch | updated | last comment | new since last poll |\n|---|---|---|---|---|---|---|---|---|---|---|";

def table:  if length == 0 then "\n_None._\n" else "\n" + header + "\n" + (map(row) | join("\n")) + "\n" end;

. as $bugs |

"## Current queue — built for you by the poll\n",
"\nAlready filtered to your lane: every ticket at `qa` (\"Verification\" —\nyours, unfinished) or `fixed` (nobody has checked it yet), from both\nbuilding lanes. Ticket bodies are deliberately omitted: fetch the full\nrecord and the comments of the one ticket you actually pick up. **Do not\nre-fetch the whole tracker.** This digest comes from the same API call the\npoll just made, moments ago.\n",
"\n\"new since last poll\" counts comments from someone other than you since\nthe poll watermark — the same signal that woke this run.\n",

"\n### Still in verification — yours, unfinished (take these first)\n",
( [ $bugs[] | select(.status == "qa") ] | sort_by(rank) | table ),

"\n### Awaiting verification, in pick order\n",
( [ $bugs[] | select(.status == "fixed") ] | sort_by(rank) | table )
