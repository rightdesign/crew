# Layer 2 of 3 (CREW-2787 spike): the crew layer on the OpenShell base.
# Node + git + the crew CLI + a credential-helper stub; non-root `sandbox` user.
FROM nvcr.io/nvidia/base/ubuntu:24.04
ARG NODE_VERSION=24.19.0
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils openssh-client \
 && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in arm64) NODE_ARCH=arm64 ;; amd64) NODE_ARCH=x64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
 && node --version
RUN npm install -g @tablation/crew && crew --version
COPY crew-credential-stub /usr/local/bin/crew-credential-stub
RUN chmod 0755 /usr/local/bin/crew-credential-stub \
 && git config --system credential.helper /usr/local/bin/crew-credential-stub \
 && git config --system safe.directory '*'
RUN (getent passwd 1000 >/dev/null || useradd --uid 1000 --create-home --shell /bin/bash sandbox) \
 && install -d -o 1000 -g 1000 /sandbox
WORKDIR /sandbox
USER 1000
