# Evidence E3 — Zero, Replicache, LiveStore (+ Linear): the speculative-mutation lineage

Scope: how the Rocicorp lineage (Replicache → Zero), LiveStore, and Linear's bespoke sync engine each implement optimistic writes + offline, with the exact optimistic lifecycle, stacked-mutation behavior, temp-id handling, offline durability, and the **server contract each one requires**. Ends with the Replicache-rebase vs Convex-layered-`withOptimisticUpdate` tradeoff, stated crisply — that fork is the actual decision in front of Stackbase.

Sourcing: primary docs fetched 2025-10-16 (URLs cited per claim). Linear material is from a reverse-engineering repo endorsed by Linear's CTO plus Linear's own blog — flagged where the source is not official. Stackbase code claims cite file:line on branch `scheduler-component`. Where a doc was unreachable or silent, I say so rather than fill in.

---

## 1. Replicache — THE canonical speculative-mutation design

Replicache is the reference algorithm everyone else in this file is a variation of. Primary sources: [how-it-works](https://doc.replicache.dev/concepts/how-it-works), [server-push spec](https://doc.replicache.dev/reference/server-push), [BYOB local-mutations](https://doc.replicache.dev/byob/local-mutations), [offline](https://doc.replicache.dev/concepts/offline).

### 1.1 Optimistic lifecycle: apply → push → pull → rebase → confirm

Mutations are **named functions implemented twice** — once on the client (speculative) and once on the server (authoritative) — and the two "need not match exactly": "The push endpoint is *not necessarily* expected to compute the same result that the mutator on the client did. This is a feature." ([how-it-works](https://doc.replicache.dev/concepts/how-it-works))

1. **Apply**: invoking a mutator runs it in a transaction against the local Client View (a KV store persisted in IndexedDB) and "queues a corresponding pending mutation record to be pushed to the server." Each mutation gets a **sequential per-client mutation id**. Subscriptions fire immediately — the UI never waits for the network.
2. **Push**: pending mutations `{clientID, id, name, args, timestamp}` are batched to the app's push endpoint, which re-executes each mutator against canonical server state.
3. **Pull**: the client sends a `cookie` (opaque server-state identifier) + `clientGroupID`; the server returns a new cookie, a **patch**, and `lastMutationIDChanges` per client.
4. **Rebase** (the heart of it): the client cannot naively apply the patch — its Client View contains speculative changes. So it "*rewinds* the state of the Client View to the last version it got from the server, applies the patch to get to the state the server currently has, and then replays any pending mutations on top." Git rebase, literally.
5. **Confirm/drop**: "Replicache therefore discards any pending mutations it has for each client with id ≤ lastMutationID. Those mutations are no longer pending, they are confirmed."

**Rollback is by construction, not by code**: there is no undo function anywhere. The rewind step discards *all* speculative effects wholesale; whatever the server's patch says is truth; only still-unconfirmed mutations get re-executed. A rejected mutation "rolls back" simply by the server bumping `lastMutationID` past it without applying it — the client then never replays it again.

### 1.2 Stacked pending mutations

Stacking is trivially correct in this model: pending mutations accumulate in causal (mutation-id) order and are replayed **in order** on every rebase, each executing against the state produced by the previous one. The docs are explicit that outcomes can shift: "It's possible and common for mutations to calculate a different effect when they run during rebase" — e.g. `markComplete(todoId)` replayed after a pull that deleted the todo becomes a no-op. The mutation *code* is the conflict-resolution policy.

### 1.3 Temp-id handling

There are no temp ids. The BYOB guide's rule: "unique IDs should often be passed into mutators as parameters, and not generated inside the mutator" ([local-mutations](https://doc.replicache.dev/byob/local-mutations)) — because a mutator that generates an id internally would generate a *different* id on every rebase replay. Client-generated ids (UUID/nanoid) passed as args are stable across replays and are the real, final ids. No id-rewrite machinery exists or is needed.

### 1.4 Offline durability

Real offline: reads and writes both work disconnected; "a tab can go offline and continue to operate for hours to days, then sync up smoothly when it reconnects"; changes sync across tabs in the same browser profile even while offline; apps can cold-start from the local cache ([offline](https://doc.replicache.dev/concepts/offline)). The same doc is honest that "the potential for serious conflicts grows the longer users are disconnected" — convergence is guaranteed, user-expectation-matching resolution is not.

### 1.5 The server contract (the part Stackbase would have to build)

The push endpoint spec ([server-push](https://doc.replicache.dev/reference/server-push)) is precise and small, but strict:

- Track `lastMutationID` **per client** in the same datastore as the data.
- Per incoming mutation: id ≤ `lastMutationID` → ignore (already applied); id > `lastMutationID + 1` → ignore (future — a gap means a lost mutation, wait); id == `lastMutationID + 1` → apply.
- **Atomicity**: "The effects of a mutation … and the corresponding update to the `lastMutationID` must be revealed atomically by the datastore." Mutation effect + lmid bump in one transaction.
- **Poison-pill rule**: "If a permanent error is encountered such that the mutation will never be appliable, ignore that mutation and increment the `lastMutationID` as if it were applied" — otherwise the client retries forever and its queue wedges behind the bad mutation.
- The pull endpoint must be able to compute a **patch** from any cookie to current state (or send a full reset), plus `lastMutationIDChanges`.

Note the fit with Stackbase's engine: "mutation effect + lmid revealed atomically" is exactly one OCC transaction; the pull "patch from cookie" is the part Stackbase does NOT have — our subscriptions push re-run *query results* (`packages/client/src/client.ts:197-217` applies `QueryUpdated` values), not key-range patches over a client-held replica.

---

## 2. Zero — Replicache industrialized: shared mutators, query-driven partial sync, explicitly NO offline writes

Primary sources: [writing-data / mutators](https://zero.rocicorp.dev/docs/writing-data), [offline](https://zero.rocicorp.dev/docs/offline), [introduction](https://zero.rocicorp.dev/docs/introduction), plus [zero.rocicorp.dev](https://zero.rocicorp.dev/) search-surfaced architecture notes.

### 2.1 Architecture in one paragraph

`zero-cache` runs server-side, maintains a SQLite replica of upstream Postgres via **logical replication** (`wal_level=logical`), and keeps a **CVR (client view record)** per client tracking exactly which rows have been synced, so reconnects send diffs. Queries are **ZQL** — a streaming query engine using **incremental view maintenance on both client and server** ("hydrate once, then incrementally push diffs"). Clients sync only the rows their active queries need ("You control what syncs by writing normal queries in your app code, instead of syncing whole tables"); queries answer instantly from the local store and fall back to the server for the rest. This solves the problem Replicache punted on — Replicache syncs a whole Client View, Zero syncs the query-defined subset.

### 2.2 Optimistic lifecycle: same rebase skeleton, mutators written ONCE

Custom mutators are arbitrary TypeScript, and "a copy of each mutator exists on both the client and on your server" — same code (or deliberately divergent: "the server can add extra checks to enforce permissions, or send notifications") ([writing-data](https://zero.rocicorp.dev/docs/writing-data)). The docs name the model: **server reconciliation**, "a technique for robust sync that has been used by the video game industry for decades."

1. Mutator runs instantly against the local store; "any changes are immediately applied to open queries."
2. A mutation record (name + args) is pushed to **your** server's push endpoint; the server-side mutator runs "in a transaction against your database and recording the fact that the mutation ran" (that recording is the lmid, inherited from Replicache — the fetched pages don't spell out the sequencing rules, but the push-protocol shape is Replicache's; flagged as inference).
3. "The changes to the database are then replicated to `zero-cache` using logical replication. `zero-cache` calculates the updates to active queries and sends rows that have changed to each client."
4. Rebase on receipt: "Any pending mutations which have been applied to the server have their local effects rolled back" — the client result "is considered speculative and is discarded as soon as the result from the server mutator is known"; still-pending mutations re-execute over the new snapshot.

Callers get two promises per mutation: `.client` (local apply, <1 frame) and `.server` (authoritative round-trip) — a genuinely nice DX detail for "saving…" indicators.

### 2.3 Stacked mutations, temp ids, errors

- **Stacked**: same as Replicache — pending queue replayed in order over each server snapshot.
- **Temp ids**: none. "Client-generated random IDs from `crypto.randomUUID()`, `uuid`, `ulid`, or `nanoid` work much better with sync engines like Zero." Same stable-id-as-argument discipline.
- **Errors**: server-side `handleMutateRequest` "skips any mutations that throw" (skip-and-advance = Replicache's poison-pill rule), returns structured errors; client code inspects `res.type === 'error'` for both the client and server phases. A rejected mutation's speculative effect evaporates on the next rebase.

### 2.4 Offline: the most important finding in this file

Zero — built by the same team that built Replicache's full offline support — **deliberately does not support offline writes**: "Zero does not support offline writes." Writes are rejected in `disconnected`/`error`/`needs-auth` states; only during the transient `connecting` state (default ≤1 min) are writes queued. Their reasoning, verbatim: "Supporting offline writes in collaborative applications is inherently difficult, and no sync engine or CRDT algorithm can automatically solve it for you" — plus schema changes, auth failures, and constraint violations accumulating during long offline periods. Roadmap: "it's not a priority right now," would "like to revisit" ([offline](https://zero.rocicorp.dev/docs/offline)).

Read that as a strong prior from the people with the most scar tissue: **short-horizon optimism (in-flight + reconnect-window queuing) is the 95% product; durable offline queues are a different, much harder product.** Offline *reads* still work in Zero (local store serves synced data).

---

## 3. LiveStore — event sourcing: the client commits *events*, the server is just an ordered log

Primary sources: [how LiveStore works](https://docs.livestore.dev/evaluation/how-livestore-works/), [syncing](https://docs.livestore.dev/reference/syncing/) (canonical docs host 502'd repeatedly; content fetched via the `dev.docs.livestore.dev` mirror of the same pages).

### 3.1 Model

"All data modifications are captured as an immutable, ordered sequence of events" — the eventlog is the canonical write model; a local SQLite database is the materialized read model ("a projection of this eventlog"), reactive, with in-memory + persisted instances. Committing is: event atomically persisted to the local eventlog (`eventlog.db`) and immediately materialized into SQLite; reactivity fires.

### 3.2 Optimistic lifecycle = git push/pull over events

"The syncing mechanism is similar to how Git works … based on a 'push/pull' model." Clients must pull before pushing; the backend "rejects stale pushes to enforce total ordering." On divergence: "Local pending events which haven't been pushed yet need to be rebased on top of the latest upstream events before they can be pushed" — the materialized SQLite state is rolled back and rebuilt by replaying events in the corrected order (rollback of materializer effects, then re-materialize). Conflict policy default is last-write-wins at the event level, with custom merge logic possible; deeper merge-conflict docs sit in an "advanced" section I could not fetch (502) — flagged as unverified.

So it is the same rewind-and-replay shape as Replicache, but the replayed unit is an **event** (a fact) rather than a **mutation** (an intention), and the rebase happens *before push* rather than on pull.

### 3.3 The crucial difference: no server-side re-execution — authority is ordering only

The sync backend contract is the smallest of the four systems: store events, enforce a global order, "provide an efficient way to query an ordered list of events given a starting event ID," reject stale pushes, ideally notify (WebSocket/poll). That's it — a dumb totally-ordered log. **There is no authoritative re-run of application logic on the server.** Events pushed by a client are accepted as facts; every other client materializes them with the same deterministic materializers. Consequences:

- Trust: a malicious/buggy client can inject any event; validation must be bolted onto the backend or accepted as absent. For a BaaS with server-side functions and authz (Stackbase), this is the wrong default — our mutations exist precisely to be the authoritative gate.
- Determinism burden moves to **materializers**: every client must materialize identically or read models diverge silently.
- Schema-evolution burden: the eventlog is forever; materializers must handle every historical event shape.

### 3.4 Stacked events, temp ids, offline

Stacked unpushed events rebase as an ordered batch (same auto-compose property as Replicache). Temp ids: not addressed in the fetched pages; the event-sourcing model sidesteps it the same way (ids are event payload data chosen at commit time). Offline: first-class — the eventlog is durably local, the app is fully functional offline, sync resumes on reconnect. `clientOnly`/session events exist that "are not synced to the sync backend" (local-only state modeled in the same system).

---

## 4. Linear — bespoke transaction queue: optimistic in memory, durable only after server confirm

Sources: [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) (reverse-engineered, endorsed by Linear's CTO — not official docs), [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine). Treat mechanism details as high-confidence-but-unofficial.

### 4.1 Lifecycle

Client state is a MobX object pool over models. A property change records **both old and new values** and updates the in-memory model immediately ("Before `save()` is called, the model in memory is already updated") — but **IndexedDB is deliberately NOT touched**: "the local database is a subset of the server database (the SSOT), and it cannot contain changes that have not been approved by the server." Only when the server's **delta packet** for the transaction arrives does the client write to IndexedDB.

The `TransactionQueue` holds four queues — `createdTransactions` → `queuedTransactions` → `executingTransactions` (sent, awaiting ack) → plus `persistedTransactionsEnqueue` (recovered from crash/offline). Transactions created in the same event loop share a `batchIndex` and are batched into one request.

### 4.2 Confirmation, rebase-equivalent, and lastSyncId

The server executes transactions authoritatively and broadcasts **delta packets** (sync actions) to all clients; each action carries a global monotonically increasing `lastSyncId` that "spans the entire database, regardless of which workspace" — a single global version number (the same shape as Stackbase's one ts line). A transaction isn't complete when the HTTP response returns: its `syncInNeededForCompletion` is set to the largest `lastSyncId` in the response and it waits for the **matching sync action** to arrive on the socket — completed-but-unsynced transactions sit in `completedButUnsyncedTransactions` "for rebasing," i.e. local speculative effects are held until the authoritative delta at that sync id lands, keeping optimistic state layered over confirmed state in the interim. Gap detection: local `lastSyncId` < server's → incremental catch-up sync.

### 4.3 Rejection, undo, temp ids, offline

- **Rejection**: the stored old values drive rollback of the in-memory model ("the transaction triggers rollback functionality to restore previous state"). Because IndexedDB never held the speculative write, durable state was never wrong.
- **Undo**: the same old/new capture powers user-facing undo — one mechanism, two features. (Linear's famous instant undo is a *byproduct* of the transaction design.)
- **Temp ids**: generated for new models; resolution ties to waiting for the sync action (details thinner in the source; unofficial).
- **Offline durability**: transactions serialize into a `__transactions` table in IndexedDB; on restart `fromSerializedData` "replays the transaction and modifies the models in memory, effectively restoring the client's state" — a durable *outbox of intentions* (not of data), replayed into memory and pushed when connectivity returns.

Linear's is the most instructive **middle path**: speculative state lives only in memory; durability is split into (a) server-confirmed data in IndexedDB and (b) a durable pending-transaction outbox. You get crash-safe offline queueing without ever persisting unconfirmed *data*.

---

## 5. The fork: Replicache rebase vs Convex layered `withOptimisticUpdate`

Convex's model, for contrast ([optimistic-updates docs](https://docs.convex.dev/client/react/optimistic-updates), [convex-js `optimistic_updates_impl.ts`](https://github.com/get-convex/convex-js/blob/main/src/browser/sync/optimistic_updates_impl.ts)): each mutation may carry a hand-written `withOptimisticUpdate((localStore, args) => …)` that patches the **query-result cache** via `localStore.getQuery`/`setQuery`. In the implementation, server results and an ordered array of pending optimistic-update functions are kept separately; on every new server result, `ingestQueryResultsFromServer()` **replaces the base and replays every remaining optimistic-update function in order** over it; a completed mutation's id goes into `optimisticUpdatesToDrop` and is filtered out at the next ingestion (so its effect is replaced by the authoritative result without a flicker window). Rollback: "No explicit rollback exists. If a mutation fails, its optimistic update simply drops," and the next ingestion recomputes from server truth. Temp ids are `crypto.randomUUID()` strings the developer plants and the rollback replaces.

**First, the non-difference**: both are replay architectures. Convex replays pending *view-patch functions* over each new server query result; Replicache replays pending *mutations* over each new server data snapshot. Stacked-mutation composition and rollback-by-recomputation are structurally identical. The real forks are two:

**Fork 1 — what is the substrate?** Replicache/Zero/LiveStore replay against a **local replica of the data** (KV store / synced rows / materialized SQLite), so speculative results flow through the *real read path* — every query, including ones you didn't think about, reflects the pending write, and reads work offline. Convex replays against the **query-result cache**, so only currently-subscribed queries the developer explicitly patched reflect the write, and there is no local dataset — no offline reads, ever. The substrate choice is really the partial-replication problem: Convex avoids it entirely (server executes queries); Replicache punts (sync everything in the Client View); Zero spent a whole new query engine (ZQL + CVR + IVM on both sides) solving it properly.

**Fork 2 — who writes the speculation?** In the rebase family the mutation code IS the optimistic update — written once (Zero literally shares the function), automatically consistent with server behavior, automatically composing when stacked. In Convex the developer hand-writes a second, parallel implementation of each mutation's effect on each affected query — cheap for the framework, but a permanent drift hazard (the mutation and its optimistic mirror are only consistent by developer discipline), quadratic-ish in mutations × queries, and hard to get right (the docs must warn that mutating objects "will corrupt the client's internal state").

**Stated crisply**: *Convex's layered model buys a near-zero server contract — Stackbase's existing protocol (`Transition`/`MutationResponse`, `packages/client/src/client.ts:148-195`) needs almost nothing added, since layering lives entirely client-side over the subscription cache — at the price of hand-written per-mutation view patches and a hard online-only ceiling (our client already rejects all pending mutations the moment the transport closes, `client.ts:235-241`). The Replicache model buys write-once mutators, whole-app consistency, and offline as a by-product — at the price of a client-side data replica, a partial-replication story, deterministic re-runnable mutators shipped to the client, and a per-client mutation-log contract (`lastMutationID` sequencing + poison-pill + atomic lmid-with-effects) that Stackbase's transactor could honor in one OCC transaction but whose pull-side "patch since cookie" inverts our push-query-results read model.* Zero's team — having built both — chose the rebase substrate but *dropped durable offline writes* as not worth the complexity; Linear splits the difference with an in-memory-only speculative layer plus a durable transaction outbox. If Stackbase wants Convex parity now and a path to offline later, those two facts are the map: layered updates are the cheap compatible first step, and the Linear-style durable *outbox of mutations* (not of data) is the smallest credible upgrade toward offline that doesn't require inverting the read model.

---

## Appendix: server-contract comparison at a glance

| | Replicache | Zero | LiveStore | Linear | Convex layered |
|---|---|---|---|---|---|
| Server re-executes app logic | yes (push endpoint, authoritative) | yes (shared mutator, authoritative) | **no** — ordering only | yes (bespoke) | yes (normal mutation; optimistic layer is client-only) |
| Per-client mutation sequencing | `lastMutationID`, atomic with effects | inherited (recorded per mutation) | event order (global) | transaction ack + global `lastSyncId` | none needed |
| Client data substrate | full Client View replica (IndexedDB) | query-synced row subset (CVR + ZQL IVM) | eventlog + materialized SQLite | object pool (mem) + confirmed-only IndexedDB | query-result cache only |
| Rejected write | server skips + bumps lmid; vanishes on rebase | server skips; structured error; vanishes on rebase | backend rejects stale push; rebase & retry | rollback from stored old values | update fn dropped; recompute from server |
| Temp ids | none — client-generated real ids as args | none — client UUID/ulid/nanoid | ids are event data | temp ids resolved via sync action | dev plants UUID; replaced by server result |
| Offline writes | yes, hours-to-days, durable | **no** (deliberate; ~1 min connecting-queue) | yes, first-class (durable eventlog) | yes, durable transaction outbox | no (in-flight promise only) |
