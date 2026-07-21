# AGENTS.md

Guidance for AI coding agents and new contributors working in this repository.
(`CLAUDE.md` is a symlink to this file.)

## What this is

**helipod** — an open-source, self-hostable Backend-as-a-Service. You write
TypeScript query/mutation functions; they run server-side, transactionally, and
**reactively**: when underlying data changes, subscribed clients are pushed fresh
results over a WebSocket. The pillars: great TypeScript DX, easy self-hosting
(single binary or `docker compose up`), and no vendor lock-in.

The engine is real and proven end-to-end: MVCC document store (SQLite, Postgres,
Cloudflare D1/DO adapters) · single-writer OCC transactor · reactive sync tier ·
actions and `httpAction` HTTP routes · file storage (FS/S3 backends) · components
(`@helipod/auth`, `scheduler`, `workflow` with saga compensation, `triggers`,
`notifications`, `authz`) · optimistic updates and a durable offline outbox in the
client · dashboard · `helipod dev`/`serve`/`deploy`/`build` CLI · multi-node
fleet and object-storage substrate under `ee/`.

## Commands

```bash
bun install               # bootstrap (Bun is package manager + runtime)
bun run build             # build all packages (Turborepo, topological)
bun run typecheck         # tsc across the workspace
bun run test              # FAST lane: parallel unit/integration suite
bun run test:e2e          # SERIAL lane: heavy real-process E2Es (~5 min)
bun run test:all          # CI: fast lane, then serial lane
bun run --filter <pkg> test   # one package (e.g. --filter @helipod/auth)

# end-user CLI (what the DX is judged on):
helipod dev               # local: watch functions, serve sync + dashboard
helipod serve             # production: admin key required, no codegen at boot
helipod build             # compile an app into a single self-contained binary
docker compose up         # self-host: generic image + bind-mounted helipod/
```

## The one concept to get right: reactivity

This is the heart of the system and the easiest thing to break.

- **Queries are pure, deterministic, read-only.** The engine records each
  query's **read set** (tables/rows/index ranges touched) as it executes.
- **Mutations are the only writers** and run as one serializable transaction.
  Commits produce a **write set**.
- A subscribed query re-runs and re-pushes **only when a committed write set
  intersects its read set** (range-precise interval matching). No polling.
- Because invalidation depends on deterministic re-execution, queries and
  mutations must never touch non-deterministic APIs (network, clock, random).
  Side effects belong in **actions**, which run outside the transaction.

Before designing engine changes, read the architecture docs at
`website/content/docs/contributing/architecture/`.

## Monorepo layout

- `packages/` — the engine, split small and single-purpose:
  - `docstore-*` — storage adapters (`sqlite`, `postgres`, `d1`, `do-sqlite`)
    behind one interface; the engine never imports a database driver directly
  - `transactor`, `query-engine`, `executor` — OCC commit path and UDF execution
  - `sync` — WebSocket subscriptions, invalidation, reconnect resume
  - `client` — framework-agnostic SDK: `useQuery`/`useMutation`, optimistic
    updates, durable offline outbox
  - `cli` — `helipod` command; also hosts the cross-package E2E tests
  - `codegen` — generated typed `api`/`Doc`/`Id`; the typed DX is load-bearing
  - `storage`, `blobstore-*` — file storage seam and backends
- `components/` — opt-in server components (auth, scheduler, workflow, triggers,
  notifications, authz), composed per project via `helipod.config.ts`
- `apps/dashboard` — live data browser, logs, function runner
- `examples/` — runnable apps (`chat`, `auth-demo`, `offline-demo`,
  `optimistic-demo`) that double as integration references
- `ee/` — commercially-licensed scale-out packages (fleet, object-store
  substrate); everything else is FSL (see `LICENSE`)
- `website/` — the docs site and landing page (`website/content/docs/`)

## Locked decisions (do not relitigate)

- **Full TypeScript end-to-end.** CLI, engine, and client are one language.
- **Storage is pluggable.** All persistence goes through the doc-store
  interface. A database-specific detail leaking out of an adapter package is a
  design bug.
- **Bun is primary** (dev, serve, single-binary compile); **Node is fully
  supported**. Engine logic stays runtime-neutral behind seams.
- **Deployment baseline is Docker self-host**; single-node self-host and data
  portability are free forever. Paid features live only under `ee/`.
- **Functions directory is `helipod/`** by default (`--dir` flag >
  `functionsDir` in `helipod.config.ts` > default). `helipod migrate` converts
  apps from other BaaS platforms; nothing is adopted silently.

## Working conventions

- **Two test lanes — keep them honest.** `bun run test` is the fast parallel
  lane and must pass reliably. Heavy real-process E2Es (multi-node fleet,
  real containers, child-spawning smokes) live in the serial lane. When you add
  a real-process E2E, name it `*-e2e.test.ts` (or `*.e2e.test.ts`) and wire it
  to the package's `test:e2e` script — never let it into the default `test`.
  Prefer a deterministic fix (explicit timer/trigger, no wall-clock waits) over
  moving a flaky test between lanes.
- **Tests run under Node** (vitest), even though Bun is the primary runtime —
  don't use Bun-only APIs in shared test code.
- **Cross-package tests resolve dependencies via built `dist/`**, not `src/`.
  After editing a dependency, rebuild it (`bun run build`) or the change is
  invisible to dependents' tests.
- **Prove features through the shipped entrypoint.** A cross-package feature
  needs an E2E through the real `helipod dev`/`serve` server (see
  `packages/cli/test/*-e2e.test.ts`), not only unit tests.
- **Spec before code for substantial slices.** Design docs live with the
  contributing docs; get the design agreed before implementing.
- **DX is the product.** Error messages, type-inference quality, and
  `helipod dev` startup speed are features, not polish. Weigh every change
  against them.
- **Two documentation audiences, kept separate.** `website/content/docs/` is
  end-user product documentation; engineering/contributor material lives under
  `website/content/docs/contributing/`. Don't mix them.

## Gotchas

- The `oven/bun:slim` Docker image has no C++ toolchain — the builder stage
  installs with `--ignore-scripts` on purpose; native modules in
  `trustedDependencies` are host-test-only.
- A few source files intentionally contain literal NUL bytes (index-key
  fixtures, a hash-separator doc comment). Text-mode grep silently skips them;
  sweep with `grep -a` when doing repo-wide renames.
- `bun install` does not refresh the root workspace `name` in `bun.lock` when
  dependencies are unchanged.
- Turbo caches aggressively; after sweeping renames or doc-guard changes, run
  the affected package's tests uncached (`--force`) before trusting green.
