# Pooled instances

A pooled instance is a host that belongs to the platform's shared pool rather
than to one organization. It starts with no tenant: `crew pool-member` waits
for a lease, provisions the host from it, and wipes the host again when the
lease is released, so the next lease runs with no trace of the last.

The platform side of this contract is the pool member endpoints in the
Tablation API. The two sides carry the same text; a change to one is a change
to both.

## Configuration

| Name | Meaning |
| --- | --- |
| `CREW_POOL_URL` or `--url` | The platform base URL, the value `crew provision --base-url` takes. |
| `CREW_POOL_TOKEN` or `--token-stdin` | The pool credential. Opaque to crew; sent as `Authorization: Bearer <credential>`. Flags win over the environment. |
| `CREW_POOL_INSTANCE_ID` | The cloud instance id reported at registration. The host name is used when it is unset. |
| `CREW_POOL_DIR` | Where the member keeps its identity. |

The base image's first-boot hook writes the variables to an owner-only
environment file that the member's unit loads. The member's own state file,
`member.json` (member id, current lease id, last reported state), lives in a
directory of its own, by default `$XDG_STATE_HOME/crew-pool-member` (or
`~/.local/state/crew-pool-member`), **outside the ship's state directory**, so
`crew deprovision` never removes the member's identity.

The credential authorizes only the three endpoints below, for the member it
was minted for. A 401 means it is unknown or revoked: the command exits 2.

## Endpoints

JSON, under the platform's API prefix.

### `POST /pool-members/register`

Body `{ cloudInstanceId, architecture: "x86_64" | "arm64", crewVersion, hostname }`.
Called at every start of the command (boot, unit restart). Idempotent.

Response 200 `{ memberId, instanceClassKey, shipKind, state, leaseId, payloadDelivered, pollWaitSeconds }`:
`state` is the platform's member state (`launching`, `idle`, `leased`,
`wiping`, `retiring`, `retired`, `failed`), `leaseId` the current lease or
null, `payloadDelivered` whether that lease's payload has been handed out, and
`pollWaitSeconds` the long-poll cap (30). `shipKind` is optional, `pooled_instance` or `managed_instance`; absent means `pooled_instance`. It is the value crew passes to `--ship-kind`: a reserved managed instance is the same member with a standing lease, and never receives `release`. A 409 means the member is retiring,
retired or failed: the command stops and exits 0.

### `GET /pool-members/lease?wait=<seconds>&leaseId=<current lease, or omitted>`

The long poll. The server holds the request up to `wait` (clamped to
`pollWaitSeconds`) and answers one of:

- **204**: nothing to do; poll again at once.
- **200** `{ action: "provision", lease: { id, shipName, routes: [{ workspace, project, workspaceId, projectId }], connectKeys: [{ workspaceId, workspace, key }], forges: [{ host, token }], relayHost, maxConcurrentAgents } }`:
  only for a member that names no lease and holds a lease at `provisioning`
  whose payload has not been delivered. Delivered once; a second poll never
  repeats it. `workspace` and `project` are the slugs `crew connect WORKSPACE/PROJECT`
  takes. `relayHost` and `maxConcurrentAgents` may be absent.
  `connectKeys` holds one entry per distinct workspace among the routes: an
  ordinary admin workspace API key the platform minted for the lease and
  revokes at its end. Each route connects with its own workspace's key. A
  payload from an older platform build with a single `connectKey` is accepted
  as the key for every route. Keys stay in memory: never argv, a log line or
  the JSON summary.
- **200** `{ action: "tokens", leaseId, forges: [{ host, token }] }`: the organization's current forge token set, sent after a token is set, replaced or deleted while the lease runs. The member replaces its stored tokens with exactly this set: hosts listed are written, hosts absent lose their token, nothing else changes and agent runs in progress continue. It then sends a `running` status report, which the platform takes as the acknowledgement. A message naming a lease the member does not hold is ignored and logged. Tokens are never logged.
- **200** `{ action: "release", leaseId }`: the lease the member named is being released.
- **200** `{ action: "retire" }`: the member is being retired; the command exits 0.
- **409** `{ code: "LEASE_MISMATCH", currentLeaseId }`: the member named a lease that is not its current one. It re-registers and follows the resume table. A stale release can therefore never wipe a newer lease: crew also ignores a release naming any lease other than the one it holds.

A network error or 5xx backs off from 5 s doubling to 60 s. A 204 never backs off.

### `POST /pool-members/status`

Body `{ state, leaseId, machineId, relayUrl, reason, crewVersion }` with
`state` one of `unprovisioned`, `provisioning`, `running`, `wiping`, `failed`.
Response 200 `{ memberState, leaseState }`.

A `running` report also carries `missingForgeHosts: [{host, lastMissAt}]`: the
forge hosts git asked the credential helper (`crew credential get`, https only)
for and the helper could not answer, de-duplicated, with the time of the last
miss. Only the bare host is recorded (never a URL path, username or token), in
`<stateDir>/forge-misses.json`. A host is removed when the helper next answers a
request for it, so a late token delivery clears it after the next successful
lookup. The list is sent on every `running` report, empty when nothing is
missing, so the platform can replace what it stored; an older crew omits it.
The run itself still fails as before.

A `running` report also carries `activeRuns` (agent runs in progress on the
ship, across all routes) and `lastRunEndedAt` (ISO time the most recent run
finished, null when none has). Both are read from the ship's own run
sidecars, with no tracker call. The member reports `running` on every poll
cycle while it holds a lease, and immediately whenever `activeRuns` flips
between zero and non-zero (checked every 2 s), so the platform sees a busy
ship within seconds of its first run. A report without the fields comes from
an older crew and must never trigger an idle release. A `release` still wins
over activity.

| `state` | Effect on the platform |
| --- | --- |
| `provisioning` | A heartbeat. |
| `running` | With `leaseId`, `machineId` and `relayUrl` (or null): the lease becomes running. Repeated to fill `relayUrl` in once the tunnel is up. |
| `wiping` | The member becomes wiping. |
| `unprovisioned` | With the released lease's id: the lease becomes released and the member idle. With no lease id on an idle member: a no-op. |
| `failed` | With `reason`: the named lease and the member become failed, and the command exits 1. |

A report equal to the current state is a 200 no-op. An illegal transition is a
409: crew logs it and does not retry. `machineId` is the hashed id written to
the Ships row (`<stateDir>/machine-id`); `relayUrl` is the persisted tunnel URL
the ship records as `relay_url`.

## Resume after a restart

The register response is read against the local member file:

| Platform says | Local file says | Crew does |
| --- | --- | --- |
| idle | no lease, no crew.yaml | Polls. |
| idle | a lease, or crew.yaml exists | Runs `crew deprovision`, reports `unprovisioned`, polls. |
| leased, payload not delivered | (anything left behind is wiped first) | Polls; the provision action arrives. |
| leased, payload delivered | the same lease, and crew.yaml exists | Brings the daemon back up from what is on disk (units, routes), reports `running`, polls naming the lease. |
| leased, payload delivered | no lease, or another | The payload is lost: reports `failed` with that reason and exits 1. |
| wiping | any | Runs `crew deprovision`, reports `unprovisioned`, polls. |
| retiring, retired, failed | any | Exits 0. |

## On `provision`

Crew records the lease id in the member file, reports `provisioning`, then runs
the same path as `crew provision` with `--ship-kind <shipKind>` and
`--instance-class <instanceClassKey>`: it connects each route, stores the forge
tokens, writes `ship.relayHost` and `ship.maxConcurrentAgents` when given,
enables the routes, installs the units and starts the daemon. It then reports
`running` with the machine id and the relay URL (null until the tunnel is
up, filled in by a later `running` report). The payload is held in memory only:
never written to disk as a whole, never in argv and never logged. A failure
reports `failed` with the reason and exits 1.

## On release

Crew reports `wiping`, runs `crew deprovision`, and reports `unprovisioned`
with the released lease's id only after the wipe exits 0. A wipe that leaves
anything behind reports `failed`, stops polling, and the platform retires the
member rather than leasing it again.

## `crew deprovision`

Usable by hand on any host. In order:

1. Stop and remove the scheduler units, so nothing wakes mid-wipe.
2. Kill every run in flight, record the kills on the event stream, and comment on each ticket while the seat keys still exist. Delete the sandbox containers.
3. On this ship's Ships row in each served workspace, clear `engaged`, `tunnel_status` and `relay_url`. The platform marks the rows retired after the wipe report.
4. Revoke and remove the seat keys, remove the workspace credential and the Pair/MCP entries, remove the checkouts (forced past local changes), and erase every forge token.
5. Remove the Docker volumes and repository image layers crew labeled. The base and crew layers stay, and nothing crew did not label is touched. Crew labels what it creates with `crew.owner=crew`; cache volumes also carry `crew.kind=cache` and image layers `crew.layer=base|crew|repo`, and only cache volumes and `repo` layers are removed.
6. Empty the state directory and remove crew.yaml.
7. Verify. If crew.yaml, a forge token, a seat key, a labeled volume or image, a sandbox or a scheduler unit still exists, exit non-zero and list what remains.

## Self-upgrade

The register body carries `crewVersion`. The boot-time and periodic crew
upgrade runs only while the member is unprovisioned, never during a lease. The
call site is in place (`maybeSelfUpgrade`); it does nothing until the upgrade
mechanism lands.
