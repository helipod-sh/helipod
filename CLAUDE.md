# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**stackbase** — an open-source, self-hostable Backend-as-a-Service in the spirit of [Convex](https://github.com/get-convex/convex-backend). The goal: write TypeScript query/mutation functions, have them run server-side and transactionally, and get **reactive** results — when underlying data changes, subscribed clients are pushed updates over a WebSocket. Convex-grade DX, easy self-hosting, no vendor lock-in.

It is loosely inspired by a now-defunct project, "concave.dev." There is **no recoverable concave source or published package** (the original author's npm/GitHub are gone, and nothing is findable). So this is **not a literal fork** — it is a clean-room build using Convex's open, well-documented architecture as the reference. Do not claim to be reverse-engineering concave; there is no artifact to reverse-engineer.

## Status: Foundation slice BUILT (M0–M11 ✅)

The reactive engine is implemented and working end-to-end: 14 packages under `packages/`, a runnable example under `examples/chat`, **131 passing tests**, build/typecheck green, on both Node and Bun. `bun install`, `bun run build`, `bun run test`, `bun run typecheck` all work (Bun is the package manager + runtime; Turborepo orchestrates; vitest runs under Bun). The commands and package layout below are now **real**, not aspirational.

What works: MVCC SQLite storage · single-writer OCC transactor · query engine with cursor pagination · isolate-safe syscall executor · reactive sync tier (subscribe→write→push) · embedded runtime + loopback/WebSocket transports · codegen (typed `Doc`/`Id`/`api` that compiles) · `stackbase dev` CLI (HTTP + hot reload) · client SDK with `useQuery`/`useMutation` · the `examples/chat` app (reactive, shard-key, pagination, ephemeral typing) · **dashboard** (`apps/dashboard`) with a **live** data browser (admin sync subscriptions — `_admin:browseTable`, cursor pagination, structured filter UI, scanCapped banner), logs viewer, and function runner · **`@stackbase/scheduler`** (component, opt-in per project via `stackbase.config.ts` — there is no auto-install/`init` command; `examples/auth-demo/stackbase.config.ts` shows the reference pattern — Convex-parity `ctx.scheduler.runAfter`/`runAt`/`cancel`, `cronJobs()` recurring/cron schedules with catch-up policies, retries/backoff, cascading cancel, and workflow-ready `onComplete`/`context` round-trip primitives), built on a new **recurring `driver` component seam** (`ComponentDefinition.driver`/`boot` — a reactive event loop woken by the commit fan-out plus a wall-clock timer, wired into `packages/component`'s `composeComponents` and `packages/runtime-embedded`'s `EmbeddedRuntime`/`DriverContext`; `packages/cli`'s `devCommand` now passes the composed `bootSteps`/`drivers` through to `createEmbeddedRuntime`, which previously silently dropped them).

Honestly deferred (seams reserved, not built): true V8-isolate global sandboxing (the inline executor runs in-process; the syscall ABI is isolate-ready) · optimistic updates + full version-gap resync in the client · Tier 2 distributed sharding/sync fleet · file storage · search/vector · **actions** (the scheduler dispatches `kind:"mutation"` jobs only — a `kind:"action"` job fails cleanly with "unsupported: action runtime not built" rather than running). (Range-precise invalidation has since SHIPPED — the recorded read/write ranges now drive subscription invalidation, so a write only re-runs subscriptions whose read-set its range intersects; activated by the authz effectivePermissions slice. Scheduled functions/crons have since SHIPPED too — see `@stackbase/scheduler` above.)

## Locked decisions (do not relitigate without the user)

- **Language:** Full TypeScript end-to-end — CLI, server engine, and client SDK are one language. No Rust core. Optimize for a small team shipping a *complete, working* system.
- **Storage is pluggable.** The engine must NOT hard-depend on one database. All persistence goes through a `DatabaseAdapter` interface; ship adapters for **SQLite** (zero-config local dev / single-node) and **Postgres** (scalable deploy), and keep the door open for others. Engine logic never imports a driver directly.
- **Runtime:** **Bun is primary** (server, dev, and the single binary via `bun build --compile`); the engine is runtime-agnostic behind `DatabaseAdapter`/runtime seams, and **Node is fully supported** (npm packages + `NodeSqliteAdapter`). Tests run under Node/vitest (runtime-neutral logic); the Bun path has a `bun run` smoke test in `docstore-sqlite`.
- **Deployment baseline:** Docker self-host. `docker compose up` should bring up engine + database + (later) dashboard. Portability over any single cloud.
- **Reference, not dependency:** study Convex (`get-convex/convex-backend`, `get-convex/convex-js`) for protocol/DX shape. Do not copy FSL-licensed code; reimplement.

## Build order (each is its own working slice, spec'd and built independently)

1. **Foundation** ✅ — reactive engine: schema + query/mutation function definitions, transactional execution via the DB adapter, WebSocket reactive subscriptions, the `stackbase dev` CLI that pushes functions, and a client SDK with a `useQuery` hook.
2. **Dashboard** ✅ — `apps/dashboard`: live data browser (admin sync subscription, cursor pagination, structured filters, scanCapped banner), logs viewer, function runner. Table list via HTTP (lazy + manual refresh); doc edits via admin HTTP (live subscription reflects writes).
3. Auth
4. File storage
5. Actions + scheduled functions / crons (side effects that run *outside* the transaction) — **scheduled functions/crons half ✅ shipped** (`@stackbase/scheduler`, see What works above); actions themselves are not yet built
6. Production deploy tooling

Do not start a later slice before the earlier one runs end-to-end.

## Canonical architecture reference

Before designing or building any slice, read **`docs/dev/architecture/system-design.md`** (the North Star), **`docs/dev/architecture/internals/README.md`** (ground-truth engine internals), and **`docs/dev/research/comparison.md`**. They define the reactive-transaction core, the storage seam, and the **tiered architecture** (single-binary Tier 0 → distributed Tier 2, same app code throughout) that reconciles the four goals: Convex-DX, PocketBase-lightweight, SpacetimeDB-fast, concave-deploy-anywhere. Per-system research is in `docs/dev/research/`.

The `docs/dev/architecture/internals/` notes are **clean-room extractions** from the published `@concavejs/*` packages (studied as reference; the packages are FSL-1.1-Apache-2.0 and live in gitignored `.reference/` — **never copy that code into our packages**, see `.reference/README.md`). Key decisions already locked from the extraction: data model is an append-only **MVCC log** (`{ts, id, value, prev_ts}`); invalidation was **table-level first, now range-precise** (recorded read/write ranges drive intersection — activated by the authz effectivePermissions slice); **3-phase OCC** with deterministic-UDF replay on conflict; syscall ABI must be **fully serializable across a V8 isolate** from day one.

## The one concept to get right: the reactivity model

This is what makes the system "Convex-like" and is the easiest thing to design wrong.

- **Queries are pure, deterministic, read-only.** During execution, the engine records the query's **read set** — exactly which tables/rows/index-ranges it touched.
- **Mutations are the only writers**, and they run as a single serializable transaction. On commit, the engine computes the **write set**.
- A subscribed query is **re-run and re-pushed** only when a committed write set **intersects** its recorded read set. No polling. This intersection logic — not the WebSocket plumbing — is the heart of the system. Get the read-set granularity and invalidation right and everything else follows.
- Because invalidation depends on deterministic re-execution, **queries must not call non-deterministic APIs** (network, random, clock). Side effects belong in *actions* (slice 5), never in queries/mutations.

## Intended architecture (target monorepo layout)

TypeScript monorepo (Bun workspaces + Turborepo). Keep packages small and single-purpose — the engine should be understandable without reading the CLI, and vice versa. Top-level dirs: `packages/` (engine + SDK), `components/` (pluggable components, e.g. `@stackbase/auth`), `apps/` (dashboard), `examples/`.

- `packages/server` — the engine: function registry, transaction manager, read/write-set tracking, subscription invalidation, WebSocket sync server.
- `packages/adapters/*` — `DatabaseAdapter` implementations (`sqlite`, `postgres`). One package per backend; engine depends only on the interface.
- `packages/client` — framework-agnostic client + sync protocol; `packages/react` (or a subpath) for `useQuery`/`useMutation` hooks.
- `packages/cli` — `stackbase` CLI: `dev` (watch + push functions + run engine), `deploy`, codegen.
- `packages/codegen` — generates typed API + schema types consumed by app code (the typed-client DX is a core selling point; treat it as load-bearing, not a nicety).
- `apps/dashboard` — live data browser, logs, and function runner (slice 2, shipped).
- `examples/*` — runnable sample apps that double as integration tests.

## Commands (target — confirm they exist before use)

```bash
bun install               # bootstrap workspace (Bun is the package manager + runtime)
bun run build             # build all packages (Turborepo, topological)
bun run dev               # watch-build packages
bun run test              # run all tests (vitest, under Bun)
bun run --filter <pkg> test    # single package's tests (e.g. --filter @stackbase/auth)
bun run lint && bun run typecheck

# end-user-facing CLI (what the DX is judged on):
stackbase dev             # local: watch functions, push to engine, serve sync
docker compose up         # self-host: engine + db (+ dashboard later)
```

When you add the first package, also add the script wiring so these top-level commands actually work — DX is the product here, so the commands must be real, not aspirational.

## Working conventions

- **Two doc audiences, kept separate.** `docs/enduser/` is the **public, end-user product documentation** (how a developer *uses* Stackbase — this is the eventual `docs.stackbase.dev` site; derived from concave's docs, rebranded, Convex-compat surface preserved). Internal engineering docs (specs, architecture decisions) live separately under `docs/superpowers/specs/` (or `docs/internal/`). Do not mix them. Raw upstream reference is kept at `.reference/concave-docs-raw/`.
- **Process:** this project uses the brainstorming → writing-plans → implementation flow. Each build-order slice gets a design spec in `docs/superpowers/specs/` before code. Don't skip to coding a slice without an approved spec.
- **DX is the feature.** Error messages from the CLI/SDK, type inference quality, and `stackbase dev` startup speed are not polish — they are the reason to choose this over alternatives. Weigh changes against them.
- **Never let the engine know which database it's on.** A leak of SQLite/Postgres specifics out of `packages/adapters/*` is a design bug.
