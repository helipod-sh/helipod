# SpacetimeDB — Engine Internals (code-verified deep dive)

**Companion to [`spacetimedb.md`](spacetimedb.md)** (the high-level positioning + published benchmark
numbers). This document is a **mechanism-level, code-verified** analysis of the open-source
SpacetimeDB engine (the `spacetimedb-standalone` / self-host edition in `.reference/SpacetimeDB`,
~1,400 Rust files across ~50 crates), produced from a six-way parallel source read (2025-11-04). Every
claim traces to a `crate/file:line`. Written to inform Stackbase's own design — the comparison and the
transferable ideas are in the last two sections.

**One-line thesis:** SpacetimeDB collapses `client → app-server → database` into `client →
database-that-runs-your-code`. Application logic ("modules") is uploaded *into* the database process and
runs there — as WebAssembly (Rust/C#/C++) **or** as JavaScript in an embedded V8 isolate (TypeScript) —
against **in-memory** tables, with durability by an **async, batched commit log**. It is, structurally,
what you get if you take the questions "make it faster by removing the I/O/network waits" and "run user
functions in many languages" to their architectural conclusion.

---

## 1. The big picture — one process, logic fused with data

- **Host** = the long-running server process (`spacetimedb-standalone`, `crates/standalone/src/main.rs`).
  A single host runs **many independent databases**, each addressed by a 32-byte `database_identity`
  (blake3-derived, optionally name-aliased); the control-plane data model already has
  `Database`/`Replica`/`Node`/`leader` (`crates/core/src/messages/control_db.rs:25-121`) — multi-node is
  modeled even though the OSS binary runs single-node.
- **Module** = the developer's schema + logic, stored as a `Program {hash, kind: HostType, bytes}` where
  `HostType` is `Wasm` or `Js` (`control_db.rs:98-102`).
- **`ModuleHost`** (`crates/core/src/host/module_host.rs`) = the live instance. Its outer interface
  (`call_reducer`, `init_database`, `update_module`, …) is **runtime-agnostic** over two backends behind
  a common abstraction; instantiation forks exactly once (`host_controller.rs:820-862`):
  `HostType::Wasm → wasmtime.make_actor` (compiles WASM to native), `HostType::Js → v8.make_actor`
  (embeds a V8 isolate, runs the JS bundle). Everything downstream never knows which.
- **`RelationalDB` / `datastore`** = the in-memory MVCC-ish storage engine. **`ModuleSubscriptions`** =
  the reactivity engine. Bundled per replica in `ReplicaContext` (`crates/core/src/replica_context.rs`).

**Reducer** = the only write path: a transactional, deterministic exported function. Each call runs
inside exactly one serializable `MutTxId`, committed or rolled back atomically on return/throw. No nested
transactions (nested reducer calls share the outer tx).

## 2. The reducer/request lifecycle (what happens on a call)

Client `CallReducer` over WebSocket → `message_handlers*.rs` → `ModuleHost::call_reducer`
(`module_host.rs:2207-2398`): resolve reducer by name, reject unknown/lifecycle/private, BSATN-decode +
typecheck args → `call_reducer_with_tx_offset` (`wasm_common/module_host_actor.rs:953-1116`):

1. `stdb.begin_mut_tx(IsolationLevel::Serializable, Workload::Reducer)` — opens the mutable tx (**takes
   the global write lock up front**).
2. Invoke the module's exported reducer (WASM or V8), energy-budget-gated; it makes **syscalls** back
   into the host to read/write rows through the open tx.
3. Classify outcome: `Committed` / `FailedUser` (app error — expected) / `FailedInternal` / `OutOfEnergy`
   / WASM `Trap` (discards the instance — post-trap WASM state is untrusted).
4. On success → `commit_and_broadcast_event` (`module_subscription_actor.rs:1736-1839`): take a **read
   lock on the subscription manager *before* committing** (race-free broadcast), `commit_tx_downgrade`
   (commit + downgrade to a read tx, yielding `tx_data` = the write set), build a `DeltaTx`, run
   `eval_updates_sequential` to compute per-subscriber deltas, hand off to an async send worker, ack the
   caller.

The whole path is **in one OS process — no network hop for "app logic touches data."**

## 3. Storage engine — in-memory pages, single serial writer

- **Rows live in fixed 64 KiB pages** (`crates/table/src/page.rs`, `PAGE_SIZE = 65536`), a slotted-page
  layout (BFLATN — a C-struct-like fixed section + a var-len section with intrusive freelists), **not**
  boxed structs and **not** columnar. Pages are recycled via a bounded shared `PagePool`
  (`page_pool.rs`, ~128 pages default) to avoid malloc churn. Large values are content-addressed
  (BLAKE3) and refcount-deduped in a `BlobStore`.
- **Row identity** is a packed `u64` `RowPointer` (`indexes.rs:250-278`): page index + offset + a
  `SquashedOffset` tag (`TX_STATE` vs `COMMITTED_STATE`) — the trick that lets a transaction compose
  "committed rows + my uncommitted rows" without copying.
- **Indexes** (`table_index/mod.rs`) are **specialized by key type** (`BTreeIndex`, `HashIndex`, unique
  variants) so integer-PK lookups compile down to `u64::cmp` — no enum-tagged comparison on hot paths.
  All indexes store `RowPointer`s, never row copies.
- **Concurrency = single serial writer, lock-based, NOT OCC.** `Locking` holds
  `committed_state: Arc<RwLock<CommittedState>>` (`datastore.rs:64-70`). A mutable tx takes the
  **exclusive write lock for its whole duration** (`begin_mut_tx`, `:920`); read-only txs take a shared
  read lock (many concurrent readers, but not concurrent with the writer). Writes accumulate in a
  per-tx `TxState` overlay (`insert_tables`/`delete_tables`); **commit = merge the overlay into
  `CommittedState` while holding the write lock** (`committed_state.rs:553-605`), producing `TxData`.
  Rollback = drop the overlay. The doc comment is explicit: *"this implementation guarantees the highest
  isolation level, Serializable"* — achieved by *"actually permit only one transaction to run at a
  time"* rather than read-tracking.
- **No conflict/retry path exists.** There is a vestigial `WriteConflict` type whose handler is literally
  `todo!("Write skew, you need to implement retries my man, T-dawg.")`
  (`module_subscription_actor.rs:203`) — unreachable under the serial-writer design. A failing reducer
  just rolls back; there is no re-execution.

> **Direct parallel to Stackbase:** this is the *same* single-serial-writer, no-OCC-needed choice
> Stackbase makes per shard. The fastest real-time DB in this space chose exactly the model you asked
> "can we beat?" — and the answer both systems give is "shard/replicate to scale, don't parallelize the
> writer."

## 4. Durability — the async, batched-fsync commit log (the key speed mechanism)

State is applied to in-memory `CommittedState` **synchronously** inside the tx; persistence is **decoupled
and never on the reducer's critical path**:

- `Durability::append_tx` is contractually **non-blocking** (`durability/src/lib.rs:127-147`: *"This
  method must never block, and accept new transactions even if they cannot be made durable
  immediately"*). `request_durability` just enqueues a boxed closure onto a bounded channel
  (`local.rs:344-347`).
- A background **`Actor`** (`local.rs:250-335`) drains the channel with `recv_many` (up to
  `batch_capacity`, default 4096), writes the batch to the commit log via `spawn_blocking`, then
  `flush_and_sync` (**the one fsync**) and advances a published `durable_offset` watch. So under light
  load ≈ fsync-per-tx; under heavy load it **naturally becomes group commit** — *implicit* batching driven
  by queue depth, **no fixed timer/window**.
- **Normal reducer calls do not wait for durability** — the client is acked after the in-memory commit +
  enqueue. Only an internal bootstrap path calls `DurableOffset::wait_for`. Rationale, verbatim
  (`zen-of-spacetimedb.md`): *"persistence guarantees only ever increase latency and never decrease
  throughput"* — justified by SSD write bandwidth (~15 GB/s) exceeding the in-memory write rate on
  average.
- **Commit log format** (`crates/commitlog`): append-only 1 GiB segments; each commit is
  `min_tx_offset | epoch | n | len | records | crc32c`; a record carries the reducer name + BSATN args
  **and** the row mutations (so the log is also a replayable call/audit log). `epoch` (leader term) is
  reserved for future replication. Torn tail writes are truncated to the last CRC-valid commit on
  reopen.
- **Snapshots** (`crates/snapshot`) are content-addressed (BLAKE3 pages/blobs, hard-linked across
  snapshots for cheap deltas), taken every 1,000,000 txs and on segment rotation. **Recovery** = load
  latest snapshot → replay the commit log forward from its offset (`replay.rs`). No snapshot ⇒ replay
  from offset 0.

> **Transferable to Stackbase now:** this is *exactly* the batched-fsync lever, and it maps onto the
> fleet-B4 group-commit work — except SpacetimeDB derives the batch from **queue depth** (continuous,
> self-tuning) rather than a fixed flush window. Worth adopting that shape. It's adoptable **without**
> abandoning Postgres as the store.

## 5. Query engine — a restricted SQL, compiled and deterministic

- **SQL subset** (`crates/sql-parser`, over `sqlparser`'s Postgres dialect): `SELECT [DISTINCT] … FROM …
  [WHERE][ORDER BY][LIMIT]`, `INSERT/UPDATE/DELETE`, `[INNER] JOIN … ON` only (no OUTER, no FROM-subqueries,
  aggregates limited to `COUNT`/`SUM`). A `:sender` param resolves to the caller identity at parse time.
- **Pipeline:** parse → typed logical `RelExpr` (`crates/expr`) → `PhysicalPlan` (`crates/physical-plan`,
  every table→`TableScan`, filter→`Filter`, equi-join→`HashJoin`, else `NLJoin`) → **optimizer**
  (`plan.rs:491-550`: push filters to leaves, `HashToIxJoin` turns a hash join into an index join when the
  RHS has a usable index, `IxScanFromPredicates` turns `Filter(TableScan)` into an index point/range scan
  when equality predicates fully cover an index, semijoin introduction) → streaming executors
  (`crates/execution/pipelined.rs`, tuple-at-a-time via callbacks; hash joins are the only pipeline
  breakers).
- **Everything funnels through one engine:** reducer `ctx.db` access, ad-hoc client SQL, and subscription
  re-evaluation all run the same physical plans against a `Datastore + DeltaStore` trait pair — a client
  SELECT runs against a read tx; a reducer's writes run DML against its `MutTxId`.
- **Determinism by construction:** the physical expression type has no clock/RNG/IO node
  (`PhysicalExpr` = LogOp/BinOp/Value/Param/Field); the only environmental inputs are resolved params
  (`:sender`, view-arg hashes) — fixed inputs, so re-evaluating a plan against the same tx+params is
  reproducible (required for incremental subscription maintenance).
- `crates/index-scan-gate` is **not** a runtime guard — it's a **CI perf-regression gate** that fails the
  build if an index-scan reducer's median exceeds **100 µs** over 31 runs. (A benchmark-as-CI-gate, the
  same discipline as our own perf backlog.)

## 6. Reactivity — incremental view maintenance + indexed subscription matching

**This is the most important section for Stackbase**, and it's a *more advanced* design than "re-run the
query on invalidation." SpacetimeDB does **incremental view maintenance (IVM)**, and it **indexes
subscriptions** so it never scans all of them.

- **A subscription is a set of SQL `SELECT`s** over a WebSocket. At **subscribe time**, each is compiled
  once into a **base plan** (for the initial result) *plus* IVM **`Fragments`**: delta-plan variants where
  a table scan is swapped for a "delta scan" over only inserted/deleted rows. A single-table query → 2
  fragments (insert-plan, delete-plan); a 2-table join → 4 each, from the bag-relational identity
  `dv = R'ds₊ ∪ dr₊S' ∪ dr₊ds₋ ∪ dr₋ds₊` (`crates/subscription/src/lib.rs:89-238`). **The query is
  compiled into a small incremental-maintenance program up front, not re-planned per write.**
- **Subscriptions are deduplicated by `QueryHash`** — *"if a query has N subscribers, it is executed once,
  with results copied to the N receivers"* (`module_subscription_manager.rs:496-500`).
- **The O(N) fix — subscriptions are indexed** (`module_subscription_manager.rs`), so a commit *looks up*
  matching subscriptions instead of scanning all of them:
  - `SearchArguments` — subscriptions with `WHERE col = <literal>` indexed by `(table_id, col_id, value)`;
    a changed row triggers only queries whose registered value it matches.
  - `JoinEdges` — join subscriptions with a unique-index equality indexed by filter value in a `BTreeMap`.
  - `tables` — the catch-all inverted index `TableId → {QueryHash}` for subscriptions with no usable
    equality/join filter (every write to that table triggers them).
  The doc comment gives the exact win: 1000 clients each `WHERE id = <distinct>` + a 1-row write ⇒ **~1
  query evaluated, not 1000**.
- **The delta step** (`delta.rs`, `tx.rs`): for each candidate query, run its insert-fragments against a
  `DeltaTx` where the "delta" table scan iterates **only the tx's newly-inserted rows** (and builds ad-hoc
  B-tree indexes over just those delta rows for joins). For a join, `R'`/`S'` are the *current* table
  (index lookups), `dr`/`ds` are the delta rows — a join delta is the delta rows joined against the live
  other side, never a full re-join. Bag/multiplicity counters keep duplicates correct.
- **It sends a diff (inserts/deletes), never a re-fetched full result** — exactly the client-cache-
  maintenance protocol the SDKs apply to their local reactive row cache.
- **Fan-out is off the hot lock:** `eval_updates_sequential` computes deltas once per distinct query
  (holding the datastore lock, must be fast) and hands them to a separate **`SendWorker`** that groups per
  client, BSATN-encodes, compresses, and pushes — *"so transaction processing can proceed on the main
  thread ahead of broadcasting… avoids starving the next reducer."*
- **They *removed* rayon (multi-core) subscription evaluation** in favor of single-threaded, because for
  typical small commits index-pruning beats thread-dispatch overhead
  (`module_subscription_manager.rs:1340-1344`). (Independent confirmation of our "threads aren't the lever
  here" finding.)
- **Consistency:** the delta comes from the same committed `TxData`; the subscription lock is taken before
  the commit-broadcast; an optional per-connection `confirmed=true` flag delays a push until its tx offset
  is durable (a latency-vs-durability knob).

## 7. Multi-language modules — WASM for compiled langs, V8 isolate for JS

The answer to "language-agnostic user functions via WASM," from a system that shipped it:

- **Compiled languages (Rust, C#, C++) → real WASM ABI.** The module exports `__describe_module__`
  (schema) and `__call_reducer__`/`__call_procedure__`/`__call_view__`; it imports host **syscalls** —
  `datastore_{table_scan,index_scan_range,index_scan_point,insert,update,delete}_bsatn`, row-iterator
  advance/close, `console_log`, `identity`, etc. Data crosses only as **BSATN bytes** via two host-managed
  handles (`BytesSource` read, `BytesSink` write); errors are `u16` errnos, not exceptions. **ABI versions
  are additive WASM import-namespaces** (`spacetime_10.0`, `10.1`, … — `bindings-sys`), so old modules keep
  working against a newer host. Rust uses proc-macros (`#[table]`/`#[reducer]`) to generate the exports; C#
  uses a Roslyn source generator + NativeAOT-to-WASM; C++ uses macros. Rust is most mature; C# is fully
  real; C++ newer.
- **TypeScript → NOT WASM.** SpacetimeDB built a **second host backend** (`crates/core/src/host/v8/`) that
  **embeds a V8 isolate per module** and runs the JS/TS source directly. Its "syscall ABI" is a virtual
  ES module `'spacetime:sys@2.0'` whose functions take/return **native JS values** (`Uint8Array`,
  `bigint`) — not WASM linear memory. It shares only the *type system* (SATS/BSATN) and the *shape* of the
  describe/dispatch convention with the WASM path, **not the transport**. TS is a first-class *server*
  module target, just under an embedded interpreter rather than sandboxed WASM.
- **SATS** (`crates/sats`) = an algebraic type system (sum/product/primitives, `Ref` into a flat
  `Typespace`) that is the **single source of truth for schema** — shared literally across storage layout,
  wire protocol, and codegen (avoids the "3 schemas drift" of JSON-Schema + SQL DDL + TS types). **BSATN**
  is its compact, non-self-describing binary encoding; a **BFLATN↔BSATN fast path** makes converting a
  fixed-shape row to wire bytes *a few memcpys*, not a per-field encode loop (`static_layout.rs`).
- **Wire protocol** (`client-api-messages`): binary BSATN over WebSocket (v3 `"v3.bsatn.spacetimedb"`);
  `ClientMessage` = Subscribe/Unsubscribe/OneOffQuery/CallReducer/CallProcedure; `ServerMessage` =
  Initial/SubscribeApplied/TransactionUpdate(insert/delete deltas)/results. A JSON path exists for
  browser debugging.

> **The decisive lesson (validates a Stackbase locked decision):** SpacetimeDB — a Rust engine that
> *could* have forced everything through WASM — concluded that **for a GC'd scripting language (JS/TS),
> WASM isn't worth it; embed the interpreter (V8) instead.** WASM pays off only for statically-compiled,
> non-GC languages that already need a build step. So multi-language for Stackbase is **not** "rewrite to
> WASM" — it's "keep the JS/V8 isolate (already the reserved seam), *add* a WASM backend for compiled
> languages behind a shared type system + describe/dispatch convention." The transport bifurcates by
> runtime; the type system and ABI *shape* stay unified.

## 8. Performance — what actually makes it fast, and where time goes

- **The dominant win is structural, not the language: no network hop + in-memory reads.** A reducer reads
  and writes local in-memory pages via in-process host-function calls. There is no "app-server ↔ Postgres
  over a socket" leg — which is precisely the leg that, in Stackbase's own benchmarks, showed the CPU
  sitting **63–87% idle waiting on Postgres**. SpacetimeDB deletes that wait by construction.
- **Where the time goes on an empty reducer: ~20 µs** (an engineer's comment next to the measurement,
  `bench/src/spacetime_module.rs:38`) — dominated by the WASM call boundary + a couple of in-process
  channel ops, **not** disk or network. Per-ABI-call instrumentation is *off by default because even
  measuring the boundary is expensive* (`instrumentation.rs:10-11`) — i.e. the host↔module crossing is
  cheap-but-not-free.
- **Benchmark suite** (`crates/bench`): three parallel impls behind one `BenchDatabase` trait —
  `stdb_raw` (datastore direct), `stdb_module` (full WASM reducer path), and **`sqlite`** as the external
  baseline; Criterion (wall-clock) + iai-callgrind (exact instruction counts, Linux only, sync path only).
  Scenarios: empty_transaction / insert_1 / insert_bulk / iterate / filter / find_unique / delete over
  `person`/`location` schemas × index types × load, plus `serialize/{bsatn,json}` and `db_game/{circles,
  ia_loop}` game-tick workloads and a `subscription` bench (up to 1M rows). **No throughput numbers are
  checked into the repo** — the "100–1000× faster" / "sub-microsecond" claims are marketing/architectural,
  not reproducible from source (the ~20 µs empty-reducer comment is the one hard in-repo number).
- **Honest tradeoffs of the fast design:**
  - **Durability *window*, not guarantee:** a crash loses writes committed-in-memory-but-not-yet-fsynced
    (like Postgres `synchronous_commit=off`, but structural; no per-call "wait for durable" on the normal
    path).
  - **Dataset bounded by RAM** — no cold/warm disk tiering; the commit log/snapshots are for durability +
    fast restart, never a swap tier. Capacity planning = provision RAM or shard into many instances.
  - **No built-in multi-tenancy scale-out:** scale = spin up many single-tenant instances via external
    orchestration (e.g. one DB per game room/match), the opposite of a shared multi-tenant Postgres.
  - **Compute and data are one deploy unit:** great for zero-downtime module hot-swap (clients stay
    connected), but there's no "stateless app fleet + shared external DB" option.
  - **WASM sandbox cost is real** (the ~20 µs floor), just far cheaper than a network round-trip.

## 9. Stackbase ↔ SpacetimeDB — convergences and divergences

| Dimension | SpacetimeDB | Stackbase | Verdict |
|---|---|---|---|
| Write concurrency | **Single serial writer** (global write lock), no OCC (`todo!`) | **Single writer per shard**, OCC-replay | **Same core choice** — validated |
| Store | **In-memory pages**, RAM-bounded | **Pluggable** SQLite/Postgres (on disk) | Fundamental divergence (their speed source vs your portability) |
| Durability | Async, **queue-depth-batched** commit log; ack before fsync | Per-commit through the store; fleet-B4 group commit (fixed window) | **Adopt their queue-depth batching shape** |
| App logic | Runs **inside** the DB (no network hop) | Separate engine ↔ external store (the I/O wait) | Their biggest win; incompatible with your pluggable-store decision |
| Reactivity | **IVM + indexed subscription matching**, sends diffs | Read-set/write-set intersection, **re-runs** queries; O(N) matcher today | **Adopt: index the matcher; consider IVM + diffs** |
| Multi-language | **WASM (Rust/C#/C++) + V8 isolate (JS/TS)** | JS/V8-isolate seam reserved, TS-only today | **Their split is the roadmap for your multi-language** |
| Type system | **SATS** — one schema for storage+wire+codegen | `@stackbase/values` validators + codegen | Their single-source-of-truth is worth studying |
| Scale-out | Many single-tenant instances (external orchestration) | Multi-tenant + fleet sharding/replicas | Divergent; yours is more BaaS-shaped |

## 10. What it means for Stackbase's open questions

- **"Convert to Rust to go faster" — still no, and SpacetimeDB proves the *real* speed source.** Their
  speed is **not** Rust; it's **no network hop + in-memory state**. Rust is just the safe sandbox language.
  You cannot get their win without fusing logic into the DB and going in-memory — which contradicts your
  locked pluggable-store decision, and would trade away deploy-anywhere/large-datasets. The transferable
  speed ideas that **don't** require the rewrite: **(1) queue-depth-batched async durability**, **(2) a
  wire-compatible in-memory row layout (BFLATN/BSATN analog) to cut serialization**, **(3) indexed
  subscription matching**, **(4) IVM + diff pushes**.
- **"Language-agnostic functions via WASM" — viable, but not via WASM-for-everything.** Keep the JS/V8
  isolate for TS (SpacetimeDB did exactly this), and *add* a WASM backend for compiled languages behind a
  shared type system + describe/dispatch shape. This is an incremental addition to the existing engine, not
  a Rust rewrite.
- **"Edge (Cloudflare) via WASM" — SpacetimeDB is a poor template for it, and that's informative.** Its
  model is "one big stateful in-memory process per database" — the *opposite* of stateless edge Workers.
  The edge fit for a reactive engine is **Durable Objects = single-writer-per-shard + hibernatable
  WebSockets + D1/DO storage adapter**, which is Stackbase's *sharding* abstraction, not SpacetimeDB's
  monolith. So edge remains viable for Stackbase, but you'd borrow the *reactivity/subscription-indexing*
  ideas from SpacetimeDB, not its deployment shape.

## 11. The single highest-leverage takeaway

If you adopt one thing from SpacetimeDB, make it the **reactivity design**: **index subscriptions by
`(table, filter-value)`/join-edge (kills the O(N) matcher — already your #1 backlog item), compile each
subscription into IVM delta-plans once, run only the changed rows through them on commit, and push a diff
(inserts/deletes) instead of a re-run result.** It's store-agnostic (works over Postgres), it's the
biggest measured reactive win available, and SpacetimeDB is a working, code-verified proof that it scales
to real-time-game fan-out.

## Sources

Code read in `.reference/SpacetimeDB` (self-host OSS edition): `crates/{core,datastore,table,commitlog,
durability,snapshot,subscription,execution,physical-plan,expr,sql-parser,query,bindings,bindings-sys,
bindings-macro,bindings-csharp,sats,client-api,client-api-messages,codegen,bench,standalone}` + `docs/`.
Six-agent parallel deep read, 2025-11-04. See [`spacetimedb.md`](spacetimedb.md) for the high-level
overview and Clockwork Labs' published benchmark numbers.
