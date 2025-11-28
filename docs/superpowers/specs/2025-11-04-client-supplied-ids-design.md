# Client-Supplied Ids — Offline Create-Then-Reference Chains

**Status:** approved design (2025-11-04; presented in-session, user delegated design calls)
**Parent:** the Receipted Outbox verdict §(i) deferred row "Client-supplied ids (full offline
'create-then-reference' chains)" — offline follow-on 2 of 4 approved 2025-11-04. Today an offline
create-then-edit across TWO mutations is impossible: a `placeholderId` is deterministic-but-non-
decodable and never valid as a mutation argument (`docs/enduser/optimistic-updates.md` documents
the composite-intent workaround). This slice removes that limit.

## Goal

A client mints a REAL `Id<"table">` at args-construction time, passes it inside the args of later
queued mutations, and the engine accepts it on insert — so "create a conversation, then send into
it, both offline" drains correctly through the outbox, exactly-once, with the reference valid the
moment the create lands.

## Why the id format already permits this

An id is `base32(varint(tableNumber) ++ internalId(16 random bytes) ++ fletcher16(2))`
(`packages/id-codec/src/document-id.ts`). 128-bit entropy — a client minting the same shape has
identical collision resistance to the engine (`crypto.getRandomValues` exists in every target
runtime: browsers, Node, Bun, workers). **No format change and no provenance marker**: a
client-minted id is indistinguishable from an engine-minted one by design. The security boundary
is server-side validation at insert, never id provenance — an id string grants nothing by itself
(reads still pass authz read policies; writes still pass write rules; `v.id(table)` still
validates decoded table numbers).

## The table-number distribution decision

Ids embed the table NUMBER; nothing client-side knows numbers today (codegen doesn't emit them,
the wire deliberately doesn't carry them — the outbox spec froze `ConnectAck` minimal). Decision:

**Codegen emits the map** (approach A — chosen over a server-delivered/cached map, which would
reopen the frozen handshake and break minting offline-from-install, and over a name-embedded
client id format, which would fork the id format forever):

- `stackbase codegen` composes the project (the same `composeComponents` path the server boots —
  `packages/component/src/compose.ts` allocates deterministically in schema order from 10001) and
  emits the resulting `{ [tableName]: tableNumber }` map plus a ready-typed `mintId` into
  `convex/_generated/` (exact file decided in the plan; likely a new `_generated/ids.ts` since
  `dataModel` is types-only — apps import it exactly as they import `api`).
- `stackbase dev` threads the LIVE runtime composition's numbers into its codegen regeneration
  (it has them at regenerate time), so the map self-corrects during normal development.
- **Honest caveat (documented, not hidden):** a long-evolved deployment whose live numbers drifted
  from fresh-compose order (tables added mid-file across many additive deploys) can have a stale
  standalone-codegen map. The system NEVER trusts the client map — every minted id is validated
  server-side at insert (below), so a stale map produces a loud typed error, never a wrong-table
  write. The docs tell users to regenerate via a dev session attached to the live deployment
  lineage if they hit it.

## The mint surface

- `@stackbase/id-codec` already has the primitives (`newDocumentId`, `encodeDocumentId`).
  `@stackbase/client` gains a dependency on it (pure JS, browser-safe, no node imports — the
  dist browser-cleanliness guard must stay green) and exports
  `mintDocumentId(tableNumber: number): string` — the untyped core.
- Codegen emits the typed wrapper: `mintId<T extends TableNames>(table: T): Id<T>` bound to the
  generated map. App code:

```ts
import { mintId } from "../convex/_generated/ids";
const conversationId = mintId("conversations");           // a REAL Id<"conversations">
await createConversation({ _id: conversationId, name });  // queued offline
await sendMessage({ conversationId, body });               // references it, also offline
```

- **The purity rule (documented in both guides):** mint at args-construction time, OUTSIDE
  optimistic updaters — minting consults randomness; updaters must stay replay-pure and read the
  id FROM args (args are fixed at enqueue). `placeholderId` is untouched: placeholders remain a
  RENDERING concern; minted ids are an ARGS concern. An updater rendering a pending row may use
  the minted id from args as the row's `_id` — that is deterministic and correct.

## The engine surface

`ctx.db.insert(table, value)` accepts an optional `_id` field inside `value`
(`packages/executor/src/kernel.ts` `handleDbInsert`): extracted BEFORE document validation (the
same strip discipline `handleDbReplace` already applies to `_id`/`_creationTime`), then:

| Check (in order) | On failure |
|---|---|
| `_id` is a string that decodes (`decodeDocumentId` — base32 + varint + checksum) | typed error: malformed id |
| decoded `tableNumber` === the insert target's table number | typed error: id belongs to a different table |
| target is a USER table (client-suppliable ids are for user tables; decoded number ≤ 9999 / `_`-prefix targets are already unreachable via `db.insert`'s own table check, but the matrix states it explicitly) | typed error |
| target table is UNSHARDED (no `shardKey`) | typed error: sharded tables don't support client-supplied ids in v1 |
| the executing mutation runs on the DEFAULT ring (no `shardBy`, or a privileged run not routed off-default) | typed error: this mutation must not be shard-routed |
| no existing document with this id (`ctx.txn.get(internalId)` — the read-your-own-writes overlay makes this correct within a transaction too) | typed error: id already in use |

All errors are loud, typed, coded (exact classes per `@stackbase/errors` conventions, decided in
the plan). On success the insert proceeds exactly as today except `newDocumentId` is skipped —
**determinism preserved: the engine consults no randomness; the id came from args.**
`_creationTime` in an insert value remains rejected (server clock authority — unchanged).

**No upsert semantics.** An outbox resend never re-executes (receipts replay the recorded
verdict), so an id collision reaching the engine is an app bug (a non-outbox caller reusing an
id) and errors. No insert-if-absent, no aliasing, ever.

**Read/write sets & reactivity:** the existence check is a point read the invalidation machinery
already handles; the insert's write set is unchanged. Fleet: no changes beyond the sharding gate
below.

**Sharding (v1 restriction, amended post-review 2025-11-04):** a client-supplied `_id` is accepted
only when BOTH hold: (1) the target table is UNSHARDED (no `.shardKey`), and (2) the executing
mutation runs on the DEFAULT ring (no `shardBy`, or a privileged run not routed off-default via
`RunOptions.shardId`). Either violation is a typed `InvalidClientIdError`, checked in
`handleDbInsert` BEFORE the existence read (fail fast, and the read is never registered — it would
be meaningless across rings anyway).

Why: the supplied-`_id` existence check (`ctx.txn.get(decoded)`) is a snapshot read on the
*executing transaction's own ring*. On the default 8-shard `ShardedTransactor`
(`packages/transactor/src/shard-writer.ts`), each shard is an independently-mutexed OCC domain
with its own snapshot and `recentCommits` ring. Without this gate, two concurrent inserts of the
SAME client-minted id running on DIFFERENT rings (e.g. one unsharded-table insert on the default
ring plus one `shardBy`-routed insert of the same table — `enforceShardWrite` exempts inserts into
unsharded tables from ring ownership, since inserts are normally fork-free) would each see "not
found" and both commit: a silent duplicate identity with a forked `prev_ts` chain, violating the
no-silent-duplicate invariant this feature promises. Restricting the feature to the default ring
makes the existence check + the OCC validated-read-set (`ctx.db.insert`'s `ctx.txn.get` already
registers a validated read, `shard-writer.ts` `TransactionContextImpl.get`) globally sound for that
table: every write of it lands on the ONE ring, so a true concurrent duplicate now loses at OCC
there instead — the executor's built-in OCC-conflict retry loop (`runInTransactionSingle`) replays
the loser's handler deterministically, its fresh read finds the winner's row, and it fails loudly
with `ID_ALREADY_IN_USE` rather than silently forking. Sharded-table support (binding a
client-supplied id to the row's shard-key value, so the existence check can be routed to the
correct ring) is deferred — see Non-goals.

## What explicitly does NOT change

- The wire protocol (ids travel inside args as strings, as they always have).
- `placeholderId`/optimistic-update semantics, the S1 seed, replay purity rules.
- The receipts/drain machinery — this slice's E2E exists to PROVE the composition, not change it.
- `v.id(table)` validation (already checks decoded table numbers; minted ids pass transparently).
- Engine-minted ids remain the default; `_id` in an insert value is always optional.

## Testing

1. **id-codec/unit:** client-minted ids round-trip decode; `mintDocumentId` output validates via
   `isValidDocumentId` with expected table number.
2. **Executor:** the full rejection matrix (malformed, wrong table, existing id — incl. an id
   inserted earlier IN THE SAME transaction via the pending overlay), plus success path (doc
   readable by its minted id in the same txn and after commit; `_creationTime` still
   server-stamped); determinism (same args replay → same id, no `newDocumentId` call on the
   `_id` path).
3. **Codegen:** the emitted map covers exactly the APP's own tables (component tables are not
   insertable by app code — `requireOwnTable` — so they are excluded from `mintId`'s domain, and
   the map, by construction); numbers match the composition; `mintId` return typing
   compiles (`Id<"messages">` assignable where `v.id("messages")`-validated args expect it);
   regeneration through `stackbase dev` uses the live composition's numbers.
4. **E2E through the real server** (`packages/cli/test/client-ids-e2e.test.ts`): the flagship
   chain — client offline (outbox configured), `mintId` a conversation id, enqueue
   create-with-`_id` then a message referencing it, reconnect, drain: exactly one conversation
   row under the minted id, the message's reference resolves, reactive subscription sees both;
   plus the rejection matrix over the wire (wrong-table id and already-in-use id → typed error
   surfaces through `onMutationFailed`/mutation rejection); plus an engine-minted-path regression
   (insert without `_id` byte-identical to today); plus the concurrent same-id duplicate race
   through the real 8-shard server (exactly one row, loser gets `ID_ALREADY_IN_USE`).

## Error handling

Client-map staleness → server-side typed rejection (never a wrong-table write) → surfaces through
the standard mutation-failure channels (R9 `onMutationFailed` for outbox clients; rejected promise
for online calls). Collision between two independently-minted ids: 2^-128-scale; if it ever
happens the second insert errors loudly (id already in use) — no silent merge.

## Docs

`docs/enduser/offline.md`: the create-then-reference section becomes primary (the composite-intent
workaround demoted to "when you can't regenerate codegen"). `docs/enduser/optimistic-updates.md`:
the "never pass a placeholderId as an argument" rule gains "mint a real id instead" with the
purity rule. Codegen docs mention `_generated/ids`. CLAUDE.md updated at merge.

## Non-goals

No CRDT/merge; no client-side replica; no collision aliasing/renaming; no `_creationTime`
acceptance; no server-delivered table-number sync (revisit only if map-staleness proves painful
in practice); no changes to placeholder semantics; no sharded-table support for client-supplied
ids (binding an id to its shard-key value so the existence check can be routed to the correct
ring) — deferred, not planned; v1 is unsharded-tables-on-the-default-ring only (see Sharding
above).
