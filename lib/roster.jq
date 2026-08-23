# How a crew member is named in anything an agent reads — the queue digest
# today, any other rendered surface later. Shared by queue-digest.jq and
# queue-digest-qa.jq so the two cannot drift.
#
# $roster is {id: {name, role, kind}}, built by crew_roster_json() in
# bin/crew: `name` comes from the project's Crew table, `role` and `kind`
# from crew.config.sh. A member is `kind: "agent"` (a seat this ship runs) or
# `kind: "hold"` (a person, or an interactive session working beside one).
#
# NAME IS PRIMARY. A crew member may be named anything — "Trevor" is a
# perfectly good name for the dev seat — so the role is a parenthetical
# qualifier rather than the label itself. It is omitted when the name already
# carries the role, which is why the default rows read "QA agent" and not
# "QA agent (QA)".
def crewlabel($roster; $id):
  ($roster[$id] // null) as $m
  | if $m == null then null
    elif ($m.role // "") == "" then $m.name
    elif ($m.name | ascii_downcase | contains($m.role | ascii_downcase)) then $m.name
    else "\($m.name) (\($m.role))"
    end;

# True when this row is a hold: a ticket assigned to it is off limits to
# every seat, whatever its status.
def isholdrow($roster; $id): ($roster[$id].kind // "") == "hold";
