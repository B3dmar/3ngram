# Production image for @3ngram/server (REST API + MCP server), the one v1
# deployable. Build context MUST be the repo root (the build needs the workspace
# manifests + lockfile + sources of every workspace dependency), e.g.:
#   docker build -f apps/server/Dockerfile -t 3ngram-server .
# On Railway: Builder = DOCKERFILE, Root Directory = repo root (blank),
# Dockerfile Path = apps/server/Dockerfile. See the PR body for the full setting
# list. The packaged @3ngram/db migrator is available for release automation,
# but migrations are not part of the served process.

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

# ---- builder: full install, build the server + its workspace deps --------------
FROM base AS builder
# NO `npm_config_ignore_scripts` here, deliberately. It suppresses every
# dependency lifecycle script, which also disables the `strictDepBuilds`
# tripwire — the thing that FAILS the install when a dependency gains an
# undeclared build script. AGENTS.md hard rule 7 bans `ignoreScripts` for exactly
# that reason: with it set, this image would build green through the supply-chain
# gate. (The old comment claimed this matched the committed .npmrc; pnpm 11 reads
# only auth/registry from .npmrc — the policy lives in pnpm-workspace.yaml.)
# pnpm fetch + filtered install would need per-package manifests staged first;
# the simplest correct path for a turbo monorepo is to copy the whole context
# (the .dockerignore keeps it lean) and run a frozen install once.
COPY . .
RUN pnpm install --frozen-lockfile
# Build apps/server and ITS workspace deps in dependency order (turbo ^build).
RUN pnpm --filter @3ngram/server... build
# Produce a self-contained, prod-only deployment of the server: pnpm deploy
# resolves the workspace graph, copies each dep's published `files` (dist/) and
# rewrites workspace: links into a flat node_modules. --prod strips devDeps.
RUN pnpm deploy --filter=@3ngram/server --prod --legacy /app

# ---- migrations: one-shot init image for self-host (compose profile `init`) ----
# Reuses the builder (full deps incl. drizzle-kit + repo sources) and adds the
# psql client so a single container can run `pnpm db:migrate` then apply
# scripts/provision-roles.sql. Never part of the served deployable — the prod
# runner below copies nothing from here, so psql does not bloat the v1 image.
FROM builder AS migrations
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# ---- runner: minimal runtime, non-root, dist + prod node_modules only ----------
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production
# The official Node image bundles npm for developer ergonomics, but the runtime
# starts the already-built server with `node` and never invokes npm/npx. Remove
# that unused package-manager tree from the final image so vulnerabilities in
# npm's own transitive tooling cannot expand the production attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
# The server binds env.PORT (packages/config default 3000) on all interfaces
# (Express default host = 0.0.0.0), so Railway's injected PORT is honored.
ENV PORT=3000
WORKDIR /app
LABEL org.opencontainers.image.title="3ngram server" \
  org.opencontainers.image.description="Persistent, typed memory for AI agents" \
  org.opencontainers.image.source="https://github.com/B3dmar/3ngram" \
  org.opencontainers.image.documentation="https://docs.3ngram.ai/container-image" \
  org.opencontainers.image.vendor="B3dmar ApS" \
  org.opencontainers.image.licenses="Apache-2.0"
# node:*-slim ships a non-root `node` user (uid 1000). Run as it.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
# Redistributable images must carry the Apache license and attribution even
# though the runtime itself contains only the deployed server closure.
COPY --from=builder --chown=node:node /repo/LICENSE /usr/share/licenses/3ngram/LICENSE
COPY --from=builder --chown=node:node /repo/NOTICE /usr/share/licenses/3ngram/NOTICE
USER node
EXPOSE 3000
# Liveness probe against the server's own /health route (apps/server health.ts),
# using Node so the image needs no extra curl/wget. Honors $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
