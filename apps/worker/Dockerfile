# Production image for @3ngram/worker (BullMQ background jobs: consolidation
# proposals, surfacing/overdue, OAuth-client GC, the session lease-expiry sweep
# and the resolve-only session closer). Build context MUST be the repo root (the
# build needs the workspace manifests + lockfile + sources of every workspace
# dependency), e.g.:
#   docker build -f apps/worker/Dockerfile -t 3ngram-worker .
#
# Deliberately a near-copy of apps/server/Dockerfile: same pinned base, same
# builder + pnpm deploy shape, same non-root runner and license layout, so the
# two deployables cannot drift in supply-chain posture. The differences are
# exactly three, and each is a property of the worker rather than a preference:
#   - no `migrations` stage (schema management stays the server image's job, so
#     self-host still has ONE migrator and cannot race two)
#   - no EXPOSE and no PORT (the worker serves no HTTP; it dials out to Postgres
#     and Redis)
#   - a process-liveness HEALTHCHECK instead of an HTTP probe (see below)

# ---- base: pin Node + pnpm once, reuse in every stage --------------------------
# Pin the multi-platform OCI index (linux/amd64 + linux/arm64) so builds cannot
# silently pick up a newly-published base image. Renovate updates this digest.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Activate the exact pnpm the repo pins (packageManager: pnpm@11.9.0).
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /repo

# ---- builder: full install, build the worker + its workspace deps ---------------
FROM base AS builder
# NO `npm_config_ignore_scripts` here, deliberately. It suppresses every
# dependency lifecycle script, which also disables the `strictDepBuilds`
# tripwire — the thing that FAILS the install when a dependency gains an
# undeclared build script. AGENTS.md hard rule 7 bans `ignoreScripts` for exactly
# that reason: with it set, this image would build green through the supply-chain
# check the repo relies on. The committed `.npmrc` + `pnpm-workspace.yaml`
# (`strictDepBuilds` / `onlyBuiltDependencies`) are the policy, and they are
# copied in with the context below.
COPY . .
RUN pnpm install --frozen-lockfile
# Build apps/worker and ITS workspace deps in dependency order (turbo ^build).
RUN pnpm --filter @3ngram/worker... build
# Produce a self-contained, prod-only deployment of the worker: pnpm deploy
# resolves the workspace graph, copies each dep's published `files` (dist/) and
# rewrites workspace: links into a flat node_modules. --prod strips devDeps.
RUN pnpm deploy --filter=@3ngram/worker --prod --legacy /app

# ---- runner: minimal runtime, non-root, dist + prod node_modules only ----------
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production
# The official Node image bundles npm for developer ergonomics, but the runtime
# starts the already-built worker with `node` and never invokes npm/npx. Remove
# that unused package-manager tree from the final image so vulnerabilities in
# npm's own transitive tooling cannot expand the production attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
LABEL org.opencontainers.image.title="3ngram worker" \
  org.opencontainers.image.description="Background jobs for 3ngram: consolidation proposals, surfacing, and the session closer" \
  org.opencontainers.image.source="https://github.com/B3dmar/3ngram" \
  org.opencontainers.image.documentation="https://docs.3ngram.ai/container-image" \
  org.opencontainers.image.vendor="B3dmar ApS" \
  org.opencontainers.image.licenses="Apache-2.0"
# node:*-slim ships a non-root `node` user (uid 1000). Run as it.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
# Redistributable images must carry the Apache license and attribution even
# though the runtime itself contains only the deployed worker closure.
COPY --from=builder --chown=node:node /repo/LICENSE /usr/share/licenses/3ngram/LICENSE
COPY --from=builder --chown=node:node /repo/NOTICE /usr/share/licenses/3ngram/NOTICE
USER node
# The worker has no HTTP surface to probe. It also has no degraded mode: a
# missing REDIS_URL is a hard boot failure and a lost connection surfaces as a
# BullMQ failure, so "pid 1 is still alive" IS the liveness signal — the process
# exits rather than idling broken. Probing Redis from here instead would report
# the broker's health as the worker's, which is a different question.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "process.exit(0)"
CMD ["node", "dist/index.js"]
