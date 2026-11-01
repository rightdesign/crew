#!/bin/bash
# CREW-2787 spike host: Ubuntu 24.04 arm64 + Docker Engine from Docker's apt repository.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io
usermod -aG docker ubuntu
loginctl enable-linger ubuntu
docker version --format '{{.Server.Version}}' > /var/tmp/docker-version
touch /var/tmp/userdata-done
