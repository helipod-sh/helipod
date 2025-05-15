# syntax=docker/dockerfile:1.7
# Stackbase Tier 0 — single-container, single-volume (embedded SQLite).
# Multi-stage: install → build → slim runtime.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true
RUN corepack enable
WORKDIR /app

# ---- build: install all workspace deps and build every package ----
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

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
CMD ["node", "-e", "console.log('Stackbase image built. Server entrypoint arrives at milestone M7/M9 (@stackbase/cli serve).')"]
