---
title: RxDB — Architecture Research (local-first reactive DB + replication)
status: research
---

# RxDB — Architecture Research

> Research date: 2025-11-28. Source: the official RxDB docs (rxdb.info — replication, rx-query,
> rx-storage, transactions-conflicts-revisions) plus the `event-reduce` and `rxdb` repos referenced
> therein.
>
> **See also: [`rxdb-internals.md`](rxdb-internals.md)** — a source-verified deep dive (RxDB is now cloned
> to `.reference/rxdb`) of the two backlog-critical subsystems: the **replication protocol** (loops,
> checkpoints, meta-instance, optimistic-CAS conflicts) and **EventReduce / reactive queries**, each with
> `file:line` pointers and a concrete "how to build it on Stackbase's MVCC log / client SDK" mapping.

## 1. Positioning — the *opposite tier* from Stackbase

RxDB is a **client-side, offline-first, reactive NoSQL database for JavaScript.** It runs **inside the
client** (browser, Node, React Native, Electron, Deno) on top of a pluggable storage engine, gives you
**reactive queries** locally, and its headline feature is a **replication protocol** to sync the local
database with *any* backend. Its tagline is effectively "a local database that syncs like git."

This is the mirror image of Stackbase's model, and the distinction matters:

- **Stackbase** = *server-authoritative reactive.* Functions run on the server, the server owns the data
  and computes reactivity, and it pushes results to thin clients over WebSocket. Clients need a live
  connection.
- **RxDB** = *client-authoritative local-first.* The database lives *in* the client; you read/write
  locally (works offline), and a replication layer eventually syncs to a backend.

They are **complementary layers, not competitors.** RxDB is, in fact, a goldmine for exactly the things
Stackbase has *deferred*: optimistic updates, offline-first, and client-side query maintenance (see §7).

## 2. Reactive queries — the EventReduce algorithm (the key idea)

An **RxQuery** (`find`/`findOne`/`count`) exposes a `.$` observable (a `BehaviorSubject` always holding
the current result set) alongside `.exec()` for a one-shot read. Subscribing gives live-updating results.

**Crucially, RxDB does NOT re-run the query on every change.** It uses the **EventReduce algorithm**
(`github.com/pubkey/event-reduce`): given a query's *current result set* plus a single document
write/delete *event*, EventReduce **incrementally computes the new result set** — deciding whether the
event inserts into, removes from, reorders, or doesn't affect the results — **without re-executing the
full query.** The pipeline: write → change event → EventReduce evaluates against the query's selector →
if the result set changes, the `.$` observable emits the updated set.

Two supporting mechanisms:
- **Query cache + dedup:** identical queries (normalized selector) share one internal RxQuery instance
  and one cached result set, so N subscribers to the same query cost one EventReduce computation.
- **Deterministic sort:** RxDB appends the primary key to every sort so results are deterministically
  ordered regardless of insert order — a precondition for EventReduce to safely maintain sorted results.

> **This is the same insight as SpacetimeDB's IVM, on the client instead of the server.** Two independent
> reactive systems both concluded that *re-running queries on change is the wrong model* — you maintain
> the result set incrementally. Stackbase currently re-runs. (See
> [`spacetimedb-internals.md`](spacetimedb-internals.md) §6 and the fan-out benchmark.)

## 3. Document & revision model (CouchDB-inspired)

- **`_rev`** = `<height>-<hash>` (e.g. `1-9dcca3b8e1a`) — a revision height (starts at 1, incremented per
  write) plus a database-instance token. Lamport-clock-like semantics for deterministic conflict
  detection.
- **No multi-document transactions — by design.** "A single write to a document is the only atomic thing
  you can do." Cross-document ACID would require global coordination, defeating offline-first. Instead:
  **optimistic locking via `_rev`** — a write carries the previous doc + its revision; a revision mismatch
  throws **`409 CONFLICT`**. The **`incrementalModify()` / `incrementalPatch()` / `incrementalUpsert()`**
  helpers auto-retry against the current state on conflict.
- **`_deleted`** — soft-delete flag (documents are never physically removed, so deletions replicate).
  **`_meta.lwt`** — last-write-time. **`_attachments`** — binary attachments carried with the doc.

This revision + soft-delete + last-write-time triple is precisely what makes the replication protocol
(§5) work with a minimal backend.

## 4. Storage layer (RxStorage) — pluggable, like Stackbase's DocStore

"RxDB is not a self-contained database; data is stored in an implementation of the **RxStorage**
interface." Same philosophy as Stackbase's pluggable `DocStore`. Adapters by environment:

- **Browser:** LocalStorage, IndexedDB, OPFS (fastest in-browser), Dexie.
- **Server/desktop:** Filesystem (Node/Electron), SQLite, MongoDB, FoundationDB.
- **Mobile:** SQLite, Expo Filesystem (JSI).
- **Other:** Memory (all envs), DenoKV, remote.

The interface (high level): **`bulkWrite`**, **`query`**, **`getChangedDocumentsSince(checkpoint)`** (the
replication hook), **`changeStream`** (the reactivity hook — emits document change events). Storage
*wrappers* compose (validation → compression → encryption → base storage), and there are worker/
shared-worker wrappers to offload CPU and sharding for large IndexedDB datasets.

## 5. The replication protocol (the headline — a "git for your database")

RxDB's replication is a **general, backend-agnostic sync primitive**: "the backend does not have to be an
RxDB instance; you can build a replication with any infrastructure." The client keeps a *fork* of server
state, writes locally, and pushes with merge semantics.

**API:** `replicateRxCollection({ collection, replicationIdentifier, live=true, retryTime=5s,
waitForLeadership=true, deletedField='_deleted', pull, push })`. `replicationIdentifier` persists so
replication resumes across reloads.

**Two operating modes:**

1. **Checkpoint iteration** (initial sync / recovery):
   - **PULL handler** `(lastCheckpoint, batchSize) → { documents, checkpoint }`. A **checkpoint** is a
     subset of the last pulled document's fields (typically `{ updatedAt, id }`) that lets the backend
     return "all documents written **after** this point," deterministically sorted. The client iterates,
     advancing the checkpoint, until the backend returns **fewer than `batchSize`** documents — then it
     switches to event mode.
2. **Event observation** (live):
   - **`pullStream$`** — an observable the backend feeds with change batches `{ documents, checkpoint }`.
     It can emit the literal **`'RESYNC'`** to force the client back into checkpoint iteration (e.g. after
     a reconnect where the stream may have missed events).

**PUSH handler** `(docs) → conflicts[]` — each pushed doc is `{ assumedMasterState, newForkState }`. This
is **optimistic concurrency**: the client asserts "move master from `assumedMasterState` to
`newForkState`." If the actual master differs, the backend **returns the actual master state** and the
push is treated as a conflict.

**Conflict handling is entirely on the CLIENT.** RxDB invokes the collection's **`conflictHandler`**
(`{ isEqual(), resolve() }`). The **default handler drops the fork and keeps the master** (offline clients
never silently overwrite concurrent changes). Conflicts + resolutions surface on `conflict$`.

**Backend requirements — deliberately minimal (this is the elegant part):**
1. Documents are **deterministically sortable by last-write-time** (with primary-key tiebreak).
2. Deletes are **soft** (`_deleted=true`), so deletion replicates.
3. The backend can **return sorted changes since a checkpoint** and **accept optimistic writes**.
4. **Client clocks are untrusted** — the backend overwrites `updatedAt` (or uses its own field) on
   receiving a client write.

That's the whole contract. "Backends are trivial — they need only return sorted deltas and accept
optimistic writes."

**Guarantees & lifecycle:**
- **Eventual consistency**, **not exactly-once** — "a write could reach the remote and be processed while
  only the *answer* fails," so the backend **must be idempotent** (dedup by write id / upsert).
- Changes processed in **checkpoint order** (updatedAt + PK).
- **Offline:** local reads/writes continue, cycles pause, `navigator.onLine` drives retry; on reconnect
  the stream emits `'RESYNC'`.
- **Multi-tab:** with `multiInstance`, only the **leader** tab replicates (`leader-election` plugin);
  `toggleOnDocumentVisible` pauses replication for hidden tabs.
- Rich observables: `received$`, `sent$`, `error$`, `active$`, `canceled$`, `conflict$`; promises
  `awaitInitialReplication()`, `awaitInSync()`, `awaitDocumentPushed(doc)`; controls `reSync()`,
  `pause()`/`start()`, `cancel()`, `remove()` (deletes replication metadata, **not** documents).

## 6. Stackbase ↔ RxDB — comparison

| Dimension | RxDB | Stackbase |
|---|---|---|
| Where data lives | **In the client** (local-first) | On the server (thin clients) |
| Reactivity | **Client-side, EventReduce** (incremental) | Server-side, **re-run** on read-set/write-set intersect |
| Offline | **First-class** (works offline, syncs later) | Requires a live connection today |
| Sync model | **Bidirectional replication** (checkpoint pull + optimistic push) | Server subscribe → push (one-way reactivity) |
| Conflicts | **Client-resolved** via `conflictHandler`, `_rev` optimistic locking | Single serial writer per shard (no client conflicts today) |
| Transactions | **None** — single-doc atomic + optimistic retry | Multi-write mutations, transactional per commit |
| Storage | Pluggable **RxStorage** | Pluggable **DocStore** (same idea) |
| Backend needed | **Trivial** (sorted deltas + optimistic writes) | The full engine |

They occupy different tiers. The natural composition: **RxDB (or an RxDB-like local layer) as the
offline-first client for a Stackbase backend.**

## 7. What Stackbase should take from RxDB

RxDB is the reference design for three things Stackbase explicitly **deferred** ("optimistic updates +
full version-gap resync in the client," offline support):

### Adopt for the client SDK / deferred work
1. **The replication protocol shape** — checkpoint-based pull + optimistic push + client-side
   `conflictHandler` + `RESYNC`-on-reconnect is the proven, minimal design for **optimistic updates +
   version-gap resync**, exactly Stackbase's deferred client item. Stackbase's server already has the
   pieces (an ordered MVCC log = "changes since a checkpoint"; soft-tombstones; a commit timestamp = the
   sortable last-write-time). A checkpoint = a commit `ts`. Implementing an RxDB-style pull/push over the
   existing log is a well-trodden path.
2. **EventReduce for client-side query maintenance** — if/when the Stackbase client caches query results
   and applies server-pushed **diffs** (the SpacetimeDB-style inserts/deletes), EventReduce is the
   algorithm to incrementally update the local result set without re-running — directly usable in the JS
   client SDK (it's an MIT npm package, `event-reduce-js`).
3. **The minimal-backend contract as a discipline** — RxDB proves you can support powerful client sync
   with a backend that only needs to *(a)* return sorted changes since a checkpoint, *(b)* soft-delete,
   *(c)* accept idempotent optimistic writes, *(d)* stamp its own write time. Stackbase's log satisfies
   all four; exposing them as a clean replication endpoint is low-cost.

### Strategic / interop opportunity
4. **Ship an RxDB-compatible replication endpoint.** RxDB has a large local-first community and a
   generic `replicateRxCollection` that syncs to *any* backend meeting the contract above. A Stackbase
   endpoint that speaks RxDB's pull/push protocol would let the entire RxDB ecosystem use Stackbase as
   its sync backend — a genuine adoption on-ramp (analogous to the `stackbase migrate` on-ramp thesis),
   at the cost of one HTTP endpoint pair, not an engine change.

### The convergence worth internalizing
5. **Three independent reactive systems — RxDB (client), SpacetimeDB (server), and the direction our own
   fan-out benchmark pointed — all reject "re-run the query on change" in favor of incremental
   maintenance.** RxDB: EventReduce. SpacetimeDB: IVM + indexed subscriptions + diff pushes. Stackbase:
   still re-runs. This is a strong, repeated signal that **incremental result maintenance + diff pushes**
   (not re-execution) is the state of the art for reactivity, on both sides of the wire.

## 8. Honest limits / what NOT to copy

- **Local-first is a different product bet.** Putting the authoritative database in the client (RxDB's
  core) conflicts with Stackbase's server-authoritative, transactional, multi-tenant model. Borrow the
  **sync protocol and EventReduce**, not the "database-in-the-client-is-the-source-of-truth" posture.
- **No transactions** is a real limitation for RxDB's tier; Stackbase's transactional mutations are a
  genuine advantage to keep.
- **RxDB's premium storages** (OPFS, IndexedDB-premium, SQLite, etc.) are paid — a licensing model note,
  not a technical one.

## 9. Sources

RxDB docs: `rxdb.info/replication.html`, `/rx-query.html`, `/rx-storage.html`,
`/transactions-conflicts-revisions.html`; the `pubkey/event-reduce` algorithm repo. See
[`spacetimedb-internals.md`](spacetimedb-internals.md) for the server-side incremental-maintenance
counterpart and [`comparison.md`](comparison.md) for the cross-system landscape.
