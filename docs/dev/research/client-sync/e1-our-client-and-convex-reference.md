# E1 — Ground truth: our client/sync stack + the Convex optimistic-update reference

Scope: (1) an exact audit of the shipped client/sync path (`packages/client`, `packages/sync`, the `packages/cli` + `packages/runtime-embedded` server half) as it stands on `scheduler-component` (repo `/Volumes/Projects/concave-dev`), with every hook point an optimistic layer would attach to; (2) the Convex reference contract for `withOptimisticUpdate`, from the official docs and `convex-js` source; (3) what the foundation's honestly-deferred "optimistic updates + full version-gap resync" actually means against today's protocol. File:line for code claims; URLs for web claims; uncertainty flagged inline.

Headline: **no optimistic machinery exists anywhere in our client — not a stub, not a seam.** Each subscription holds exactly one value slot that is overwritten by server pushes (`packages/client/src/client.ts:26` `value: Value | undefined`). There is no local store, no pending-mutation overlay, no reconnect, and no offline anything. The good news: the protocol shape is already Convex-shaped enough that the reference reconciliation contract needs only **one wire change** (commit ts on `MutationResponse`) plus a client-side layer.

---

## Part 1 — Our stack, precisely

### 1.1 Wire protocol (`packages/sync/src/protocol.ts`)

- `StateVersion { querySet, ts }` (L13–20). `ts` = "the latest commit timestamp reflected"; `querySet` bumps on any query-set or auth change. **No identity counter** — `SetAuth` bumps `querySet` instead (`handler.ts:298`). Contrast: the concave/Convex reference version is a triple `(querySet, identity, ts)` (`docs/dev/architecture/internals/03-reactivity-sync.md:209`).
- Client→server: `Connect`, `ModifyQuerySet {add: QueryRequest[], remove: number[]}`, `Mutation {requestId, udfPath, args}`, `Action`, `EphemeralPublish`, `SetAuth`, `SetAdminAuth` (L43–50).
- Server→client: `Transition {startVersion, endVersion, modifications}`, `MutationResponse {requestId, success, value|error}`, `ActionResponse`, `Broadcast`, `FatalError`, `Ping` (L57–65).
- `StateModification` = `QueryUpdated {queryId, value}` | `QueryFailed {queryId, error}` | `QueryRemoved {queryId}` (L52–55). **`QueryUpdated` carries the full JSON result** — no deltas, no journal field (the binary-delta encoding and the pagination journal are documented targets, not built: `internals/03-reactivity-sync.md:342–348, 218–223`).
- **`MutationResponse` carries NO commit ts** (L59–60): only `requestId` + `success` + `value`/`error`. The reference protocol's `MutationResponse` carries the commit `ts` (`internals/03-reactivity-sync.md:212–213`). This is the single wire gap blocking the Convex reconciliation contract (§2.3) — and the ts is already in the server's hand at the send site (§1.5).

### 1.2 `StackbaseClient` (`packages/client/src/client.ts`)

Subscription lifecycle:
- `subscribe()` L55–87: dedupes by `hash = path + ":" + JSON.stringify(argsJson)` (L63); first subscriber allocates a client-local monotonically-increasing `queryId` (L67, never reused) and sends `ModifyQuerySet{add}` (L71); later subscribers share the sub and get the cached value immediately (L75). Last unsubscribe sends `ModifyQuerySet{remove}` (L82).
- `query()` L90–105: one-shot subscribe→first-value→unsubscribe.
- Results enter the client in exactly **one place**: `applyModifications` (L197–217) — `QueryUpdated` sets `sub.value = jsonToConvex(mod.value)` and fires every listener (L202–203); `QueryFailed` logs + fires `onError` and leaves the last value (L205–213); `QueryRemoved` keeps the last known value (L215).

Version gating (`onServerMessage`, L148–195):
- Normal path: a `Transition` is applied only if `startVersion` equals the client's current `version` (L161); apply → `version = endVersion` (L165–166). Equality-only check — same semantics as the reference reducer `packages/sync/src/client-reducer.ts:38–41`.
- Gap path: mismatch → `resync()` (L161–164, L220–233): set `resyncing`, reset `version` to `INITIAL_VERSION`, re-send `ModifyQuerySet{add}` for every live sub with the **same queryIds** (server-side `SubscriptionManager.add` refreshes in place, `subscription-manager.ts:50–52`). While `resyncing`, the **next Transition is adopted as the new baseline regardless of its startVersion** (L153–158).
- Mutations: `mutation()` L108–114 — client-local `requestId` counter, promise parked in `pendingMutations`, resolved/rejected by `MutationResponse` (L169–177). The resolution carries **value only — no ts**. Actions mirror this (L117–123, L178–186), non-reactive by design.
- Transport close: `onTransportClosed` L235–241 **rejects every pending mutation/action with "connection closed"** and clears them. Note the ambiguity: a mutation that was sent may have committed server-side; the client cannot know. There is **no server-side requestId dedup** (`handler.ts:204–217` just runs the mutation), so blind resend risks double-apply — an offline queue needs idempotency keys as a server change, not just a client change.

### 1.3 React hooks (`packages/client/src/react.tsx`)

- `useQuery` L29–43: `useState` + `client.subscribe`; re-renders on every push (L36); **resets to `undefined` on any ref/args identity change** (L35) — a loading flash on args change (relevant to optimistic pagination UX). Returns `T | undefined`; no error state surface (errors go to `onError`, which `useQuery` doesn't pass).
- `useMutation` L46–52 / `useAction` L55–61: thin `useCallback` over `client.mutation`/`client.action`. **No `withOptimisticUpdate` — no options argument at all.** The Convex-parity API would hang off the returned callback (Convex: `useMutation(...).withOptimisticUpdate(fn)`).
- If the optimistic layer lives inside `StackbaseClient` (composing values before listeners fire), the hooks need zero changes except surfacing `.withOptimisticUpdate`.

### 1.4 Transport (`packages/client/src/transport.ts`)

- `webSocketTransport` L47–100: **no reconnect, no backoff, nothing.** `close`/`error` → `fireClose` once (L55–60, 72–73); the only buffering is pre-OPEN queueing (L51, flushed L63–66, discarded on close L58). A dropped socket is terminal for the client instance; the app must construct a new client and re-render. There is no reconnect logic anywhere in `packages/client`, `packages/sync`, or `examples/chat` (grep: zero hits).
- `loopbackTransport` L23–44 for embedded/tests.

### 1.5 Server half (`packages/sync/src/handler.ts`, `packages/runtime-embedded/src/runtime.ts`, `packages/cli/src/server.ts`)

- The executor seam **already returns `commitTs` for every mutation**: `SyncUdfExecutor.runMutation → { value, tables, writeRanges, commitTs }` (`handler.ts:46–47`), produced at `runtime.ts:409–428` (L427: `Number(r.oplog?.commitTs ?? r.commitTs ?? 0n)` — local and forwarded-sharded commits both thread it).
- `handleMutation` (`handler.ts:204–217`): sends `MutationResponse` **without** the `commitTs` it holds at L209–210. Adding `ts` to the response is a one-line wire change + `protocol.ts:59`.
- Fan-out (`handler.ts:241–277`): `notifyWrites` is tail-serialized (L241–245); `doNotifyWrites` re-runs affected subs per session and pushes a `Transition` with `endVersion.ts = invalidation.commitTs` (L273). **Only sessions with an affected subscription get a Transition** (L259–261) — an unaffected session's `version.ts` never advances. This matters for ts-gated optimistic drops (§3, gap G4).
- **The origin session is included in its own fan-out.** `excludeOriginFromTransition` exists (`handler.ts:63, 253`) but the shipped wiring never sets it — `runtime.ts:459` passes only `{ autoNotifyOnMutation: false, verifyAdmin }`, and the queued drain (L460–485) calls `notifyWrites(inv)` with **no** originSessionId. So a mutating client observes its own write through a normal `Transition` whose `endVersion.ts` equals its mutation's commitTs — exactly the read-your-own-writes signal Convex's ts-gate consumes. (Concave's internal design excluded the origin, relying on `MutationResponse` alone — our own extraction flags the cross-query flicker risk of that choice at `internals/03-reactivity-sync.md:232–235, 375–377`. Our shipped behavior is the Convex-compatible one; keep it.)
- Ordering: `MutationResponse` is sent before the invalidation drains (`runtime.ts:455–458` comment; drain runs after the current stack), so the client reliably sees response-then-transition.
- Sessions are **server-assigned per-socket**: `sessionId = "ws-" + counter` on upgrade (`cli/server.ts:280` Node path, `:377` Bun path); socket close → `handler.disconnect` drops all subscriptions (`handler.ts:121–126`). Our client never sends `Connect`; the server's `Connect` handler is a no-op (`handler.ts:152–153`). **There is no session-resumption primitive** — a reconnect is a brand-new session that must re-subscribe from scratch.
- Backpressure can drop frames for slow clients (`session-controllers.ts`, wired at `handler.ts:115`); the protocol's stated degradation is "dropped frame → version gap → client resyncs" (`protocol.ts:5–8`). So resync is not an edge case; it is the designed slow-client path.

### 1.6 Every hook point the optimistic layer needs

| # | Hook | Site | What's available there |
|---|------|------|------------------------|
| H1 | Mutation initiation (apply update) | `client.ts:108–114` | `requestId` (client-local), path, args; `subsByHash` is the natural `OptimisticLocalStore` backing (keying at H4) |
| H2 | Sole server-value ingest point | `client.ts:197–217` `applyModifications` | queryId→sub, fresh JSON value; the layer must intercept here: keep server value separate, replay pending updates, notify with composed view |
| H3 | Initial cached delivery | `client.ts:75` | must serve the composed (optimistic) view, not raw `sub.value` |
| H4 | Query identity | `client.ts:63` (`path:JSON(args)`) | same identity Convex's local store keys on (query token = path+args) |
| H5 | Mutation resolution | `client.ts:169–177` | success/value or error; **no ts today** — failure→drop-now works; success→ts-gated drop blocked on H8 |
| H6 | Version after each Transition | `client.ts:156, 166` (`this.version`, private) | `endVersion.ts` = commitTs of the invalidating write — the ts-gate's clock |
| H7 | Transport close | `client.ts:235–241` | today rejects pendings; an offline queue replaces this with park-and-resend (needs server idempotency, §1.2) |
| H8 | Server: commitTs in hand at response time | `handler.ts:209–210`; produced `runtime.ts:427`; wire type `protocol.ts:59` | the one wire change: `MutationResponse { …, ts }` |
| H9 | Origin fan-out policy | `handler.ts:253` + `runtime.ts:459` | origin included today — required by the ts-gate; do not enable `excludeOriginFromTransition` |
| H10 | React re-render | `react.tsx:36` | unchanged if the layer composes inside `StackbaseClient`; `useMutation` needs `.withOptimisticUpdate` surface |

Also relevant: `@stackbase/test`'s `createTestStackbase` + reactive `t.subscribe` runs the REAL engine in-process (per project memory), so the optimistic layer's reconciliation can be conformance-tested against real commits rather than mocks.

---

## Part 2 — The Convex reference contract

### 2.1 API surface (docs)

Source: https://docs.convex.dev/client/react/optimistic-updates

- `const mutate = useMutation(api.x.y).withOptimisticUpdate((localStore, args) => { ... })`.
- `OptimisticLocalStore`: `getQuery(fn, args)` (returns `undefined` if not subscribed/loaded), `setQuery(fn, args, newValue)`, and `getAllQueries(fn)` (all subscribed arg-variants of one query function — needed when e.g. a mutation should patch every page of a paginated list).
- Exact timing sentence: *"Optimistic updates are run when a mutation is initiated, rerun if the local query results change, and rolled back when a mutation completes."*
- Exact reconciliation sentence: *"The Convex client will handle rolling back this update after the mutation completes and the queries are updated."* — i.e. rollback is deferred until server state covering the mutation has arrived (see 2.3 for the precise mechanism).
- Documented constraint: update functions must not mutate objects in place (*"Mutating objects inside of optimistic updates will corrupt the client's internal state"*) — the store shares references.

### 2.2 `OptimisticQueryResults` (convex-js source)

Source: https://github.com/get-convex/convex-js/blob/main/src/browser/sync/optimistic_updates_impl.ts

State: `queryResults` (query-token → result map) + an ordered array of `{update, mutationId}` for pending mutations.
- `applyOptimisticUpdate(update, mutationId)`: push onto the pending array, run it against a store view over `queryResults`, return the set of modified query tokens (for targeted notification).
- `ingestQueryResultsFromServer(serverQueryResults, optimisticUpdatesToDrop)` — the whole reconciliation model in three steps: (1) filter out dropped mutations' updates; (2) **replace local state wholesale with the server snapshot** (`this.queryResults = new Map(serverQueryResults)`); (3) **replay every surviving optimistic update in order on top**. Rollback is therefore not an inverse operation — it is "stop replaying." Changed-query detection is reference inequality (`oldQuery.result !== query.result`).
- Consequence worth internalizing: the reference "rerun if the local query results change" (2.1) is literal — updates are pure functions replayed on every server ingest, so they must be cheap and deterministic over whatever state they find.

### 2.3 When updates are dropped — the ts-gated contract (RequestManager)

Source: https://github.com/get-convex/convex-js/blob/main/src/browser/sync/request_manager.ts

- `MutationResponse` **success**: the request moves to `"Completed"` carrying the server's commit `ts` — the optimistic update is **not** dropped yet, and the mutation's promise does not resolve yet.
- The drop happens in `removeCompleted(ts)`: when a `Transition` advances the client past the mutation's timestamp (`status.ts.lessThanOrEqual(ts)` — i.e. transition `endVersion.ts >= mutation.ts`), the update is dropped **in the same ingest that delivers the server results reflecting the write**. That simultaneity is the no-flicker guarantee: speculative state is replaced by authoritative state atomically, never by a pre-write snapshot.
- `MutationResponse` **failure**: dropped immediately (source comment: *"We can resolve Mutation failures immediately since they don't have any side effects."*), remaining updates replayed → automatic rollback.
- So the full contract: **apply at initiation → replay on every server ingest → on failure drop now → on success drop only when a Transition with `endVersion.ts >= mutationTs` is applied.** This is what `MutationResponse.ts` exists for, and what our wire is missing (H8).

### 2.4 Reconnect/session in convex-js (the offline baseline)

Source: https://github.com/get-convex/convex-js/blob/main/src/browser/sync/client.ts

- Stable client-generated `sessionId` sent in `Connect` (with `maxObservedTimestamp`), `connectionCount` incremented per reconnect. On reconnect: fresh `RemoteQuerySet`, re-send the whole query set, re-auth, and `requestManager.restart()` **reissues unresolved mutations** (source comment: *"Throw out our remote query, reissue queries and outstanding mutations, and reauthenticate."*). Exactly-once for reissued mutations depends on server-side session state; we did not audit the backend half (flagged, not verified).
- **No disk persistence, no offline mode** in convex-js — in-memory only. Offline-first would be beyond-Convex territory for us, not parity.

### 2.5 Concave adds nothing here

`.reference/concave-docs-raw/llms-full.txt:3070`: *"Optimistic updates | Full | Client-side via Convex React client"* — concave reused the Convex client wholesale; the `@concavejs/*` packages contain **no optimistic-update machinery of their own** (the only "optimistic" hits in `.reference/concave-npm/ex/` are OCC-transactor internals). The concave-side requirements are purely the server metadata (commit ts on the mutation response + version-bracketed transitions), which our extraction already documents at `internals/03-reactivity-sync.md:225–235`.

---

## Part 3 — What "optimistic updates + full version-gap resync" (the deferred note, `CLAUDE.md:17`) means today

`internals/03-reactivity-sync.md:225–235` already states the design intent: requestId correlation + version-bracketed Transitions are "exactly what a client needs" — the metadata model was built for this; only the client layer (and one wire field) is missing.

What resync IS today: in-band gap detection + re-subscribe. A non-contiguous `Transition` triggers `resync()` (`client.ts:161–164, 220–233`); the designed use is backpressure frame drops (`protocol.ts:5–8`).

What makes it not "full", concretely:

- **G1 — stale-baseline adoption race.** While `resyncing`, the client adopts the *first* arriving `Transition` as its new baseline regardless of `startVersion` (`client.ts:153–158`). `handleModifyQuerySet` (the re-subscribe response) and `doNotifyWrites` (unrelated invalidations) are not mutually serialized server-side (`handler.ts:179–202` vs the `notifyTail` chain L241–245), so an unrelated partial invalidation frame can land first and be adopted — versions align again, but non-included queries silently keep stale values until their next invalidation.
- **G2 — no reconnect at all.** Resync only handles in-band gaps on a live socket. A dropped socket is terminal (`transport.ts:55–60`); no retry/backoff, no re-subscribe on a new socket.
- **G3 — no session resumption.** Server session ids are per-socket (`cli/server.ts:280`); client `Connect` is unsent/no-op (`handler.ts:152–153`). A reconnect is a cold session: full re-subscribe, and no `maxObservedTimestamp` fast-path (convex-js sends one, §2.4).
- **G4 — no ts-advancement for unaffected sessions.** Only sessions with affected subscriptions receive a `Transition` (`handler.ts:259–276`), so a session's `version.ts` can sit arbitrarily far behind the commit frontier. A Convex-style ts-gate ("drop when my version.ts ≥ mutationTs") can therefore wait indefinitely if the mutation invalidated nothing the client subscribes to. The design must either (a) have the server send the origin an empty ts-advancing Transition per mutation, or (b) drop-on-`MutationResponse` when the update modified no locally-subscribed queries. (We did not verify which the Convex backend does — its client-side gate is confirmed, the backend's empty-transition behavior is not.)
- **G5 — in-flight mutations are unrecoverable on disconnect.** `onTransportClosed` rejects with "connection closed" (`client.ts:235–241`) — outcome genuinely unknown, and blind resend can double-apply because the server has no requestId dedup (`handler.ts:204–217`). Any offline queue/resend design needs a server-side idempotency key, which also interacts with the sharded/fleet write path (forwarded mutations, `runtime.ts:409–428`).
- **G6 — resync is full-result, always.** Re-subscribe re-runs every query and re-sends full values (`protocol.ts:53`); fine at today's scale, but the deferred binary-delta/journal work (`internals/03:342–348`) changes the cost model of "resync from scratch" and the write-sharding corpus already notes the scalar `ts` loses its "everything ≤ ts reflected" meaning under multi-shard feeds (`write-sharding/evidence-invariants.md` §4) — a version-gap design decided now should not assume the scalar stays a global frontier.

Bottom line for the designers: the Convex contract is implementable as a pure client-side layer over H1–H7 plus exactly one wire field (H8), with G4 as the one genuine protocol-semantics decision; reconnect/offline (G2/G3/G5) is a separate, strictly larger slice that convex-js itself only partially occupies (reconnect yes, offline no).
