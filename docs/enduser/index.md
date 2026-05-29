---
title: Stackbase Documentation
description: Convex-compatible runtime for Docker, Bun, and Node.js — self-hosted, multi-runtime, no cloud lock-in.
---

# Stackbase Documentation

> **Stackbase** is a Convex-compatible runtime you can self-host anywhere. Write your backend functions like Convex (queries, mutations, actions in a `convex/` folder), using Stackbase's native `@stackbase/*` imports (`import { v } from "@stackbase/values"`), then run them on **Docker**, **Bun**, or **Node.js** — no managed-cloud lock-in.

Stackbase's API is **Convex-compatible in shape** — reactive queries, transactional mutations, typed generated client — but its canonical imports are native `@stackbase/*`, not `convex/*`. Bring an existing Convex app across with **`stackbase migrate`**, which rewrites its imports for you; you keep the DX and own the infrastructure.

> These docs are derived from the original concave.dev documentation and rebranded for Stackbase. The `convex/` directory layout and `_generated` output are intentionally preserved (and pages still link to the official Convex docs for API-shape reference), but the import surface is native — Stackbase code imports from `@stackbase/*`, not `convex/server`/`convex/values`. Migrating an existing Convex app is a `stackbase migrate` run, not a drop-in import swap — that on-ramp is the compatibility story.

## ⚠️ Implementation status (read this first)

These pages describe the **target product surface** (inherited from the concave reference). The
current build is the **Foundation slice (Tier 0)** — a single self-hosted process with embedded
SQLite. Not everything below is built yet. Honest status:

| Area | Status |
|---|---|
| Schema, queries, mutations, validators (`v`), generated types (`Doc`/`Id`/`api`) | ✅ Built |
| Reactive `useQuery`/`useMutation` (React), client SDK, loopback + WebSocket transport | ✅ Built |
| `stackbase dev` (codegen, hot reload, dashboard, HTTP `/api/run`) | ✅ Built |
| Embedded SQLite storage (MVCC), single-writer OCC, cursor pagination | ✅ Built |
| Self-host via Docker (single binary), runs on Bun (primary) + Node | ✅ Built (Tier 0) |
| **Actions**, scheduled functions / **crons**, `httpAction` + HTTP router | ✅ Built |
| **File storage** (blob) — `ctx.storage`, fs + S3-compatible backends | ✅ Built |
| Postgres storage adapter, **standalone binary** (`stackbase build`), `stackbase deploy` | ✅ Built |
| **`stackbase deploy --target cloudflare`** (Durable-Object-native, `wrangler deploy`) | ✅ Built — see [Cloudflare](/deploy/cloudflare). |
| Cloudflare via **Containers + R2** (hand-wired, portable `serve` image) | ⚠️ Experimental — works, but scheduled functions/crons/triggers **do not fire**. See [Cloudflare via Containers](/deploy/cloudflare-containers). |
| **Auth** | 🟡 Partial — session core built; not fully documented here yet |
| **Full-text & vector search** | 🚧 Planned (adapter seams reserved) |
| **Desktop bundling** (Electron/Tauri/Electrobun) | 🚧 Planned — the [standalone binary](/deploy/standalone-binary) is the real path today |

> **🚧 How to tell roadmap from product.** Some pages describe the **intended** design rather than
> what ships today — the vision is real, but the API may not exist yet. Every such page or section
> is marked with a **`status: planned`** frontmatter field and a **"🚧 Planned — not yet shipped"**
> banner at the top. If you don't see that banner, the page describes shipped behavior you can run
> today.
>
> Two things worth knowing up front, because they recur across the planned pages: **there is no
> `createStackbase` API** (the entrypoints are the `stackbase dev` / `stackbase serve` CLI), and
> **the only runtime package is `@stackbase/runtime-embedded`** (no
> `@stackbase/runtime-{bun,node,cf,cloud}`).

The reactive core (Build + Local development) is real and runnable — see
[`examples/chat`](../../examples/chat).

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

- [Dev Server](/local/dev-server) — `stackbase dev` and CLI commands. (Runtime is auto-detected; there are no `--node`/`--bun`/`--cf` flags.)
- [Vite Plugin](/local/vite-plugin) — `@stackbase/vite`: run your Vite frontend and Stackbase backend on one origin with a single `vite` command.
- [Dashboard](/local/dashboard) — browse data and run functions at `/_dashboard`.
- [DevTools](/local/devtools) — browser extension for debugging.

## Configure

- [Configuration & Extensibility](/configure/configuration) — `stackbase.config.ts`, using Stackbase as a library, custom adapters.

## Deploy

- [Self-Hosted](/deploy/self-hosted) — Docker, Railway, Fly.io. **The baseline deployment story.**
- [Standalone Binary](/deploy/standalone-binary) — single-file builds for Linux/macOS/Windows.
- [Deploy Targets](/deploy/targets) — the multi-provider `stackbase deploy --target/--env` seam.
- [Cloudflare](/deploy/cloudflare) — `stackbase deploy --target cloudflare`, the Durable-Object-native host. Scheduler/crons/triggers work here.
- [Cloudflare via Containers](/deploy/cloudflare-containers) — the alternative hand-wired path (portable `serve` image in a Container). **Experimental**, with a scheduler gap.
- [GitHub Actions](/deploy/ci-github-actions) — a copy-paste CI deploy workflow.
- [Scaling Blueprint](/deploy/scaling) — multi-region topology and sharding.
- Desktop bundling: [Electron](/deploy/electron) · [Electrobun](/deploy/electrobun) · [Tauri](/deploy/tauri).

## Reference

- [API Compatibility](/reference/api) — the supported API surface.
- [Convex Compatibility](/reference/compatibility) — what matches Convex and what differs.

---

## How this maps to the build

The product surface documented here is the **target**. Implementation is being built in slices (see the repo `CLAUDE.md` for the locked decisions and build order). The pluggable storage model is how Stackbase keeps the engine database-agnostic — SQLite for zero-config local/single-node, Postgres for scalable self-host, S3-compatible object storage (including R2) as a substrate — without the engine ever importing a driver directly. Backends are selected by CLI flag or environment variable (`--database-url`, `--object-store`, `--storage-bucket`), not by composing adapters in application code.
