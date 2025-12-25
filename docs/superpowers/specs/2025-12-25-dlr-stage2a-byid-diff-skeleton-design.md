# DLR Stage 2a — The By-Id Diff Pipeline Skeleton

> **Status:** approved design (2025-12-25), ready for an implementation plan.
> **Parent:** [`docs/dev/architecture/reactivity-differential-log-tail.md`](../../dev/architecture/reactivity-differential-log-tail.md) §4.2–4.4/4.6 (Stage 2). Builds on Stage 1 (the interval-indexed matcher, shipped `fa4f8d7`).
> **Position:** Stage 2 is decomposed into vertical slices by query shape. This is **2a — the pipeline skeleton on the trivial `db.get(id)` shape**; 2b extends the differ to single-index-range `collect()` (the benchmark-measured shape); 2c handles pagination.

---

## 1. Motivation & strategy

Stage 2 replaces "re-run the query + send the full result" with "derive a row diff from the in-hand write entries + send the diff." That is a five-piece pipeline (write-entry fan-out → classifier → CommitDiffer → diff wire → client materialized cache + drift checksum), and its value only materializes **end-to-end**. Rather than build all five pieces against the hardest query shape at once, **2a builds the entire pipeline on the trivial `db.get(id)` shape** — where a write's new value simply *is* the query's new value — then 2b reuses the machinery for the shape that actually moves the benchmark (`collect()` lists).

Feasibility is already established in the code:
- The commit result carries an **`oplog: OplogDelta`** (`packages/executor/src/executor.ts:255,476`) — the written `{id, value, prev_ts}` MVCC entries, i.e. CommitDiffer's exact raw material. It is produced at commit but **not currently plumbed into the fan-out** (`notifyWrites` gets only `{tables, ranges, commitTs}` — `handler.ts:442`).
- The client's **`LayeredQueryStore`** (`packages/client/src/layered-store.ts`) already holds a per-query authoritative value plus a resume `hash`; it is the natural foundation for the `MaterializedCache`.
- The wire is already **version-bracketed** (`Transition{startVersion,endVersion,modifications}`), so diffs need no new fencing — just a new modification type.

## 2. Scope

- **In:** the full pipeline, but only the `db.get(id)` (single-doc) shape takes the diff path: oplog fan-out, a `DIFFABLE_BYID | RERUN` classifier, a by-id CommitDiffer, the `Change` vocabulary + shared `apply`, a `QueryDiff` wire modification, a client `MaterializedCache` (uniform keyed row-map), and the drift XOR checksum + scoped resync.
- **Out (later slices):** single-index-range `collect()` diffs (**2b** — the benchmark-measured shape), pagination-boundary diffs (**2c**). Any sub not classified `DIFFABLE_BYID` stays on today's RERUN full-result path — untouched.
- **Out (later DLR stages):** log-tail catch-up / `readLogSince` (Stage 3), client optimistic-over-diffs (Stage 4), fleet per-shard fragments (Stage 5). Reconnect resume already ships (the `hash` fingerprint).

## 3. Locked decisions

| Decision | Choice |
|---|---|
| First slice | `db.get(id)` skeleton — prove all five pieces on the trivial shape before 2b's differ. |
| Client model | **Uniform keyed row-map.** A DIFFABLE query's base is a `Map<key, row>`; by-id is a degenerate 0-or-1 entry map; one `apply(Change[])` machinery reused verbatim by 2b. |
| Drift checksum | **Built in 2a** — the mechanism (rolling XOR + scoped resync) is built and tested on the trivially-correct by-id case, so 2b's harder differ inherits a proven safety net. |
| Initial value | A DIFFABLE query communicates via `QueryDiff` for BOTH the initial base (a *reset*: one `add` per row, carrying ts + a checksum over the fresh map) and subsequent incremental diffs — so per-row ts is always carried and the checksum is always client-computable. RERUN queries use `QueryUpdated` (full value) exactly as today. |
| Fallback | RERUN full-result path is the always-available oracle; any classification/diff uncertainty degrades to it. |
| Fleet | A forwarded commit whose oplog isn't locally in hand → the affected DIFFABLE subs fall back to RERUN for that commit (correct, not diffed). Single-node is the diff path; multi-node diff fan-out is not required by 2a. |

## 4. Architecture

### 4.1 The `Change` vocabulary + shared `apply` — a new shared module

Adopt DLR §4.4's type, in a module importable by both `@stackbase/sync` (server) and `@stackbase/client`:

```ts
export type Change =
  | { t: "add"; key: string; row: JSONValue; ts: number }
  | { t: "remove"; key: string }
  | { t: "edit"; key: string; row: JSONValue; ts: number };

/** A materialized query row + its MVCC version. The client holds a Map<key, RowVersion>. */
export interface RowVersion { row: JSONValue; ts: number }

/** Apply changes to a keyed row-map (copy-on-write); returns the new map. The ONE apply used by
 *  server (to validate) and client (to materialize). Deterministic, pure. */
export function applyChanges(rows: Map<string, RowVersion>, changes: readonly Change[]): Map<string, RowVersion>;
```

Home: a small module in `@stackbase/sync` (the protocol's owner) re-exported to the client, OR a shared leaf package. The plan picks the exact location following existing patterns; the type is the contract. `key` is the document id (a string); `row` is the document's JSON; `ts` is the row's MVCC commit ts (carried so the client can compute the drift checksum — §4.5). `add`/`edit` carry the new row + ts; `remove` carries only the key.

### 4.2 Server — oplog fan-out + classifier + CommitDiffer (`packages/sync`, `packages/runtime-embedded`)

- **Oplog fan-out:** extend `WriteInvalidation` (or a parallel argument to `notifyWrites`/`doNotifyWrites`) to carry the commit's written entries as `{ key: string; keyspace: string; newRow: JSONValue | null; wasPresent: boolean }[]` (derived from the `OplogDelta` — `newRow: null` + a tombstone means delete; `wasPresent=false` means insert). Plumb it from `handler.ts:442` (the mutation commit site) where the `oplog` is in hand. Callers without an oplog (forwarded/fleet, HTTP external-write paths) pass `undefined` → those subs take RERUN.
- **Classifier:** at subscribe (where `readRanges`/`tables` are recorded), tag each subscription `DIFFABLE_BYID` iff its read-set is **exactly one point range in a table's primary (by-id) keyspace** and the query returned a single document or `null`; else `RERUN`. Store the class + the read id + the table on the `Subscription`.
- **CommitDiffer (by-id):** in `doNotifyWrites`, for each affected sub:
  - `RERUN` → today's path (`execSub` + `QueryUpdated`), unchanged.
  - `DIFFABLE_BYID` → find the oplog entry whose `key` equals the sub's read id. Emit one `Change`: `add` if `!wasPresent`, `remove` if `newRow===null`, else `edit` (`add`/`edit` carry the entry's `newRow` + its commit ts). Update the server's notion of the sub's current row-map (needed for the checksum). Emit `QueryDiff` (no `execSub`, **zero store reads**). If the oplog is absent (fallback) → RERUN.
  - The **initial subscribe answer** for a `DIFFABLE_BYID` sub is likewise a `QueryDiff` reset (an `add` for the doc if present, or empty changes if null) rather than a `QueryUpdated` — so the client seeds its row-map + per-row ts uniformly.

### 4.3 Wire — the `QueryDiff` modification (`packages/sync/src/protocol.ts`)

Add to `StateModification`:

```ts
| { type: "QueryDiff"; queryId: number; changes: Change[]; checksum: string }
```

Carried in the existing `Transition{startVersion,endVersion,modifications}` (same version fence). `QueryUpdated` (full value, RERUN) and `QueryFailed` are unchanged. An **old client** never negotiated diffs, so the server sends `QueryDiff` only to a client that advertised diff support on `Connect` (a capability flag) — otherwise that sub is treated as RERUN for that client. (Back-compat: a pre-2a client keeps getting `QueryUpdated`.)

### 4.4 Client — `MaterializedCache` (`packages/client`)

Extend `LayeredQueryStore`: a DIFFABLE query's authoritative base becomes a **`Map<key, RowVersion>`** plus its rendered value (the single doc or `null` for by-id — the render is "the sole map entry's row, or null"). On ingest:
- `QueryUpdated` → set the whole value (RERUN queries only), exactly as today.
- `QueryDiff` → `applyChanges(map, changes)` (a reset arrives as add-all over an empty map; incremental diffs mutate it) → recompute the checksum → recompute the rendered value → fire subscribers. Version-fenced by the enclosing `Transition` (no torn render).
- Advertise diff capability on `Connect`.

### 4.5 Drift checksum + scoped resync (`packages/sync` + `packages/client`)

- A rolling **`XOR` of `hash(key) ⊕ ts`** over the query's row-map (`ts` = each row's MVCC commit ts, already available server-side; the client carries it per row) travels as `QueryDiff.checksum`.
- Client recomputes after `applyChanges`; on **mismatch** it triggers a **scoped resync of that one query** (re-subscribe / request a full `QueryUpdated`), never a global refetch. The resync path reuses the existing subscribe/answer machinery.
- For by-id the diff is trivially correct, so a mismatch should never fire in normal operation — the E2E test **forces** one (inject a wrong checksum) to prove the resync path works.

## 5. Correctness strategy

- **Server differential oracle:** for a `DIFFABLE_BYID` sub, `applyChanges(oldRowMap, CommitDiffer.changes)` must equal the row-map derived from a fresh `execSub` re-run — a property test over randomized by-id insert/update/delete sequences. (Same oracle discipline that de-risked Stage 1.)
- **`applyChanges` unit tests:** add/remove/edit, absent-key edit, idempotence, empty changes.
- **Classifier tests:** by-id get → DIFFABLE_BYID; a `collect()`/filtered/multi-range read → RERUN; a by-id returning null → still DIFFABLE_BYID.
- **Checksum tests:** matching checksum applies cleanly; a forced mismatch triggers exactly one scoped resync and recovers.
- **E2E through the real `stackbase dev` server** (`packages/cli/test/`): a by-id subscription (a) gets a full `QueryUpdated` on first subscribe, (b) gets a `QueryDiff` (not `QueryUpdated`) on a subsequent write and renders the new doc, (c) self-heals from a forced checksum mismatch, (d) an old (non-diff) client still gets `QueryUpdated`.
- **Regression:** the full existing sync + client suites pass unchanged (RERUN path untouched).

## 6. Acceptance gate

2a's gate is **correctness + the pipeline existing end-to-end**, NOT a benchmark delta — by-id already sends a single doc, so wire bytes don't change here. The measured win is 2b's gate (the `diffbytes`/`fanout-selective` collapse). Concretely, 2a passes when:
- The E2E test proves a real by-id `QueryDiff` round-trip through the dev server, with checksum self-heal and old-client back-compat.
- The server oracle proves diff+apply ≡ re-run for by-id.
- `bench:reactive` shows **no regression** on any scenario (the RERUN path, which every bench scenario currently uses, is unchanged; by-id isn't a bench scenario).
- Full monorepo green.

## 7. Risks

- **Oplog plumbing across paths.** The mutation commit has the oplog; forwarded/fleet/HTTP-external writes may not. Mitigation: `undefined` oplog → RERUN for affected subs (correct, just not diffed). Enumerate every `notifyWrites` caller in the plan and default each to RERUN unless it can supply the oplog.
- **Classifier false-positive** (a sub wrongly tagged DIFFABLE_BYID) → a wrong diff. Mitigation: the drift checksum catches divergence → scoped resync; and the classifier is conservative (exactly-one-point-read-in-primary-keyspace-returning-single-doc).
- **Server-side per-sub row-map state for the checksum.** 2a keeps a minimal current-row-map per DIFFABLE sub in memory (for by-id, 0-or-1 rows — tiny). This is NOT a durable CVR (DLR forbids that); it's ephemeral matcher-adjacent state, dropped on unsubscribe. Bounded and small.
- **Capability negotiation.** A client that advertises diffs must handle `QueryDiff`; a client that doesn't must never receive one. The `Connect` flag + per-sub RERUN-for-old-clients covers it; the E2E old-client test guards it.
- **Wire/protocol back-compat.** `QueryDiff` is additive; `QueryUpdated`/`QueryFailed`/resume `hash` all unchanged.

## 8. Provenance

Grounded in `packages/sync/src/handler.ts` (fan-out + push), `packages/executor/src/executor.ts` (the commit oplog), `packages/client/src/layered-store.ts` (the query-value store), `packages/sync/src/protocol.ts` (the wire), and the DLR design §4.2–4.4/4.6. Decomposition into by-id → range-collect → pagination vertical slices agreed 2025-12-25. Correctness rests on the RERUN path as the oracle; the perf win is deferred to 2b.
