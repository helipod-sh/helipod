# Stackbase

A Convex-compatible, self-hostable reactive backend. **Lightweight by default, scalable on demand** — the same app code runs as a single binary on a $5 VPS or as a distributed fleet (see [docs/dev/architecture/scalability-spectrum.md](docs/dev/architecture/scalability-spectrum.md)).

> Status: **early development.** Building the [Foundation slice](docs/superpowers/specs/2025-05-15-foundation-implementation-plan.md) (Tier 0: single binary + embedded SQLite). Architecture lives in [docs/dev/architecture/](docs/dev/architecture/); this is a clean-room implementation (see [CLAUDE.md](CLAUDE.md)).

## Repository layout

```
packages/        # the engine, in dependency order (see design §3)
  values/        # @stackbase/values — Convex-compatible value system, validators, schema
  errors/        # @stackbase/errors — structured engine error hierarchy
docs/
  enduser/       # public product docs (the eventual docs site)
  dev/           # engineering: architecture, research, clean-room internals
  superpowers/   # design specs + implementation plans
```

## Develop

Requires **Node ≥ 22** and **pnpm** (`corepack enable` or `npm i -g pnpm`).

```bash
pnpm install        # bootstrap the workspace
pnpm build          # build every package (Turborepo, topological)
pnpm test           # run all tests (vitest)
pnpm typecheck      # tsc --noEmit across packages
pnpm dev            # watch mode
```

Single package, e.g. just the value system:

```bash
pnpm --filter @stackbase/values test
pnpm --filter @stackbase/values test -- compare   # one test file
```

## Run (Tier 0)

```bash
docker compose up        # one container, one volume (embedded SQLite)
```

> The server entrypoint lands at milestone **M7/M9**; today the image builds the workspace. The build order and acceptance tests are in the [implementation plan](docs/superpowers/specs/2025-05-15-foundation-implementation-plan.md).

## License

MIT.
