# E1 — Our foundations: every shipped surface the durable offline outbox builds on

Evidence agent E1 for the durable-offline-outbox research. Inventory of what exists in OUR tree
today (branch `scheduler-component`, post-optimistic-updates merge), with file:line for every
claim. The companion agents cover competitors and external patterns; this file is only "what do
we already have, what exactly does it give us, and where does it stop."

---

## 1. The Gated Ledger's seams (the client half the outbox extends)

The optimistic-updates slice deliberately shipped four named seams (S1–S4) whose doc comments
each say what the outbox slice swaps in. They are real code, not aspirations.

### 1.1 S1 — `MutationLog` and the `PendingMutation` record

`packages/client/src/mutation-log.ts:14-33` is the record:

- **What is serializable today**: the triple `(requestId, udfPath, args)`
  (`mutation-log.ts:17-20` — `args` is already wire-shape `JSONValue`, converted at
  `client.ts:170` before the entry is built) **plus** `seed: { entropy: string; now: number }`
  (`mutation-log.ts:26`) — plain JSON, fixed at creation, and the doc comment says the SAME seed
  is reused on every replay so `placeholderId()`/`now()` mint stable values. **Consequence the
  outbox must honor: persist the seed alongside the triple**, or placeholder ids change identity
  across a reload and every "temp-id atomic swap" guarantee breaks for reloaded entries.
- **What is NOT serializable and must reconstruct**:
  - `update?: OptimisticUpdate` (`mutation-log.ts:23`) — "Looked up at replay, never
    serialized." Today there is **no lookup registry**: `update` is the caller's captured closure
    (`client.ts:175`). The verdict's receiving seam is "registry-by-`udfPath` for reload replay"
    (`docs/dev/research/client-sync/verdict.md:152`) — that registry does not exist yet anywhere
    in `packages/client`; it is new outbox work, not a swap.
  - `touched: Set<string>` (`mutation-log.ts:28`) — needs **no persistence at all**: it is
    recomputed on every recompose pass (`packages/client/src/layered-store.ts:126-152`, note
    `entry.touched = touched` at `layered-store.ts:152`). A reloaded entry with an empty
    `touched` self-heals on the first rebuild.
- **Status enum** (`mutation-log.ts:29-32`): `unsent | inflight | completed{commitTs,completedAt}`.
  Only `unsent` is meaningful to persist — S4 already guarantees `inflight`/`completed` never
  survive a session (see 1.3), and a reload IS a session end. A persisted outbox likely needs a
  richer status alphabet (e.g. `failed-poisoned`), which is additive to this union.
- **Ordering contract**: the Map's insertion order IS replay order because `requestId`s come from
  a monotone counter (`mutation-log.ts:2-5`, `client.ts:48`); `entriesInOrder()`
  (`mutation-log.ts:52-54`) and `unsentInOrder()` (`reconcile.ts:60-62`) both lean on it. An
  IndexedDB-backed S1 must reproduce insertion order explicitly (a persisted seq column) —
  it cannot inherit it from Map semantics.

### 1.2 The `requestId` lifecycle — where minted, how far it travels

- **Minted**: `client.ts:168` — `String(this.nextRequestId++)`, an **in-memory counter starting
  at 1 per `StackbaseClient` instance** (`client.ts:48`). It is deliberately typed as an opaque
  string on the record "so a future durable outbox can choose uuid vs monotone clientSeq without
  reshaping this record" (`mutation-log.ts:15-16`).
- **Reused across retry**: the reconnect flush re-sends with the ORIGINAL `requestId`
  (`client.ts:330-342`, send at `client.ts:341`) so the promise created at `mutation()` call time
  is the one the new session's `MutationResponse` resolves.
- **Hard limitation for the outbox**: the counter resets to 1 on every page reload / new client
  instance, and there is **no client identity on the wire at all** — `Mutation` carries only
  `{requestId, udfPath, args}` (`packages/sync/src/protocol.ts:46`). Two tabs, or the same tab
  before/after reload, mint colliding `requestId`s. The server never looks at `requestId` except
  to echo it (`packages/sync/src/handler.ts:283`, `:299`) — **zero server-side dedup on this
  path**: `handleMutation` (`handler.ts:269-301`) runs the mutation unconditionally. So a durable
  outbox that resends previously-SENT mutations needs (a) a durable per-client id, (b) a
  request identity the server can dedup on, and (c) a wire field to carry it — all new. The wire
  change is cheap: `parseClientMessage` is a bare `JSON.parse` (`protocol.ts:73-75`), so an
  additive optional field is backward-compatible by construction (the protocol doc says
  versioned-by-shape/extensible, `protocol.ts:7-9`).

### 1.3 S4 — `DeliveryPolicy`, the close rules the outbox swaps

`packages/client/src/delivery-policy.ts:40-59` (`closeDisposition`): `unsent` → retain;
`inflight` → reject with `MutationUndeliveredError` + drop layer; `completed` → drop layer. The
file's own comments condition the reject on the outbox's absence, twice: "outcome genuinely
unknowable — **no server dedup exists**; a blind resend would double-apply"
(`delivery-policy.ts:10-11`) and "retry is unsafe — there is no server-side dedup **yet**"
(`delivery-policy.ts:19-20`). The swap the verdict names is "S4 policy → park-and-resend"
(`verdict.md:152`): once server dedup exists, `inflight` entries park instead of rejecting.
Consumption sites that change: `Reconciler.closeSession` (`packages/client/src/reconcile.ts:183-192`)
and the client's reject loop (`client.ts:312-324`).

One S4 rule the outbox must NOT relax: **no optimistic layer of any kind crosses a session**
(`delivery-policy.ts:2-7` — the ts-gate is only sound over one monotone feed; `observedTs` resets
at `reconcile.ts:189`). What persists is the mutation *intent* (triple + seed); layers are always
rebuilt from scratch against the fresh session's baseline via the normal recompose path.

### 1.4 S3 — `versionCoversCommit`, the isolated gate predicate

`packages/client/src/reconcile.ts:25-27`: `commitTs <= maxObservedTs && commitTs > 0`. Isolated
as one exported function precisely so "the sharded-frontier future (lmid-shape identity
confirmation, verdict §(g)) changes one predicate, not the reconciler" (`reconcile.ts:5-6`). Used
at exactly two sites: `reconcile.ts:133` (ingest sweep) and `reconcile.ts:161` (ack-time
short-circuit). If the outbox slice adopts a Lunora/Replicache-style
per-client-sequence confirmation (see §6), this predicate — plus the `Transition` payload — is
the declared change surface.

### 1.5 The reconnect flush path (what "resend" already means today)

`client.ts:326-343` (`onTransportReopened`), order documented as load-bearing:
1. `SetAuth` replay from client memory (`client.ts:337`; token remembered at `client.ts:49-52`, `:208-212`).
2. `resync()` — resubscribe every live query (`client.ts:297-310`); the reply is adopted as a
   fresh baseline regardless of start version (`client.ts:249-254`).
3. Flush `unsentInOrder()` FIFO, each `unsent → inflight`, original `requestId` (`client.ts:339-342`).

The transport beneath it: `webSocketTransport` reconnects by default with equal-jitter
exponential backoff (`packages/client/src/transport.ts:71-75`, `:85-143`), fires `onClose` once
per disconnect and `onReopen` once per successful reconnect-not-first-connect
(`transport.ts:20`, `:145-157`). Frames sent while down after a first open are **dropped, not
buffered** (`transport.ts:177-188`) — the reopen sequence reconstructs the session entirely from
client state. Offline mutation capture therefore already lives ABOVE the transport: `mutation()`
while closed retains the entry as `unsent` with a pending promise (`client.ts:186-189`). The
outbox extends exactly this: today's capture is in-memory only and sent-mutation resend is
forbidden; the outbox makes the capture durable and makes resend safe.

---

## 2. The server dedup relative: B3 `fleet_idempotency` — and the measured distance

The only shipped server-side write dedup is Fleet B3's effectively-once forwarding, in the
**commercial `ee/` tree** (`ee/packages/fleet`, Stackbase Commercial License header, e.g.
`ee/packages/fleet/src/stable-prefix.ts:1`).

### 2.1 What it is

- **Key mint**: `crypto.randomUUID()`, once per LOGICAL forwarded write, before the first
  attempt, reused verbatim across the retry-once (`ee/packages/fleet/src/forwarder.ts:142-149`).
- **The commitMeta channel**: the key rides `RunOptions.commitMeta` → the transactor's per-unit
  `meta` → the commit guard (`packages/cli/src/http-handler.ts:217-229` builds
  `commitMeta = { idempotencyKey }` and passes it to `runtime.run(...)`).
- **Guard INSERT atomic with commit**: `installCommitGuard`
  (`ee/packages/fleet/src/node.ts:911-973`) INSERTs one `fleet_idempotency (key, commit_ts)` row
  per unit **inside the same Postgres transaction** as the commit and the frontier bump
  (`node.ts:964-971`); a PK collision aborts the whole batch (`node.ts:957-960`). Table DDL:
  `ee/packages/fleet/src/lease.ts:249-257` (`key TEXT PRIMARY KEY, commit_ts, value_json,
  oversized, created_at`).
- **The 23505 replay**: the `/_fleet/run` handler pre-SELECTs the key and replays a hit without
  touching the runtime (`packages/cli/src/http-handler.ts:202-204`); the concurrent-duplicate
  loser catches the narrow `unique_violation`-on-`fleet_idempotency` shape
  (`http-handler.ts:73-90`) and re-SELECTs the winner's row as a replay
  (`http-handler.ts:238-240`). Replay body: `{replayed: true, commitTs, value?/valueMissing?}`
  (`http-handler.ts:92-104`).
- **Result-value cache is best-effort**: `value_json` is UPDATEd AFTER the run (the value isn't
  known inside the commit txn), capped at 64KB (`lease.ts:77-82`); the crash window and the
  oversized case both replay as `valueMissing: true` (`lease.ts:89-99`).
- **1h TTL sweep**: `IDEMPOTENCY_TTL_INTERVAL = "1 hour"` (`lease.ts:84-87`), deleted by
  `sweepIdempotency` (`lease.ts:872-879`) on every balancer writer-ish beat
  (`ee/packages/fleet/src/balancer.ts:230-237`).

### 2.2 The distance to what an offline outbox needs (measured, not vibes)

| Dimension | B3 `fleet_idempotency` | Offline outbox needs |
|---|---|---|
| Key identity | Random UUID per logical write; keys are mutually unordered and carry no client identity | Per-CLIENT durable identity (clientId + something) so "this client's mutation #7" is a stable name across reloads |
| Ordering | None. Each key independent; nothing rejects or sequences out-of-order arrivals | FIFO per client is the whole point (create-then-edit chains); Lunora/Replicache do `seq ≤ watermark` ordered dedup that also REJECTS out-of-order (spec `docs/superpowers/specs/2025-10-16-optimistic-updates-design.md:118-126`) |
| Lifetime | 1h TTL, sized for seconds-scale forward retries (`lease.ts:84-87` calls it "generous headroom") | Hours-to-days: a client can come back online tomorrow; a swept row silently re-executes (`lease.ts:85-86` documents exactly this boundary) |
| Reach | Fleet-only + Postgres-only: the guard is installed via `pgStore.setCommitGuard` on fleet boot (`node.ts:916`); non-fleet commits carry no meta and the whole machinery is a silent no-op (`node.ts:962-963`). Single-node SQLite has NO dedup table at all | Must work on the free single-node SQLite default — dedup atomic with commit in core `packages/transactor`/docstore, not `ee/` |
| Entry path | HTTP `/_fleet/run` only (`http-handler.ts:197-250`); the sync WebSocket `Mutation` path passes no commitMeta and does no lookup (`handler.ts:269-301`) | The WebSocket mutation path is THE path clients use |
| License | Commercial `ee/` | Outbox dedup is core reliability — must be free-tier (CLAUDE.md: single-node self-host free forever); reusing the fleet table would be both a layering and a licensing mistake |

What B3 DOES prove and hand us: (a) the `commitMeta` plumbing from `RunOptions` through the
transactor to a per-unit commit hook exists end-to-end and is already exercised
(`http-handler.ts:217`, `node.ts:953-955`) — the outbox's "dedup row atomic with commit" can ride
the same channel; (b) the replay-response shape (`replayed`/`commitTs`/`valueMissing`) is a
worked answer to "what do you return for a duplicate whose value you no longer have"; (c) the
loser-aborts-then-reads-winner pattern for the concurrent-duplicate race. The verdict prices the
rest honestly: "per-client dedup atomic with commit (threads the sharded/fleet forward path),
poison-pill semantics, session resumption — a transactor+sync slice, correctly refused as a rider
on a client slice" (`verdict.md:152`).

---

## 3. Commit-log + cursor precedents (the replay substrate)

Two shipped precedents establish "a durable consumer over the MVCC log with a gap-free bound" —
the same shape a server-side outbox/dedup consumer or a resumable client feed would use.

- **`readLog` with the stable-prefix bound**: `DriverContext.readLog`
  (`packages/runtime-embedded/src/runtime.ts:550-608`) scans `(afterTs, bound]` where `bound` is
  the **stable log prefix** — fleet: `min(shard_leases.frontier_ts)` across shards
  (`ee/packages/fleet/src/node.ts:725-732`); non-fleet: `store.maxTimestamp()` fallback
  (`runtime.ts:555-560`, option declared at `runtime.ts:196-206`). "This bound is what makes
  at-least-once delivery gap-free by construction" (`runtime.ts:558`). It also never advances a
  cursor past a partially-scanned ts, because one commit stamps all its docs with the same ts
  (`runtime.ts:590-599`), and has the documented `limit: 0` tip-peek idiom (`runtime.ts:563-577`).
- **Durable cursors as component rows**: `@stackbase/triggers` persists one cursor row per
  trigger in a component table (`components/triggers/src/modules.ts:31-44`,
  lazily initialized at tip or ts-0 — `components/triggers/src/boot.ts:77-111`), advanced by a
  reactive driver woken by the commit fan-out (`components/triggers/src/driver.ts:52-60`), with
  batch caps and a circuit breaker (`driver.ts:19-25`). The typed fence discipline behind the
  bound is `StablePrefixTs` (`ee/packages/fleet/src/stable-prefix.ts:24-36`).

Relevance, stated conservatively: these are **server-side** at-least-once consumption precedents.
They do not give the client anything directly (the client's feed is the subscription protocol,
not `readLog`). What they contribute to the outbox design is (a) the proven pattern
"durable cursor + gap-free upper bound + never split a commit," should the server keep a
per-client delivery/ack log; and (b) evidence that our commit log is already consumable as an
ordered replay substrate with exact semantics for limits and fleet gaps.

---

## 4. Session machinery (what a "resumable session" would attach to)

- **`Connect` is a reserved no-op**: the message exists in the protocol
  (`packages/sync/src/protocol.ts:44`, carries a `sessionId`) and the handler explicitly ignores
  it (`packages/sync/src/handler.ts:197-198`). The verdict's deferred table names this as the
  receiving seam for `maxObservedTimestamp` fast-resume / session resumption (`verdict.md:155`).
  Today the session is created server-side at socket accept with a fresh `INITIAL_VERSION`,
  null identity, and no memory of any prior session (`handler.ts:130-136`); disconnect erases
  everything including pending G4 frontiers (`handler.ts:140-146`).
- **`SetAuth` replay**: client-side, the last token is remembered and replayed first on reopen
  (`client.ts:49-52`, `:335-337`); server-side, `handleSetAuth` re-runs every subscription under
  the new identity and emits a querySet-bumping Transition (`handler.ts:423-440`).
- **Resubscribe baselines**: a reconnect's `ModifyQuerySet` re-executes each query and returns
  full results as `QueryUpdated` modifications with `ts` preserved from the (fresh, 0) session
  version (`handler.ts:244-267`); the client in `resyncing` mode adopts that as the new base
  (`client.ts:249-254`). This is why reconnect currently costs full query re-sends — the honest
  deferral cost the verdict records ("fine at today's scale", `verdict.md:155`).
- **Delivery reliability primitives already in place**: `MutationResponse`/`ActionResponse` are
  exempt from backpressure dropping (`handler.ts:162-170`); `MutationResponse.ts` carries the
  real commitTs with a send-site `> 0` invariant check (`handler.ts:172-189`,
  `protocol.ts:57-66`); the G4 origin-frontier fallback for forwarded fleet writes
  (`handler.ts:288-294`). An outbox ack ("your mutation #N is durably applied") would extend this
  response discipline, not invent a new one.

---

## 5. Client-side storage options (what the client package may assume)

The client is genuinely isomorphic today, and **uses no persistence API of any kind**:

- Runtime deps are only `@stackbase/sync` + `@stackbase/values`
  (`packages/client/package.json:33-36`); React is an optional peer served from the `./react`
  subpath (`package.json:15-18`, `:27-32`).
- A repo-wide grep for `indexedDB|localStorage|navigator.` in `packages/client/src` matches only
  the aspirational doc comment in `mutation-log.ts:6-8` ("the durable-offline slice backs S1 with
  IndexedDB"). Nothing else. There is no storage abstraction to reuse — the outbox introduces the
  first one.
- Environment assumptions actually made: the platform `WebSocket` global — documented as
  "browsers, Node 22+, Bun" (`transport.ts:77-89`, injectable via the `createWebSocket` test
  seam at `transport.ts:62-63`); timers with defensive `unref?.()` so Node processes aren't held
  alive (`transport.ts:142`, `reconcile.ts:205-206`); `console.warn/error` for diagnostics.
  Tests run under Node/vitest with jsdom available (`package.json:45`; memory:
  tests-run-under-node).
- Consequence: durable S1 backing must be a **pluggable seam with per-environment adapters**
  (IndexedDB in browsers; fs/SQLite for Node/Bun clients; explicit in-memory fallback preserving
  today's exact semantics when no adapter is available) — mirroring the project's
  `DatabaseAdapter`/`BlobStore` seam discipline (CLAUDE.md locked decision: engine never imports
  a driver directly). IndexedDB's async API also means log persistence cannot be synchronous with
  `mutation()`'s current sync initiation path (`client.ts:163-194`) — write-behind with a
  documented crash window, or an awaitable enqueue, is a design decision the outbox spec owes.

---

## 6. The bound decisions (what the outbox slice has already been committed to)

Two documents constrain this slice before it starts; both are explicit and recent.

- **The verdict's deferred table** (`docs/dev/research/client-sync/verdict.md:144-157`, the
  outbox row at `:152`): receiving seams are *S1 backing → IndexedDB; S4 policy →
  park-and-resend; registry-by-`udfPath` for reload replay*. The deferral cost is stated ("a
  reload loses everything pending; hours-offline unsupported") and the server bill is priced:
  **per-client dedup atomic with commit threading the sharded/fleet forward path, poison-pill
  semantics, session resumption** — "a transactor+sync slice, correctly refused as a rider on a
  client slice." Related rows: lmid-shape identity confirmation seats at `versionCoversCommit` +
  the Transition payload and "must be revisited before a multi-node client ships"
  (`verdict.md:154`); client-supplied ids for inserts are the named unlock for offline
  create-then-edit chains (`verdict.md:156`).
- **The spec's outbox-alignment check + Lunora paragraph**
  (`docs/superpowers/specs/2025-10-16-optimistic-updates-design.md:113-126`): the optimistic
  slice was reviewed against exactly these seams ("NOTHING in this slice's design may close those
  doors"). The Lunora input binds three things on THIS slice: (a) `requestId` stays an opaque
  string so the outbox can choose **monotone clientSeq vs uuid** without reshaping
  `PendingMutation` (honored — `mutation-log.ts:15-16`); (b) the outbox slice must evaluate
  Lunora's watermark shape (`clientId + monotone clientSeq`, `seq ≤ watermark` acked without
  re-running, out-of-order rejected, reconciled by `lastMutationId` — per
  `docs/dev/research/lunora.md` §5) **head-to-head** against random-key `fleet_idempotency`; (c)
  Lunora joins Replicache and Zero as the third convergent lmid datapoint for the D12 revisit.
  Given §2.2's distance table, the honest reading of the evidence is that the ordered
  per-client-watermark family answers four of the six gaps (identity, ordering, lifetime, and a
  natural session-resume token) that random-key dedup answers zero of — but that comparison is
  the outbox slice's decision to make, not this inventory's.

## Confidence and gaps

High confidence on everything above — all claims are read from shipped source on this branch.
Two genuine unknowns this inventory cannot resolve: (1) whether the `commitMeta` channel is
plumbed through the **SQLite** transactor path as cleanly as the Postgres one (B3 only exercises
`PostgresDocStore.setCommitGuard`; the sync-SQLite commit path has no guard seam today — needs a
code read in `packages/transactor`/`docstore-sqlite` before assuming symmetry); (2) real
IndexedDB behavior (eviction, multi-tab locking) is outside this repo — the client-storage
evidence agent's territory.
