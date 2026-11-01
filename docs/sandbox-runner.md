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
```

## What a run does

1. `openshell sandbox create` with the policy, image, the cache volume (read-only) and the run's
   environment. Secrets (the tracker key, the forge token) go in through `--env-from`, read from the create
   process's environment, never argv.
2. One `sandbox exec` clones `<mirrorDir>/<repo>.git` with `--shared` into `workDir`, points `origin` at the
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
