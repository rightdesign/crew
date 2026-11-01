# CREW-2787 spike: OpenShell sandbox timings on Docker Desktop and Docker Engine

OpenShell **v0.1.6** (CLI, gateway, supervisor 0.1.6, sandbox runtime 0.1.6) on three hosts, 2026-11-01:

| Host | OS / kernel | Docker | CPU / RAM | Gateway |
|---|---|---|---|---|
| Mac Studio (M-series) | macOS, Docker Desktop VM 7.0.14-linuxkit | Docker Desktop 29.9.2 | 18 cores / 64 GB | Homebrew formula, `supervisor_network_mode = "bridge"` |
| Lima VM on the Studio | Ubuntu 26.04.1 arm64, 7.0.0-34-generic | Docker Engine 29.9.2 | 6 vCPU / 12 GB | `.deb`, systemd user unit, host mode |
| EC2 m7g.xlarge, us-west-2 | Ubuntu 24.04.5 arm64, 7.0.0-1014-aws | Docker Engine 29.9.2 | 4 vCPU / 16 GB, 60 GB gp3 | `.deb`, systemd user unit, host mode |

All three ran the same Dockerfiles, policy and in-sandbox script (this directory). Landlock was set to `hard_requirement`, so a filesystem-enforcement failure would have failed the sandbox rather than degrade.

## Verdict

The per-run sandbox with a per-route cache volume **passes** on every host. Nothing OpenShell does is on the critical path: sandbox create, clone from the read-only mirror, exec, delete and volume mounts all cost well under a second each. The only large number is dependency install, and it is the host's cost, not the sandbox's: 22 s on the Studio, 158 s on a 4-vCPU EC2 instance, identical in a plain Docker container on the same instance. The persistent-sandbox fallback is not needed.

## 1. Cache volume with a bare mirror

| | Mac (Docker Desktop) | Lima VM | EC2 |
|---|---|---|---|
| Initial `git clone --mirror` of synthesis from GitHub (27.5 MiB pack) | 3.6 s | 3.2 s | 18.5 s * |
| Refresh (`git remote update --prune`, nothing new) | 0.6 s | 0.56 s | 0.63 s * |
| In-sandbox `git clone --shared` from the read-only mirror (716 K `.git`) | 0.4–0.5 s | 0.3 s | 0.4 s |
| In-sandbox `git clone --no-hardlinks` copy (29 M `.git`) | 0.4–0.5 s | 0.3 s | 0.6 s |

\* EC2 had no forge token, so the GitHub numbers there are for a public 205 MiB repository (NVIDIA/OpenShell); the synthesis mirror was restored from a tarball.

Finding: the ticket's "hardlinked local clone" does not exist across the volume boundary. `git clone --local` fails with `Invalid cross-device link` because the named volume and the container's writable layer are different filesystems. Use `--shared` (alternates into the read-only mirror, which is safe because the mirror is never pruned during a run) or a plain copy; both are under a second.

## 2. Image layers

Three layers: the OpenShell base (`nvcr.io/nvidia/base/ubuntu:24.04`, 143 MB, uid 1000 is `ubuntu`), a crew layer (Node 24.19.0, git, `@tablation/crew` 0.92.0, a credential-helper stub registered as `credential.helper`, 617 MB) and a repo layer (pnpm 11.22.0 with the store pre-fetched for the lockfile, PostgreSQL 16 with a cluster initialised for the sandbox user and `synthesis`/`synthesis_test` databases, 3.7–4.2 GB).

| | Mac | Lima VM | EC2 |
|---|---|---|---|
| Base image pull | 2.2 s | 0.7 s | 1.2 s |
| Crew layer, no cache | 20.7 s | 14.6–15.9 s | 28.3 s |
| Repo layer, no cache | 78.3 s | 73.7–74.9 s | 152 s |
| Repo layer rebuild, trailing step changed | 0.8 s | 0.7 s | 9.7 s |
| Repo layer rebuild, lockfile changed (store re-fetched) | 54.3 s | 56–58 s | 121 s |

## 3. Create to a runnable checkout

Per-run cycle: `sandbox create --from <repo image>` with the cache volume mounted read-only, then one `sandbox exec` that clones, starts Postgres, runs `pnpm install --offline --frozen-lockfile`, `db:generate`, `db:migrate:deploy`, lists the backend jest suite (519 files) and runs one unit file, then `sandbox delete`.

| Step | Mac | Lima VM | EC2 |
|---|---|---|---|
| `sandbox create` to Ready (image present) | 0.6–1.0 s | 0.3–0.7 s | 0.8 s |
| First create ever (pulls supervisor 98 MB + sandbox runtime 15 MB) | ~12 s | 0.6 s ** | 0.8 s ** |
| clone from mirror | 0.4–0.5 s | 0.3 s | 0.4–0.6 s |
| Postgres start | 0.1 s | 0.1 s | 0.1 s |
| `pnpm install --offline` | 21–23 s | 23–26 s | 158 s |
| `db:generate` | 2.2–2.9 s | 2.2–2.5 s | 4.9–5.0 s |
| `db:migrate:deploy` | 1.8–3.0 s | 2.2 s | 7.6–7.9 s |
| `jest --listTests` | 0.5–0.7 s | 0.6 s | 1.3–1.9 s |
| one jest file | 3.0–4.2 s | 3.4 s | 8.1–8.3 s |
| `sandbox delete` | 1.5–2.4 s | 2.3–2.8 s | 3.7 s |
| **Whole cycle** | **32–37 s** | **35–38 s** | **185–186 s** |

\** the gateway had already pulled the runtime images for an earlier probe.

Control on EC2: the same clone and `pnpm install --offline` in a plain `docker run` of the repo image took 157.5 s, so the sandbox adds nothing; the instance does. Copying a 123,000-entry `node_modules` tree inside the instance takes 5.7 s, so a warmed `node_modules` in the cache volume (keyed by lockfile hash) would turn the 158 s into seconds. pnpm's `enable-global-virtual-store` made no difference (23 s on the Mac either way).

## 4. exec, stdin, streaming, delete mid-run

Same on all three hosts:

- 1.4 MB piped into `sandbox exec` arrives intact (byte count and SHA-256 match) in 0.05–0.08 s. Documented limits: 4 MiB piped stdin, 256 KiB of command arguments; larger prompts go through `sandbox upload`.
- stdout streams line by line: lines emitted 0.5 s apart arrive 0.5 s apart with 10–40 ms latency, no buffering until exit.
- The command's exit code is propagated (`exit 7` gives 7).
- `sandbox delete` during a running exec: the exec returns 0.13–0.26 s after the delete is issued with exit 143, the lines produced so far were delivered, and the sandbox is gone from the list within 0.3 s. Delete is the kill switch the limits ticket assumes.

## 5. Volume mounts and the bind-mount defect

- A named volume passed through `--driver-config-json` mounts **read-only by default** (`ext4 ro` in `/proc/mounts`; `touch` fails with "Read-only file system") on Docker Desktop and Docker Engine alike. `read_only: false` mounts it `rw`; writes then depend on ownership, since the volume's files are root-owned and the sandbox runs as uid 1000.
- Resource admission works: a volume without the `openshell.ai/sandbox-attachable=true` and `openshell.ai/sandbox-attachable-workspace=<workspace>` labels is refused ("external resource not admitted by required labels"). Driver config needs `allow_driver_config = true` in the gateway's docker table.
- Bind mounts are refused unless `enable_bind_mounts = true` and admission is disabled, so the Docker Desktop VirtioFS defect is never reached: the design uses only named volumes.
- Landlock enforced on all three hosts under `hard_requirement` (writing `/etc` inside the sandbox is denied, the workdir is writable).

## Things the runner has to get right (found the hard way)

1. **Docker Desktop needs `supervisor_network_mode = "bridge"`.** In the default host mode the supervisor container cannot reach the gateway on 127.0.0.1 (that is the Desktop VM's loopback), and every create fails with `ControlSupervisorStartFailed` after 12 s of retries. Linux hosts work in host mode.
2. **The sandbox's HOME is the workdir** (`/sandbox`), not the image user's home. Anything warmed into a per-user cache at image build time (pnpm store and offline metadata, corepack) is invisible until HOME or the tool's cache path is pointed at it. The spike exports `HOME=/home/ubuntu` in the run script; the images ticket should put caches at absolute paths.
3. **No implicit network.** The default policy denies all egress, so every run-time download fails with `EACCES`. corepack fetching pnpm and Prisma fetching its query engine both bit; the fix was installing pnpm with npm at build time and one network rule for `binaries.prisma.sh` bound to `/usr/local/bin/node`. The sandboxed-lane brief should say that a download is a policy rule or a bake-time step, never a surprise.
4. **Volumes mount read-only unless asked otherwise**, and the mirror volume should stay that way during runs.
5. **`git clone --local` cannot hardlink** across the volume boundary; use `--shared` or a copy.
6. **Installing OpenShell on macOS** is a Homebrew formula staged into a local `nvidia/openshell` tap (the upstream installer does exactly this and then starts a `brew services` job). The gateway can also run without launchd through its libexec wrapper with `OPENSHELL_GATEWAY_CONFIG` pointing at a TOML file, which is how this spike ran it.

## Recommendations

- Proceed with the per-run shape (CREW-2793); no change to decision 2 of the grill.
- CREW-2799 (cache volume): besides bare mirrors, keep a warmed dependency tree per route keyed by lockfile hash, copied into the checkout at run start. This is the only thing that moves the cloud number.
- TABL-2790 (instance classes): a 4-vCPU class spends about three minutes per run on setup for a repository like synthesis; size the "small" class with that in mind or make the warmed tree mandatory for managed ships.
- CREW-2801 (policy generation): the generated policy must carry the toolchain's known download hosts as rules.
- CREW-2794 (images): caches at absolute paths, pnpm installed with npm rather than corepack, uid 1000 is the base image's `ubuntu`.
