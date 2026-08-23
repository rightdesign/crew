# The dev loop's ticket ordering, in one place.
#
# This is the executable copy of the Step 2 ordering rule in
# common.md. Both queue-digest.jq (which sorts the agent's queue)
# and bin/crew's lane_top_priority (which decides which lane runs this
# cycle) include this module, so the sort the agent is handed and the choice
# of who runs can never disagree. If this and the prose ever drift, the
# prose is what to correct.

# Priority derived from severity, using triage's own mapping.
def der:      {"s1":0,"s2":1,"s3":2,"s4":3}[.severity // ""] // 2;
def explicit: {"p0":0,"p1":1,"p2":2,"p3":3}[.priority // ""];

# Effective priority is the STRONGER of explicit and derived (lower number
# wins), so an explicit Priority can only ever move a ticket forward, never
# behind where its Severity alone would have put it. Marking an S2 as "P2
# Medium" used to demote it below every unmarked S2 — flagging a ticket for
# attention pushed it backwards (ISSUE-159 vs ISSUE-142). To rank something
# down, lower its Severity.
def eff:      if explicit == null then der else ([explicit, der] | min) end;

def sevrank:  {"s1":0,"s2":1,"s3":2,"s4":3}[.severity // ""] // 4;
def num:      (.issue_id // "ISSUE-0") | split("-") | .[1] | tonumber;

# Full sort key: effective priority, then severity, then oldest first.
def rank:     [eff, sevrank, num];
