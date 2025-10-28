# Position B — The speculative log: a durable, replayable pending-mutation log as the foundation for optimistic updates AND offline

Position agent B in the client-sync adversarial workflow. Claim defended: **the right foundation for Stackbase's optimistic-update slice is a Replicache-shaped speculative log — an ordered, serializable, (eventually durable) client-side log of pending mutations, with optimistic state computed as `rebase(serverState, pendingLog)` on every server ingest.** Rollback is dropping an entry from the log. Stacking is the log's order. Offline is the log's persistence plus a drain loop. None of those three are features you add later; they are properties the data structure has from day one.

The rival position (Convex-style ephemeral layers) is not wrong about the reconciliation *loop* — it is wrong about the *representation*. Both replay pending speculation over each server snapshot; the evidence file E3 calls this "the non-difference" (`e3-zero-replicache-livestore.md` §5: "both are replay architectures"). The fork that matters is: **are pending mutations anonymous in-memory closures, or identified serializable records?** Closures cannot be persisted, cannot be deduplicated server-side, cannot be resent after reconnect, and cannot be shown to the user as a queue. Records can. The loop code is the same either way — so choosing the record shape now is nearly free, and choosing the closure shape now means rebuilding the public API surface and the wire contract when reconnect and offline arrive. And reconnect is not hypothetical future work: **our transport has no reconnect at all today** (`packages/client/src/transport.ts:47-100`, E1 finding G2), so the next client slice after optimism *must* touch this ground regardless.

All file:line claims verified against branch `scheduler-component` at `/Volumes/Projects/concave-dev` (client/handler/protocol re-read 2025-10-16); web claims cite the evidence files E1–E4 in this directory, which carry the original URLs.

---

## 1. The design in one page

### 1.1 Data structures (client-side, inside `StackbaseClient`)

```ts
// One entry per un-confirmed mutation. Serializable by construction: no closures.
interface LogEntry {
  mutationId: string;        // client-generated, globally unique: `${clientId}:${seq}` — durable identity
  seq: number;               // per-client sequence — FIFO order IS the stacking order
  udfPath: string;           // "messages:send"
  args: JSONValue;           // already-serialized mutation args
  state: "pending" | "inflight" | "completed" | "failed";
  commitTs?: number;         // set on MutationResponse success (needs wire change W1, §6)
  error?: string;            // set on failure; kept until the app observes it (failure UX, §5)
}

// The client's query-result store splits in two:
serverResults: Map<hash, Value>;   // immutable base — ONLY applyModifications writes here
composedResults: Map<hash, Value>; // = rebase(serverResults, log) — what listeners/hooks see
log: LogEntry[];                   // the speculative log, ordered by seq
```

Today's client has exactly one slot per subscription, overwritten by pushes (`packages/client/src/client.ts:26` `value: Value | undefined`; sole ingest point `applyModifications`, `client.ts:197-217` — E1 H2). The split above is the whole structural change: the server value and the composed view stop being the same field.

### 1.2 Local effects: a registry, not call-site closures

The log entry stores `{udfPath, args}` — an *intent*, like Replicache's `{clientID, id, name, args}` mutation record (E3 §1.1) and Linear's durable `__transactions` outbox of intentions-not-data (E3 §4.3). To render that intent locally, the client looks up a **registered local effect** by mutation path — Replicache's client-mutator registry translated to our substrate:

```ts
// app code, once, near client construction — NOT per call site
const localMutators = defineLocalMutators({
  [api.messages.send.path]: (store, args) => {
    const list = store.getQuery(api.messages.list, { channel: args.channel });
    if (list === undefined) return; // not subscribed → nothing to speculate
    store.setQuery(api.messages.list, { channel: args.channel }, [
      ...list,
      { _id: store.placeholderId("messages"), _creationTime: store.now(), body: args.body, pending: true },
    ]);
  },
  [api.messages.del.path]: (store, args) => {
    for (const [qargs, list] of store.getAllQueries(api.messages.list)) {
      store.setQuery(api.messages.list, qargs, list?.filter((m) => m._id !== args.id));
    }
  },
});

const client = new StackbaseClient(transport, { localMutators });
```

`store` is the Convex-shaped `OptimisticLocalStore` surface (`getQuery`/`setQuery`/`getAllQueries` — E1 §2.1) plus two log-aware helpers: `placeholderId(table)` (deterministic per `(mutationId, table, ordinal)` so replays mint the *same* placeholder — see §4.3) and `now()` (fixed at entry creation, so replays don't drift timestamps).

Honesty first: **the local effect is still hand-written app code, same as Convex's `withOptimisticUpdate`.** We do not get Replicache/Zero's "mutator written once" property in v1 — our mutations run `ctx.db` against the server's docstore and cannot execute client-side without a local data substrate, which E2 shows empirically is a different product (PowerSync×Convex: "reworking the read path of an existing app, the biggest piece of migration work", E2 §2.4). Position B does not propose a client replica. What the registry buys over call-site closures is structural, and it is exactly the part that can't be retrofitted:

1. **Serializable log.** `{mutationId, udfPath, args}` round-trips through IndexedDB; a closure does not. On cold start, entries re-bind to effects by path. This is the precondition for durable offline (Linear's `fromSerializedData` replay, E3 §4.3) — with call-site closures it is impossible without an API break.
2. **Effect follows the mutation, not the call site.** Every `useMutation(api.messages.send)` in the app is optimistic, identically. Call-site attachment means two screens calling the same mutation can disagree about its speculative effect — E4 catalog #10's per-query-vs-store split, resolved at the store level by construction.
3. **The registry is the upgrade slot.** If Stackbase ever ships client-executable mutators over a local substrate (Zero's shared-mutator model, E3 §2.2), they land in this exact slot with the same log semantics. The sync contract doesn't change.

Convex-compat sugar: `.withOptimisticUpdate(fn)` can still be offered — it registers an ad-hoc effect for that call only, and marks the entry non-durable (a closure-backed entry is excluded from any persisted outbox). Migration on-ramp preserved; canonical surface is the registry.

### 1.3 The API the app sees

```ts
// React — unchanged from today's hooks (packages/client/src/react.tsx:29-61),
// they just start observing composedResults instead of raw sub.value:
const messages = useQuery(api.messages.list, { channel });
const send = useMutation(api.messages.send);
await send({ channel, body });        // composed view updates synchronously, before the await

// The log is observable — this is what a closure model structurally cannot offer:
const pending = usePendingMutations();          // LogEntry[] — "sending…" affordances, offline badge
client.onMutationFailed((entry) => toast(...)); // failure surface, entry stays visible until handled
```

Hooks need zero structural changes (E1 §1.3: "if the optimistic layer lives inside `StackbaseClient` … the hooks need zero changes"); the composed view is what listeners receive at H2/H3 (`client.ts:203`, `client.ts:75`).

---

## 2. The reconciliation algorithm, precisely, against our protocol

The loop is intentionally the verified Convex loop (E1 §2.2–2.3, from `convex-js` source) — because it is correct and because E3 §5 establishes it is *the same loop* Replicache runs, with query results as the substrate instead of a KV replica. What differs in Position B is only what an entry *is*.

**On mutation call (H1, `client.ts:108-114`):**
1. Append `LogEntry{mutationId: clientId+":"+seq, seq, udfPath, args, state:"pending"}`.
2. Run the registered effect (if any) against a store view over `composedResults`; record which query hashes it touched (`touchedHashes` per entry — needed for the G4 fallback, below).
3. Notify listeners of touched queries with the new composed values. Synchronous — zero network on the render path (the "no spinners" ideal, E2 §4).
4. Mark `inflight`, send `Mutation{requestId: mutationId, udfPath, args}` — the existing wire message (`packages/sync/src/protocol.ts:46`); `requestId` is already a client-chosen string, so carrying the durable `mutationId` in it is **zero wire change**.

**On every `Transition` ingest (H2/H6, `client.ts:150-167, 197-217`):**
1. Version-bracket check unchanged (`startVersion` equality → apply, else resync; `client.ts:161`).
2. Write `QueryUpdated` values into `serverResults` (the base) — never into the composed view directly.
3. **Drop gate:** remove every log entry with `state === "completed"` and `commitTs <= endVersion.ts`. This is the exact convex-js `removeCompleted(ts)` contract (E1 §2.3: drop "in the same ingest that delivers the server results reflecting the write") and the convergent industry primitive E2 §5.1 found in Electric's `write_id`, TanStack DB's txid-match, and PowerSync's write checkpoints: **never drop on API ack; drop on observed inclusion in the authoritative read stream.** The signal already reaches us: the origin session is included in its own fan-out (`excludeOriginFromTransition` exists but is never enabled — `handler.ts:62-63,253`, `runtime.ts:459`; E1 H9 — keep it that way), and `endVersion.ts = invalidation.commitTs` (`handler.ts:273`).
4. **Rebase:** `composedResults = clone(serverResults)`, then replay surviving entries' effects **in seq order** on top. Rollback of anything is "it stopped being replayed" — no inverse ops exist anywhere, same as Replicache ("rollback is by construction, not by code", E3 §1.1) and convex-js (`new Map(serverQueryResults)` + replay, E1 §2.2).
5. Notify listeners whose composed value changed (reference inequality, same as convex-js).

Because drop (3) and base-replacement (4) happen in one ingest, the frame where the optimistic entry disappears is the frame where the authoritative row appears. **No flicker window, structurally** — the failure PowerSync documents verbatim when the ack races the stream ("the UI to flash or revert", E2 §2.2) cannot occur.

**On `MutationResponse` (H5, `client.ts:169-177`):**
- **Failure:** definitive — the server executed and rejected. Set `state:"failed"`, remove from replay immediately, rebase, reject the promise, surface the entry (§5). Matches convex-js ("mutation failures … don't have any side effects", E1 §2.3).
- **Success:** set `state:"completed"`, `commitTs = msg.ts` (wire change W1, §6). Do **not** drop yet — wait for the ts gate.
- **G4 fallback (the one genuine protocol wrinkle, E1 G5→G4):** only sessions with affected subscriptions receive Transitions (`handler.ts:259-276`), so a mutation that touched nothing this client reads never advances `version.ts` and the gate would wait forever. Position B's answer needs **no server change**: if the entry's `touchedHashes` is empty — the effect modified no subscribed query (or no effect is registered) — there is nothing on screen to protect, so drop at `MutationResponse` directly. If `touchedHashes` is non-empty, the mutation wrote something those queries read (that's why the effect touched them), so the origin's Transition is coming. Edge case flagged honestly: an effect that speculatively touched a query the real mutation did *not* invalidate would hold its entry until the next unrelated invalidation of that query — bounded staleness of a wrong guess, not a wedge; an optional entry-level `dropOnResponse: true` escape hatch covers pathological cases.

**On `QueryFailed` / `QueryRemoved`:** unchanged semantics (`client.ts:205-215`); the base keeps its last value, replay proceeds over it.

**On resync (`client.ts:220-233`):** the resyncing-baseline Transition replaces `serverResults` wholesale and the same rebase runs — the log is orthogonal to resync, which also means E1's G1 stale-baseline race neither worsens nor improves under this design (it should be fixed server-side regardless).

**On transport close (H7, `client.ts:235-241`):** v1 keeps today's behavior for `inflight` entries — reject with "connection closed", state `failed`, because without server dedup a blind resend can double-apply (E1 G5: no requestId dedup at `handler.ts:204-217`). This is precisely the wall §6's slice-2 contract removes. `pending` (never-sent) entries are safely retained and sent on the next connection even in v1 — they were never on the wire, so no ambiguity exists. That asymmetry — which a closure model can't even express, because it has no entry states — is already a small offline win in slice one.

### Forward-compatibility note the rivals should have to answer

The ts drop-gate compares a session-scalar `version.ts` against a mutation `commitTs`. The write-sharding corpus already flags that a scalar ts "loses its 'everything ≤ ts reflected' meaning under multi-shard feeds" (E1 G6, citing `write-sharding/evidence-invariants.md` §4) — and sharding is LIVE (B2a shipped). Single-node semantics hold today because fan-out is tail-serialized per handler (`handler.ts:241-245`). But the durable answer under a multi-shard/fleet future is **per-mutation identity confirmation** — "this Transition reflects mutationIds ⩽ X for your client" — which is Replicache's `lastMutationID` shape (E3 §1.5), not a timestamp comparison. Only a log with per-entry identity can consume that signal. An anonymous-layer client would need its third representation change.

---

## 3. Stacking, rollback

- **Stacking is the log's order.** Entries replay in `seq` order against each other's outputs on every rebase — automatic composition, the property E3 §1.2 states is "trivially correct in this model" and E4 catalog #6 shows every snapshot/independent-layer system getting wrong (TanStack snapshot-restore erasing sibling writes; Relay's documented counter double-count when layer B baked in layer A's effect). Recompute-over-new-base is the fix Relay itself recommends ("re-run pending updaters over the new base", E4 §3) — here it is the only code path, not an advanced mode.
- **Rollback = removal.** Failure, cancellation, poison-drop: delete the entry, rebase. The next composed view provably contains zero projections of the write in every subscribed query, because it was recomputed from a base that never contained it — E4 catalog #3's "rollback missed a cache location" class is unrepresentable.
- **Interleaved outcomes compose.** A completes while B is in flight: A's entry drops at A's ts-gate in the same ingest that carries A's authoritative rows; B replays on top of them. B fails while A pends: B stops replaying; A's speculation stands. No pairwise interaction code exists.

## 4. Temp ids — the honest corner

Stackbase generates document ids server-side (same as Convex; E2 §2.4 calls the resulting client-UUID remapping "the most visible DX cost" of PowerSync's Convex integration). Replicache's clean answer — client-generated real ids passed as args, no temp ids at all (E3 §1.3) — is unavailable without engine changes. Position B's v1:

1. `store.placeholderId(table)` mints a marked placeholder, **deterministic per `(mutationId, table, ordinal)`** — replays across rebases yield the identical placeholder (the Replicache rule "ids should be passed into mutators as parameters, not generated inside" [E3 §1.3], transposed: generation is outside the replayed function, keyed by the entry).
2. Duplicate-on-confirm (E4 catalog #4) cannot occur *transiently*: the placeholder row exists only in replay output; the confirming ingest simultaneously delivers the real row in the base and drops the entry — replace-not-add, atomically, one frame.
3. **Deferred, explicitly:** offline create-then-edit chains (catalog #8's dependency case), where a queued entry's args reference an earlier entry's placeholder. The slice-2 design: `MutationResponse` already returns the mutation's value (`protocol.ts:59`) — typically the new id — so the drain loop rewrites later queued args that reference the placeholder before sending (Redux-Offline's documented app-side pattern [E4 §5], mechanized, since the log knows both the placeholder and the response value). The cleaner long-term fix — mutations accepting client-supplied ids/correlation keys, as PowerSync×Convex adopted — is an engine decision this position flags but does not require.

## 5. Failure UX

The mainstream bar is "silent revert + toast" (E4 catalog #9: "Nobody ships a built-in 'this failed, tap to retry' affordance"). The log exceeds it for free, because failed intent is *data*, not a vanished closure:

- Online failure: promise rejects (unchanged contract), rebase removes the speculation in the same tick — plus the entry persists in `state:"failed"` until the app observes it via `onMutationFailed`/`usePendingMutations`. Default unobserved behavior: auto-evict after rejection is delivered (exactly today's semantics — no new obligations on apps that ignore the feature).
- Retry is a *new* `mutationId` (a failed mutation was definitively rejected by server execution; replaying the same identity would be wrong under slice-2 dedup).
- Queued-offline failure (slice 2) is where this genuinely matters: a write can fail hours after the user made it (E2 §2.3: "the user who made the write may be gone by the time it fails"). Log entries carry enough — path, args, error, timestamps — to render a Linear-style outbox UI. Rejection *strategy* (block / dead-letter / discard) is a per-app product decision with a dead-letter default and a poison-pill guarantee (§6), adopting PowerSync's four-strategy honesty (E2 §2.3) rather than pretending the problem away.
- Pending affordance: `pending: true` rows planted by effects + `usePendingMutations()` answer catalog #3(b) — queued writes look queued, not committed.

---

## 6. Server changes required — small, and each one earns its place

**Slice 1 (optimistic updates): exactly one wire field — the same one every position needs.**

- **W1: `MutationResponse` gains `ts`.** The handler already holds `commitTs` at the send site and discards it (`handler.ts:209-210`; produced at `runtime.ts:427`); the type change is `protocol.ts:59`. E1 calls this "the single wire gap blocking the Convex reconciliation contract" (E1 §1.1). One field, one line at the send site.
- Not a change, but a locked invariant: **do not enable `excludeOriginFromTransition`** (`handler.ts:62-63,253`) — the origin must observe its own write's Transition or the drop gate starves (E1 H9; concave's origin-excluding variant is flagged as flicker-prone by our own extraction, E1 §1.5).
- `requestId` already carries an arbitrary client string (`protocol.ts:46`) — the durable `mutationId` rides it with zero server involvement in slice 1.

**Slice 2 (reconnect + durable offline): the contract that cannot live client-side.**

- **W2: per-client mutation dedup.** A small system table (`_applied_mutations`: clientId → lastSeq, or recent mutationIds) checked in `handleMutation` and written **inside the mutation's own OCC transaction** — Replicache's atomicity rule ("effects … and the corresponding update to the lastMutationID must be revealed atomically", E3 §1.5), which E3 notes "maps 1:1 onto one Stackbase OCC transaction." Replay of an applied id returns the recorded outcome (success + stored `commitTs`/value) without re-executing — resend becomes exactly-once-in-effect, closing E1 G5 (dropped socket → unknowable outcome → today's client must reject; `client.ts:235-241`). Note W2 is required by **reconnect alone**, before any offline ambition: convex-js reissues outstanding mutations on reconnect (E1 §2.4), and doing that against today's dedup-free handler double-applies. Any position that ships reconnect meets this bill; B just refuses to pretend it isn't coming.
- **W3: poison-pill semantics.** A permanently-failing replayed mutation must be *recorded as resolved* (failed) so the client's drain doesn't wedge behind it — Replicache's rule verbatim ("ignore that mutation and increment the lastMutationID as if it were applied", E3 §1.5); E2 §5.2 independently names the poison-queue wedge "the default failure mode."
- **W4: session resumption.** Client-generated stable `sessionId` on `Connect` — the message already exists in the protocol and is currently a server no-op (`protocol.ts:44`; `handler.ts` `case "Connect": return`), so this fills in a reserved slot rather than adding one. Sessions are per-socket today (`cli/server.ts:280`, E1 G3).

**What Position B does NOT require — the full-Replicache costs E3 §1.5 warns about, avoided:** no pull endpoint, no patch-since-cookie (our Transitions push whole query results, so "rewind to server state" is free — the base is simply replaced), no client data replica, no CVR, no client-executable mutators. The log rides the existing push-query protocol unchanged. The parts of Replicache we take are the parts that fit our engine in one transaction; the part that inverts our read model, we leave.

---

## 7. What ships in ONE slice vs deferred

**Slice 1 — optimistic updates (client + one wire field):**
in-memory `LogEntry[]` + base/composed split; local-mutator registry + `defineLocalMutators` + `.withOptimisticUpdate` compat sugar; full reconciliation loop of §2 (replay-on-ingest, ts drop-gate, G4 fallback, failure-drop); `placeholderId`; `usePendingMutations` + `onMutationFailed`; W1. Retained-not-sent `pending` entries across a dead transport (safe half of offline). Conformance-tested against the real engine via `@stackbase/test`'s reactive `t.subscribe` (E1 §1.6) — reconciliation asserted against real commits, not mocks. Every structure is already in its final shape: nothing in this slice is scaffolding to be torn out.

**Slice 2 — reconnect + bounded durable offline:** transport reconnect/backoff + re-subscribe (fills G2); W2/W3/W4; IndexedDB persistence of registry-backed entries; FIFO drain with overlay pinned while the outbox is non-empty (PowerSync's crown-jewel rule translated, E2 §2.1 — never treat server state as settled over a non-empty queue); placeholder-arg rewrite on drain (§4.3); dead-letter default + per-app rejection strategy.

**Deferred indefinitely, with reasons:** client data substrate / local SQLite / offline *reads* (different product — E2 §2.4's read-path evidence, E3 Fork 1); shared client/server mutators (needs the substrate); indefinite multi-master offline (Zero — the team with the most scar tissue — dropped durable offline writes entirely, E3 §2.4; our slice-2 scope is Linear's, not CouchDB's: **bounded** offline, intents replayed under server OCC).

The scope honesty cuts both ways: Zero's retreat is the strongest argument *against* over-investing in offline — and Position B's answer is that the log is not an offline bet. It earns its keep in slice 1 (correct stacking, observable queue, failure UX, zero-flicker) and even Zero's non-offline design still keeps a reconnect-window queue (~1 min, E3 §2.4) — which is *a log*. The question is never whether Stackbase will have a pending-mutation log; it's whether it will have one designed on purpose.

---

## 8. Checked against E4's failure-mode catalog, number by number

1. **Refetch/invalidation revert-flicker** — no refetch primitive exists; the subscription stream is the sole reconcile path and every ingest rebases the whole log. The TanStack `isMutating()===1` userland hack has no analogue because the class is absent (Firebase-family property, E4 §6).
2. **Echo mismatch** — local effects approximate arbitrary server logic; the swap to truth happens in exactly one frame (drop + base-replace are one ingest, §2). Effects should mark rows `pending: true` (Firestore's `hasPendingWrites` convention) so apps can style, not hide, the approximation.
3. **Ghost entries** — (a) failure → entry removed → next rebase recomputes from a base that never held the write: covers every projection, no per-location cleanup to miss; (b) queued items are visibly pending via entry state + `usePendingMutations`.
4. **Temp-id duplicate-on-confirm** — deterministic placeholders; confirm replaces-not-adds atomically (§4.2). No transient coexistence window.
5. **Double-apply via independent feed** — there is no independent feed; the drop-gate guarantees an entry is replayed iff the base does not yet include its write (`version.ts < commitTs` ⟺ replay), a strict complementarity.
6. **Non-independent stacking / compounding** — replay-in-order over each new base is the only mode; Relay's double-count and TanStack's snapshot-erase are unrepresentable (§3).
7. **Ambiguous failure / retry idempotency** — online `MutationResponse` failure is definitive (post-execution). Connection-drop ambiguity is solved *properly* by W2 dedup (slice 2) and until then fails safe exactly as today; never-sent entries are distinguishable from in-flight ones and retained (§2, transport close). The entry-state machine is what makes SWR's "error-dependent rollback" concern (E4 §4) tractable at all.
8. **Offline ordering + dependency** — FIFO by `seq` (drain preserves it); dependency rewrite via response-value → placeholder substitution at drain (§4.3), the one genuinely deferred hard corner, deferred with a stated mechanism rather than silence.
9. **Failure UX** — exceeds the mainstream bar: failed intent persists as an observable entry with retry-as-new-identity; silent-revert remains the zero-config default (§5).
10. **Cross-view consistency** — store-level by construction: effects registered per mutation apply to the client's whole query-result store; every subscriber of every touched query sees the same composed state. Ceiling stated honestly: only *subscribed* queries — un-subscribed reads would need the local substrate we decline to build.

---

## 9. Why layers are a dead end (the adversarial core)

1. **Closures don't survive anything.** Not a page reload, not serialization, not a process restart. The moment durable offline (or even durable crash-safe in-flight queuing — Linear ships it, E3 §4.3) is wanted, an ephemeral-layer implementation keeps only its replay loop; the entry representation, the public API (`withOptimisticUpdate` call-site closures), and the wire contract all change. That is a v2 rewrite with a DX migration, versus choosing the serializable registry shape now at ~zero marginal cost — the loop is identical (E3 §5, E1 §2.2).
2. **Reconnect is already owed, and it forces the server contract anyway.** No reconnect exists (G2); convex-js's own reconnect reissues outstanding mutations (E1 §2.4); reissue without W2 dedup double-applies (G5). The "layers need almost no server changes" pitch is true only for the sliver of roadmap before the very next client slice. B fronts a contract that is due regardless.
3. **Anonymous speculation can't face the user.** Pending badges, outbox UI, "tap to retry", crash-safe queues — every one requires speculation to be enumerable data with identity and state. The industry's best failure UX (Linear) falls out of a transaction log; the industry's median (silent revert + toast, E4 #9) is the *ceiling* of a closure model.
4. **Timestamps are a single-node luxury.** The ts drop-gate is correct today; under the shipped sharded writes and the fleet roadmap, per-mutation identity confirmation (lmid-shape) is the robust primitive (§2, forward-compat note). Only identified log entries can consume it.
5. **The convergent evidence points here.** Every system that survived contact with production converged on: server owns writes; optimism is an overlay dropped on observed inclusion; **offline is a durable ordered queue of intents** (E2 §5.4). Electric abandoned the CRDT replica and landed on tentative overlays + write-id round-trips; PowerSync's queue is a persistent FIFO of ops; Linear's is a persistent FIFO of transactions; Replicache/Zero's is the mutation log itself. The intent-log is the fixed point. Stackbase's mutations — deterministic, named, server-re-executed under OCC — are a *better* replay unit than any of their row-ops (E2 §5.2: "strictly better conflict semantics"). We are unusually well-shaped for exactly this design; building the closure variant first is building the one representation nobody's endgame uses.

**What B concedes without spin:** v1 keeps the hand-written-effect drift hazard (the mutation and its local effect agree only by discipline — Fork 2 of E3 §5, unresolved without a substrate); the registry is one more concept than a call-site closure and puts the effect away from the call site; G4's fallback holds a wrong-guess entry until the touched query's next invalidation (bounded, escape-hatched, but real); offline's hard corners (poison strategy, dependency rewrite, hours-later rejection) are product decisions the log *organizes* but does not dissolve. None of these costs is avoided by layers — layers just add a rebuild in front of them.
