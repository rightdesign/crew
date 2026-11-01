# Layer 3 of 3 (CREW-2787 spike): the synthesis repo layer on the crew layer.
# pnpm with a pre-fetched store for the lockfile, PostgreSQL 16 with an
# initialised cluster owned by the sandbox user, and the in-sandbox run script.
FROM crew2787/crew:latest
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.22.0 && pnpm --version
RUN install -d -o 1000 -g 1000 /opt/pnpm-store /var/lib/pg-synthesis /run/postgresql /opt/spike
COPY --chown=1000:1000 pnpm-lock.yaml pnpm-workspace.yaml .npmrc /opt/spike/
USER 1000
ENV PNPM_HOME=/home/ubuntu/.local/share/pnpm PATH=/home/ubuntu/.local/share/pnpm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN printf "store-dir=/opt/pnpm-store\n" >> /home/ubuntu/.npmrc
WORKDIR /opt/spike
RUN pnpm fetch
RUN /usr/lib/postgresql/16/bin/initdb -D /var/lib/pg-synthesis -U synthesis --auth=trust >/dev/null \
 && /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/pg-synthesis -o "-k /run/postgresql -c listen_addresses=127.0.0.1" -w start \
 && createdb -h /run/postgresql -U synthesis synthesis \
 && createdb -h /run/postgresql -U synthesis synthesis_test \
 && /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/pg-synthesis -w stop
ARG REPO_LAYER_REV=1
RUN echo "$REPO_LAYER_REV" > /opt/spike/layer-rev
COPY --chmod=0755 spike-run /usr/local/bin/spike-run
WORKDIR /sandbox
