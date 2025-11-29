# Subscription Resume — Server-Minted Result Fingerprints

**Status:** approved design (2025-11-28; presented in-session, user delegated design calls)
**Parent:** the Receipted Outbox verdict §(i) deferred row "Subscription resume token" — offline
follow-on 3 of 4 approved 2025-11-04. Also closes CLAUDE.md's oldest deferred seam
("maxObservedTimestamp fast-resume / full session-resumption on reconnect") in its practical
sense: today `resync()` re-subscribes every live query and the server re-sends every full result;
after this slice, unchanged results cost a tiny frame instead of a payload.

## Goal

Reconnect bandwidth for a client with N live subscriptions collapses from N full result sets to N
fingerprint-compare frames when nothing changed while disconnected (the common case for brief
drops and offline-heavy apps), with byte-compatible graceful degradation to today's full send in
every other case. Compute is explicitly NOT saved — queries still re-run at resubscribe (the
retained-read-set design that would save compute is the deferred v2 seam, see Non-goals).

## Approach decision (three candidates)

- **(a) Server-retained session state + grace TTL — rejected.** Session/subscription state is
  per-node and in-memory (`packages/sync/src/handler.ts` `sessions` map, `subscription-manager.ts`;
  ALL of it deleted on disconnect). A fleet reconnect routinely lands on a DIFFERENT node, where
  retained state is worthless unless replicated — a distributed subscription store is a
  Tier-2-sized project, plus TTL/routing/identity-binding surface.
- **(c) MVCC-log pre-check — rejected.** `DriverContext.readLog` is an unfiltered
  O(total-log-churn) scan with post-scan table filtering (`runtime.ts:758-765`), and the read-sets
  that would make it precise exist only in live sessions — (c) reduces to (a) plus a scan.
- **(b') Stateless server-minted fingerprint — CHOSEN.** The server hashes its own serialized
  result and sends it with every `QueryUpdated`; the client stores the hash opaquely and echoes it
  per-query on resubscribe; the server re-runs, re-hashes, and sends `QueryUnchanged` on match.
  The classic client-side-ETag canonicalization problem does not exist: the server only ever
  compares hashes it minted itself.

## Wire changes (all additive; old peers degrade to full send)

```ts
// protocol.ts — additive fields/variant only
QueryRequest:        { queryId, udfPath, args, resultHash?: string }   // client echo on resubscribe
StateModification:   | { type: "QueryUpdated"; queryId; value; hash?: string }  // server-minted
                     | { type: "QueryUnchanged"; queryId }                       // NEW variant
```

- `hash` = `"sha256:" + hex(SHA-256(serialized value bytes))` — computed at the send site over the
  exact JSON the server would transmit, via `node:crypto` `createHash` (server-side only; the
  client never hashes anything). The `"sha256:"` prefix reserves algorithm agility.
- Every `QueryUpdated` the server sends carries `hash` (initial subscribe answer AND reactive
  re-run pushes), so the client's stored hash is always current at disconnect time. Cost: one
  SHA-256 over bytes the server already serialized — negligible next to query execution.
- Compatibility matrix: new client ↔ old server (server ignores `resultHash`, sends full — the
  client must treat a hash-less `QueryUpdated` as full delivery, which it is); old client ↔ new
  server (no `resultHash` sent → server never sends `QueryUnchanged`); byte-identical today-path
  when the client has nothing to echo (first subscribe, failed prior answer, no `serverValue`).

## Server behavior (`handler.ts` `doModifyQuerySet` + the re-run push path)

- Subscribe processing runs the query exactly as today (`execSub` → full run, fresh
  `tables`/`readRanges` registered). Then: if the add entry carried `resultHash` AND the fresh
  result's hash equals it → push `{type: "QueryUnchanged", queryId}`; else push `QueryUpdated`
  with `value` + `hash`. `QueryFailed` unchanged (never hashed, never "unchanged").
- The reactive push path (invalidation → re-run → send) attaches `hash` to its `QueryUpdated`s.
  It never sends `QueryUnchanged` (a push only happens because the read-set was intersected; if
  the re-run produced an identical value the existing behavior — send it — stays; suppressing
  identical pushes is a separate optimization, out of scope).
- No retention anywhere: `disconnect()` still deletes everything. Statelessness is the feature.

## Client behavior (`client.ts` / `layered-store.ts` / `reconcile.ts`)

- `Subscription` gains `lastHash?: string` — stored verbatim from every `QueryUpdated.hash`
  ingested (absent hash → `lastHash` cleared, so an old-server session never echoes a stale hash).
- `resync()`'s `ModifyQuerySet` add entries include `resultHash: sub.lastHash` only when the
  subscription is `answered` with a defined `serverValue` (a failed or never-answered sub echoes
  nothing).
- Ingesting `QueryUnchanged`: **counts as a full delivery in every gate** — sets `answered`,
  retains `serverValue` (and `lastHash`) as-is, recomputes `composedValue` through the same path a
  value-equal `QueryUpdated` takes today, and notifies listeners with EXACTLY today's
  identical-value re-send semantics (whatever the store currently does for a value-equal
  `QueryUpdated` — the implementer verifies and matches it; `QueryUnchanged` must not introduce a
  new observable difference for app code).
  Specifically it must satisfy: the resyncing-adoption path (it rides inside the adopted
  Transition), `hasUndeliveredSubscription()` (the outbox drain's baseline gate — a resumed-
  unchanged subscription is answered; the drain must not starve), and `versionCoversCommit`
  semantics (unchanged: the enclosing `Transition.endVersion.ts` advances `observedTs` exactly as
  today — `QueryUnchanged` needs no ts of its own).
- Identity safety needs no code: `SetAuth` replays BEFORE `resync()` (existing reopen ordering),
  and an identity change alters the server's fresh result → hash mismatch → full send.

## Security

Echoing a hash of a result the client already possessed reveals nothing. A forged/guessed
`resultHash` elicits `QueryUnchanged` only when it equals the hash of the fresh result computed
for THIS session's identity — i.e. the attacker already knows the result. `QueryUnchanged`
carries no data. Authz re-evaluation is inherent (the query re-runs under current identity/rules).

## Failure honesty

There is NO error path: missing/stale/forged hash, old peer, identity change, changed data — all
degrade to today's full `QueryUpdated`. A `QueryUnchanged` for a queryId the client no longer
tracks is ignored (same as a stray `QueryUpdated` today).

## Testing

1. **Sync unit:** hash attached to every `QueryUpdated` (subscribe + reactive push); echo-match →
   `QueryUnchanged` (subscription still registered with FRESH read-sets — assert a subsequent
   write still invalidates and pushes); echo-mismatch → full; no-echo → full; `QueryFailed` never
   hashed; old-client path byte-identical (no `resultHash` → no `QueryUnchanged` ever).
2. **Client unit:** `lastHash` stored/cleared correctly; `resync()` echoes only answered+defined
   subs; `QueryUnchanged` ingest sets `answered`, keeps value, satisfies
   `hasUndeliveredSubscription()` (the drain-gate regression: seeded outbox backlog + reconnect
   where ALL subscriptions resume unchanged → the drain must proceed — red-first against the gate);
   listener not notified when composed value unchanged; optimistic layers over an unchanged base
   still compose.
3. **E2E through the real server** (`packages/cli/test/resume-e2e.test.ts`): N subscriptions,
   kill the socket, reconnect → all N resume as `QueryUnchanged` (assert via wire taps or client
   state + bytes); mutate ONE query's data while disconnected → exactly that one arrives as full
   `QueryUpdated` (with a fresh hash), the rest `QueryUnchanged`; a full offline-outbox client
   reconnect (drain + resume composing); old-client compat (a client that never sends
   `resultHash` gets today's behavior byte-for-byte).
4. **Benchmark** (extending the `bench-fanout-ws` real-WS pattern, opt-in env like its siblings):
   N=50 subscriptions with realistic payloads, disconnect/reconnect, measure (a) total bytes
   received during resume and (b) time-to-all-answered, with and without fingerprints. Recorded in
   `docs/dev/research/` alongside the other bench notes.

## Non-goals

- Saving server COMPUTE on resume (retained read-sets / true watermark resume) — the explicit v2
  seam; this slice's `QueryUnchanged` variant is forward-compatible with it (the wire shape
  wouldn't change).
- Row-level diffs/patches (Unchanged-or-full only).
- Suppressing identical-value reactive pushes (orthogonal optimization).
- A persisted client query baseline (declared non-goal of the offline slice — resume ≠ replica).
- Cross-session resume (a fresh page load has no `serverValue` to echo; nothing to resume).

## Docs

`docs/enduser/offline.md` reconnect section: a short "what reconnect costs" paragraph (unchanged
results resume as fingerprint matches; changed ones arrive in full; nothing to configure —
automatic when both peers are current). CLAUDE.md: the deferred-seam line updated (fast-resume
shipped in its bandwidth sense; compute-saving resume remains deferred). The deferred table row in
offline.md graduates.
