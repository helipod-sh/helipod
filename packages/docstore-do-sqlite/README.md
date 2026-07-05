# @helipod/docstore-do-sqlite

The MVCC `DocStore` over a **Cloudflare Durable Object's** embedded SQLite (`ctx.storage.sql`) — the
Cloudflare-native Tier 0 storage backend. Slice 2 of the DO-native host program
(`docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md`).

DO-SQLite *is* SQLite, so the MVCC document-log implementation is reused **verbatim** from
[`@helipod/docstore-sqlite`](../docstore-sqlite) (`SqliteDocStore`). This package adds only the one
new thing: a `DatabaseAdapter` (`DoSqliteAdapter`) that drives the DO's synchronous SQL API.

```ts
import { SqliteDocStore } from "@helipod/docstore-sqlite";
import { DoSqliteAdapter } from "@helipod/docstore-do-sqlite";

// inside a Durable Object (the Slice 3 host wires this up):
const adapter = new DoSqliteAdapter({
  sql: ctx.storage.sql,
  transactionSync: ctx.storage.transactionSync.bind(ctx.storage),
});
const store = new SqliteDocStore(adapter);
await store.setupSchema();
```

## Design notes

### Injection, not import (neutrality)

The engine must never know it is on Cloudflare. So the adapter is **handed** the DO's SQL surface as
constructor input — `{ sql, transactionSync }` pulled off `ctx.storage` by the host — exactly as the
`node`/`bun`/`pg` adapters are constructed with their drivers. This package references **no**
Cloudflare type: the injected surface is declared as minimal structural interfaces (`SqlStorageLike`
etc.), which a real DO's typed `ctx.storage.sql` (`SqlStorage` from `@cloudflare/workers-types`)
satisfies by width — mirroring how `bun-adapter.ts` declares its `bun:sqlite` shape inline to avoid a
build dependency. Nothing above this leaf package imports a Cloudflare primitive.

### The 10 GB ceiling → a typed error, not a crash

A Durable Object's embedded SQLite is capped at **10 GB per object**; a write past that limit
hard-fails with `SQLITE_FULL`. The adapter classifies **only** that failure into a typed
[`DatabaseFullError`](./src/errors.ts) (`code: "DATABASE_FULL"`, original error kept as `cause`) so a
host can catch it and react (shed the write, reshard, alert) instead of seeing an opaque driver throw.
Every other error — notably the `SQLITE_CONSTRAINT` that the conflict-strategy contract relies on to
reject a duplicate `(id, ts)` — propagates untouched.

Cloudflare does not document a stable error *code* for the limit, so `isDatabaseFullError` matches the
SQLite `SQLITE_FULL` result-code family and its canonical "database or disk is full" message,
deliberately narrow so it never mislabels an unrelated failure. Reaching 10 GB is not reachable in a
unit test, so the classifier is tested directly against a synthetic `SQLITE_FULL`-shaped error (and
proven to pass a constraint error through).

### Three DO-SQLite deviations the adapter absorbs

1. **No `BEGIN`/`COMMIT`/`SAVEPOINT` via `exec`.** DO-SQLite rejects transaction-control SQL; the only
   atomic primitive is `ctx.storage.transactionSync(fn)`. `transaction()` delegates to it (it does
   **not** emit `BEGIN`/`COMMIT` the way the node/bun adapters do). This is why `transactionSync` is a
   required constructor input, not optional.
2. **Values are `ArrayBuffer | string | number | null`.** BLOB columns read back as `ArrayBuffer`
   (re-wrapped to `Uint8Array` on the read path, so the DocStore sees the same blobs as every other
   adapter); INTEGER columns read back as `number` (there is no `setReadBigInts`/`safeIntegers` mode).
3. **`bigint` is not a documented binding type.** The DocStore binds logical timestamps as `bigint`;
   the bind path narrows them to `number` before `sql.exec`.

### Why `number` timestamps are lossless here

Helipod's only INTEGER columns are logical timestamps (a per-store monotonic `MAX(ts)+1` counter
seeded at 1) and millisecond wall-clocks. Both stay far under `Number.MAX_SAFE_INTEGER` (2^53) in
every reachable state — a single DO would need ~9 quadrillion commits to overflow. Document ids and
index keys are BLOBs, never integers. The bind path throws loudly rather than silently truncate if a
value ever exceeds the safe range.

## Test fidelity — what is (and is not) proven

This package passes the **full shared docstore conformance suite**
(`@helipod/docstore/test-support/conformance` — the identical contract SQLite/Postgres/PGlite run),
driving `SqliteDocStore` over `DoSqliteAdapter`.

**Fidelity level: API-shape conformance against a faithful in-process `SqlStorage` stand-in — NOT a
real Durable Object run.** The suite runs against `test/memory-sql-storage.ts`, a stand-in backed by
Node's built-in `node:sqlite` that reproduces the DO SQL surface the adapter actually depends on:

- a **synchronous** `exec(query, ...bindings)` returning a cursor with `toArray()` / `rowsWritten`;
- a `transactionSync(fn)` that is the sole atomicity primitive;
- BLOB results returned as **`ArrayBuffer`** (forcing the adapter's `ArrayBuffer → Uint8Array` wrap);
- INTEGER results returned as **`number`**;
- **rejection of `bigint` bindings** (forcing the adapter's `bigint → number` narrowing);
- `exec` refusing `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` (forcing use of `transactionSync`).

Because the stand-in enforces exactly the constraints a real DO imposes, a green suite proves the
adapter speaks the DO SQL contract correctly. It does **not** prove behavior inside a real DO
runtime (workerd) — SQLite version quirks, the real `SQLITE_FULL` message text, and 10 GB behavior are
unverified here.

**Follow-on (deferred, like the container smoke was for `serve`):** run this same conformance suite
inside a real Durable Object via `@cloudflare/vitest-pool-workers` (`runInDurableObject`) once the DO
host lands (Slice 3). That is the gold-standard gate; wiring `vitest-pool-workers` (workerd + wrangler
config + a separate vitest project) was out of scope for this leaf-adapter slice.
