# Slice 5 — Data-migration tool (portable ⇄ DO-native): design note

**Date:** 2026-03-20
**Status:** DESIGN NOTE (light, per roadmap — Slice 5 is "mostly mechanical once the two topologies are stable").
**Branch:** from `spike/cloudflare-r2-gate`.
**Scope:** Slice 5 of `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md` — move an app's
DATA between the two topologies: portable (container + R2 object-store / plain SQLite / Postgres) ⇄
DO-native (DO-SQLite). Single-shard only; multi-shard split is Slice 6.

---

## TL;DR — the load-bearing findings

1. **Migration is possible because the data model is ONE logical shape across every store** (locked
   decision: append-only MVCC log `{ts, id, value, prev_ts}` + a parallel MVCC index log). The
   *physical* host differs (R2 shared log vs DO-SQLite per-object), but the *materialized current
   state* — every live document's latest revision + every current index row — is identical in shape.
   So a dump is exactly `SqliteDocStore.dumpCurrentState()`'s output (`{documents, indexUpdates}`),
   the SAME primitive the Tier-3 R2 snapshot mechanism already uses (`ee/.../snapshot.ts`). **Reuse
   that shape; do not invent a new one.**

2. **The dump MUST carry table numbers, and import MUST reject a mismatch.** A document's physical
   `table_id` column IS its table number (`encodeStorageTableId(n) === String(n)`); the number→name
   mapping lives only in the *runtime's* schema, never in the store. Two independent deploys of the
   same `schema.ts` can assign DIFFERENT numbers (allocation is declaration-order-dependent). If a
   dump's rows land in a target whose `messages` table has a different number, queries would serve
   those rows under the WRONG table — the exact table-number-clash bug this program already hit with
   a reused object store. **The collision guard (`assertImportableTableNumbers`) is the single most
   important correctness check in this slice.**

3. **Both topologies already funnel `/_admin/*` through ONE handler** (`handleAdminRequest`), on the
   container `serve` path AND the DO host (`durable-object.ts` → `host.ts` → `handleHttpRequest` →
   `handleAdminRequest`). So export/import added as `AdminApi` methods + two admin routes work on
   BOTH topologies for free — the DRYest possible integration. The DO's store is writable ONLY from
   inside the DO, and this endpoint runs inside the DO. No new DO-specific plumbing.

4. **Import must advance the timestamp oracle.** A freshly-booted runtime seeds its oracle from
   `store.maxTimestamp()` (0 for a fresh store). Writing imported rows at their real ts (up to N)
   directly via `store.write(..., "Overwrite")` does NOT advance the in-memory oracle, so queries
   would still read at `ts <= 0` and see nothing. After applying a dump, call
   `runtime.observeTimestamp(await store.maxTimestamp())` to re-floor the read/write snapshot — the
   same seeding a boot does. (Single-node target only; no `queryStore`.)

---

## The portable dump format — `MigrationDump`

Lives in **`@stackbase/docstore`** (`src/migration-dump.ts`) — the neutral package that owns the
`DocumentLogEntry`/`IndexWrite` types and already depends on `@stackbase/values` for `Value`
tagging. Engine-neutral: no Cloudflare, no SQLite, no CLI types. Reuses the SAME
bigint→decimal-string / `Uint8Array`→base64 / `Value`→`convexToJson` wire tagging that
`ee/.../segment.ts` proved (reimplemented in core — core cannot depend on the `ee/` package).

```jsonc
{
  "format": "stackbase-migration-dump",
  "version": 1,
  "deploymentId": "…|null",              // source deployment id — METADATA ONLY, never applied
                                         //   (applying it would flip outbox clients to known:false)
  "tableNumbers": { "messages": 10001, "_storage": 20, … },  // name → number (THE collision guard)
  "frontierTs": "42",                    // source store.maxTimestamp() at export (decimal bigint)
  "documents": [ /* WireDocumentLogEntry[] — real ts/prev_ts, tombstones excluded */ ],
  "indexUpdates": [ /* WireIndexWrite[] — current index rows, deletions included */ ]
}
```

`documents`/`indexUpdates` are exactly `dumpCurrentState()`'s output, wire-encoded. `schemaJson` is
NOT carried — the target must already have the matching schema deployed (its own codegen'd
`_generated/`), and the table-number guard is what enforces compatibility. Carrying schema would
tempt a "schema import" that this slice explicitly does not do (a migration target deploys its schema
the normal way first).

## Export — `exportDumpFromStore(store, { tableNumbers, deploymentId? })`

`DumpableDocStore` capability (`{ dumpCurrentState(): Promise<{documents, indexUpdates}>; maxTimestamp():
Promise<bigint> }`). `SqliteDocStore` has it; the R2 `ObjectStoreDocStore` and `PostgresDocStore` get
a thin delegating/mirroring `dumpCurrentState()` so all three source topologies export. A store
without the capability throws a clear typed error rather than a silent partial dump.

## Import — `applyDumpToStore(store, dump)` + the guard

1. `assertImportableTableNumbers(dump, targetTableNumbers)` — for every table number actually present
   in `dump.documents`/`indexUpdates`: resolve its name via the dump's own `tableNumbers`; require
   the target to map that SAME name to that SAME number. Reject (typed `TableNumberMismatchError`)
   on: a dump-internal inconsistency, a table the target doesn't have, or a number that differs.
2. `store.write(documents, indexUpdates, "Overwrite")` — INSERT-OR-REPLACE overlay at the dump's real
   ts, preserving `_id`, `_creationTime` (a field IN the value, untouched), prev_ts chains, and index
   rows. Idempotent for the same dump.
3. Caller (AdminApi) then advances the oracle (finding 4).

**Import targets a FRESH deployment** for the "identical results" guarantee. Importing onto a store
that already holds divergent data merges by MVCC-latest-ts and is NOT a supported merge — documented,
not defended (out of scope, like all merge semantics in this program).

## The admin endpoints (both topologies, one code path)

Added to `packages/admin/src/router.ts` + `AdminApi`:

| Route | Method | Does |
|---|---|---|
| `/_admin/export` | GET | `AdminApi.exportDump()` → `MigrationDump` JSON |
| `/_admin/import` | POST | `AdminApi.importDump(dump)` → `{ ok, imported: {documents, indexUpdates} }` |

Both admin-key (`STACKBASE_ADMIN_KEY`) bearer-gated by `handleAdminRequest`'s existing check (401 on
wrong key, before anything is read/applied). No `--allow-deploy`-style opt-in: import/export are admin
operations, gated by the admin key alone, same as the data browser's read/patch/delete. On the DO this
is reachable because the DO already routes `/_admin/*` through the same handler.

## The CLI — `stackbase migrate export` / `stackbase migrate import`

Verb dispatch inside `migrateCommand` (keeps `stackbase migrate` coherent; the existing bare
`migrate` = the Convex codemod is unchanged):

```
stackbase migrate export --url <src-url>  --out dump.json   [--admin-key … | $STACKBASE_ADMIN_KEY]
stackbase migrate import --url <dst-url>  --in  dump.json   [--admin-key … | $STACKBASE_ADMIN_KEY]
```

HTTP clients modelled verbatim on `deploy.ts` (fetch + `Bearer` + friendly errors). They hit the
running source/target's `/_admin/export`/`/_admin/import`. A STOPPED plain-SQLite source is exported
by pointing a throwaway `stackbase serve`/`dev` at it and running `migrate export` — the DO can ONLY
be reached over HTTP anyway, so an HTTP-first client is the coherent shape. (A direct-file export mode
is a possible follow-on; not built — it needs the app's `convex/` to recover table numbers.)

## The gate — fidelity of the proof

- **Adapter/engine round-trip (Node, real `SqliteDocStore`):** a source runtime with real data across
  multiple tables + indexes → `exportDump` → `applyDump` onto a FRESH runtime → a query returns
  identical rows, ids, and `_creationTime`. Proves codec + guard + oracle-advance end to end.
- **Real-workerd DO import (`vitest-pool-workers`, `runInDurableObject`):** POST a dump to a real DO's
  `/_admin/import` (writing into the real `ctx.storage.sql`), then read it back via `/api/run` — the
  highest-fidelity proof short of a live `wrangler deploy`. DO export via `/_admin/export` proves the
  reverse direction.
- **Collision guard:** a dump whose `messages` number differs from the target's is REJECTED (adapter
  level + through the endpoint) — never silently served under the wrong table.
- **Deploy-pending:** a full `wrangler deploy` + cross-account R2→DO migration is left to the same
  real-CF E2E rig Slice 3 uses; the workerd `runInDurableObject` run exercises the identical code over
  real DO-SQLite, so nothing structural is unproven — only the network deploy is deferred, honestly.

## Non-goals (explicit)

Multi-shard export/import (Slice 6); schema migration/transform; live/streaming migration (export is a
point-in-time snapshot); merge of divergent target data; migrating `persistence_globals`
(deploymentId is metadata-only); a stopped-file direct export mode.
