---
title: Hardening pass — adversarial code review (2025-05-15)
status: applied
---

# Hardening pass — adversarial review of the built code

An adversarial review workflow (5 subsystem reviewers, each finding verified by an independent
skeptic against the actual source) surfaced **23 candidates → 19 confirmed** real bugs in the
Foundation code. 4 candidates were correctly rejected as false positives. This records each
finding and its disposition. Regression tests were added for the two criticals.

## Fixed (16)

| # | Severity | Finding | Fix |
|---|---|---|---|
| snapshot-uses-allocated-not-committed-ts | **critical** | Snapshot read the just-*allocated* commit ts (outside the mutex), so OCC's strict `c.ts > snapshotTs` check could miss an in-flight commit → **silent lost update** | Oracle now has a separate `lastCommitted` clock, advanced only after writes apply (under the mutex); transactions snapshot from `getLastCommittedTimestamp()`. Regression: 25 concurrent increments → 25. |
| client-bypasses-gap-guard | **critical** | Client applied `Transition` modifications outside the version-gap guard and never acted on `needsResync` → delivered post-gap (stale) values, defeating the resync contract | Client gates updates on the version bracket; on a gap it **resyncs** (re-subscribes, adopts the server's next state) and never delivers stale. Regression test added. |
| blind-write-prev-ts-fork | high | Blind `put`/`delete` chained `prev_ts` from the stale snapshot → forked revision chain under concurrent writers | Chain `prev_ts` from the latest committed revision (`get` with no upper bound, race-free under the single-writer lock). |
| nan-sign-codec-order | high | `encodeFloat64` produced inconsistent bytes for sign-set/non-canonical NaN, breaking the order-preserving contract | Canonicalize NaN before encoding (matches `compareValues`). |
| pending-mutations-leak-on-disconnect | high | Mutation promises hung forever if the transport closed mid-flight | Transport `onClose` → client rejects all pending mutations. |
| ws-transport-no-close-error-handling | high | `webSocketTransport` ignored close/error; `send` threw after close; queue could grow unbounded | Handle close/error (fire `onClose`), no-op `send` after close, queue only buffers pre-OPEN. |
| fanout-unwired-http-mutations-not-reactive | high | The write fan-out was never subscribed, so commits via `runtime.run()` / HTTP `/api/run` never invalidated live subscriptions | Runtime subscribes the sync handler to the fan-out; `autoNotifyOnMutation: false` unifies all commit paths through the seam (no double-notify). |
| static-symlink-and-prefix-traversal | high | Dev-server static guard escapable via symlinks and sibling-prefix paths | `realpathSync` both root and target; require target `=== root` or under `root + sep`. |
| fanout-publish-inside-mutex-blocks-writer | medium | `fanout.publish()` awaited inside the commit mutex → a slow subscriber stalls the writer | Fire-and-forget publish; the runtime drains notifies on an async serialized queue. |
| index-scan-limit-counts-tombstones | medium | SQL `LIMIT` counted deleted index entries → short pages | Apply the limit in JS after skipping tombstones/null pointers. |
| notifywrites-no-serialization | medium | Concurrent `notifyWrites` could reorder version brackets → false client gaps | `notifyWrites` is serialized via a promise chain. |
| replace-resurrects-missing-doc | medium | `db.replace` on a missing/deleted doc silently created it | Throws `DocumentNotFoundError`. |
| ws-no-error-handler | medium | A socket `error` (abrupt drop) could crash the process | Server attaches an `error` handler per WS connection (full bufferedAmount backpressure still deferred — see below). |
| tagged-object-collision-roundtrip | low | A user object with a single `$integer`/`$float`/`$bytes` key was misdecoded | Escape `$`-prefixed keys (`$x → $$x`) in `convexToJson`; reverse in `jsonToConvex`. |
| unbounded-request-body | low | `readBody` buffered the whole request with no cap | 5 MB limit; oversize requests are rejected. |
| dashboard-html-injection | low | Dashboard rendered function/table names unescaped | HTML-escape names. |

## Deferred (3 + 1 partial) — with rationale

- **newdocumentid-nondeterministic-replay** (medium) — `db.insert` uses `crypto` randomness, non-deterministic across replay. *Not a correctness bug in our model:* ids are globally unique and a conflicting replay's writes are discarded (never committed), so only the committed attempt's ids persist. Seeded deterministic ids are a future refinement.
- **creationtime-from-snapshot-not-commit** (medium) — `_creationTime` derives from the snapshot ts. Deterministic per attempt and monotonic across sequential commits; exact commit-time would require allocating the commit ts before insert. Deferred.
- **dead-structured-cursor-vs-rawbyte-cursor** (low) — the exported value-tuple `Cursor` codec in `index-key-codec` is unused (pagination uses raw-byte cursors). Harmless dead code; will unify or remove.
- **ws bufferedAmount backpressure** (part of ws-no-error-handler) — the error handler is in; full drop-and-resync backpressure on slow consumers is the planned `SessionBackpressureController` work.

## Rejected as false positives (4)
`prune-minactive-empty-fallback`, `count-ignores-snapshot-ts`, `modifyqueryset-version-stomp`, `dbread-capability-not-gated` — each verified to be already-handled or non-issues.
