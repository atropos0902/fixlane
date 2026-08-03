# check: runs a repository's tests. agent: the same, plus the agent tools.
FROM node:24.15.0-bookworm-slim AS check
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps tini && rm -rf /var/lib/apt/lists/*
# A program that can be run but not read is not dumpable, so the kernel keeps its /proc/<pid>/fd from other
# processes of the same user. Without this, tests write results of their own into the runner's output.
RUN chmod 0711 /usr/local/bin/node /usr/bin/tini
COPY check /opt/check
WORKDIR /work

FROM check AS agent
WORKDIR /opt/runner
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY runner ./
WORKDIR /work
CMD ["node", "/opt/runner/main.ts"]
