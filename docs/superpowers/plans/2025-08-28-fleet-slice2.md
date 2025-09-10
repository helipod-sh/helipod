# Fleet Slice 2 Implementation Plan — Embedded Replicas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync nodes serve all queries/subscriptions from a local file-backed `SqliteDocStore` replica fed by verbatim log tailing — primary read load per node drops to one tail cursor; reads survive a Postgres outage; forwarded writes keep read-your-own-writes.

**Architecture:** Spec = `docs/superpowers/specs/2025-08-28-fleet-slice2-replicas-design.md`. A fleet-owned `SwitchableDocStore` is the sync node's runtime store (delegate = local replica; promotion atomically swaps the delegate to the writable Postgres store — zero new core seams). The slice-1 `CommitTailer` evolves into a `ReplicaTailer`: one loop pulls `(watermark, newMax]` docs + index rows from the primary, applies them **verbatim** (`DocStore.write()` accepts exactly what `load_documents()` yields), derives the `WriteInvalidation` from the same batch (slice 1's derivation queries are deleted), and advances the watermark. `/_fleet/run` returns `commitTs`; the forwarder waits for the replica watermark to reach it (5s bound) — server-side RYOW.

**Tech Stack:** TypeScript, `ee/packages/fleet` (@stackbase/fleet, enterprise license), `pg` + PGlite (tests), file-backed `SqliteDocStore` via `NodeSqliteAdapter({path})`, vitest under Node, Docker-gated E2E.

## Global Constraints

- Without `--fleet`: **byte-for-byte today's behavior** — every task keeps the full monorepo gate green (`bun run build && bun run typecheck && bun run test`).
- Node/vitest tests, no Bun APIs. `bun run build` before cross-package tests (dist resolution). Run typecheck after tests pass (vitest doesn't typecheck).
- ee/ source files carry: `/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */`. FSL-core touches are the two spec §5 seams ONLY (`/_fleet/run` commitTs; fleet boot replica construction/threading) — no new core packages/dep edges; `packages/cli` keeps zero static `@stackbase/fleet` dependency (structural mirrors in serve.ts must be updated in lockstep when the fleet surface changes).
- Exact values: replica file `<dataDir>/fleet-replica.db`; RYOW wait bound **5000ms** (resolve + `console.warn` on timeout); bootstrap batch size **1000** log entries; apply strategy **"Overwrite"** (`ConflictStrategy`, verified — SQLite INSERT OR REPLACE mirror = idempotent re-apply); poll fallback stays 1000ms; ready line only after initial catch-up.
- The slice-1 keyspace lesson binds every bridge in this slice: reconstruct/derive using the producing side's own helpers/types (`packages/docstore` types, `@stackbase/id-codec` + `index-key-codec` helpers), and tests must compute expected values via those helpers — never hand-rolled strings/shapes.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Verified ground truth (do not re-derive):** `DocStore.write(documents: DocumentLogEntry[], indexUpdates: IndexWrite[], conflictStrategy, shardId?)` (`packages/docstore/src/types.ts:94`); `DocumentLogEntry {ts,id,value,prev_ts}` (:25); `IndexWrite {ts, update: DatabaseIndexUpdate}` (:63) with `DatabaseIndexUpdate {indexId, key, value: DatabaseIndexValue}` (:57); `ConflictStrategy = "Error" | "Overwrite"` (:40); `load_documents(range, order): AsyncGenerator<DocumentLogEntry>` (:115); `maxTimestamp()` (:127); file-backed sqlite `NodeSqliteAdapter({path})` (`packages/docstore-sqlite/src/node-adapter.ts:33-46`); whole-runtime-on-one-store holds because query `db.get` reads via `ctx.txn.get` (kernel.ts:150) and scans via `ctx.queryRuntime` (:253), both on the injected store. Slice-1 wiring: `prepareFleetNode` (`ee/packages/fleet/src/node.ts:112`) builds `NodePgClient` → `PostgresDocStore(client, {readOnly:true})` (:120) → `NotifyingFanoutAdapter` (:130) → writer boot `setWritable()` (:137) / sync boot `runtimeOptions {store, writeRouter, deferDrivers, fanoutAdapter}` (:161); `FleetPrep.store: PostgresDocStore` (:97-99); promotion sequence in `startFleetNode` (~:388-394); `CommitTailer` (`ee/packages/fleet/src/commit-notifier.ts:106`, private `watermark`, re-entrancy `draining` guard, `onInvalidation` with watermark-advance-after-resolve, `DerivedInvalidation {newMaxTs, writtenTables, writtenKeys, writtenDocs}`); point-range helpers `keyToPointRange`/`docKeyToPointRange` in node.ts; `/_fleet/run` handler `packages/cli/src/http-handler.ts:91` (response mirrors `/api/run`'s `{value, committed}` build at :144, `commitTs` available on the run result's `oplog`); boot threading `packages/cli/src/boot.ts:153-162` (`opts.fleet.store` overrides `makeStore`; `opts.dataPath` is the data dir) and :202-204 (runtime options spread); serve.ts structural mirrors of the fleet surface (~:19).

---

### Task 1: `SwitchableDocStore` (ee)

**Files:**
- Create: `ee/packages/fleet/src/switchable-store.ts`
- Modify: `ee/packages/fleet/src/index.ts` (append `export { SwitchableDocStore } from "./switchable-store";`)
- Test: `ee/packages/fleet/test/switchable-store.test.ts`

**Interfaces:**
- Consumes: `DocStore` (all members — enumerate from `packages/docstore/src/types.ts`, don't guess).
- Produces (Task 4 relies on): `class SwitchableDocStore implements DocStore { constructor(initial: DocStore); swapTo(next: DocStore): void; current(): DocStore }`. Every `DocStore` method reads `this.delegate` **once at call entry** into a local and completes against it (a call started pre-swap finishes on the old store; the next call sees the new one). `close()` closes the CURRENT delegate only (the swapped-out replica is closed by the lifecycle owner, not here — Task 4 owns that decision; document it in the class docstring).

- [ ] **Step 1 (failing test):** delegation for every `DocStore` member against two in-memory `SqliteDocStore`s with different contents: `get`/`index_scan`/`load_documents`/`maxTimestamp`/`getGlobal`/`setGlobal`/`write`/`setupSchema` answer from store A before `swapTo(B)` and from B after; the async-generator case (`load_documents`) started before a swap keeps yielding A's rows; `current()` identity.
- [ ] **Step 2:** Run `cd ee/packages/fleet && ../../../node_modules/.bin/vitest run test/switchable-store.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement (pure delegation; ~1 line per member; capture `const d = this.delegate` first in each method, including at generator-entry for `load_documents` before the first `yield`).
- [ ] **Step 4:** Test passes; `bun run --filter @stackbase/fleet test && bun run --filter @stackbase/fleet typecheck`.
- [ ] **Step 5:** Commit: `feat(fleet): SwitchableDocStore — atomic delegate swap behind the DocStore seam`

---

### Task 2: `ReplicaTailer` (ee) — verbatim apply + batch-derived invalidation + bootstrap

**Files:**
- Create: `ee/packages/fleet/src/replica-tailer.ts`
- Modify: `ee/packages/fleet/src/index.ts` (append export), `ee/packages/fleet/src/node.ts` ONLY to export/reuse the existing point-range helpers (`keyToPointRange`/`docKeyToPointRange` — move them into a shared `ee/packages/fleet/src/ranges.ts` if needed to avoid a node.ts↔replica-tailer import cycle; keep node.ts consuming the same functions).
- Test: `ee/packages/fleet/test/replica-tailer.test.ts`

**Interfaces:**
- Consumes: `CommitChannelClient` (structural, from commit-notifier.ts), `PostgresDocStore` (primary: `load_documents`, `maxTimestamp`, plus raw `indexes` SQL via the client), any `DocStore` (replica target), the shared point-range helpers, `DerivedInvalidation` shape (extend or parallel it).
- Produces (Tasks 3+4 rely on):

```ts
/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
export class ReplicaTailer {
  constructor(client: CommitChannelClient, primary: PostgresDocStore, replica: DocStore, opts: {
    pollMs?: number;                          // default 1000
    batchSize?: number;                       // default 1000 (bootstrap + steady-state pulls)
    onInvalidation: (inv: AppliedInvalidation) => Promise<void>;  // fires AFTER the batch is applied to the replica
  })
  start(): Promise<void>       // seeds watermark = await replica.maxTimestamp(); resolves AFTER initial catch-up to primary.maxTimestamp() at call time (the ready gate)
  stop(): Promise<void>
  watermark(): bigint
  /** Resolves when watermark >= ts (immediately if already), or when released(). Task 3's RYOW primitive. */
  waitFor(ts: bigint, timeoutMs: number): Promise<"reached" | "timeout" | "released">
  /** Releases ALL pending waitFor()s (promotion). */
  release(): void
}
export interface AppliedInvalidation { newMaxTs: bigint; writtenTables: string[]; writtenKeys: ...; writtenDocs: ... }  // same member shapes as slice 1's DerivedInvalidation
```

- Per-tick behavior (keep CommitTailer's LISTEN + poll wake, `draining` re-entrancy guard, watermark-advance-only-after-success): (1) `newMax = await primary.maxTimestamp()`; if `<= watermark` no-op. (2) Pull docs: iterate `primary.load_documents({after: watermark, upTo: newMax}-shaped range, "asc")` — VERIFY `TimestampRange`'s exact field names in `packages/docstore/src/types.ts` — collecting up to `batchSize` entries; if the batch fills, cap the tick's `newMax` at the last collected ts (next tick continues). (3) Pull index rows for the SAME `(watermark, cappedMax]` via SQL (`SELECT index_id, key, ts, table_id, internal_id, deleted FROM indexes WHERE ts > $1 AND ts <= $2 ORDER BY ts ASC`) and reconstruct `IndexWrite[]`: `deleted=true` → the Deleted variant of `DatabaseIndexValue`, else the NonClustered variant carrying the document identity — **VERIFY the exact `DatabaseIndexValue` union member names/fields in `packages/docstore/src/types.ts` and mirror how `postgres-docstore.ts`'s `write()` serializes them to those columns (that write path is the producer; invert it exactly — including bytea key decoding and NULL table_id/internal_id on Deleted rows).** (4) `await replica.write(docs, indexWrites, "Overwrite")`. (5) Build `AppliedInvalidation` from the in-memory batch with the shared helpers (index ranges from reconstructed index rows; doc ranges from DISTINCT `(tableId, internalId)` of the doc entries). (6) `await onInvalidation(inv)`; advance watermark; resolve any `waitFor(ts <= watermark)`.
- `CommitTailer` stays in place untouched this task (node.ts still uses it until Task 4 swaps; it is deleted in Task 4).

- [ ] **Step 1 (failing test):** PGlite-backed `PostgresDocStore` primary (writable) → in-memory `SqliteDocStore` replica. Tests: **(a) verbatim parity** — write 3 docs across 2 tables + updates + a delete on the primary (reuse the write-fixture shape from `ee/packages/fleet/test/pglite-client.ts` consumers / `packages/docstore-postgres/test/write-get.test.ts`), run the tailer to catch-up, then assert `replica.get(id, tsHistorical)` and `replica.index_scan(...)` outputs equal the primary's for the same args (historical ts included — MVCC parity), and `replica.maxTimestamp() === primary.maxTimestamp()`; **(b) idempotent re-apply** — force a second application of the same range (construct a second tailer with watermark 0 over the SAME replica) → no throw, same final state; **(c) invalidation parity** — the `AppliedInvalidation` for a write equals what slice 1's CommitTailer derived for identical writes (instantiate the old CommitTailer side-by-side in the test while it still exists — this is the regression bridge); **(d) tombstone-only batch** — a pure delete produces doc-keyspace ranges + applies the tombstone (replica.get → null); **(e) bootstrap gate** — `start()` on a primary with 2500 pre-existing entries resolves only after full catch-up (batch capping exercised: assert ≥3 onInvalidation calls) ; **(f) `waitFor`** — resolves "reached" on advance, "timeout" after a short bound, "released" after `release()`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** fleet suite + typecheck green. **Step 5:** Commit: `feat(fleet): ReplicaTailer — verbatim log apply, batch-derived invalidation, bootstrap catch-up, waitFor`

---

### Task 3: RYOW — `/_fleet/run` commitTs + forwarder watermark wait

**Files:**
- Modify: `packages/cli/src/http-handler.ts` (the `/_fleet/run` 200 response at :91's handler — add `commitTs: String(result.oplog?.commitTs ?? 0n)` alongside `{value}`; mirror `/api/run`'s result access at :144), `ee/packages/fleet/src/forwarder.ts`, `ee/packages/fleet/src/index.ts` if new exports.
- Test: `ee/packages/fleet/test/forwarder-ryow.test.ts` (+ extend the existing forwarder test file if present rather than duplicating stubs).

**Interfaces:**
- Consumes: `ReplicaTailer.waitFor(ts, timeoutMs)` / `release()` (Task 2).
- Produces: `WriteForwarder` gains `attachTailer(t: ReplicaTailer): void` and, in `forward()`, after a 200 response: parse `commitTs` (BigInt of the string; tolerate absence → skip wait, warn once) and `await tailer.waitFor(commitTs, 5000)`; on `"timeout"` → `console.warn` (include path + commitTs) and resolve anyway; `"released"` → resolve. `promote()` additionally calls `tailer?.release()`. No `WriteRouter` interface change.

- [ ] **Step 1 (failing test):** stub tailer with controllable watermark: forward() (against a stub fetch returning `{value, committed, commitTs:"7"}`) does not resolve until watermark reaches 7n; resolves immediately when already ≥; resolves + warns at the 5s bound (use fake timers); `promote()` releases a pending wait; response without commitTs skips the wait.
- [ ] **Steps 2–5:** fail → implement (cli response line + forwarder) → fleet + cli package suites + typecheck green → commit: `feat(fleet,cli): read-your-own-writes across forwarding — commitTs + replica watermark wait`

---

### Task 4: Node lifecycle — replica boot, ready gate, promotion swap

**Files:**
- Modify: `ee/packages/fleet/src/node.ts` (prepareFleetNode + startFleetNode), `ee/packages/fleet/src/commit-notifier.ts` (DELETE the CommitTailer class + its derivation internals; keep `NotifyingFanoutAdapter` + `CommitChannelClient` — move them if the file becomes trivial, updating imports), `packages/cli/src/boot.ts` + `packages/cli/src/serve.ts` (thread `dataPath` into the fleet prep + update the structural mirror types for the changed fleet surface), `ee/packages/fleet/src/index.ts`.
- Test: `ee/packages/fleet/test/node-lifecycle.test.ts` (extend existing node tests if present).

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces the new fleet surface (serve.ts mirrors updated in lockstep):
  - `prepareFleetNode(deps: { …existing…, dataDir: string })`: sync boot now builds `replica = new SqliteDocStore(new NodeSqliteAdapter({ path: join(dataDir, "fleet-replica.db") }))` (+ `await replica.setupSchema()`), `switchable = new SwitchableDocStore(replica)`, and `runtimeOptions.store = switchable` (the PG store remains in `FleetPrep` as `pgStore` for lease/tail/swap). Writer boot unchanged (runtime on the writable PG store directly — no switchable needed). Corrupted replica file: catch open/setupSchema failure → `rmSync` the file → retry once → warn.
  - `startFleetNode`: constructs `ReplicaTailer(client, pgStore, replica, { onInvalidation })` where onInvalidation = the existing notifyWrites bridge (ranges now come pre-derived) + `runtime.observeTimestamp(newMaxTs)`; `await tailer.start()` BEFORE the node reports ready (VERIFY how the ready line's timing is controlled — serve.ts prints it after `startFleetNode` returns or via a callback; make sync-role ready await catch-up, writer-role unchanged); `forwarder.attachTailer(tailer)`. **Promotion order becomes:** `runtime.observeTimestamp(await pgStore.maxTimestamp())` → `pgStore.setWritable()` → **`switchable.swapTo(pgStore)`** → `forwarder.promote()` (releases RYOW waits) → `await tailer.stop()` → `await runtime.startDrivers()` → onPromoted. After the swap, close the replica store (the swapped-out delegate — lifecycle owner per Task 1's docstring) and leave its file on disk.
- The sync node **no longer runs the PG store as its runtime store** — `PostgresDocStore(client, {readOnly:true})` is still constructed as the tail source + swap target (setWritable flips it at promotion exactly as slice 1).

- [ ] **Step 1 (failing test):** with PGlite primary + temp-dir replica file: (a) prepareFleetNode sync boot returns runtimeOptions whose store is a SwitchableDocStore over a file at `<tmp>/fleet-replica.db`; (b) full lifecycle against a real EmbeddedRuntime is covered by E2E — here assert the promotion sequence via an instrumented fake (spy order: observeTimestamp, setWritable, swapTo, promote/release, tailer.stop, startDrivers); (c) corrupted file path (write garbage bytes first) → boots after delete+retry with a warning; (d) restart resume: run tailer to ts N, dispose, re-prepare with same dataDir → new tailer.start() seeds watermark N (no re-apply of old entries — assert via onInvalidation not firing for old range).
- [ ] **Steps 2–5:** fail → implement (including CommitTailer deletion + import/mirror updates) → **full monorepo gate** (this task touches cli) → commit: `feat(fleet,cli): sync nodes boot on a file-backed replica; promotion swaps the store delegate`

---

### Task 5: E2E ship gate extension

**Files:**
- Modify: `ee/packages/fleet/test/fleet-e2e.test.ts`

**Interfaces:** consumes the shipped CLI (`bun run build` first). Keep the 6c78d42 hygiene: every wait bounded with informative failure, all processes in the module-level kill array, container removed in afterAll.

- [ ] **Step 1:** Extend the existing single-flow test (or add a sibling `it` reusing the harness) to cover, in order:
  1. **Slice-1 regression on the replica path:** existing assertions unchanged and passing (election, forward+push on B via its replica, SIGKILL failover with epoch bump, node C join) — the subscription/push assertions now implicitly prove tail→apply→invalidate.
  2. **RYOW:** mutate via B's `/api/run` → **immediately** (no sleep) query via B's `/api/run` → value present.
  3. **Offload proof:** `docker pause <pg>` → B's `/api/run` query still answers (200, correct data) and B's live subscription socket stays healthy → mutation via B fails within a bounded window (non-200 or error result — assert visible failure, not hang) → `docker unpause` → a fresh mutation commits and the subscription receives it (reconvergence).
  4. **Replica persistence:** assert `fleet-replica.db` exists under B's `--data-dir`; kill B (not the writer), restart with the same data dir → ready line within a tight bound (resume, not replay) and a query on restarted B serves current data.
- [ ] **Step 2:** `bun run build`, run the E2E: `cd ee/packages/fleet && ../../../node_modules/.bin/vitest run test/fleet-e2e.test.ts` — iterate to green (this is where promotion/apply/timing bugs surface; fix product bugs in the smallest correct way, separate commits, documented in the report). Note: `docker pause` semantics — the tailer's LISTEN connection survives a pause (TCP just stalls); ensure the offload assertions don't depend on NOTIFY during the pause.
- [ ] **Step 3:** Full monorepo gate. Commit: `test(fleet): slice-2 E2E — RYOW, postgres-pause offload proof, replica persistence`

---

### Task 6: Docs + finish

**Files:**
- Modify: `docs/enduser/deploy/fleet.md` (replica serving model, RYOW guarantee wording — "a mutation's response means your next read on the same node sees it", PG-outage read availability, `fleet-replica.db` location + safe-to-delete note, limits shift: sync-node reads no longer load the primary; remaining limits: single writer, no autoscaler), `docs/dev/architecture/tier2-topology-research.md` (status: slice 2 SHIPPED).
- [ ] **Step 1:** Write docs (match the file's existing voice; no pricing/promises beyond shipped behavior).
- [ ] **Step 2:** Full gate; commit: `docs(fleet): slice 2 — embedded replicas, RYOW, outage-tolerant reads`

## Execution notes

- Parallelizable: **T1 ∥ T2** after nothing (independent modules; T2's helper-extraction touch to node.ts is trivial — if run in parallel worktrees, T2 owns `ranges.ts` extraction and T1 must not touch node.ts). T3 after T2. T4 after 1+2+3 (the integration heart — most capable model). T5 after T4 (ship gate — most capable model). T6 last.
- T4 deletes CommitTailer — T2's parity-regression test (c) must be rewritten against recorded expectations or dropped at T4 (note for T4's implementer: keep the parity test by snapshotting expected invalidations, not by importing the deleted class).
