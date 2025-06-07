# syntax=docker/dockerfile:1.7
# Stackbase Tier 0 — single-container, single-volume (embedded SQLite).
# Multi-stage: install → build → slim runtime. Bun-native (Bun is the primary runtime).

FROM oven/bun:1.3 AS base
ENV CI=true
WORKDIR /app

# ---- build: install all workspace deps and build every package ----
FROM base AS build
COPY . .
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile
RUN bun run build

# ---- runtime: the Tier 0 server image ----
FROM base AS runtime
ENV NODE_ENV=production \
    STACKBASE_DATA_DIR=/data
COPY --from=build /app /app
# Embedded SQLite database lives on a single mounted volume.
VOLUME ["/data"]
EXPOSE 3000
# NOTE: the real server entrypoint arrives at milestone M7/M9 (`@stackbase/cli serve`).
# Until then this image builds the workspace and prints guidance on `docker run`.
CMD ["bun", "-e", "console.log('Stackbase image built. Server entrypoint arrives at milestone M7/M9 (@stackbase/cli serve).')"]
