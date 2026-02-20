# Tier 3 Slice 8 — replica-serve mode (implementation plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the design record (§7 replica,
> §8 cross-node reactivity), Slice 5 (the ObjectStoreReplicaTailer + the reactive injection surface + the
> consumer-watermark), and Slice 6/7 (the writer serve boot + driver wiring). The Slice-5 cross-node E2E
> already PROVED the reactive wiring end to end through `createEmbeddedRuntime`; this slice makes it a
> production `stackbase serve --object-store <url> --replica` deployment.

**Goal:** `stackbase serve --object-store <url> --replica` boots a read-scaled REPLICA node: it
materializes the shard from the bucket (no lease), tails the writer's new segments and drives its OWN
reactive fan-out (so its subscriptions see the writer's commits), publishes its consumer watermark (so
the writer's gc respects it), serves queries + subscriptions, and cleanly REJECTS mutations (it holds no
lease). N replicas over one bucket = read scale-out with no shared database.

**Architecture (the neat part — mutation rejection is free):**
- A replica opens the shard via `ObjectStoreDocStore.open({objectStore, shard, local})` WITHOUT calling
  `acquire()` (Slice 4 designed `open` to materialize-without-claim). Its `commitWriteBatch` already
  throws "not the lease owner" — so a mutation routed to the replica runtime is rejected at the store
  layer for free (no separate write-guard). We only improve the ERROR MESSAGE to name "read replica".
- The replica runtime = `createEmbeddedRuntime({ store: <the ObjectStoreDocStore, open-no-acquire> })`.
  Reads/queries forward to the materialized local SQLite; mutations hit `commitWriteBatch` → rejected.
- The `ObjectStoreReplicaTailer` (Slice 5) polls the manifest, pulls new tail segments, applies them to
  the SAME `local` the ObjectStoreDocStore wraps, and its `onInvalidation` sink drives the reactive tier
  via `runtime.observeTimestamp(newMaxTs)` → convert `writtenKeys`/`writtenDocs` to point ranges →
  `runtime.handler.notifyWrites({tables, ranges, commitTs})` → `runtime.notifyExternalCommit(...)` — the
  EXACT sink the Slice-5 E2E built inline, now a reusable production helper. The sink also
  `publishConsumerWatermark(objectStore, shard, consumerId, {appliedSeqno})` after each applied round so
  the writer's gc-driver (Slice 7) floors at this replica's watermark (never strands it).
- The tailer runs on its own `start(pollMs)`/`stop()` timer (it can't be a driver passed INTO
  `createEmbeddedRuntime` — its sink needs the runtime; chicken-and-egg — so it's started AFTER the
  runtime, mirroring the fleet's `node.ts` create-runtime-then-ReplicaTailer sequence). Stopped on
  graceful shutdown (+ `removeConsumer` so a departed replica stops pinning gc).

**Point-range conversion — a canonical shared home (de-dup):** `keyToPointRange`/`docKeyToPointRange`
currently live in `ee/packages/fleet/src/ranges.ts` and were COPIED into the Slice-5 E2E. Extract them to
a shared package the replica path can import without depending on `@stackbase/fleet` (prefer
`@stackbase/index-key-codec`, which owns `SerializedKeyRange`/key-range logic — confirm where
`SerializedKeyRange` is defined and co-locate). Re-export from `fleet/ranges.ts` so the shipped fleet API
+ tests are unchanged (a thin, low-risk re-export of identical logic). The replica sink + the Slice-5 E2E
then import the canonical version.

**Scope boundary (NOT in Slice 8 — the remaining tail):** multi-shard-single-node, the reshard tool (B5
Part 1), and the real-cloud benchmark. A replica serves READS/SUBSCRIPTIONS only; write-FORWARDING to
the primary (so a client could send a mutation to a replica and have it proxied) is a client-routing
concern, explicitly deferred — v1 rejects writes with a clear "read replica" message and the client
sends writes to the writer node's URL. Multi-shard replicas (one node tailing N shards) are deferred
with multi-shard-node.

## Global constraints (+ the whole-arc plan's)
- ee-gated (the object-store CLI path's existing entitlement gate). Engine/CLI never imports an S3 SDK.
- `--replica` REQUIRES `--object-store` (error clearly if given alone). numShards=1, shard="0"
  (single-shard, matching Slice 6/7; multi-shard-replica is deferred).
- The replica NEVER acquires a lease + NEVER runs the heartbeat/gc drivers (those are writer-only). It
  runs only the tailer + publishes its consumer watermark.
- Existing SQLite/PG/fleet/writer-object-store boot paths byte-identical when `--replica` is unset.
- Reuse verbatim: `ObjectStoreDocStore.open` (no-acquire), `ObjectStoreReplicaTailer` +
  `readGlobalFrontier` + `publishConsumerWatermark`/`removeConsumer` (Slice 5), the Slice-6 serve
  flag/shutdown machinery, `ensureGlobals` (adopt).

## Task 8.1 — canonical point-range conversion + the replica reactive-tailer wiring helper
**Files:** extract `keyToPointRange`/`docKeyToPointRange` to `@stackbase/index-key-codec` (or the package
owning `SerializedKeyRange`) + re-export from `ee/packages/fleet/src/ranges.ts`; new
`ee/packages/objectstore-substrate/src/replica-wiring.ts` (the helper); `src/index.ts` export; tests.
- **Extract the conversion:** move `keyToPointRange(indexId, key)` / `docKeyToPointRange(tableId,
  internalId)` (byte-for-byte, from `fleet/ranges.ts`) into the shared home; `fleet/ranges.ts`
  re-exports them (unchanged public API + tests). Confirm fleet's suite still passes.
- **The wiring helper** (`replica-wiring.ts`): `startReplicaReactiveTailer(opts: { runtime:
  ReplicaReactiveRuntime; objectStore: ObjectStore; shard: string; local: SqliteDocStore; consumerId:
  string; pollMs?: number }): { stop(): Promise<void> }` where `ReplicaReactiveRuntime` is the NARROW
  structural surface the sink needs (`observeTimestamp(ts: bigint): void`; `handler: { notifyWrites(inv:
  {tables: string[]; ranges: SerializedKeyRange[]; commitTs: number}): Promise<void> }`;
  `notifyExternalCommit(inv): void`) — kept narrow so the helper doesn't import `@stackbase/runtime-
  embedded` (avoid the dep; the CLI passes the real runtime, which satisfies the shape). The helper:
  constructs an `ObjectStoreReplicaTailer` with an `onInvalidation` sink that (a) `observeTimestamp(inv.
  newMaxTs)`, (b) converts `inv.writtenKeys`/`writtenDocs` to point ranges via the canonical fns, (c)
  `await runtime.handler.notifyWrites({tables: inv.writtenTables, ranges, commitTs: Number(inv.newMaxTs)})`,
  (d) `runtime.notifyExternalCommit(...)`, (e) `await publishConsumerWatermark(objectStore, shard,
  consumerId, { appliedSeqno: tailer.appliedSeqno })`; then `tailer.start(pollMs)`. `stop()` →
  `tailer.stop()`.
- [ ] 8.1a Failing test (mirror the Slice-5 cross-node E2E, but through the helper): a WRITER
      ObjectStoreDocStore (open+acquire) + its runtime commits a mutation to an fs bucket; a REPLICA
      (fresh local, ObjectStoreDocStore.open no-acquire) + its runtime; `startReplicaReactiveTailer` over
      the replica. Open a subscription on the replica runtime; the writer commits a NEW row; assert the
      replica subscription FIRES with the writer's data (the helper drove reactivity), the replica's
      `local` has the row, AND a `consumers/s0/<consumerId>` watermark object was published with the
      applied seqno. `stop()` halts the tailer.
- [ ] 8.1b Failing test: the extracted `keyToPointRange`/`docKeyToPointRange` produce identical output to
      fleet's (a golden-value test) — proves the extraction didn't change bytes. Confirm fleet's own
      tests still pass.
- [ ] 8.1c Implement. Build/typecheck/test green (objectstore-substrate + fleet + index-key-codec). Commit.

**Gate:** the helper drives cross-node reactivity + publishes the consumer watermark; the conversion is
canonically homed with fleet unchanged.

## Task 8.2 — CLI `--replica` boot path
**Files:** `packages/cli/src/serve.ts` (`--replica` flag + validation + shutdown), `packages/cli/src/
boot.ts` (build the replica node); a clear replica-write-rejection message; tests.
- `serve.ts`: `--replica` flag + (optional) `STACKBASE_REPLICA=1` env → `replica: boolean` on
  `ServeOptions`. Validate: `--replica` without `--object-store` → a clear `✗ --replica requires
  --object-store` error (mirror the fleet+object-store mutual-exclusion error style). Thread into
  `bootProject`. Shutdown: stop the replica tailer + `removeConsumer` BEFORE `store.close()`.
- `boot.ts`: when `objectStoreUrl` set AND `replica` → build a REPLICA node instead of the writer node:
  `resolveObjectStore` → `assertCasSupported` → `ensureGlobals(adopt)` → `local = makeStore` → `store =
  ObjectStoreDocStore.open({objectStore, shard:"0", local})` (NO acquire, NO heartbeat/gc drivers) → use
  `store` at the store seam → after the runtime is built, `startReplicaReactiveTailer({runtime, objectStore,
  shard:"0", local, consumerId: <minted per process>, pollMs})` and return its `stop` as the shutdown
  handle. Reuse `ensureGlobals`'s returned deploymentId to seed the runtime global (adopt, same as the
  writer).
- **Clear write rejection:** a mutation on a replica hits `commitWriteBatch` → "not the lease owner". For
  DX, surface a clear "this node is a read replica; send writes to the primary/writer node" — either by
  mapping that error at the serve/run boundary for the replica, or a thin store wrapper whose
  `commitWriteBatch` throws the clear message. If a clean hook isn't readily available, the lease error
  is an ACCEPTABLE v1 fallback (the E2E asserts the mutation is REJECTED; the message wording is a
  nice-to-have) — but prefer the clear message.
- [ ] 8.2a A hermetic boot test (via bootLoaded with a `file://` object-store URL + `replica: true`):
      the replica node materializes the writer's committed state from the bucket, a query returns it, and
      a mutation is REJECTED (assert the throw/clear message). `--replica` without `--object-store` →
      the validation error. Reuse the objectstore-boot.test.ts harness.
- [ ] 8.2b Implement. Build/typecheck green; existing paths unchanged when `--replica` unset. Commit.

**Gate:** `serve --object-store --replica` boots a read-only replica node (materialize + tail + serve
reads/subscriptions + reject writes clearly); `--replica` alone errors; writer/SQLite/PG paths untouched.

## Task 8.3 — Headline E2E: writer + replica over one bucket, cross-node reactive, fs + MinIO
**Files:** `packages/cli/test/objectstore-replica-e2e.test.ts` (two REAL serve processes).
- A shared `scenario(makeObjectStoreUrl)` mirroring the Slice-6 serve E2E harness:
  1. Boot a WRITER node (`serve --object-store <url>`) + a REPLICA node (`serve --object-store <url>
     --replica`) over the SAME bucket (distinct local data dirs, distinct ports).
  2. The replica adopts the deploymentId + materializes the writer's current state (a query on the
     replica returns it).
  3. Open a WebSocket subscription on the REPLICA; commit a mutation on the WRITER via `POST /api/run`;
     assert the REPLICA's subscription FIRES with the writer's new data (cross-node reactive propagation
     through two real serve processes, over object storage alone).
  4. Attempt a mutation via `POST /api/run` on the REPLICA → assert it's REJECTED (a clear read-replica
     error / non-2xx), and the writer's data is unaffected.
  5. Assert the replica published a consumer watermark (`consumers/s0/*` object exists in the bucket) —
     the writer's gc respects it.
- [ ] 8.3a fs (always-on) + MinIO-gated (`dockerAvailable() && STACKBASE_OBJECTSTORE_S3==="1"` → skip).
      Build/typecheck/test green (default skips MinIO). If docker available, run the gated arm + report.
      Commit.

**Gate (headline):** a real read-scaled fleet over an object store — a writer node + a replica node, no
shared database; a mutation on the writer fans out reactively to a subscription on the replica; the
replica rejects writes and publishes its watermark — proven through two real `stackbase serve` processes
on fs AND real MinIO.

## Self-review
- Delivers design §7/§8 (replica bootstrap + tail + cross-node reactive) as a real deployment mode +
  the Slice-5 consumer-watermark loop closed end to end (replica publishes, writer's gc respects). Multi-
  shard-replica, write-forwarding, reshard, real-cloud bench remain the explicit tail.
- Reuse honored: `open`(no-acquire), `ObjectStoreReplicaTailer`, `publishConsumerWatermark`/`removeConsumer`,
  the Slice-6 serve flag/shutdown machinery; mutation-rejection falls out of the lease requirement (no
  new write-guard). Point-range conversion canonically homed (de-dup, fleet unchanged).
- Type consistency: the helper's narrow `ReplicaReactiveRuntime` shape is satisfied by the real
  `EmbeddedRuntime` (`observeTimestamp`/`handler.notifyWrites`/`notifyExternalCommit`); `consumerId` is a
  per-process string; the watermark key is the shard-scoped `s{shard}/consumers/{id}` (Slice-7 fix).
- The `--replica` boot is strictly conditional; writer/existing paths byte-identical when unset.
