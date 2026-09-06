# Test image for the local pre-PR E2E gate. See docs/local-e2e-design.md.
#
# Deliberately pinned to the supported Node floor rather than `node:lts`: running the
# suite on the oldest release we claim to support is what catches syntax or runtime
# usage that quietly requires a newer engine. CI owns the newer matrix entry.
FROM node:22.18.0-bookworm-slim

# The slim base ships no git, and Mercury's default `git-worktree` workspace mode
# cannot run without it. Nothing else is installed.
RUN apt-get update  && apt-get install -y --no-install-recommends git ca-certificates  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer first: it is invalidated by manifest changes only, so editing a
# source file does not re-run `npm ci`.
#
# `--ignore-scripts` is required, not an optimization. package.json has a `prepare`
# script that compiles client and server, and npm runs `prepare` automatically at the
# end of `npm ci` -- before any source exists in this layer, so it would fail. The
# build is run explicitly after the source copy instead.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY --chown=node:node . .

# `npm ci` above ran as root, so /app and its node_modules are root-owned; the build
# below runs as the service user and must be able to create /app/dist.
RUN chown -R node:node /app

# Build `dist/` exactly as a production install would.
USER node
RUN npm run prepare

# Runtime state (SQLite, fixture repository, workspaces) lives on a named volume
# mounted at this exact path in every service container, so a workspace path written
# by one process resolves identically in all of them.
USER root
RUN mkdir -p /state && chown node:node /state
USER node

EXPOSE 3000
CMD ["node", "src/cli.ts", "server"]
