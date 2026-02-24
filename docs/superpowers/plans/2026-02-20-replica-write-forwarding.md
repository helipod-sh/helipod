# Replica write-forwarding (Tier 3 Slice 8 follow-on)

## Problem

`stackbase serve --object-store <url> --replica` currently REJECTS every mutation/action
("read replica" — `REPLICA_WRITE_REJECTED_MESSAGE`, `boot.ts`'s `wrapReplicaWriteRejection`).
A client that happens to connect to a replica instead of the writer can't write at all —
it has to know the writer's URL out-of-band. This slice makes a replica FORWARD writes to
the writer instead, transparently, when told where the writer is.

## Key insight: reuse the core `WriteRouter` seam, not a new HTTP proxy

`@stackbase/executor`'s `WriteRouter` interface (`isLocalWriter(shardId)` / `forward(kind,
path, args, identity, shardId, dedup?)`) is ALREADY the exact mechanism needed here, and it's
CORE (not `ee/`) — `packages/runtime-embedded`'s `EmbeddedRuntime` already threads it through
ONE chokepoint that covers:
  - `executor.run()`'s per-shard mutation branch — used by WS `Mutation` messages
    (`syncExecutor.runMutation`), `POST /api/run` (`EmbeddedRuntime.run`), and an action's inner
    `ctx.runMutation`.
  - `EmbeddedRuntime.run`/`runAction`'s wholesale action-forward branch — used by WS `Action`
    messages (`syncExecutor.runAction`) and `POST /api/run` with an action path.
  - Queries NEVER touch this seam (`fn.type === "query"` is excluded by construction) — reads
    stay local on the replica, which is the whole point of a read replica.

So implementing a `WriteRouter` for the object-store replica case and passing it into
`createEmbeddedRuntime` automatically covers BOTH `POST /api/run` and the WS sync path, with
zero additional wiring in the sync/WS layer. `@stackbase/fleet`'s `WriteForwarder` (ee) is the
precedent for this exact seam, generalized over per-shard lease discovery + idempotency — this
slice's version is deliberately simpler: ONE fixed writer URL (no shard lease discovery), no
idempotency store (dedup, if present, rides the forward so the WRITER classifies it — mirrors
the "classification runs where the commit runs" placement rule already documented on
`runtime.ts`'s `syncExecutor.runMutation`).

## Design

1. **`packages/cli/src/replica-forward.ts`** (new): `ReplicaWriteForwarder implements WriteRouter`.
   - `isLocalWriter()` always `false` — a replica is never the writer for any shard.
   - `forward(kind, path, args, identity, shardId, dedup?)` POSTs to `${writerUrl}/api/run` with
     `{ path, args, kind, forwarded: true, clientId?, seq? }`, `identity` passed as
     `Authorization: Bearer <identity>` (mirrors the httpAction convention: the caller's raw
     bearer is passed straight through as `opts.identity`). Throws a clear error on a network
     failure or a non-2xx/`error` response.

2. **`packages/cli/src/http-handler.ts`**: extend `POST /api/run`:
   - Derive `identity` from `Authorization: Bearer <token>` (new capability — `/api/run` had NO
     identity support before this; additive, backward compatible: no `Authorization` header ->
     `identity: null`, byte-identical to today).
   - Return `commitTs` in the response body (additive field) so a forwarding replica's
     `WriteRouter.forward()` can report the writer's real commitTs instead of a hardcoded 0.
   - Single-hop defensive guard: a new optional `replicaWriterUrl` param to `handleHttpRequest`
     marks "this node is itself a replica configured to forward". If a request arrives here with
     `forwarded: true` AND this node is such a replica, reject with 409 instead of silently
     forwarding again (a misconfiguration — some caller's `--writer-url` points at a replica
     instead of the real writer). The actual WRITER has no `writeRouter` at all, so `runtime.run`
     always executes locally there — it structurally can't re-forward, no guard needed on that
     side.

3. **`packages/cli/src/server.ts`**: thread `replicaWriterUrl` from `DevServerOptions` to both
   `handleHttpRequest` call sites (Node + Bun backends).

4. **`packages/cli/src/boot.ts`**: `bootLoaded`/`bootProject` gain `writerUrl?: string`. When
   `opts.replica && opts.writerUrl` is set, construct a `ReplicaWriteForwarder(opts.writerUrl)`
   and pass it to `createEmbeddedRuntime` as `writeRouter`. `BootResult` exposes
   `replicaWriterUrl` so `serve.ts` can thread it to `startDevServer`. When `writerUrl` is unset,
   behavior is BYTE-IDENTICAL to today — no `writeRouter`, mutations attempt a local commit and
   hit the existing `wrapReplicaWriteRejection` "read replica" rejection.

5. **`packages/cli/src/serve.ts`**: `--writer-url <url>` flag + `STACKBASE_WRITER_URL` env
   (flag wins), threaded into `bootProject` and `startDevServer`. Ignored unless `--replica` is
   also set (mirrors how other replica-only flags are documented).

## Non-goals (v1)

- Queries/subscriptions are NEVER forwarded — they stay local on the replica (by construction,
  via the `WriteRouter` seam's own mutation/action-only scope).
- No shard-lease discovery (single fixed writer URL — matches the object-store substrate's
  single-shard-node scope boundary already documented in `boot.ts`).
- No retry/backoff on the forward call beyond what `fetch` does natively — a writer-unreachable
  forward surfaces as a clear error to the caller (not a silent success, not a hang).

## Tests

- `packages/cli/test/replica-forward.test.ts` (new, unit): `ReplicaWriteForwarder` against a
  stub HTTP "writer" — asserts the POST target/body/headers (`forwarded: true`, `Authorization:
  Bearer <identity>`), successful forward, non-2xx -> throws, unreachable writer -> throws a
  clear error.
- `packages/cli/test/http-handler.test.ts` or a new focused file: `/api/run` derives identity
  from `Authorization`; the `forwarded: true` + `replicaWriterUrl` set -> 409 single-hop guard.
- `packages/cli/test/objectstore-replica-forward-e2e.test.ts` (new, E2E): a real WRITER +
  a real REPLICA (`--object-store <url> --replica --writer-url <writer's url>`) over one fs
  bucket — a `POST /api/run` mutation on the REPLICA forwards, commits on the writer, and the
  replica's own pre-opened WS subscription fires with the new data (via the existing tailer).
  Also covers: a query on the replica is served locally (no forward), and the pre-existing
  reject-without-`--writer-url` behavior is unchanged (already covered by
  `objectstore-replica-e2e.test.ts`, left untouched).
