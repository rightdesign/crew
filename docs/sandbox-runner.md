# Sandbox runner

By default an agent run is a detached child of the crew daemon on this machine (`ship.runner: host`).
With `ship.runner: sandbox` each run executes inside an [OpenShell](https://github.com/NVIDIA/OpenShell)
sandbox created for that run and deleted when it ends. Everything above the spawn boundary is the same:
the run stream, the `.pid` sidecar, the wall-clock limit, the orphaned-run hand-back.

```yaml
ship:
  runner: sandbox
  sandbox:                    # every key optional
    bin: openshell            # the CLI
    image: my-registry/crew-synthesis:latest   # default: the OpenShell base image
    policy: ~/.crew/sandbox-policy.yaml        # handed to `sandbox create --policy`
    cacheVolume: crew-cache   # named volume of bare mirrors, mounted read-only
    mirrorDir: /cache         # where it appears in the sandbox
    workDir: /sandbox/work    # where the run's clone is made
    agentBin: claude          # harness binary inside the image (default: basename of the toolchain bin)
    forgeTokenVar: GITHUB_TOKEN   # host env var injected for pushing
    engine: docker            # container engine CLI that owns the cache volume
    cacheWorkspace: default   # OpenShell workspace label on the volume; must match the workspace sandboxes are created in (default)
    cacheImage: alpine/git:latest   # helper image that refreshes the mirrors (needs git, sh, base64)
    depsCommand: pnpm install --frozen-lockfile   # optional: warm a dependency tree per lockfile hash
    depsImage: my-registry/crew-synthesis:latest  # image that command runs in (default: image)
    depsLockfile: pnpm-lock.yaml                  # file whose hash keys the tree
```

## What a run does

1. `openshell sandbox create` with the policy, image, the cache volume (read-only) and the run's
   environment. Secrets (the tracker key, the forge token) go in through `--env-from`, read from the create
   process's environment, never argv.
2. One `sandbox exec` clones `<mirrorDir>/mirrors/<forge host>/<remote path>.git` with `--shared` into `workDir`, points `origin` at the
   real remote and checks out a fresh branch. The plan's host `cwd` is ignored.
3. `sandbox exec` runs the harness with the prompt on stdin and its stdout appended to the same stream
   file a host run writes. A prompt over 4 MiB goes through `sandbox upload` and is read from a file.
4. On exit the sandbox is deleted. Killing a run (wall-clock limit) is deleting the sandbox; the exec client
   returns within about a second.

The sidecar records the sandbox name beside the client pid, so a daemon that restarts mid-run adopts the
live run and deletes the sandbox when it finishes. The event stream carries `sandbox_created` and
`sandbox_deleted`, each with its timing in milliseconds.

## Doctor

`crew doctor` checks that the CLI runs and the gateway answers, then creates and deletes a probe sandbox
with a crew-shaped name (`crew-` plus 14 characters, 19 in all: a Linux host-mode gateway rejects names
longer than 19). A refusal is reported as the gateway refusing the probe, with its message. The probe
create is allowed 120 s because of the image pull below; a timeout is reported as a timeout, not a refusal.
The probe runs `sleep 60`, so it stops by itself even if the delete fails. On Docker Desktop the gateway's docker
section needs `supervisor_network_mode = "bridge"` (otherwise every create fails with
`ControlSupervisorStartFailed` after 12 s), and `allow_driver_config = true` for the cache volume. Linux
hosts use host mode. The first create on a host pulls the supervisor and runtime images (about 12 s on a Mac).

## The network policy

Crew writes the sandbox policy for every run (it is not a hand-maintained file) and writes it beside the
run's stream files as `<stream>.policy.yaml`, so what a run was allowed is inspectable afterwards. `crew sandbox policy --route R --role ROLE [--repo NAME] [--json]` prints the policy a run would get.
Setting `ship.sandbox.policy` replaces the generated policy with your own file.

Everything is denied except:

- the **forge host(s)** of the route's repositories (`github.com` when a repository names none), for clone and push;
- the route's **Tablation host**, for the tracker;
- the **model route** for the toolchain's `auth`: under `workspace` the Tablation inference endpoint is the
  only route (the provider's hosts are not in the policy at all); under `subscription` or `inherit` the
  provider's hosts (`api.anthropic.com` and the login hosts for Claude, and so on);
- the hosts the repository's `.crew.yaml` `sandbox:` section declares, and the download hosts of the
  toolchains it names. A declared host is recorded in the run's event stream (`sandbox_policy`).

Rules are bound to binary paths inside the sandbox: the model route is open to the harness and `node` only, the forge to `git`, so a
stray `curl` cannot reach a provider directly. Landlock is generated as `hard_requirement`: a host that cannot enforce it fails the run rather than running unconfined. The cloud metadata address `169.254.169.254` is never
reachable; a declared host that is that address, loopback or a private range is refused when the policy is generated, and the run fails before a sandbox exists.

A request the policy denies shows up in the run's event stream as `sandbox_denied` (host, port, binary and a count),
read from the sandbox log just before the sandbox is deleted, so an agent blocked by policy is diagnosable from the app.
Hot-reloading the network section of a running sandbox is not supported.

## The cache volume

`cacheVolume` names one volume per route on the container engine. Crew creates it on first use with the labels
OpenShell needs to admit it into a sandbox (`openshell.ai/sandbox-attachable=true` and
`openshell.ai/sandbox-attachable-workspace=<cacheWorkspace>`, `default` unless set, because that is the workspace `sandbox create` puts sandboxes in and the gateway admits only volumes labeled for it) and the labels `crew deprovision` removes by.
On Docker Desktop it lives inside the engine's virtual machine; it is never a host bind mount.

```
mirrors/<forge host>/<remote path>.git                   bare mirror, plus a crew-last-refresh stamp
cache/deps/<forge host>/<remote path>/<lockfile hash>/   node_modules trees, relative paths kept
intel/<forge host>/<remote path>/                        symbol cache (`cache/`) + `indexed-commit` of the default branch; `intel: serena` repos only (CREW-2924)
```

- **Refresh.** At the start of each daemon pass (at most once a minute) crew refreshes every served repository's
  mirror with the forge token, through a short helper container, under the same checkout lock the poll-cadence
  sync takes, so two routes sharing a repository never refresh it at once. A failure raises a `sandbox_cache`
  attention item for that repository and runs keep using the previous mirror; the next successful refresh clears it.
- **Read-only in runs.** Only the host writes the volume; every sandbox mounts it read-only. The run's clone is
  `git clone --shared`, with the mirror as an alternate (a hardlinked clone cannot cross the volume boundary).
- **No partial refresh is visible.** `git fetch --atomic` adds objects before it moves any ref, a first clone is
  renamed into place, and nothing is garbage collected, so a clone made before a refresh stays whole and a clone
  made during one sees the state before or after it.
- **Warmed dependencies.** With `depsCommand` set, crew installs the mirror's default-branch checkout in
  `depsImage` whenever the volume has no tree for its current `depsLockfile` hash, and keeps every
  `node_modules` directory (workspace packages included). A run hashes its own checkout's lockfile and, if a
  tree exists for it, copies the tree in before the harness starts; otherwise it installs as it would without a
  cache. This is what turns minutes into seconds on a small instance class.
- **`crew sandbox cache`** lists the mirrors with their last refresh. `--prune` drops mirrors (and their
  dependency trees) for repositories the ship no longer serves; `--reset` recreates the volume, and the next
  pass refreshes every mirror again. `--refresh` runs the daemon's cache pass once in the foreground, creating
  every served repository's missing mirror and printing each outcome (exit 1 if any failed). `--json` prints the list.
  A fresh ship's daemon does the same at start, before it reads any contract from a mirror, and does not exit
  over a repository whose mirror is merely absent.

## The ship's image (CREW-2956)

Sandboxing is a ship property. On a ship with `ship.runner: sandbox`, the build tick builds the
crew layer on its own (ca-certificates, curl, git, the credential helper, Claude Code at
`/opt/crew/bin/claude`), whether or not any repository declares `sandbox:`, and every run
starts from it. A repository's `sandbox:` section is optional: it only adds that repository's
layer (packages, warmed caches, setup steps) on top of the same crew layer, and a run for that
repository uses the layer once it has built (the ship's image until then). `ship.sandbox.image`
overrides both. `crew sandbox images` lists the ship's image first, as `@ship`, and
`crew doctor` reports it as MISSING or FAILED until it builds; `crew sandbox build @ship`
forces a build.

## The harness in the image

The crew layer installs Claude Code's standalone binary at `/opt/crew/bin/claude`
at build time (`SANDBOX_CLAUDE_VERSION` in `sandbox-image.ts`, never `latest`),
verifies it against the checksum pinned beside the version, and sets
`DISABLE_AUTOUPDATER=1`. A run never downloads anything. Bumping the pin
rebuilds the crew layer and so every route's image; an unchanged pin reuses the
tags. `crew doctor` and `crew sandbox images` show the Claude Code version baked
into each image.

## Leaked containers and a full disk

On a sandbox ship the daemon checks the docker host on every pass (at most every 30 seconds).

- **Reaper.** Containers named `openshell-<workspace>--…crew-<14 characters>` that no live run sidecar and no `openshell sandbox list` entry names, and that are more than five minutes old, are removed with `docker rm -f`. Each removal is logged as `sandbox_reaped` with the container name and age, and the Ships row's attention shows a `sandbox_leak` item with the running count; it clears after an hour with nothing reaped. If the gateway cannot be listed, nothing is removed.
- **Disk watermark.** Used space on the root filesystem and the docker data root is read each pass. At 85% a `disk_pressure` item is raised. At 95% crew first runs the reaper and `docker builder prune -f`; if the disk is still at 95% it raises `disk_full`, and no agent run or sandbox image build starts until usage is below 90%.
- **Labels.** Every sandbox is created with `crew.role`, `crew.ticket` (absent for a release) and `crew.run` labels, so a leaked one can be attributed from the OpenShell sandbox record or `docker inspect`.
