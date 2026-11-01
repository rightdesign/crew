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
    cacheWorkspace: crew      # value of the OpenShell workspace label on the volume
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

`crew doctor` checks that the CLI runs and the gateway answers. On Docker Desktop the gateway's docker
section needs `supervisor_network_mode = "bridge"` (otherwise every create fails with
`ControlSupervisorStartFailed` after 12 s), and `allow_driver_config = true` for the cache volume. Linux
hosts use host mode. The first create on a host pulls the supervisor and runtime images (about 12 s on a Mac).

## The cache volume

`cacheVolume` names one volume per route on the container engine. Crew creates it on first use with the labels
OpenShell needs to admit it into a sandbox (`openshell.ai/sandbox-attachable=true` and
`openshell.ai/sandbox-attachable-workspace=<cacheWorkspace>`) and the labels `crew deprovision` removes by.
On Docker Desktop it lives inside the engine's virtual machine; it is never a host bind mount.

```
mirrors/<forge host>/<remote path>.git                   bare mirror, plus a crew-last-refresh stamp
cache/deps/<forge host>/<remote path>/<lockfile hash>/   node_modules trees, relative paths kept
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
  pass refreshes every mirror again. `--json` prints the list.
