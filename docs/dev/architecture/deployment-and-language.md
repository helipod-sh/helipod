---
title: Deployment Topologies & the TypeScript-vs-Rust Question
status: reference / decision record
audience: engineering (internal)
date: 2025-07-19
---

# Deployment Topologies & the TypeScript-vs-Rust Question

> **Why this doc exists.** Recurring questions keep coming up: *"What would we have gained
> building the engine in Rust? Could users still use it like a package? How does the single
> binary deploy to the edge, to a DigitalOcean droplet, with Docker, without Docker (just
> npm)? And does a single binary even scale?"* This consolidates those answers in one place
> so we don't re-derive them from intuition each time.
>
> It is a **companion**, not a replacement, for:
> - [`scalability-spectrum.md`](./scalability-spectrum.md) — the Tier 0 → Tier 2 spectrum and the seams.
> - [`scaling-reality.md`](./scaling-reality.md) — JS/Bun vs Rust/BEAM *for holding many connections*.
> - [`foundation/occ-transactor.md`](./foundation/occ-transactor.md) — the single-writer commit internals.
>
> This doc adds the **deployment matrix**, the **whole-system language decision** (not just the
> connection tier), and an **honest snapshot of what actually ships today** vs. what is designed.

---

## 1. The reframe that resolves most of the confusion

**Engine language ≠ user language.** Developers write their query/mutation/action functions in
**TypeScript no matter what the engine is built in.** Convex — our architecture reference — is a
**Rust core that runs user JavaScript inside embedded V8 isolates.** So "Rust vs TypeScript" is
*not* a question about the developer's authoring experience; it is only a question about what
language the **transactor, MVCC log, read/write-set tracker, and invalidation intersector** are
written in.

Two more facts collapse the rest of the confusion:

- **The engine is a server you connect to, not a library you link in.** Users run
  `stackbase dev` (a process) and connect over WebSocket via `@stackbase/client`. They never
  `import` the engine into their app bundle. It is Postgres-shaped: nobody `import`s
  Postgres-the-database; they run it and connect. What language the database is written in is
  invisible across that process boundary.
- **Our reference implementation (concave) is itself pure TypeScript — and it runs on the edge.**
  The published `@concavejs/*` packages are ordinary npm packages (`"type": "module"`, built with
  `bun build --target node`, shipping `dist/*.js` + `*.d.ts` — **no Rust, no WASM**). concave runs
  on Cloudflare Workers/Durable Objects *as TypeScript*, and even ships a distributed, sharded,
  autoscaled sync tier — all in TS. See
  [`internals/06-runtimes-topology.md`](./internals/06-runtimes-topology.md).

**Conclusion:** the "we need Rust to scale / to reach the edge / to ship a package" intuitions are
mostly wrong. The scaling story is **architectural**, and the language is the implementation of one
component behind a seam.

---

## 2. What Rust would (and would not) buy us, across the whole system

The [`scaling-reality.md`](./scaling-reality.md) doc already covers Rust vs JS for the **connection
tier**. Here is the broader whole-system view.

| Dimension | TypeScript wins | Rust wins |
| --- | --- | --- |
| Team velocity / one language end-to-end | ✅✅ | |
| Time-to-first-working-system | ✅✅ | |
| DX iteration (scheduler/workflow/actions shipped fast) | ✅ | |
| Shared types across client ↔ server | ✅ | |
| Ships as an npm package | ✅ (concave proves it) | (hides behind an npm wrapper) |
| Deploys to Cloudflare Workers/DOs | ✅ (Workers *is* a JS runtime) | ✅ (via WASM — also fine) |
| Shard across the edge / autoscale | ✅ (concave did it in TS) | ✅ |
| p99 latency, no GC pauses | | ✅✅ |
| Memory density (shards/tenants per node) | | ✅✅ |
| Raw commit throughput per single writer | | ✅ |
| Hard user-code isolation | | ✅ (but Workers gives V8 isolation *for free*) |

**The pattern:** TypeScript wins everything about *building and shipping* the system; Rust wins
everything about *running one node very hard*. Rust's advantages are **latent** — they don't bite
until real multi-tenant load or adversarial user code. For a small team whose thesis is
"Convex-grade DX, complete working system, easy self-host," TS is the correct bet for the phase
we're in, and the seams preserve a **surgical** Rust path later (see §6).

### 2.1 "Can users still use it like a package?" — yes

Migrating the engine to Rust would **not** change how app developers consume Stackbase, because
they don't `import` the engine today:

| Piece | How users consume it | Language, always |
| --- | --- | --- |
| `@stackbase/client` + hooks | `import { useQuery }` — real import, runs in the browser | **must be JS/TS** |
| `@stackbase/codegen` output (typed `api`/`Doc`/`Id`) | `import { api }` | **TS** |
| `@stackbase/cli` (`stackbase dev`) | a **command**, not an import | wrapper can hide a native binary |
| the engine (`runtime-embedded`) | never imported; the CLI boots it as a server | free to be anything |

If the engine ever went Rust, it would ship the way esbuild / swc / Biome / Turbopack do: an npm
package that is a thin JS shim which downloads the right prebuilt native binary per platform.
`npx stackbase dev` would be **byte-for-byte identical** from the user's terminal. Docker and the
edge are likewise unaffected.

**The one real casualty** would be in-process embedding via `@stackbase/runtime-embedded`
(`createEmbeddedRuntime`) — today you can spin the whole engine up *inside* a Node/Bun process (how
our e2e tests and CLI work). A Rust core turns that from a function call into an FFI/socket
boundary. Niche, and even that can be preserved by keeping a thin TS orchestration shell over a
local socket.

---

## 3. Deployment topology matrix — every way to run it

The **same Tier 0 binary** is the deployment unit everywhere. "Single binary" is how it is
*packaged*, not a scaling ceiling — you scale by running **more copies** and swapping what is wired
around the unchanged engine (storage adapter, write-fanout, shard router). See §5.

| # | Target | How you run it | Storage | Scaling axis | Ships today? |
| --- | --- | --- | --- | --- | --- |
| A | **Bare process / npm, no Docker** (VPS, DO droplet) | `bun packages/cli/dist/bin.js dev …` behind a reverse proxy | SQLite on local disk | Vertical (bigger droplet) | ✅ works via `dev` |
| B | **Compiled single binary** | `bun build --compile` → one executable | SQLite on disk | Vertical | ⚠️ `serve` entrypoint pending (M7/M9) |
| C | **Docker, single container** | `docker run` the root `Dockerfile` | SQLite on a `/data` volume | Vertical | ⚠️ image builds; default `CMD` is a placeholder |
| D | **`docker compose up`** | one service + one named volume | SQLite volume | Vertical | ⚠️ 2 fixes away (see §7) |
| E | **PaaS (Railway / Fly / Render)** | container or nixpacks, persistent volume | SQLite volume, or managed Postgres | Vertical → Tier 1 replicas | ✅ container path works |
| F | **Edge (Cloudflare Workers / DO)** | `runtime-base`-style host subclass; DO per shard | Durable Object storage | Horizontal (DO per shard) | ⚪ designed, host package not built |

Legend: ✅ works today · ⚠️ scaffold exists, gap noted · ⚪ designed, not built.

### 3.1 The two axes of "scaling up"

Everything in the matrix scales along one of two axes, and they are **language-independent**:

- **Vertical (scale up):** one writer, bigger machine. Capped by one core's serial *commit* rate
  (which is small — see §5). This is the primary lever on a droplet or a single PaaS instance, and
  it is exactly where Rust's no-GC/density would raise the ceiling.
- **Horizontal (scale out):**
  - **Reads / subscriptions / connections** → run **N replicas** sharing one Postgres, with a
    **write-fanout adapter** (Redis pub/sub) so a write on replica A invalidates a subscription on
    replica B. This is **Tier 1**. Seam: `createEmbeddedWriteFanout` / `EmbeddedWriteFanoutAdapter`.
  - **Writes** → **shard the keyspace** so each shard has its own single writer. This is **Tier 2**
    (`ShardRouter`, per-conversation shard key). Designed, not yet built.

### 3.2 Edge is an *architecture* constraint, not a language one

A common misconception worth killing: *"TypeScript/Bun can't do the edge."* The precise truth:

- **Bun-at-runtime** does not run on Cloudflare Workers, and an engine that imports `node:sqlite` /
  `ws` / Bun APIs can't deploy there.
- But **Workers *is* a JavaScript runtime** (a restricted V8 isolate). JS/TS runs there natively —
  concave proves it. The real requirement is the **`runtime-base` discipline**: the engine must
  never import host primitives (`node:fs`, `ws`, a CF binding). Each host (Node, Bun, Cloudflare) is
  then a thin subclass supplying `fileExists`/`importModule`, a timer, a socket type, and a storage
  binding. A Durable Object provides the stateful, addressable "home" a shard needs; concave's
  `ShardRouter<DurableObjectStub>` is exactly that.

So a `runtime-cloudflare` package would be a **new subclass, not a rewrite** — and it would be TS.

---

## 4. Worked example — a single DigitalOcean droplet

The most common self-host question: *"I have one $6 droplet. How do I run Stackbase, with and
without Docker?"* Both are Tier 0; pick by preference.

### 4.1 Without Docker (just the npm/Bun process)

```bash
# on the droplet
curl -fsSL https://bun.sh/install | bash          # install Bun
git clone <your-app> && cd <your-app> && bun install
bun run build                                       # build the engine + your convex/ dir

# run the engine, bound to all interfaces, data on a persistent path
STACKBASE_ADMIN_KEY="<a-long-random-secret>" \
  bun packages/cli/dist/bin.js dev \
    --dir convex \
    --data /var/lib/stackbase/db.sqlite \
    --ip 0.0.0.0 \
    --port 3000
```

Then put **Caddy or nginx** in front for TLS and WebSocket upgrade, and point clients'
`ConvexReactClient` at `wss://your-domain/`. Use a systemd unit (or `pm2`) so it restarts on
reboot. That's the entire deployment.

> **Security note (matters on a public droplet):** always set `STACKBASE_ADMIN_KEY`. If unset,
> `dev` generates an **ephemeral** key per run (`packages/cli/src/cli.ts`), which rotates on every
> restart. The CLI only auto-injects a key into the dashboard HTML on a **loopback** bind, so a
> `0.0.0.0` bind correctly refuses to embed your persistent secret — that guard is deliberate.

### 4.2 With Docker (same droplet, containerized)

```bash
docker build -t stackbase .          # root Dockerfile — Bun, Turborepo-pruned, non-root, /data volume
docker run -d --restart unless-stopped \
  -p 3000:3000 \
  -e STACKBASE_ADMIN_KEY="<secret>" \
  -v stackbase-data:/data \
  stackbase \
  bun packages/cli/dist/bin.js dev --dir project/convex --ip 0.0.0.0 --port 3000 --data /data/db.sqlite
```

The explicit `bun … dev …` command is required **today** because the image's default `CMD` is a
placeholder pending the `serve` entrypoint (see §7). Once `stackbase serve` lands, this collapses to
`docker run … stackbase` (and `docker compose up`).

### 4.3 When one droplet isn't enough

- **First**, scale **vertically** — a single writer commits a lot (§5); most apps never leave one
  droplet.
- **Then**, move the DB off the box: swap the `DatabaseAdapter` to **Postgres** (managed, e.g. DO's
  managed Postgres) via `DATABASE_URL`. Same binary; the DB now scales independently.
- **Then Tier 1**: multiple droplets/replicas + Postgres + Redis write-fanout for read/subscription
  capacity.
- **Then Tier 2**: shard writers. This is where a bare-container platform (droplet/Railway) is
  *more* work than Cloudflare — you build the coordinator + shard router yourself, because there is
  no Durable Object primitive to lean on.

---

## 5. Does the single binary scale? — how the engine core actually behaves

The fear "single binary = single-threaded DB = won't scale" conflates **packaging** with
**topology**. The reality, grounded in `packages/transactor/src/single-writer-transactor.ts`:

- **The function body runs lock-free.** `runInTransaction` runs your code, its reads, and staging
  of writes **outside** any lock — optimistically, at an MVCC snapshot timestamp. Hundreds of
  transactions run their bodies concurrently.
- **Only the commit is serialized**, via `mutex.runExclusive(() => this.commit(...))`, and `commit`
  is just three fast steps: **validate** (read-set ∩ recent write-sets → `OccConflictError` +
  deterministic replay on conflict), **allocate** one commit timestamp, **apply** (append staged
  revisions, publish the oplog delta). The lock is held for microseconds, not for the whole txn.
- **Pure reads never take the lock at all** — if nothing was staged, `runInTransaction` returns at
  the snapshot without touching the mutex.

Therefore, per package:

| Package | What scales | How | Ceiling |
| --- | --- | --- | --- |
| `@stackbase/query-engine` | reads at a snapshot | **freely** — add replicas (Tier 1); reads never block | none practical |
| `@stackbase/executor` | running function bodies | with **cores/processes** (lock-free; `SerializedUdfExecutor` only where `AsyncLocalStorage` is unavailable) | CPU |
| `@stackbase/transactor` | commits | **up** (tiny critical section) + **out via sharding** | one commit **per shard** at a time |

**"Single-writer" means one *commit* at a time, not one *transaction* at a time.** And it is
**single-writer *per shard*** — `shardId` is threaded through `runInTransaction`, `commit`, and the
oplog, so each shard is its own `SingleWriterTransactor` with its own mutex. N shards = N parallel
writers, with no cross-writer coordination (that's the cheap serializability win). The one genuinely
hard remaining problem is a **write spanning two shards**, which needs coordination — the
"cross-shard transactions" open question in
[`internals/06-runtimes-topology.md`](./internals/06-runtimes-topology.md), and a reason Tier 2 is
designed-but-unbuilt. Full internals: [`foundation/occ-transactor.md`](./foundation/occ-transactor.md) §3.1.

---

## 6. The strategic path: TS now, surgical Rust later (if ever)

The architecture deliberately keeps a **narrow** Rust escape hatch open, so we never have to
rewrite the engine:

- **Connection tier** — the sync tier talks only to `SyncProtocolHandler` / `SyncWebSocket` over a
  serializable wire protocol. If per-node connection cost ever dominates, reimplement **just that
  tier** in Rust/Zig behind the identical protocol; transactor, storage, codegen, and DX stay TS.
  (See [`scaling-reality.md`](./scaling-reality.md) §"escape hatch".)
- **Hot core** — the `DatabaseAdapter` seam and the serializable syscall ABI mean the invalidation
  intersector / isolate host could be reimplemented in Rust→WASM behind the same interface, without
  touching user code, the CLI, or the client.

Both are "rewrite the 5% on the hot path, keep the 95% that's DX." Neither is needed now, and the
reference implementation (concave, pure TS) reached edge + sharding + autoscaling without either.

---

## 7. Honest current-state snapshot (what ships vs. what's designed)

Recording these so the deployment story isn't overstated:

1. **No production `serve` command yet.** The CLI (`packages/cli/src/cli.ts`) ships only `dev`
   (hot-reload + dashboard + ephemeral admin key) and `codegen`. Production self-host currently
   means running `dev` as the server (it binds any IP and serves the real engine). A dedicated
   `stackbase serve` (no watcher, persistent key, adapter selection) is **build-order item 6**,
   still open. The root `Dockerfile`'s default `CMD` is a placeholder that prints exactly this.
2. **`docker compose up` won't build as written.** `docker-compose.yml` requests `target: runtime`,
   but the `Dockerfile`'s final stage is `AS runner`. One-word mismatch → "target runtime not
   found." Fix the target **and** point the `CMD`/compose command at the future `serve`.
3. **End-user deploy docs describe an aspirational API.** `docs/enduser/deploy/self-hosted.md`
   references `@stackbase/runtime-bun` / `@stackbase/runtime-node` / `createStackbase({...})`, which
   **do not exist** in the shipped packages (the real host is `@stackbase/runtime-embedded`, driven
   by the `stackbase dev` CLI). Those docs are forward-written; reconcile them when `serve` +
   per-runtime packages land.
4. **Tier 2 is contract-shaped, not built.** The `ShardRouter`, `SyncShardMap`, autoscaler, and
   cross-shard transactions are designed (`scalability-spectrum.md`, `internals/`) but not
   implemented. Tier 0 ships; the Tier 1 write-fanout seam exists; the distributed tier does not.

### Suggested follow-ups (small, self-contained)

- Add `stackbase serve` (a no-watch, persistent-key sibling of `devCommand`) and set it as the
  Docker `CMD`; fix the compose `target: runtime` → `runner`. This turns "self-host works if you
  know the incantation" into "`docker compose up`."
- Add a Postgres service + `DATABASE_URL` to the compose so durability doesn't ride on one
  container's volume (also the Tier 1 prerequisite).
- Reconcile `docs/enduser/deploy/*` with the shipped CLI, or gate the aspirational API behind a
  clearly-marked "planned" banner.

---

## 8. See also

- [`scalability-spectrum.md`](./scalability-spectrum.md) — Tier 0 → Tier 2, sharding, the sync
  fleet, the seams to reserve.
- [`scaling-reality.md`](./scaling-reality.md) — JS/Bun vs Rust/BEAM for holding many connections
  (the connection-tier half of the language question).
- [`foundation/occ-transactor.md`](./foundation/occ-transactor.md) — the single-writer commit
  critical section, OCC validation, deterministic replay.
- [`internals/06-runtimes-topology.md`](./internals/06-runtimes-topology.md) — the `runtime-base`
  host abstraction, the embedded runtime, capnweb transports, shard routing, autoscaling.
- [`docs/enduser/deploy/`](../../enduser/deploy/) — end-user deployment guides (self-hosted,
  cloudflare, standalone-binary, scaling) — note the API drift flagged in §7.3.
