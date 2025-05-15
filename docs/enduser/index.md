---
title: Stackbase Documentation
description: Convex-compatible runtime for Docker, Bun, Node.js, and Cloudflare — self-hosted, multi-runtime, with local devtools.
---

# Stackbase Documentation

> **Stackbase** is a Convex-compatible runtime you can self-host anywhere. Write your backend functions exactly like Convex (queries, mutations, actions in a `convex/` folder, `import { v } from "convex/values"`), then run them on **Docker**, **Bun**, **Node.js**, or **Cloudflare Workers** — no managed-cloud lock-in.

Stackbase is **100% API compatible with Convex**. Existing Convex apps run unchanged; you keep the DX (reactive queries, transactional mutations, typed generated client) and own the infrastructure.

> These docs are derived from the original concave.dev documentation and rebranded for Stackbase. The Convex compatibility surface (the `convex/` directory, `convex/server`, `convex/values`, `_generated`, and links to the official Convex docs) is intentionally preserved — that compatibility is the whole point.

## Start here

- [Quickstart](/quickstart) — install the CLI, init a project, run your first function, deploy.

## Build

- [Backend Functions](/build/backend-functions) — queries, mutations, actions (identical to Convex).
- [Schema & Data Models](/build/schema) — define tables and indexes.
- [Realtime & Sync](/build/realtime-caching) — reactive queries, the sync protocol, caching.
- [Data Storage & Search](/build/data-search) — the document store, file storage, vector/full-text search.
- [Authentication](/build/auth) — auth integration.
- [Testing](/build/testing) — unit and end-to-end testing strategies.

## Local development

- [Dev Server](/local/dev-server) — runtime options (`--node`, `--bun`, `--cf`) and CLI commands.
- [Dashboard](/local/dashboard) — browse data and run functions at `/_dashboard`.
- [DevTools](/local/devtools) — browser extension for debugging.

## Configure

- [Configuration & Extensibility](/configure/configuration) — `stackbase.config.ts`, using Stackbase as a library, custom adapters.

## Deploy

- [Self-Hosted](/deploy/self-hosted) — Docker, Railway, Fly.io. **The baseline deployment story.**
- [Cloudflare](/deploy/cloudflare) — Workers + D1/R2/Vectorize.
- [Standalone Binary](/deploy/standalone-binary) — single-file builds for Linux/macOS/Windows.
- [Scaling Blueprint](/deploy/scaling) — multi-region topology and sharding.
- Desktop bundling: [Electron](/deploy/electron) · [Electrobun](/deploy/electrobun) · [Tauri](/deploy/tauri).

## Reference

- [API Compatibility](/reference/api) — the supported API surface.
- [Convex Compatibility](/reference/compatibility) — what matches Convex and what differs.

---

## How this maps to the build

The product surface documented here is the **target**. Implementation is being built in slices (see the repo `CLAUDE.md` for the locked decisions and build order). The pluggable storage model described in [Configuration](/configure/configuration) is how Stackbase keeps the engine database-agnostic — SQLite for zero-config local/single-node, Postgres for scalable self-host, D1/R2 on Cloudflare — without the engine ever importing a driver directly.
