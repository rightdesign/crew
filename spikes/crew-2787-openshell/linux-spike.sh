#!/bin/bash
# CREW-2787: Linux half of the spike. Runs on a Docker Engine host as the
# ordinary user, with /tmp/spike holding ctx-crew, ctx-repo, policy.yaml and
# mirror.tgz. Installs OpenShell from the release .deb if missing, then takes
# the same measurements as the Mac side.
set -uo pipefail
cd /tmp/spike
T() { /usr/bin/time -f "real %e" "$@"; }
echo "### host: $(uname -r) $(grep PRETTY /etc/os-release) docker=$(docker version --format '{{.Server.Version}}') nproc=$(nproc)"
if ! command -v openshell >/dev/null; then
  mkdir -p dl && cd dl
  curl -fLsS -O https://github.com/NVIDIA/OpenShell/releases/download/v0.1.6/openshell_0.1.6-1_arm64.deb
  curl -fLsS -O https://github.com/NVIDIA/OpenShell/releases/download/v0.1.6/openshell-checksums-sha256.txt
  grep openshell_0.1.6-1_arm64.deb openshell-checksums-sha256.txt | sha256sum -c - || exit 1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ./openshell_0.1.6-1_arm64.deb >/tmp/spike/deb-install.log 2>&1 || { tail -5 /tmp/spike/deb-install.log; exit 1; }
  cd /tmp/spike
  mkdir -p ~/.config/openshell
  printf '[openshell]\nversion = 2\n\n[openshell.gateway]\ncompute_driver = "docker"\n\n[openshell.drivers.docker]\nallow_driver_config = true\n' > ~/.config/openshell/gateway.toml
  echo "OPENSHELL_TELEMETRY_ENABLED=false" > ~/.config/openshell/gateway.env
  systemctl --user daemon-reload; systemctl --user enable --now openshell-gateway
  for i in $(seq 1 30); do curl -sk https://127.0.0.1:17670/ -o /dev/null && break; sleep 1; done
  openshell gateway add https://127.0.0.1:17670 --local --name openshell 2>&1 | tail -1
fi
echo "### openshell $(openshell --version) / $(NO_COLOR=1 openshell status 2>&1 | grep -E 'Status:' | xargs)"
echo "== base image pull"; docker image rm -f nvcr.io/nvidia/base/ubuntu:24.04 >/dev/null 2>&1; T docker pull -q nvcr.io/nvidia/base/ubuntu:24.04 2>&1 | tail -1
echo "== crew layer build"; T docker build --no-cache -q -t crew2787/crew:latest ctx-crew 2>&1 | tail -1
echo "== repo layer build"; T docker build --no-cache -q -t crew2787/repo:latest ctx-repo 2>&1 | tail -1
echo "== repo layer rebuild, trailing step only"; T docker build -q --build-arg REPO_LAYER_REV=2 -t crew2787/repo:latest ctx-repo 2>&1 | tail -1
echo "== repo layer rebuild, lockfile touched"; printf '\n# spike rev 2\n' >> ctx-repo/pnpm-lock.yaml; T docker build -q --build-arg REPO_LAYER_REV=3 -t crew2787/repo:latest ctx-repo 2>&1 | tail -1
docker image ls --format "{{.Repository}}:{{.Tag}} {{.Size}}" | grep -E "crew2787|nvcr"
echo "== cache volume: restore synthesis mirror from tarball"
docker volume create --label openshell.ai/sandbox-attachable=true --label openshell.ai/sandbox-attachable-workspace=default crew2787-cache >/dev/null
docker run --rm -i -v crew2787-cache:/cache alpine tar xzf - -C /cache < mirror.tgz
echo "== mirror clone + refresh timing from GitHub, public repo stand-in (NVIDIA/OpenShell, no token on this host)"
T docker run --rm -v crew2787-cache:/cache alpine/git clone --quiet --mirror https://github.com/NVIDIA/OpenShell.git /cache/openshell.git 2>&1 | tail -1
T docker run --rm -v crew2787-cache:/cache -w /cache/openshell.git alpine/git remote update --prune 2>&1 | tail -1
docker run --rm -v crew2787-cache:/cache alpine/git -c safe.directory='*' -C /cache/openshell.git count-objects -vH | grep size-pack
echo "== probe sandbox: cold create (runtime images not pulled)"
T openshell sandbox create --name probe --policy policy.yaml --detach -- sleep 3600 2>&1 | grep -E 'real|Error|error' 
echo "== probe sandbox: warm create"
T openshell sandbox create --name probe2 --policy policy.yaml --detach -- sleep 3600 2>&1 | grep -E 'real|Error|error'
echo "== enforcement, stdin, streaming, exit code"
openshell sandbox exec -n probe --no-login-shell -- sh -c 'id -u; touch /etc/x 2>&1; echo "write /etc exit=$?"; touch /sandbox/ok && echo "write workdir ok"' </dev/null
head -c 1048576 /dev/urandom | base64 > prompt.txt; echo "local: $(wc -c < prompt.txt) $(sha256sum prompt.txt | cut -c1-16)"
T sh -c 'openshell sandbox exec -n probe --no-login-shell -- sh -c "cat > /sandbox/p; wc -c < /sandbox/p; sha256sum /sandbox/p | cut -c1-16" < prompt.txt' 2>&1
openshell sandbox exec -n probe --no-login-shell -- sh -c 'for i in 1 2 3 4 5; do echo line $i; sleep 0.5; done' </dev/null | python3 -u -c 'import sys,time; t0=time.time()
for l in sys.stdin: print(f"{time.time()-t0:5.2f}s {l.strip()}")'
openshell sandbox exec -n probe --no-login-shell -- sh -c 'exit 7' </dev/null; echo "exit=$?"
echo "== delete mid-run"
( openshell sandbox exec -n probe2 --no-login-shell -- sh -c 'i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.5; done' </dev/null > midrun.out 2>midrun.err; echo "exec exit=$?" ) & P=$!; sleep 3; T0=$(date +%s.%N); openshell sandbox delete probe2 | tail -1; wait $P; echo "exec returned $(awk -v a=$(date +%s.%N) -v b=$T0 'BEGIN{printf "%.2f", a-b}')s after delete; lines=$(wc -l < midrun.out)"
echo "== volume mounts: read-only default, read_only:false, unlabeled refused"
M='{"docker":{"mounts":[{"type":"volume","source":"crew2787-cache","target":"/cache"}]}}'
openshell sandbox create --name m1 --policy policy.yaml --detach --driver-config-json "$M" -- sleep 600 2>&1 | grep -E 'Error' ; openshell sandbox exec -n m1 --no-login-shell -- sh -c 'grep " /cache " /proc/mounts | cut -d" " -f1-4; touch /cache/x 2>&1' </dev/null
openshell sandbox create --name m2 --policy policy.yaml --detach --driver-config-json '{"docker":{"mounts":[{"type":"volume","source":"crew2787-cache","target":"/cache","read_only":false}]}}' -- sleep 600 2>&1 | grep -E 'Error'; openshell sandbox exec -n m2 --no-login-shell -- sh -c 'grep " /cache " /proc/mounts | cut -d" " -f1-4; touch /cache/x 2>&1; rm -f /cache/x' </dev/null
docker volume create unl >/dev/null; openshell sandbox create --name m3 --policy policy.yaml --detach --driver-config-json '{"docker":{"mounts":[{"type":"volume","source":"unl","target":"/cache"}]}}' -- sleep 600 2>&1 | grep -E 'not admitted|Error' | head -2; docker volume rm unl >/dev/null
openshell sandbox delete probe m1 m2 >/dev/null 2>&1
for MODE in shared copy; do
  echo "=== per-run sandbox, clone --$MODE"
  T0=$(date +%s.%N); openshell sandbox create --name run-$MODE --policy policy.yaml --detach --driver-config-json "$M" --from crew2787/repo:latest -- sleep 7200 2>&1 | grep -E 'Error'; T1=$(date +%s.%N)
  echo "create->Ready $(awk -v a=$T1 -v b=$T0 'BEGIN{printf "%.2f", a-b}')s"
  openshell sandbox exec -n run-$MODE --no-login-shell -- spike-run $MODE </dev/null > run-$MODE.out 2>&1; echo "exec exit=$?"
  grep -E '^STEP|^DONE|^  .git|fatal|Error|error|EACCES|ERR_' run-$MODE.out | head -20
  T2=$(date +%s.%N); openshell sandbox delete run-$MODE >/dev/null 2>&1; T3=$(date +%s.%N)
  echo "delete $(awk -v a=$T3 -v b=$T2 'BEGIN{printf "%.2f", a-b}')s; whole cycle $(awk -v a=$T3 -v b=$T0 'BEGIN{printf "%.2f", a-b}')s"
done
echo "### done"
