---
title: Zero (Rocicorp) — Architecture Research (unified IVM sync engine over Postgres)
status: research
---

# Zero (Rocicorp) — Architecture Research

> Research date: 2025-11-28. Docs (`zero.rocicorp.dev`) + a **three-agent code-verified read** of the
> cloned source at `.reference/mono` (`rocicorp/mono`, tip `ca40512`; `zql`, `zero-cache`, `zero-client`,
> `zqlite`, `zero-protocol`, `replicache`). `file:line` throughout.

**Zero is the closest peer to what Stackbase aspires to.** It's a general-purpose sync engine that
*"syncs the data your UI needs into a local, normalized client datastore,"* built on three ideas that map
one-to-one onto Stackbase's open questions: a **real incremental-view-maintenance (IVM) engine that runs
identically on client and server**, a **Client View Record (CVR)** that lets the server push minimal
diffs, and **optimistic custom mutators with rebase reconciliation**. It ties together the IVM
(SpacetimeDB), client-reactive+optimistic (RxDB), and Postgres-sync (Electric) themes into one system —
so it's the definitive reference for backlog items **#10 (server IVM), #12 (client IVM), and #13
(optimistic updates + resync)**.

---

## 1. The ZQL IVM engine — one engine, two sources

The crown jewel. A ZQL query compiles (`zql/src/builder/builder.ts:126-397`) into a **tree of stateful
dataflow operators**; changes flow leaf→root incrementally, and `fetch` pulls lazily the other way.

- **`Change` is a recursive tagged-tuple union** (`zql/src/ivm/change.ts:12-75`): `Add`/`Remove`/`Edit
  [type, node, oldNode]`/`Child [type, node, {relationshipName, change}]`. A **child** change nests a full
  `Change`, so a join propagates a nested-relationship change up to a parent **without touching the parent
  row**. Sources *split* an edit into `Remove(old)+Add(new)` when it crosses a join key or filter boundary
  (`memory-source.ts:548-602`, `filter-push.ts`).
- **Operators keep almost no state of their own:**
  - **Filter** — stateless predicate; splits edits on the predicate boundary (`filter.ts`).
  - **Join** — an **index-backed nested loop, no hash table of its own** (`join.ts:51-303`). On a parent
    change it attaches a *lazy* child stream = an indexed point/range lookup on the child source; on a
    child change it reverse-looks-up the affected parent(s) and re-emits a `Child` change. An overlay
    (`#inprogressChildChange`) handles in-flight races. Never a full re-join.
  - **Take (`LIMIT`)** — stores just `{size, bound}` per partition (`take.ts:55-757`); maintains the window
    with a handful of neighbor fetches on the upstream index, never a re-scan.
  - **Exists** — caches a boolean per parent key; a `child` change only matters at the 0↔1 boundary
    (`exists.ts`).
- **View** — `ArrayView` (`array-view.ts` + `view-apply-change.ts:185-548`) materializes the result tree
  with **refcounts** (dedup when a row is reachable via multiple relationship edges) and a **copy-on-write
  `WeakSet`** so a multi-change transaction is `O(spine + K)` and *untouched subtrees stay
  reference-stable* — i.e. `React.memo`-friendly. It's the only operator that's `O(result-set)`, by design.
- **The unifying design:** the *entire* operator/pipeline layer (`zql/src/ivm/`) is **100% shared between
  client and server** — only the `Source` differs: `MemorySource` (a `BTreeSet` per sort order, client,
  fed from IndexedDB) vs `TableSource` (SQLite, server) — and `TableSource` **imports the client source's
  push/overlay/edit-split machinery directly** (`zqlite/src/table-source.ts:17-30`). So "server IVM" and
  "client IVM" are literally *one engine, two row backends*.

> **For Stackbase:** this is the direct answer to how backlog #10 (server) and #12 (client) relate — build
> one IVM operator engine, parameterized by a `Source` seam, and run it both places.

## 2. The server — `zero-cache` (SQLite replica + CVR + view-syncer + pokes)

- **A full SQLite replica of Postgres, not a query cache.** `zero-cache` does an initial COPY then a
  Postgres logical-replication subscription (`change-source/pg/change-source.ts:122`), decodes `pgoutput`
  into a normalized change stream, and `ChangeProcessor` (`replicator/change-processor.ts:87`) applies each
  transaction to a **SQLite replica** (`zqlite`) *and* appends to `_zero.changeLog2 (stateVersion, pos,
  table, rowKey, op)` — the changelog that later yields a **pure SQL diff** between two snapshots
  (`snapshotter.ts:398-554`). ZQL/IVM runs against SQLite locally — **no Postgres round-trip per query**.
  The replica uses **`wal2`** so a `Snapshotter` reads at `BEGIN CONCURRENT` (MVCC snapshot isolation on
  SQLite) while the replicator is sole writer — decoupling replicator progress from every client's IVM
  pipeline, all sharing one SQLite file.
- **The CVR (Client View Record)** — *the key server concept.* A durable record (in Postgres, schema
  `cvr.ts:45-329`), **per client group** (tabs sharing local storage share one), of *exactly which query
  results and which row versions the client currently has*: `queries` (per query hash + `patchVersion`),
  `desires` (which client wants which query, with TTL), and `rows` (`rowKey`, `rowVersion`, `refCounts:
  {queryHash: count}` with a GIN index). **Row contents are NOT duplicated** — only versions/refcounts;
  payloads are re-read from SQLite when a patch must be sent. `CVRVersion = {stateVersion, configVersion}`
  serializes into the client's cookie.
- **The view-syncer** — one per client group (`view-syncer.ts:212`), owns a `PipelineDriver` (one IVM
  pipeline per query hash). On each new replica transaction: `advance()` → SQL change sequence → push into
  IVM → per-query `RowChange`s → **`CVRQueryDrivenUpdater.received()` diffs them against the CVR's stored
  row versions/refcounts** → emits minimal `put`/`del` patches (dedup via `#lastPatches`) → streams them
  into a poke. **The CVR is the correctness backstop**: refcounts are recomputed against stored CVR state
  every time, so even a redundant/out-of-order IVM emission is deduped before a patch is sent.
- **Poke protocol** (`zero-protocol/src/poke.ts`): `pokeStart{pokeID, baseCookie}` → many `pokePart
  {lastMutationIDChanges, desiredQueriesPatches, gotQueriesPatch, rowsPatch, mutationsPatch}` →
  `pokeEnd{pokeID, cookie}`. The client applies all parts atomically and jumps its cookie — **it can never
  observe a partially-applied transaction** (atomic version jump; `finalVersion` must exceed the client's
  base). One CVR patch stream fans out to all clients in the group via `Promise.allSettled`.
- **Catch-up without replay:** a reconnecting client is brought forward by reading `cvr.rows`/`cvr.queries`
  patch-version indexes from Postgres directly — the CVR already durably records the target state, so no
  IVM replay is needed. **`rowSetSignature`** (an XOR checksum of a query's row keys, `pipeline-driver.ts:
  884-899`) is compared on re-hydration to catch non-deterministic-operator drift and force a clean
  re-execution.
- **Query sharing scope = the client group, not the server.** Tabs of the same user share pipelines + CVR;
  identical queries across *different* client groups are hydrated separately (**no cross-user IVM dedup** —
  the shared substrate is only the SQLite replica). A `QueryCoveringIndex` reuses subset-covered queries
  within a group.

## 3. The client — local store + optimistic custom mutators + rebase

Built on **Replicache** (a content-addressed, versioned KV B-tree = a DAG of hash-chained commits, over
IndexedDB). One flat namespace holds everything (`zero-client/src/client/keys.ts`): `e/` rows, `d/` desired
queries, `g/` got queries, `m/` mutation acks — **so one diff/rebase reconciles rows + query state +
acks together.** An `IVMSourceBranch` wraps a `MemorySource` per table so client queries are answered from
the incrementally-maintained local view — **no network round trip.**

- **Custom mutators** = a plain `async (tx, args) => {}` shared client+server (same code, different `tx`).
  Client apply (`replicache-impl.ts:1511-1602`): stage a `Local` commit, run the mutator, commit
  synchronously, advance IVM, **fire subscriptions in the same tick** (instant optimistic UI); *then* push
  async. The **queue is the DAG chain of unacked local commits** — not a separate structure.
- **Rebase (the core reconciliation):** the server never edits the client's optimistic commits — it sends
  a snapshot patch (poke), and the client rebuilds its local-mutation chain on top:
  1. apply the snapshot to a *side* branch (`sync` head; `main` untouched);
  2. drop local commits already acked (`mutationID <= server lastMutationID`), keep the rest;
  3. **re-run each still-pending mutator with its frozen args** on the new base (`db/rebase.ts:25-150`);
  4. atomically repoint `main` and fire **one** diff (old `main` → final) — intermediate states are
     **invisible**, so no flicker.
- **Exactly-once = at-least-once + idempotent-by-`lastMutationID`.** `MutationTracker` resolves everything
  `<= lastMutationID`; `alreadyProcessed` is treated as success. Offline: local commits queue indefinitely;
  a cross-tab `mutation-recovery` pushes orphaned mutations.

## 4. Stackbase ↔ Zero

| Dimension | Zero | Stackbase |
|---|---|---|
| Reactive engine | **One IVM engine, client + server** (shared operators, swappable Source) | Server re-runs queries; no client engine |
| Server change source | Postgres WAL → **local SQLite replica** + changelog | Own MVCC log (over SQLite/Postgres) |
| Per-client state | **CVR** — durable ledger of each client's rows/versions/query-refcounts | None — server re-runs + pushes full results |
| Diff to client | Minimal `put`/`del` patches vs CVR | Full re-run result pushed |
| Optimistic writes | **Custom mutators + rebase-replay** | None (deferred) |
| Reconciliation | Rebase (re-run pending mutators on new base) | — |
| Query matcher | (hydrate per query hash) | Linear scan (backlog #1) |
| Writes | First-class (client mutators + server authoritative) | First-class transactional mutations |

Zero is the *most* similar system: server-authoritative-ish, over Postgres, transactional writes,
reactive. The differences are exactly Stackbase's gaps: **no client IVM, no CVR, no optimistic path.**

## 5. What Stackbase should take from Zero

(Tracked as backlog items in [`../../../benchmarks/docs/performance-backlog.md`](../../../benchmarks/docs/performance-backlog.md).)

1. **The unified IVM engine (one engine, two sources)** — the *reference implementation* for backlog #10
   (server IVM) + #12 (client IVM). Zero proves they should be one operator engine parameterized by a
   `Source` seam. The `Change` = add/remove/edit/child recursive union and the near-stateless operators
   (Join delegates to source indexes; Take keeps `{size,bound}`) are directly instructive.
2. **The CVR (Client View Record)** — *new, high-value.* A durable per-client(-group) ledger of
   `{row → version, per-query refcounts}` lets the server compute **minimal diffs** against known client
   state (instead of re-running and pushing full results), gives **catch-up/resync without recompute**, and
   is a **correctness backstop** that dedupes redundant emissions. Directly upgrades Stackbase's push model
   and its deferred resync (#13).
3. **Optimistic mutators + rebase** — the definitive #13 reference. Zero shows the full machinery, and the
   client-agent's honest read stands: **Stackbase needs only a *lighter* version** — mutations always run
   authoritatively server-side, so a "local mirror + optimistic-patch queue + reconcile-and-drop-on-ack
   (keyed by a monotonic per-client `lastMutationID`)" captures the UX win without Replicache's full
   replay-the-mutator-on-a-forked-branch DAG. The `lastMutationID` ack ties directly to the B3
   `commitMeta`-atomic idempotency already shipped.
4. **The poke protocol shape** (`pokeStart`/`pokePart`/`pokeEnd`, atomic version jump; rows + query-state +
   mutation-acks in one multi-part poke) — a concrete wire-protocol reference for #13/#15.
5. **`rowSetSignature` drift-check** — an XOR checksum of a query's row keys, compared on re-hydration to
   catch a non-deterministic operator silently desyncing a client. A cheap safety net any incremental
   push system should have.

## 6. What NOT to copy

- **A full second SQLite replica of Postgres per deployment** is Zero's way to run IVM off-Postgres;
  Stackbase already *has* its own store/log, so the transferable idea is "run IVM against your own log,"
  not "stand up a replica."
- **The full Replicache commit-DAG rebase** (re-executing arbitrary mutator code on forked branches) is
  heavier than a server-authoritative engine needs — see #3's lighter model.
- **No cross-client-group IVM dedup** — Zero deliberately doesn't share IVM computation across users; note
  that its "millions of clients" story leans on client groups + the shared replica, not shared pipelines.

## 7. Sources

Three-agent source read of `.reference/mono` (tip `ca40512`): `packages/zql/src/{ivm,builder}/*`,
`packages/zqlite/src/*`, `packages/zero-cache/src/services/{change-source,replicator,view-syncer}/*`,
`packages/zero-client/src/client/*`, `packages/replicache/src/{sync,db}/*`, `packages/zero-protocol/src/*`.
The four prior reactive systems — [`spacetimedb-internals.md`](spacetimedb-internals.md),
[`rxdb-internals.md`](rxdb-internals.md), [`electric.md`](electric.md) — all converge with Zero on:
**incremental maintenance + an indexed/versioned matcher + diff pushes, never re-run.**
