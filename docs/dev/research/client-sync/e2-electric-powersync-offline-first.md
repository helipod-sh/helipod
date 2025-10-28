# E2 Evidence: Electric, PowerSync, and the Offline-First Ancestors

**Question this doc answers:** how do the two leading Postgres-sync engines (ElectricSQL, PowerSync) and the classic offline-first ancestor (CouchDB/PouchDB) handle optimistic writes, offline queues, and reconciliation — and which of their ideas transfer to a Convex-shaped, server-authoritative reactive-query system with no client SQLite.

**Sources & method:** primary web sources fetched 2025-10-16 (docs, official blogs, GitHub), cited inline by URL. Local Stackbase claims cite `file:line` against the repo at branch `scheduler-component`. Web content was fetched through a summarizing fetch tool — quotes are as reported by that tool against the live page, not hand-copied from raw HTML; treat exact wording with one notch of caution, the substance was cross-checked across multiple sources. One environmental note: `electric-sql.com` URLs now 301-redirect to `electric.ax` (observed during fetching) — an apparent domain move; both hosts serve the same docs.

---

## 1. ElectricSQL (current) — read-path sync only; writes are deliberately your problem

### 1.1 The pivot: they built the full local-first CRDT stack first, and abandoned it

This history is the single most important data point in this doc, because Electric v1 (legacy) is the closest thing to a shipped, funded attempt at the "full" answer — local SQLite, writes with **"finality of local-writes"** (writes are final, not tentative — no rollbacks), CRDT merge semantics (the team includes CRDT co-inventors; they built a rich-CRDT database, [Vaxine](https://github.com/electric-sql/vaxine)), and a custom Satellite replication protocol. In July 2024 they froze all of it and rebuilt from scratch ([electric-next announcement](https://electric-sql.com/blog/2024/07/17/electric-next), archive of the old repo at [electric-sql/electric-old](https://github.com/electric-sql/electric-old)).

Their own stated reasons:

- **"The complexity of the stack has provided a wide surface for bugs"** — the vertically-integrated local-first stack (DDLX permission rules, mandatory writes-through-local-SQLite, migrations proxy, custom protocol) had too many moving parts.
- Effort went to **"docker networking, migration tooling and client-side build tools"** instead of the core.
- The archetype they were escaping: a system that **"demos well, with magic sync APIs but that never actually scales out reliably."**
- Explicit invocation of Gall's law: **"A complex system that works is invariably found to have evolved from a simple system that worked."**

The rebuild (current Electric) is scoped to **read-path partial replication only**: HTTP-based Shape subscriptions out of Postgres. Out of scope by design: permissions, schema management, client reactivity, type safety, and **all write strategies**. From the [writes guide](https://electric-sql.com/docs/guides/writes): *"Electric does read-path sync. It syncs data out-of Postgres, into local apps and services. Electric does not do write-path sync."*

The pivot on write semantics is explicit: legacy Electric's principle was *finality* of local writes (CRDT merge, never roll back); current Electric embraces **tentativity** — optimistic state is provisional, the server is authoritative, rollback is a normal outcome. That is the same stance Convex takes, and the same stance Stackbase's engine already embodies (single-writer OCC transactor, deterministic mutations).

### 1.2 The four write patterns (their official taxonomy)

Electric's [writes guide](https://electric-sql.com/docs/guides/writes) + [runnable examples](https://github.com/electric-sql/electric/tree/main/examples/write-patterns) define a progression. For each: where the pending write lives / reconciliation / rejection UX / server requirements.

**Pattern 1 — Online writes.** No pending state; the client calls your existing API and the UI updates only when the write syncs back through the read stream. *"The simplest and easiest to implement first"*, but *"you have the network on the write path... the user left watching loading spinners."* Server requirement: nothing beyond your normal API. This is exactly Stackbase today: `client.mutation()` resolves on `MutationResponse` and the UI updates via the reactive `Transition` (`packages/sync/src/handler.ts:209-212`).

**Pattern 2 — Component-scoped optimistic state.** Pending write lives in component memory (React `useOptimistic`). Reconciliation: the optimistic value is *discarded* when synced data arrives through the Electric stream. Rejection: the optimistic state just disappears — *"users may be confused by the optimistic state disappearing"*, and because it's *"component-scoped... other components may display inconsistent information."* Server requirement: same plain API. This is the pattern they call simple but explicitly warn is inconsistent across components.

**Pattern 3 — Shared persistent optimistic state.** Pending writes live in a shared local store (their example: valtio + localStorage), persisted across reloads, visible to all components. Reads **merge on read**: immutable synced state + mutable local optimistic layer, combined at render. Reconciliation is a *rebase*: *"rebasing local optimistic state on concurrent updates from other users."* Rejection: an individual write is removed from the local store by a per-write rollback handler. Server requirement: your API **plus write tracking** — e.g. a `write_id` column so the client can recognize its own write when it comes back through the read stream and drop the matching optimistic entry. Their assessment: *"a powerful and pragmatic pattern, occupying a compelling point in the design space"*; the cost is *"combining data on-read makes local reads slightly slower."* Key design sentence: *"Separating immutable synced state from mutable local state also makes it easy to reason about and implement rollback strategies."*

**Pattern 4 — Through-the-database sync.** Pending writes live in an embedded local database (PGlite) with `_synced` (immutable) and `_local` (optimistic) shadow tables reconciled through a view with `INSTEAD OF` triggers; a changelog is drained to the server by a sync utility. Their own caveats are blunt: *"this opens the door to a lot of complexity"*, *"adds quite a heavy dependency to your app"*, the shipped rollback strategy is *"very naive"* (clears ALL local state on any rejection), and rejection context *"is harder to reconstruct"* than in an API-call pattern where the error returns synchronously to the caller. This is the pattern that most resembles the legacy system they abandoned.

They also state a pragmatic conflict philosophy: *"conflicts are extremely rare and can be mitigated well by strategies like presence"* — blunt rollback strategies *"are perfectly serviceable for many applications."*

### 1.3 TanStack DB — Electric's blessed optimistic layer, and the txid-matching trick

Electric's current recommended client story is [TanStack DB](https://tanstack.com/db/latest) ([Electric's own post](https://electric-sql.com/blog/2025/07/29/local-first-sync-with-tanstack-db)): typed client-side collections with live queries. Its internal model is Pattern 3 industrialized: *"each collection stores synced data and optimistic state separately and rebases the optimistic state on top of the synced data"* ([mutations guide](https://tanstack.com/db/latest/docs/guides/mutations)). Mutations are transactional across collections (applied/rolled back atomically); if the persistence handler throws, the optimistic state rolls back.

The reconciliation mechanism is the sharpest transferable detail: for [Electric collections](https://tanstack.com/db/latest/docs/collections/electric-collection), the mutation handler persists to the backend, the backend returns the **Postgres transaction ID (txid)**, and the client **holds the optimistic overlay until that specific txid appears in the Electric read stream** — only then is the overlay dropped, atomically replaced by the confirmed synced rows. This closes the classic flicker window (optimistic state removed before the authoritative write has arrived → UI flashes backward). A documented footgun: the txid must be captured *inside* the same Postgres transaction as the write (`pg_current_xact_id()` outside it → mismatched txid → overlay never released).

### 1.4 What Electric requires of the server

Almost nothing on the write path (that's the point), but the read path must provide: (a) a total-ordered change stream out of the authority database, (b) enough metadata in that stream to let a client *recognize its own write* (txid or `write_id`). Requirement (b) is the load-bearing one for optimistic UX — it recurs in every system studied here.

---

## 2. PowerSync — the full client-SQLite-replica model, done rigorously

PowerSync ([v1.0 announcement](https://powersync.com/blog/introducing-powersync-v1-0-postgres-sqlite-sync-layer)) is the "keep the local database, drop the CRDTs" school: a full local SQLite replica per client, synced down via a service that tails the backend's CDC stream, with writes going up **through your own backend API** (like Electric, they refuse to own write semantics — [their words](https://www.powersync.com/blog/turnkey-backend-functionality-conflict-resolution-for-powersync): the developer retains *"full control over how mutations are applied to the source database"*).

### 2.1 The consistency machine: checkpoints + a blocking FIFO upload queue

From [docs.powersync.com/architecture/consistency](https://docs.powersync.com/architecture/consistency) — the model is **"causal+ consistency"**, built from three rules:

1. **Checkpoints are atomic.** A checkpoint is a single server-side point-in-time (*"similar to an LSN in Postgres"*) containing *"only fully committed transactions."* *"The client only updates its local state when it has all the data matching a checkpoint"* — no torn intermediate states during large downloads, and *"different tables and buckets are all included in the same consistent checkpoint."*
2. **Every local write is intercepted** by the SDK and placed in a persistent FIFO upload queue (an internal `ps_crud` table) as PUT/PATCH/DELETE row-ops. Mutations are *"applied on top of the last checkpoint received from the server"* — a local overlay on a pinned snapshot.
3. **The blocking rule (the crown jewel):** *"While mutations are present in the upload queue, the client does not advance to a new checkpoint."* The client only moves forward *"once all the client-side mutations have been acknowledged by the server, and the data for that new checkpoint is downloaded."* Consequence: **the client never merges** — it never has to reconcile its pending writes against newer server state, because it refuses to observe newer server state until its own writes are durably included. No CRDTs, no rebase, no client-side conflict resolution, by construction.

### 2.2 Write checkpoints — the read-your-writes primitive

[Write checkpoints](https://docs.powersync.com/handling-writes/custom-write-checkpoints) are how the client knows its writes made it around the loop: once the upload queue is empty, the client requests a write checkpoint; the service records the current CDC-stream position (LSN / resume token / binlog pos); when replication catches up past it, the client is notified and may advance. The brittle assumption is documented: the system *"assumes that once the client's upload succeeds, the data is in the backend database"* — if the acknowledged write is NOT in the next checkpoint (e.g. the backend acked before committing, or an async pipeline lagged), *"the client will remove those changes from the local SQLite database, causing the UI to flash or revert."* For async backend pipelines they offer *custom* write checkpoints — the backend inserts a checkpoint marker row into a table that rides the replication stream itself, so the marker is causally ordered with the data ([protocol discussion #317](https://github.com/powersync-ja/powersync-service/discussions/317)).

### 2.3 Rejection handling — four documented strategies, developer's problem

Uploads are acked with a 2xx / rejected with a 4xx by your API. Rejection is explicitly the developer's responsibility (*"it is also the developer's responsibility to implement this correctly to avoid consistency issues"*), with four sanctioned strategies: (1) relax server constraints so writes can't fail; (2) block the queue (preserves ordering, but one poison write wedges the client); (3) move failed ops to a dead-letter store; (4) discard. The honest lesson: **a durable offline queue makes rejection UX strictly harder** — the user who made the write may be gone by the time it fails.

### 2.4 The Convex integration — a direct dry run of "PowerSync semantics on a Convex-shaped backend"

PowerSync shipped experimental Convex support ([announcement](https://releases.powersync.com/announcements/announcing-convex-backend-support-experimental), [design notes](https://powersync.com/blog/convex-powersync-design-notes)) — the closest existing artifact to "bolt a client-replica model onto a Stackbase-shaped engine." Findings that transfer straight into our design space:

- **Down-path:** they tail Convex's Streaming Export API (`list_snapshot` + `document_deltas`). Convex's model *helps* them: *"A Convex mutation is atomic, and every write in it shares one commit timestamp (`_ts`)"* — whole documents, stable `_id`s, easy checkpointing. A Stackbase MVCC log (`{ts, id, value, prev_ts}`) has the identical shape.
- **Up-path:** the upload queue drains into *"your existing Convex mutations."* No new write model needed — a Convex-shaped backend's mutations are already the write endpoint.
- **The server-generated-ID collision:** *"Convex generates document IDs server-side"*, so an offline client can't know `_id` at insert time. Their fix: client-generated UUID column synced back as the client-side primary key, with the mutation mapping UUID→`_id` — called out as *"the most visible DX cost of the integration today."* Stackbase generates IDs server-side too (id-codec/docstore), so any offline-insert design hits this exact wall: either temp-ID remapping in the client or a way for mutations to accept client-supplied idempotency/correlation keys.
- **The idle-cursor checkpoint bug:** write checkpoints ride the replication cursor, but on an idle deployment nothing advances the cursor, so checkpoints are *"correct but never delivered."* Workaround: a `createCheckpoint` mutation that writes a marker row just to produce a delta. Design lesson for us: **the ack channel must not depend on unrelated traffic** — a commit-ts returned directly on the mutation response (which Stackbase can do trivially, see §5) avoids the entire failure class.
- **The biggest migration cost was the read path**, not writes: Convex authorization/reactivity lives in TypeScript query functions; PowerSync forces reads down into local SQLite with authorization re-expressed as sync rules — *"reworking the read path of an existing app, the biggest piece of migration work."* This is the strongest single argument that a client-SQLite replica is a *different product*, not a feature you add to a reactive-query system.

---

## 3. CouchDB / PouchDB — the ancestor: conflicts as first-class data

The classic model ([CouchDB replication & conflict docs](https://docs.couchdb.org/en/stable/replication/conflicts.html), [PouchDB conflicts guide](https://pouchdb.com/guides/conflicts.html)): every peer (including the in-browser PouchDB) is a full multi-master replica. Writes are always local and always succeed; replication exchanges revision histories. Concurrent edits to one document don't fail — both revisions are kept in a **revision tree** (git-like), the document is flagged `_conflicts`, and every peer independently picks the same **arbitrary-but-deterministic winner** (longest revision history, ties by revision-ID sort) so replicas converge without coordination. Real resolution is deferred to the application, which must query for conflicts and write a resolving revision.

- **Optimistic-write model:** there is no "pending" state at all — the local write *is* the truth on that replica. Reconciliation is merge-at-replication-time; nothing is ever rolled back.
- **Offline story:** the strongest ever shipped — indefinite offline, any topology, guaranteed convergence.
- **What it requires of the server:** the server is just another replica speaking the replication protocol; there is no authoritative business logic on the write path at all. That is precisely why the model lost: no server-side validation/invariants (any client writes anything), deterministic-winner = silent data loss unless every app ships conflict UI (in practice almost none did), and revision-tree metadata grows forever. Electric-legacy was in many ways CouchDB-with-CRDTs; both converged on the same lesson from opposite directions.

---

## 4. The local-first essay — the bar, and how the industry actually responded

Kleppmann et al., ["Local-first software: you own your data, in spite of the cloud"](https://www.inkandswitch.com/essay/local-first/) (Ink & Switch, 2019). Seven ideals: (1) **no spinners** — near-instant response, *"your work at your fingertips"*; (2) work not trapped on one device; (3) **the network is optional**; (4) seamless collaboration; (5) longevity ("the Long Now"); (6) security & privacy by default; (7) user ownership & control. The essay's preferred substrate is CRDTs, and it scores backend-as-a-service (Firebase-style) approaches as fast-but-cloud-owned.

Seven years on, the field's revealed preference — Electric's pivot (§1.1), PowerSync's no-client-merge design (§2.1), Convex/Linear-style server-authoritative optimism — is that **ideals 1 and 3 decompose**: "no spinners" (optimistic latency-hiding) is cheap and near-universal; "network optional" (true offline multi-master) is expensive, and the CRDT road to it sacrifices server-side invariants that most SaaS apps cannot give up. The pragmatic industry answer is ideal-1-always, ideal-3-bounded (short offline windows via a durable queue, not indefinite divergence).

---

## 5. What transfers to a Convex-shaped, server-authoritative, no-client-SQLite system — and what doesn't

### 5.1 The one convergent mechanism (transfers wholesale)

All three modern systems independently arrive at the same reconciliation primitive:

> **Pending writes live in an ephemeral overlay on top of immutable synced state; the overlay for a write is dropped only when the client observes, in the authoritative read stream, a marker proving that write is included.**

Electric Pattern 3 (`write_id` round-trip), TanStack DB (txid matching), PowerSync (write checkpoints), and — per training knowledge, to be confirmed by E1 — Convex's own client (drop `withOptimisticUpdate` state once subscribed query results reflect `ts ≥` the mutation's commit ts) are all instances. Never drop the overlay on the API ack alone; drop it on *observed inclusion*, or the UI flashes backward (PowerSync documents this failure verbatim, §2.2).

**Stackbase is unusually close to having the marker for free.** The sync protocol is already version-bracketed with a commit timestamp: `Transition` carries `startVersion → endVersion` where `StateVersion = { querySet, ts }` (`packages/sync/src/protocol.ts:17,58`), and the fan-out sets `end.ts = invalidation.commitTs` (`packages/sync/src/handler.ts:273`). The executor already returns `commitTs` from every mutation (`packages/sync/src/handler.ts:47,209`) — but the `MutationResponse` sent to the client **discards it** (`protocol.ts:59-60`, `handler.ts:210` sends only `value`). Adding `commitTs` to `MutationResponse` gives the client exactly the write-checkpoint/txid primitive: hold the optimistic overlay until `clientVersion.ts ≥ myMutation.commitTs`. No marker rows, no cursor-idle bug (§2.4), no extra round trip. One wiring caveat to verify in design: `excludeOriginFromTransition` (`handler.ts:62-63,253`) can suppress the originating session's own transition — optimistic reconciliation requires the origin to *receive* its own write's transition (or to treat the MutationResponse's commitTs as advancing its version), so that option interacts directly with this design.

### 5.2 Transfers with adaptation

- **Overlay architecture (Electric P3 / TanStack DB):** immutable synced query results + a mutable optimistic layer merged on read, rebased when new server results land. In a reactive-query system the "rebase" is Convex-shaped: re-apply each pending mutation's optimistic updater function against the *new* server results — the updater is app code operating on query results, not row-diffs. Transactional multi-query optimistic updates (TanStack DB's cross-collection atomicity) map to "one optimistic updater may touch several subscribed queries' local results, applied/rolled back as a unit."
- **Durable FIFO outbox for bounded offline (PowerSync):** queue mutations `(name, args, requestId)` durably (IndexedDB/localStorage), replay in order on reconnect. Two PowerSync lessons carry: (a) *ordering* — keep the overlay pinned and don't treat server state as settled while the queue is non-empty (their checkpoint-blocking rule, translated); (b) *rejection strategy is a product decision* — block/dead-letter/discard must be chosen per app; a poison mutation wedging the queue is the default failure mode. Crucially, our replayed unit is a **named mutation (intent)**, not a row-op — the server re-executes real business logic under OCC at replay time, which is strictly better conflict semantics than PUT/PATCH/DELETE upload and is the reason a Convex-shaped system can skip client merge logic entirely.
- **Client-generated correlation for inserts (PowerSync×Convex, §2.4):** server-side ID generation means optimistic inserts need temp IDs remapped on ack, or idempotency keys on mutations. This is a real design item, not incidental — the PowerSync team called it their most visible DX cost.
- **Rejection UX honesty (Electric P2's warning, PowerSync's four strategies):** online-optimistic rollback (seconds) is benign; offline-queue rollback (hours later) needs surfaced, app-visible error affordances. Design the failure channel, not just the happy path.

### 5.3 Does not transfer

- **A client SQLite replica (PowerSync's core, Electric P4):** our read unit is a server-executed TypeScript query function — authorization, joins, and reactivity live server-side. The PowerSync-Convex notes (§2.4) show empirically that bolting a replica on means *rewriting the read path and re-expressing authorization as sync rules* — a different product. If ever wanted, it's a separate export/tailing surface (their integration tails a streaming-export API), not the client sync protocol.
- **CouchDB revision trees / deterministic-winner merge / CRDT finality:** these exist to reconcile *multi-master state* without an authority. We have an authority; conflicts are resolved by re-executing mutations transactionally under OCC. Electric's own retreat from finality-of-local-writes to tentativity (§1.1) is the strongest evidence this is the right side of the fork — and it was made by CRDT inventors.
- **Shape/bucket-based partial replication:** Electric Shapes and PowerSync buckets exist because their sync unit is "a filtered slab of tables." Our sync unit is already a query subscription — partiality is inherent.
- **Indefinite-offline multi-master (ideal 3 in full):** without client-side merge semantics, a week-offline client replaying stale mutations against a moved-on database is intent-replay Russian roulette. Bounded offline (outbox + replay + rejection surface) is the honest scope; full local-first is a different architecture with different products (Automerge/CouchDB descendants), and the two leading Postgres-sync companies both explicitly declined to build it.

### 5.4 Sharpest summary of the field

Both Electric and PowerSync — the two best-funded attempts at client sync on top of an authoritative database — converged on: **server owns writes; client optimism is an overlay dropped on observed inclusion; offline is a durable ordered queue of intents; nobody merges on the client.** A Convex-shaped system starts on the winning side of every one of those forks, and Stackbase's version-bracketed protocol already carries the commit-ts spine the reconciliation primitive needs.
