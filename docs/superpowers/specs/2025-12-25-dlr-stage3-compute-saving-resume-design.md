# DLR Stage 3 — Compute-Saving Reconnect Resume

> **Status:** approved design (2025-12-25), ready for an implementation plan.
> **Parent:** [`docs/dev/architecture/reactivity-differential-log-tail.md`](../../dev/architecture/reactivity-differential-log-tail.md) §4.5 (log-tail catch-up / `readLogSince`, per-shard fences). Follows the DLR Stage 2 arc (2a/2b/2c — the differ; shipped v1.0.0–v1.2.0).
> **Grounded in** a 6-system survey of `.reference/` (Electric, PowerSync, RxDB/Replicache, Zero, Convex, Instant, SpacetimeDB) — see §Provenance.

---

## 1. Motivation — the measured gap

Today's reconnect-resume saves **bytes** but not **compute**. On reconnect the client echoes each query's `resultHash`; the server **fully re-executes every subscribed query**, hashes the result, and sends a tiny `QueryUnchanged` only if the hash matches (`docs/dev/research/reconnect-resume-benchmark.md` §"Compute is unchanged": *"every subscription still fully re-executes its query handler and re-hashes... this slice buys network bytes, not compute"*).

For a **reconnect storm** — a network blip disconnects thousands of clients who all resubscribe at once — the server re-runs every query for every client even though almost nothing changed during the gap. Stage 3 closes this: on reconnect, **skip the re-run entirely** for a subscription whose read-set nothing touched during the disconnect.

## 2. Research verdict (what the field does, and where we land)

| Camp | Systems | Reconnect | Per-client durable state |
|---|---|---|---|
| **Log-offset / checkpoint, stateless** | ElectricSQL, PowerSync, RxDB, Replicache | client presents a log position → serve "changed since X"; **no query re-run** | none |
| **Durable CVR** | Zero (rocicorp) | diff a durable per-client view → exact deltas; no re-run | **yes** (Postgres CVR + a GC purger; justified only by a co-designed *client-side IVM*) |
| **Re-run everything** | Convex, InstantDB, SpacetimeDB | full re-execute on resubscribe (Spacetime has IVM but a `// TODO` to wire it to reconnect) | none |
| **Stackbase today** | — | re-run + `QueryUnchanged` (bytes only) | none |

**Conclusions that shape this design:**
- **We adopt the winning camp** (log-offset, stateless-leaning). Stage 3 makes us the first among the *re-run* systems (Convex/Instant/Spacetime) to skip the reconnect re-run.
- **Reject the durable CVR** (Zero): it earns its heavy cost — durable per-client Postgres tables + a dedicated GC service — only when paired with a client-side IVM to consume exact deltas, which we do not have. Our goal is a **boolean** ("did the read-set change?"), not exact-delta precision.
- **Two borrowed refinements:** the resume token is a **single scalar commit `ts`** (RxDB's insight — our MVCC log is globally totally-ordered, so we skip the `{id, lwt}` tiebreak everyone else needs); a content **fingerprint is an optional gap-detection safety net** (PowerSync) — we already have it (the 2b drift-XOR + `resultHash`).
- **Our differentiator:** everyone else scopes resume by a *static, coarse* unit — Electric's WHERE-shape, PowerSync's bucket, RxDB's whole collection. Ours is a **dynamic, fine-grained per-query read-set**, matched via the Stage-1 `IntervalIndex`. So "skip if untouched" is *more precise* — a write to an unrelated row of the same table does not force our re-run.

## 3. The correctness key

The reactivity invariant: **a query's result can only change if a committed write intersects its recorded read-set.** Therefore, if nothing intersected the read-set between the client's last-observed `ts` and now, the result is *provably* unchanged — the re-run is skippable, soundly, without re-executing the handler. (The read-set from the query's *last execution* is sufficient even for data-dependent queries: the only way the result — and hence the read-set — could have evolved is via a write that intersected that same read-set, which the check catches → re-run.)

## 4. Architecture

### 4.1 Resume token — a scalar per-shard `ts`

The client already tracks `maxObservedTs` (its `version.ts`). On a resume `ModifyQuerySet` (`client.ts#resync`), it echoes a new `sinceTs` per query alongside the existing `resultHash`. (Fleet: `{shardId → lastTs}`; single-node: one scalar.) No durable client state — the token is the ts the client already holds.

### 4.2 The read-set registry (server, single-node core — reuses the matcher)

A query's read-set is **deterministic for a given `(identity, path, argsJson)`** (queries are pure). So the server maintains a small in-memory registry keyed by `(identity, path, argsHash)`:

```
RegistryEntry = { readRanges: SerializedKeyRange[]; tables: string[]; lastInvalidatedTs: number; refCount: number }
```

- **Populated/refreshed** whenever a subscription is (re)executed — the entry records that query's current read-ranges + the ts at execution.
- **`lastInvalidatedTs` is advanced by the existing commit fan-out**: `doNotifyWrites` already calls `findAffectedByRanges(writtenRanges, writtenTables)` (the Stage-1 `IntervalIndex`) to find affected subs; when a commit intersects a query's read-set, set `entry.lastInvalidatedTs = max(., commitTs)`. This is the fine-grained intersection we already compute per commit — no new scan, no per-doc recompute.
- **CRITICAL — retained ranges stay indexed for the TTL** (load-bearing for correctness, not just an optimization). A registry entry's ranges MUST remain matched by the fan-out even when the query has **no live subscriber** — otherwise a write during the disconnect gap would not advance `lastInvalidatedTs`, and the reconnect skip would be *wrong* (stale data). So the entry's ranges stay in the `IntervalIndex` (or a parallel registry-owned index the fan-out also consults) from first subscribe until TTL eviction — decoupled from any single session's lifetime. On disconnect the *session's* subscription is torn down, but the *registry entry's* ranges persist and keep receiving `lastInvalidatedTs` advances.
- **Retained across disconnect**: the entry survives while ANY session subscribes (`refCount > 0`) and for a **TTL (~60s)** after the last unsubscribe/disconnect, then is evicted (bounded memory: KeyRanges + one ts per distinct live-or-recently-live query, NOT per-row and NOT durable — far lighter than a CVR). Eviction removes its ranges from the index.

### 4.3 The reconnect skip (server)

In `doModifyQuerySet`, for a resubscribe carrying `sinceTs`:
```
entry = registry.get(identity, path, argsHash)
if (entry && entry.lastInvalidatedTs <= sinceTs) {
  // nothing touched this query's read-set since the client last saw it → provably unchanged
  push QueryUnchanged   // NO execSub — the re-run is skipped
  re-arm the subscription with entry.readRanges/tables (no re-execution)
} else {
  // no entry (TTL-cold / never seen) OR touched during the gap → today's path
  { value, readRanges, ... } = await execSub(...)   // re-run
  refresh the registry entry
  ... existing QueryUpdated / QueryUnchanged-by-hash / QueryDiff-reset logic ...
}
```
- **Re-arming without re-execution:** the skipped sub must still be registered in the `SubscriptionManager`/`IntervalIndex` with its retained `readRanges` so future writes invalidate it. The registry entry holds those ranges → register from them, no `execSub`.
- **The diffable subs (2a/2b/2c):** a skipped diffable sub also needs its per-sub row-map (`byIdRowMap`) intact for future incremental diffs. On a compute-skip we did NOT re-materialize the page/list — so the row-map must be re-seeded lazily on the *next* incremental diff, OR the skip path is (v1) limited to RERUN subs and diffable subs fall through to the existing (already-cheap) re-run+hash path. **v1 decision: the compute-skip applies to the RERUN classification; a diffable sub keeps its existing (already-optimized) resume-via-`QueryUnchanged`-with-re-run path.** (Extending the skip to diffable subs — seed the row-map from a retained snapshot or the log tail — is a follow-on.)

### 4.4 Fallback & back-compat

No `sinceTs` (old client), no registry entry (cold/TTL-expired), or any uncertainty → the existing re-run path, byte-for-byte. A wrong skip is impossible by the §3 invariant; the existing `resultHash`/drift-checksum remains as an independent safety net on the re-run path.

### 4.5 Fleet generalization (deferred, but the seam is named)

Single-node, the registry lives on the one node. In a fleet, a client may reconnect to a *different* node that has no registry entry. The DLR-doc mechanism covers this: **`readLogSince(fromTs, ranges) → entries`** — a store seam (both adapters, byte-identical parity) that scans the shared MVCC log tail since `fromTs` and reports whether any entry intersects `ranges`. The existing `store.load_documents(tsRange, order, limit)` (already used by `@stackbase/triggers`' `readLog`) is the primitive; the addition is range-intersection filtering. **v1 ships the single-node registry; `readLogSince` + the fleet resume path is the named follow-on** (aligns with the Tier-2/Stage-5 fleet work).

## 5. Scope

- **In (v1):** the resume `sinceTs` token, the `(identity, path, argsHash)` read-set registry (populated on exec, advanced by the fan-out, TTL-evicted), and the reconnect compute-skip for **RERUN-classified** subscriptions (`QueryUnchanged` without `execSub` when `lastInvalidatedTs <= sinceTs`). An A/B `resume-compute` benchmark gate.
- **Out (deferred follow-ons):** (a) extending the skip to **diffable** subs (2a/2b/2c) — seed the row-map without a full re-materialize; (b) **`readLogSince` + the fleet resume path** (reconnect to a different node); (c) **catch-up-as-diff** — for a *touched* sub, replay the intersecting log tail as `Change[]` instead of re-running (the DLR-doc §4.5 "apply as Change[]").
- **Untouched:** the diffable resume path, the RERUN re-run path when the skip doesn't apply, and every non-reconnect code path.

## 6. Acceptance gate — a benchmark (A/B, like the DLR differ)

A `resume-compute` scenario: N (~50) RERUN subscriptions, a gap in which **nothing changes**, then a reconnect. Measure **server query re-executions on reconnect**: today = N; Stage 3 = **≈0**. Run it A/B (Stage-3 skip ON vs a forced-re-run baseline) to isolate the effect, mirroring the diff-arc's capability-toggle A/B. Also measure a **partial-change** gap (only 1 of N queries touched) → exactly 1 re-execution, N−1 skips. Report re-executions saved + the reconnect-storm CPU delta. No regression on the reactive scenarios; full suite + typecheck green.

## 7. Risks

- **Registry keying / determinism.** The `(identity, path, argsHash)` key assumes a query's read-set is deterministic for fixed identity+args. This is the core reactivity assumption (queries are pure) — but a query that reads *non-deterministically* would already be a reactivity bug. Guard: the registry is an OPTIMIZATION; a wrong entry can only cause a wrong *skip*, which §3 proves impossible unless the read-set is non-deterministic — and the `resultHash` echo can additionally be validated on the skip path (compare the client's echoed `resultHash` to a stored fingerprint in the registry entry) as a belt-and-suspenders catch that degrades to a re-run on mismatch.
- **Registry memory.** Bounded by distinct live-or-recently-live `(identity, path, args)` queries × (ranges + a ts). Ephemeral, TTL-evicted, refcounted. Not per-row, not durable. Orders of magnitude lighter than a CVR. A cap + LRU eviction bounds the worst case.
- **`lastInvalidatedTs` correctness under the fan-out** (locked in §4.2). The advance must happen for EVERY intersecting commit, including for a query with NO currently-connected session — so retained entries' ranges stay indexed for the TTL, decoupled from session lifetime. A miss here (ranges dropped on disconnect) is the one path to a wrong skip / stale data; the benchmark's partial-change case and a dedicated test (a write during a simulated gap, then reconnect, must re-run — not skip) pin it.
- **Diffable subs excluded in v1** — a diffable sub still re-runs on reconnect (its existing path). Honest v1 boundary; the diffable-skip follow-on closes it.
- **Fleet** — single-node only in v1; a cross-node reconnect falls back to re-run (correct, just not skipped) until the `readLogSince` follow-on.
- **Interaction with the existing `QueryUnchanged` resume** — the skip must produce the SAME client-visible outcome as today's re-run-then-`QueryUnchanged` (a `QueryUnchanged` frame, the sub re-armed) — just without the `execSub`. Verify the client can't tell the difference (it already handles `QueryUnchanged`).

## 8. Provenance

The comparative model is grounded in a source-level survey of `.reference/`: `electric/packages/sync-service` (offset-addressed log, pure replay, stateless), `powersync-js` (op-id checkpoints, bucket op-log streaming), `rxdb` + `mono/packages/replicache` (checkpoint/cookie "changed-since", client-held), `mono/packages/zero-cache/.../cvr*` (the durable CVR + purger — rejected), `convex-backend/crates/sync` (fresh `SyncState`, full re-run), `instant/server/.../session.clj` + `SpacetimeDB/crates/core/src/subscription` (re-run on resubscribe; Spacetime's IVM not wired to reconnect). Cross-checked against our own `docs/dev/architecture/reactivity-differential-log-tail.md` §4.5 (readLogSince, per-shard fences — the fleet seam) and `docs/dev/research/reconnect-resume-benchmark.md` (the documented "compute is unchanged" gap this closes). The single-node registry reuses the Stage-1 `IntervalIndex` (`packages/index-key-codec`) and the existing `doNotifyWrites` fan-out; `readLogSince` reuses `store.load_documents` (already the basis of `@stackbase/triggers`' `readLog`).
