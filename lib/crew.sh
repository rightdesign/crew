# Shared crew helpers: the tracker credential, and the roster that tells every
# agent who is aboard this ship and what each of them is called. Sourced by
# bin/crew and bin/crew-triage, which both need to name crew members
# and neither of which should own a second copy of the rule.
#
# Expects crew.config.sh to have been sourced already, plus the derived
# *_TEAM_MEMBER_ID vars, BASE_URL and USER_AGENT. `log` must exist.

tracker_api_key() {
  if [[ -n "${CREW_API_KEY:-}" ]]; then
    echo "$CREW_API_KEY"
  elif [[ -f "$CREW_API_KEY_FILE" ]]; then
    grep "^${CREW_API_KEY_VAR}=" "$CREW_API_KEY_FILE" | cut -d= -f2-
  fi
}

# ---------------------------------------------------------------------------
# The roster: who is aboard this ship, and what each of them is called.
#
# Every agent gets this. Two things depend on it. The queue digest labels each
# ticket's assignee and each comment's author by NAME rather than by role, and
# the prompt tells the running agent its own name so it can address its
# shipmates in a ticket comment the way a person would.
#
# Names come from the project's Crew table, never from config and never from
# prompt prose: a crew member may be called anything ("Trevor" is a fine name
# for the dev seat), and renaming one must be a data edit, not a redeploy.
# crew.config.sh contributes only the id -> role/kind mapping, which is a fact
# about this ship rather than about the project.
# ---------------------------------------------------------------------------

# [{id, role, kind}] from config alone — no network. Seats this ship does not
# crew are dropped, so an empty CREW_MEMBER_DESIGN simply means no design seat.
crew_seats_json() {
  local seats entry id role
  seats=$(jq -cn \
    --arg dev    "$DEV_TEAM_MEMBER_ID" \
    --arg design "$DESIGN_TEAM_MEMBER_ID" \
    --arg qa     "$QA_TEAM_MEMBER_ID" \
    --arg triage "${CREW_MEMBER_TRIAGE:-}" \
    --arg op     "$OPERATOR_TEAM_MEMBER_ID" '
    [ {id:$dev,    role:"Dev",      kind:"agent"},
      {id:$design, role:"Design",   kind:"agent"},
      {id:$qa,     role:"QA",       kind:"agent"},
      {id:$triage, role:"Triage",   kind:"agent"},
      {id:$op,     role:"Operator", kind:"hold"} ]
    | map(select(.id != ""))')
  for entry in ${CREW_HOLDS[@]+"${CREW_HOLDS[@]}"}; do
    [[ -z "$entry" ]] && continue
    id="${entry%%|*}"
    role="${entry#*|}"
    [[ "$role" == "$entry" ]] && role=""
    seats=$(jq -c --arg id "$id" --arg role "$role" \
      '. + [{id:$id, role:$role, kind:"hold"}]' <<<"$seats")
  done
  printf '%s' "$seats"
}

# {id: {name, role, kind}} — the seats above, joined to the Crew table's Name
# field. Fetched once per invocation and memoised; it is six rows.
#
# A failed fetch is not fatal. Every consumer degrades to the role as a name
# ("Dev", "Operator"), which is worse prose but identical behaviour — holds
# still hold and authorship still resolves, because those key off the id.
CREW_ROSTER_JSON=""
crew_roster_json() {
  [[ -n "${CREW_ROSTER_JSON:-}" ]] && { printf '%s' "$CREW_ROSTER_JSON"; return 0; }
  local api_key seats rows
  seats=$(crew_seats_json)
  api_key=$(tracker_api_key)
  rows=$(curl -sf --max-time 15 -H "Authorization: Bearer $api_key" \
    -H "User-Agent: $USER_AGENT" \
    "$BASE_URL/api/data-models/$CREW_MEMBER_MODEL_ID/records?limit=200") || rows=""
  [[ -z "$rows" ]] && { rows='[]'; log "roster: Crew table unreachable, falling back to role names"; }
  CREW_ROSTER_JSON=$(jq -c --argjson seats "$seats" '
    (map({key: .id, value: (.name // "")}) | from_entries) as $names
    | reduce $seats[] as $s ({};
        .[$s.id] = { name: (if ($names[$s.id] // "") == "" then $s.role else $names[$s.id] end),
                     role: $s.role,
                     kind: $s.kind })' <<<"$rows")
  printf '%s' "$CREW_ROSTER_JSON"
}

# The hold ids as a JSON array, for the `assignee_id | IN(...)` checks below.
crew_hold_ids_json() {
  crew_roster_json | jq -c '[ to_entries[] | select(.value.kind == "hold") | .key ]'
}

# The roster block prepended to every agent run. $1 is the lane whose seat is
# running, so the agent can find itself in the table.
crew_roster_markdown() {
  local lane="$1" me=""
  case "$lane" in
    dev)    me="$DEV_TEAM_MEMBER_ID" ;;
    design) me="$DESIGN_TEAM_MEMBER_ID" ;;
    qa)     me="$QA_TEAM_MEMBER_ID" ;;
    triage) me="${CREW_MEMBER_TRIAGE:-}" ;;
  esac
  # -L + include, rather than a second copy of the naming rule: crewlabel is
  # defined once, in lib/roster.jq, and the digest uses the same one.
  crew_roster_json | jq -L "$CREW_HOME/lib" -r --arg me "$me" 'include "roster";
    . as $r
    | [ to_entries[] | select(.value.kind == "agent") ] as $seats
    | [ to_entries[] | select(.value.kind == "hold") ]  as $holds
    | ( crewlabel($r; $me) // "an unnamed seat" ) as $selfname
    | "## Your crew\n",
      "\nYou are **\($selfname)**. Address your shipmates by name in ticket",
      "comments the way you would a colleague; add the role in parentheses only",
      "where a reader would otherwise not know which seat you mean. Your own",
      "row id is what you write to `assignee_id` and `team_member_id`.",
      "\n| seat | name | Crew row id |\n|---|---|---|",
      ( $seats | sort_by(.value.role)[]
        | "| \(.value.role | ascii_downcase) | \(crewlabel($r; .key))\(if .key == $me then "  ← you" else "" end) | `\(.key)` |" ),
      "\n**Not crew — these are holds.** A ticket assigned to any of them is off",
      "limits to every seat, whatever its status: a person is driving it right",
      "now. Their clearing `assignee_id` is what hands it back.",
      "\n| | name | Crew row id |\n|---|---|---|",
      ( $holds | sort_by(.value.role)[]
        | "| \(if (.value.role // "") == "" then "—" else (.value.role | ascii_downcase) end) | \(crewlabel($r; .key)) | `\(.key)` |" ),
      "\nThe **operator** is this ship'"'"'s owner: the machine, the dev stack and the",
      "credentials the steps below refer to are theirs, and approving work is",
      "their call alone.\n"
  '
}

