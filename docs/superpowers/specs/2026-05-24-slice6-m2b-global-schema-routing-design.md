# Slice-6 M2b — `.global()` schema mode + write-through routing — Design Spec

**Date:** 2026-05-24
**Status:** Design (pre-plan). Brainstorming complete; awaiting user review before the implementation plan.
**Slice:** M2b of Slice-6 M2 (`.global()`/D1 cross-shard reads). Wires the shipped **M2a `@stackbase/docstore-d1`** store into the engine. Parent decomposition: `docs/superpowers/specs/2026-05-15-slice6-m2-global-reads-notes.md` §4; parent spec `docs/superpowers/specs/2026-03-20-multishard-crossshard-slice6-design.md` §6.4 T6.

> **Note on file:line references.** The seam locations below were mapped 2026-05-24 and are load-bearing to the design, but are point-in-time — the implementation plan must re-confirm each against current code before editing.

## Goal

Teach the engine that a `.global()` table lives in Cloudflare D1: route its reads and writes to the M2a `D1DocStore` instead of the per-shard DO-SQLite MVCC-log store, keep global-and-sharded writes from mixing in one mutation, and reject `.unique()` on a sharded table at schema-load — proven end-to-end on miniflare (a real DO + real D1).

M2a built the standalone `D1DocStore` (its own interface, `D1Client` seam, `withSession` primitive) but left it **not engine-wired**. M2b is that wiring.

## Decisions (made as CTO; rationale in plain terms)

1. **Cross-store atomicity → forbid co-writing sharded + global tables in one mutation.** A single mutation writes EITHER sharded/root tables (DO-SQLite, transactional) OR `.global()` tables (D1), never both. Enforced at runtime (a clear typed error) and flagged at codegen where statically detectable. *Why:* a D1 write cannot enlist in the DO's SQLite transaction, so any design that allows both admits a partial-commit that leaves the two stores disagreeing. `.global()` is for genuinely-global / global-unique data (accounts, unique handles, orgs) — co-writing it with per-shard hot data in one mutation is rare, so the restriction costs little and removes the entire data-integrity hazard class. Relaxable later if a real use case demands it.

2. **`x-d1-bookmark` (D1 Sessions) threading → deferred to a later scaling slice.** M2b routes global reads to the **D1 primary**, which is read-your-writes-correct with no bookmark. The bookmark only matters for reads served from D1 **read replicas** (a throughput optimization), and the interactive client is WebSocket-only (a WS frame has no per-message header), so full threading would mean a new wire-protocol field for zero present benefit. The `withSession(bookmark)` primitive M2a shipped stays ready for that future slice. *Why:* YAGNI — build correctness now, the replica optimization when replicas are actually configured.

3. **Sequencing → build + prove M2b on miniflare; a real-Cloudflare run is a required checkpoint before M2c.** M2b's gate (a `.global()` write commits to D1 and a read returns it) runs fully on miniflare (real DO + real D1), the substrate M2a already established. The real-Cloudflare production proof genuinely needs multiple live DOs talking cross-node — that is M2c's (reactivity) job — so M2b is not blocked on it, but it is NOT skipped: it becomes a hard gate before M2c starts. *Why:* keep momentum without front-running the cross-node proof, while honoring the project's "prove M1 in production before M2 lands" rule at the point where it actually bites (cross-DO reactivity).

## Explicit scope boundary (stated so it is not a surprise)

M2b delivers correct global **reads and writes**. It does **not** make global-table **subscriptions live-update**: a `useQuery` on a `.global()` table returns correct data on each execution, but does not auto-refresh when another DO (or the same DO) writes that table — because the existing reactivity keys off the local DO-SQLite commit fan-out (`shard-writer.ts` `fanout.publish`), and a global write goes to D1, not the local log. Global-table reactivity (poll-based invalidation) is **M2c**. M2b's read path is point-in-time-correct; live global subscriptions are the next slice.

## Architecture

### 1. Schema: the `.global()` table mode (`packages/values/src/schema.ts`)
Today `TableDefinition` has `.shardKey(field)` (metadata → `TableDefinitionJSON.shardKey: string | null`, `schema.ts:~100,~117,~44`). There is no table-mode concept and no way to mark a table global.

- Add a `.global()` method to `TableDefinition`. It marks the table D1-resident. It is **mutually exclusive with `.shardKey()`** — calling both on one table throws at build time (in `.export()` or at call time) with a clear message.
- Serialize it additively: add `global?: boolean` (or `mode?: "global"`) to `TableDefinitionJSON`, omitted for non-global tables so existing exported schema JSON is byte-for-byte unchanged (same discipline as M2a's `IndexDefinitionJSON.unique`). Keep the existing `shardKey` field as-is; do NOT restructure it into a union (minimize churn to the many existing `shardKey` consumers).
- A `.global()` table MAY declare `.index(name, fields, { unique: true })` (M2a) — that is its whole point (global-unique).

### 2. Catalog threading (`packages/component/src/compose.ts` → `packages/executor/src/catalog.ts`)
The `.global()` marker flows the same route `shardKey` already does:
- `compose.ts` `addSchema` (`~:44-69`) reads `tableDef.global` and passes it to `catalog.addTable(...)` (new param, alongside the existing `shardKey`).
- `catalog.addTable` stores it on `TableMeta` (`catalog.ts:~9-19,~35-45`) as e.g. `TableMeta.mode: "root" | "shard" | "global"` (derived: `global` → `"global"`, else `shardKey != null` → `"shard"`, else `"root"`), which the kernel already reads as `meta` in every `handleDb*` handler.

### 3. The routing seam (`packages/executor/src/kernel.ts`)
This is the heart of M2b. Today every `ctx.db.insert/patch/replace/delete/get` and the scan/query path resolves `const meta = ctx.catalog.getTable(...)` and then calls `ctx.txn.put/get/delete` against the single injected DocStore (`kernel.ts` `handleDbInsert/Replace/Delete/Get` `~:469,540,566`, scan `~:418-426`). There is no per-table store dispatch.

- Add a branch in each `handleDb*` handler (and the query/scan path): when `meta.mode === "global"`, route the op to an injected **global store** (the M2a `D1DocStore`) instead of `ctx.txn` (the local DO-SQLite path).
- Writes to a global table do NOT enter the local transaction's write-set / OCC chain — they are applied to D1 directly (see §5 for the commit-timing detail) and do NOT participate in `docStore.commitWrite`.
- Reads (`get`, `queryByIndex`) on a global table call the `D1DocStore` read methods and return the row(s) — they are NOT recorded in the local read-set (global reactivity is M2c).

### 4. Injecting the global store into the DO runtime
The `D1DocStore` needs a live `D1Client` bound to the DO's `env.DB` D1 binding.
- The Cloudflare DO host (`packages/runtime-cloudflare/src/host.ts` / `durable-object.ts`) constructs a `bindingD1Client(env.DB)` → `D1DocStore(client, schemaJson)` at boot (when a D1 binding is present) and threads it into the runtime so the executor kernel can reach it (a new optional `globalStore` on the transaction/executor context, parallel to the existing `docStore`).
- `applyDdl()` (M2a create-only DDL) runs once at DO boot if a global store is present, so the D1 tables/indexes exist before the first global op.
- When no D1 binding is configured (e.g. the local `stackbase dev` / non-CF runtimes), `globalStore` is undefined; a mutation/query that touches a `.global()` table then fails fast with a clear "global tables require a D1 binding (Cloudflare)" error rather than silently hitting the wrong store. (M2b's `.global()` is a Cloudflare-runtime feature; broadening it to the SQLite/Postgres runtimes is a separate future decision, not M2b.)

### 5. The co-write guard + global write application
- **Guard (runtime):** during a mutation's execution, track whether any write has targeted a sharded/root table and whether any has targeted a global table. If both occur in one mutation, abort with a typed `CrossStoreWriteError` (clear message: a mutation may write global tables or sharded tables, not both). This is checked in the kernel write handlers (where `meta.mode` is known).
- **Guard (codegen, best-effort static flag):** where a function's writes are statically detectable, `packages/codegen` emits a warning/error for an obvious sharded+global co-write. This is a DX nicety; the runtime guard is the correctness backstop.
- **Global write application timing (buffer → flush-as-batch at commit):** global writes do NOT hit D1 the instant `ctx.db.insert/patch/...` is called. They are **buffered in a per-mutation pending overlay** (mirroring how the local transaction buffers writes before `commitWrite`), for two reasons: (1) **read-your-own-writes within the handler** — a later `ctx.db.get`/query on a global table in the same mutation must consult the overlay first, then D1; (2) **atomicity + abort-safety** — a mutation that throws after a global write must leave D1 untouched, and a multi-write global mutation must be all-or-nothing. At commit (after the co-write guard has confirmed the mutation is global-only), the buffered global writes are flushed as **one atomic D1 `batch()`**. A global-unique violation surfaces from the batch as M2a's `UniqueConstraintError`, mapped to a typed coded write rejection to the caller.
- **Seam extension:** M2a's `D1Client`/`D1DocStore` shipped without `batch()` (deferred as YAGNI). M2b **adds `batch()` to the `D1Client` seam and a batch-write method to `D1DocStore`** (additive: the `better-sqlite3` substrate wraps a synchronous transaction, the real binding uses D1's native `batch()`), so the flush is genuinely atomic on both substrates. This is the one change M2b makes to the `@stackbase/docstore-d1` package.

### 6. The `.unique()`-on-`.shardBy` schema-load guard
At schema-load (`compose.ts` `addSchema`, where both `shardKey` and the table's `indexes` are visible), reject a schema where a `.shardBy` (sharded) table declares a `{ unique: true }` index — a per-shard store cannot enforce a global-unique constraint (each shard is a separate DO-SQLite). Clear error naming the table + index. (Unique indexes are only meaningful on `.global()` tables.)

## Data flow (M2b)

```
schema.ts  .global() table ──► TableDefinitionJSON.global ──► catalog TableMeta.mode="global"
DO boot ──► bindingD1Client(env.DB) ──► D1DocStore ──► applyDdl()  (create-only, once)

mutation writes a .global() row:
  ctx.db.insert(globalTable, doc)
    └─ kernel handler: meta.mode==="global"  ──► co-write guard (global-only?) ──► buffer in pending global overlay
       (NOT ctx.txn; NOT in the DO OCC write-set; NOT yet in D1)
    └─ in-handler ctx.db.get(globalTable, id) ──► overlay first, then D1  (read-your-own-writes)
    └─ on commit: flush overlay as ONE atomic D1 batch(); UniqueConstraintError ──► coded write rejection
       (mutation throws/aborts before commit ──► overlay discarded, D1 untouched)

query reads a .global() row (in a query function, no writes):
  ctx.db.query(globalTable)... / ctx.db.get(globalTable, id)
    └─ kernel: meta.mode==="global" ──► globalStore.queryByIndex/get ──► rows  (from D1 PRIMARY, RYOW-correct)
       (NOT recorded in the local read-set — global reactivity is M2c)

mutation tries to write a sharded AND a global table  ──►  CrossStoreWriteError (typed, rejected)
schema declares .unique() on a .shardBy table          ──►  rejected at schema-load
```

## Error handling
- **Sharded + global co-write in one mutation** → typed `CrossStoreWriteError`, rejected before any global write is applied (the guard trips on the second-store write; the mutation aborts, the DO SQLite txn rolls back, no global write is flushed).
- **Global-unique violation** → M2a `UniqueConstraintError` mapped to a coded write rejection to the caller.
- **`.unique()` on a `.shardBy` table** → schema-load rejection naming the table + index.
- **`.global()` op with no D1 binding configured** → fail-fast typed error ("global tables require a Cloudflare D1 binding"), never a silent wrong-store write.
- **`.global()` + `.shardKey()` on one table** → build-time (schema) rejection.

## Testing
- **Unit:** the schema `.global()` builder (mutual-exclusion with `.shardKey`, serialization); the `.unique()`-on-`.shardBy` schema-load guard; the catalog `mode` threading; the co-write guard (a mutation writing both stores → `CrossStoreWriteError`).
- **Batch/overlay unit tests (`@stackbase/docstore-d1`):** the new `batch()` on both substrates (all-or-nothing: a batch whose Nth statement violates a unique index leaves the first N-1 unwritten); the pending-overlay read-your-own-writes (a buffered insert is visible to a same-mutation get before flush).
- **Gate — miniflare DO + D1 E2E (serial lane, `*-e2e.test.ts`):** through a real DO on miniflare with a real D1 binding: (1) a mutation inserts a `.global()` row → it commits to D1; (2) a query reads it back correctly (RYOW from the D1 primary); (3) a same-mutation read-your-own-writes on a global insert before commit; (4) a global-unique violation is rejected with the coded error; (5) a mutation attempting a sharded+global co-write is rejected with `CrossStoreWriteError` and leaves NEITHER store written; (6) a global-only mutation that throws after a global insert leaves D1 untouched (abort-safety). Mirror the M2a/`runtime-cloudflare-shard` miniflare harness pattern. This gate does NOT assert reactive subscription updates on global tables (that is M2c).
- **Regression:** existing sharded/root mutation + query paths unchanged; the `@stackbase/values` `.global()` addition is additive (existing schema JSON unchanged).

## Package layout / files touched
- `packages/values/src/schema.ts` — `.global()` method + `TableDefinitionJSON.global`; `.global()`/`.shardKey()` mutual exclusion.
- `packages/component/src/compose.ts` — thread `global` through `addSchema` → `catalog.addTable`; the `.unique()`-on-`.shardBy` schema-load guard.
- `packages/executor/src/catalog.ts` — `TableMeta.mode`.
- `packages/executor/src/kernel.ts` — the `mode === "global"` routing branch in `handleDb*` + query/scan; the co-write guard; global-store injection point.
- `packages/runtime-cloudflare/src/{host.ts,durable-object.ts}` (and/or the shard runtime host) — construct `bindingD1Client(env.DB)` → `D1DocStore`, run `applyDdl()` at boot, inject `globalStore` into the executor context.
- `packages/codegen/*` — best-effort static co-write flag (DX; optional if not cheaply detectable).
- `packages/docstore-d1/*` (the M2a package) — additive `batch()` on the `D1Client` seam + a batch-write method on `D1DocStore` (the atomic commit-flush primitive; `better-sqlite3` substrate = a sync transaction, real binding = D1 native `batch()`). The one change M2b makes to M2a's package.
- New serial-lane E2E under the CF runtime rig (miniflare DO + D1).
- **Untouched:** the client SDK / wire protocol (no bookmark field — decision 2), `ee/packages/runtime-cloudflare-shard/src/worker.ts` (routing to D1 is DO-internal).

## Grounding-driven refinements (added 2026-05-24 after mapping the actual engine seams)

A full read of `kernel.ts`, `catalog.ts`, `compose.ts`, `shard-writer.ts`, the M2a store, and the CF DO boot path (captured in `.superpowers/sdd/m2b-grounding.md`) tightened several points the initial design left optimistic:

1. **Global-table READS are a separate path and are equality-only in M2b.** Local reads flow through two distinct objects on `KernelContext`: point reads via `ctx.txn.get(id)` and scans/queries via `ctx.queryRuntime.collect/paginate(...)` — the latter deeply tied to the MVCC index keyspace. A global table has neither. M2b routes `ctx.db.get(id)` on a global table to `D1DocStore.get`, and an **equality** index query (`.withIndex(ix).eq(field, value)`) to `D1DocStore.queryByIndex` (which today supports only `{ eq, limit }`). **Range queries, ordering, filters beyond equality, and pagination on `.global()` tables are DEFERRED** (a documented M2b limitation) — mapping the full MVCC query surface onto D1 SQL is its own slice. A global-table query using an unsupported feature fails fast with a clear "not yet supported on global tables" error.

2. **Global writes bypass MVCC index maintenance.** Every local write handler calls `maintainIndexes(...) → ctx.txn.stageIndexUpdates(...)`, which is MVCC-log-index-keyed. Global writes must NOT enter that — D1 enforces indexes at the SQL level (M2a's `CREATE [UNIQUE] INDEX`). The `meta.mode === "global"` branch in each handler skips both `ctx.txn.put/delete` AND `maintainIndexes`, staging into the global overlay instead.

3. **The global-write overlay is a parallel object on `KernelContext`, not a widening of `ctx.txn`.** `TransactionContextImpl` is a concrete, non-pluggable class. Rather than widen it, add a per-mutation global buffer reached through a new optional `KernelContext` member (parallel to how `ctx.queryRuntime` already sits alongside `ctx.txn`), e.g. `ctx.globalTxn?: GlobalTxn` with `stage(op)/get(table,id)/queryByIndex(...)` serving read-your-own-writes from the buffer-then-D1. Absent (no D1 binding) → a `.global()` op fails fast.

4. **A global-only mutation commits via a D1 batch flush, separate from the MVCC OCC commit.** Because co-writes are forbidden (decision 1), a mutation is EITHER local-only OR global-only. The commit logic branches: local writes present → the existing MVCC `commit()` (unchanged); global writes present → flush the global overlay as one atomic `D1DocStore` batch; neither → no-op. A global-only mutation produces NO oplog and NO local-reactivity fan-out (correct — global reactivity is M2c). This keeps the delicate MVCC OCC/group-commit paths **untouched** for global mutations rather than threading a second store through them. `CrossStoreWriteError` (the co-write guard) guarantees the two buffers are never both non-empty at commit.

5. **Injection point needs one more grounding pass.** The D1 store is injected mirroring the existing `blobStore?: BlobStore` precedent: `DurableObjectAppConfig.d1?` (filled by the codegen'd DO subclass from `env.DB`) → `DurableObjectBootInput` → `bootDurableObjectRuntime` constructs `new D1DocStore(bindingD1Client(env.DB), schemaJson)` and `applyDdl()`s it → `createEmbeddedRuntime`. **`createEmbeddedRuntime` (`@stackbase/runtime-embedded`) is where `ShardWriter`/`TransactionContextImpl`/the `KernelContext` are actually constructed from the `store`, and was NOT yet read** — the implementation plan requires a grounding pass on `packages/runtime-embedded/src/*` to pin exactly where the global store + overlay thread onto `KernelContext`. This is the one open mapping before the plan's injection tasks can carry accurate code.

6. **`db.replace` is the only mutate-existing syscall** (no `handleDbPatch`); `.patch()` desugars above the kernel. The global routing branch is needed in `handleDbGet`/`handleDbInsert`/`handleDbReplace`/`handleDbDelete` and the query/paginate handlers — five/six sites, all keyed off `meta.mode`.

7. **`D1Client.batch()` and a `D1DocStore` batch-write are genuinely new** (M2a shipped neither; `run()` returns `{ changes }`, keep that flat shape). The batch is the atomic commit-flush primitive.

## Non-goals (explicit — these are M2c–M2e or deferred)
- **Global reactivity** (live subscription updates on `.global()` tables, poll-based invalidation) — **M2c**.
- **Cross-shard `fanOut` reads** — **M2d**.
- **`x-d1-bookmark` end-to-end threading** (HTTP and the WS wire field) + D1 read-replica reads — deferred scaling slice (decision 2).
- **Real-Cloudflare production proof** — a required checkpoint before M2c, not built in M2b (decision 3).
- **`.global()` on the SQLite/Postgres (non-Cloudflare) runtimes** — M2b's `.global()` is Cloudflare-D1-only; broadening it is a separate future decision.
- **Relaxing the co-write restriction** (allowing sharded+global in one mutation via 2PC/saga) — future, only if a real use case appears.
- **Range / sorted / paginated / non-equality queries on `.global()` tables** — deferred (refinement 1); M2b global reads are `get(id)` + equality-index only.
- **Schema migrations / `ALTER` on D1 tables** — deferred (M2a is create-only).
