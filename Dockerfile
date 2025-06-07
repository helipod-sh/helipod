# syntax=docker/dockerfile:1.7
# Stackbase Tier 0 — single-container self-host. Follows the official Turborepo Docker
# pattern (prune → cached install → build → slim non-root runner), Bun-native.
# Ref: https://github.com/vercel/turborepo/tree/main/examples/with-docker

ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

# ---- prepare: prune the workspace to @stackbase/cli (the server/engine) + its deps ----
# `turbo prune --docker` splits the result into:
#   out/json  — manifests + bun.lock  → a dependency-install layer cached until manifests change
#   out/full  — source                → the build layer
# The dashboard SPA is pulled in because @stackbase/cli depends on @stackbase/dashboard.
FROM base AS prepare
COPY . .
RUN bunx turbo prune @stackbase/cli --docker

# ---- builder: install only the pruned deps (cached unless manifests change), then build ----
FROM base AS builder
COPY --from=prepare /app/out/json/ .
RUN bun install --frozen-lockfile
COPY --from=prepare /app/out/full/ .
# `turbo prune` does not copy root-level shared config files; every package's tsconfig does
# `"extends": "../../tsconfig.base.json"`, so the DTS build needs it present at the root.
COPY tsconfig.base.json ./tsconfig.base.json
RUN bun run build

# ---- runner: slim, non-root (the oven/bun image ships a `bun` user, uid 1000) ----
FROM base AS runner
ENV NODE_ENV=production \
    STACKBASE_DATA_DIR=/data
COPY --from=builder --chown=bun:bun /app .
USER bun
# Embedded SQLite database lives on a single mounted volume.
VOLUME ["/data"]
EXPOSE 3000
# NOTE: the production server entrypoint (`stackbase serve`) arrives at milestone M7/M9.
# The CLI is built at packages/cli/dist/bin.js — run it directly until then, e.g.:
#   docker run -v $PWD:/app/project stackbase \
#     bun packages/cli/dist/bin.js dev --dir project/convex --ip 0.0.0.0 --port 3000
CMD ["bun", "-e", "console.log('Stackbase image built (Turborepo-pruned, Bun). Production `serve` entrypoint arrives at M7/M9; until then run packages/cli/dist/bin.js directly.')"]
