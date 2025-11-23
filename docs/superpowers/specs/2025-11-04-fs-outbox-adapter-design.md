# `fsOutbox()` — Filesystem OutboxStorage Adapter (Node/Bun/Electron/Tauri)

**Status:** approved design (2025-11-04; design presented and approved in-session, user delegated
implementation-level calls)
**Parent:** the Receipted Outbox (verdict §(i) deferred table row "A Node/Bun filesystem
`OutboxStorage` adapter"; `docs/enduser/offline.md` deferred table). Offline follow-on 1 of 4
approved 2025-11-04. This is an ADDITIVE adapter on the existing `OutboxStorage` seam — nothing in
the record family, the wire contract, the drain, or the reconcile algorithm changes.

## Goal

Non-browser clients — CLI tools, and Electron/Tauri sidecar hosts (the audience the single-binary
build's `{"ready":…}` stdout line exists for) — get durable offline mutation queues instead of
memory-only: enqueue offline in one process run, exit, and a later process run hydrates and drains
exactly-once through the same receipts machinery the browser uses.

## API

```ts
// packages/client/src/outbox-fs.ts — shipped as the `@stackbase/client/outbox-fs` subpath export
export interface FsOutboxOptions {
  /** Queue directory (created recursively). One durable queue per dir. */
  dir: string;
  /** fsync appends before resolving append()'s promise (park-eligibility durability proof).
   *  Default true; false is for tests/throughput experiments only. */
  fsync?: boolean;
  /** Same contract as indexedDBOutbox's onFallback: best-effort notification when the adapter
   *  degrades to memoryOutbox() (lock held by a live process, dir not creatable, open failure). */
  onFallback?: (reason: unknown) => void;
}
export function fsOutbox(opts: FsOutboxOptions): OutboxStorage;
```

`fsOutbox()` mirrors `indexedDBOutbox()`'s probe-and-fallback shape exactly: the returned object is
the seam; if the backing store can't be opened the methods transparently delegate to a fresh
`memoryOutbox()` and `onFallback(reason)` fires once. The probe is async (open/lock happen on first
use); calls made before the outcome queue behind it, calls after route directly.

## Storage layout (one dir per queue)

```
<dir>/journal.jsonl        append-only op log (the store)
<dir>/journal.quarantine   corrupt NON-tail lines copied here at hydrate (never replayed)
<dir>/journal.tmp          compaction scratch (tmp → fsync → rename → dir fsync)
<dir>/lock                 O_EXCL lockfile: JSON {pid, createdAt}
```

### Journal line shapes (one JSON object per line)

| op | payload | seam call |
|---|---|---|
| `{"op":"append","entry":OutboxEntry}` | full entry verbatim | `append` |
| `{"op":"status","clientId","seq","status","error"?}` | error only when status="failed" | `updateStatus` |
| `{"op":"dequeue","clientId","seq"}` | | `dequeue` |
| `{"op":"meta","clientId","meta":OutboxMeta}` | | `setMeta` |
| `{"op":"metaDelete","clientId"}` | | `deleteMeta` |

`loadAll()` replays the journal into a Map state (same key discipline as `memoryOutbox`:
`clientId\0seq`), sorts by persisted `order`, and runs the existing `dropStaleVersion` helper
(imported from `./outbox-idb` — a pure function; `memoryOutbox` already imports it) so
`outboxVersion` drop-with-verdict behavior is byte-identical across all three backends.
`getMeta`/`listMetaClientIds` read the same replayed state (state is kept in memory after open;
the journal is the durability record, not a per-read source).

## Crash safety

- **Appends can only tear the tail.** All writes go through a single serialized appender (one
  in-process queue; same-microtask calls batch into one write+fsync, mirroring the IDB adapter's
  write-behind batching). At open, if the final line fails to parse it is PHYSICALLY truncated
  (the file is trimmed to the last newline of the last valid line) before any new append — a torn
  tail must never become a corrupt middle. Losing that entry is correct by the verdict's own rule:
  `append()`'s promise had not resolved, so the entry was never park-eligible.
- **`append()` resolves only after write + fsync** (when `fsync: true`, the default). The wire
  send never waits on it (seam contract); the promise exists exactly so park-eligibility can await
  durability.
- **Corrupt middle lines** (bit rot, external edits): skip-and-quarantine — the raw line is
  appended to `journal.quarantine`, hydrate continues. A `status`/`dequeue` op whose base `append`
  was quarantined or missing is a no-op (same as `memoryOutbox`'s missing-key behavior). The queue
  is never bricked by a bad line.
- **Compaction** runs at open (after replay) and thereafter whenever the journal exceeds
  **4096 ops**: current state is serialized as fresh `append`/`meta` lines to `journal.tmp`,
  fsynced, atomically renamed over `journal.jsonl`, and the directory fsynced. A crash mid-compact
  leaves either the old journal or the new one — never a mix.

## Multi-process

- Per-process clientIds (minted fresh at every `StackbaseClient` construction — the existing
  identity model) make seq collisions structurally impossible, exactly as per-tab ids do in the
  browser. Receipts remain the safety layer; the lock is only about journal integrity.
- **One writer per dir, enforced:** open takes `<dir>/lock` with `O_EXCL` (`wx`), writing
  `{pid, createdAt}`. On `EEXIST`: read the lockfile; if its pid is dead (`process.kill(pid, 0)`
  throws `ESRCH`), the file is unreadable/garbage, OR the pid equals OUR OWN pid but the dir is
  not in this process's open-dir registry (a leftover lock from a previous boot that recycled our
  pid), steal it (unlink + retry `wx`, one retry); if the pid is genuinely alive → probe-and-
  fallback to `memoryOutbox()` + `onFallback`. A module-level registry of dirs open IN THIS
  process makes a same-process double-open deterministic: the second `fsOutbox()` on the same dir
  falls back + `onFallback` (no pid ambiguity). The lock is released (unlinked) by `close()` and,
  best-effort, by a process-exit hook; a SIGKILLed process leaves a stale lock the next open
  steals via the dead-pid check.
- **`close(): Promise<void>` — a new OPTIONAL seam method** (additive, like
  `listMetaClientIds`/`deleteMeta`; callers guard with `?.`). fs: flush pending appends, release
  the lock, deregister the dir. IDB: close the DB handle (a genuine small win for Electron
  renderer teardown). memory: no-op. Nothing in `client.ts` calls it today — it exists for host
  shutdown/relaunch flows (Electron window cycling) and for tests; a client that never calls it
  loses nothing (exit hook + stale-lock steal cover it).
- Network filesystems are documented UNSUPPORTED for the lock (O_EXCL/pid semantics don't hold);
  the docs say local disk only.

## What stays identical to the other backends

- `persist()`: no-op (no eviction advisory exists on a filesystem).
- `dropStaleVersion` semantics, `HydrateResult{entries, dropped}` contract, optional
  `listMetaClientIds`/`deleteMeta` both implemented.
- The seam's concurrency promise ("every method safe to call concurrently") via the serialized
  appender.

## Shipping

- `packages/client/src/outbox-fs.ts`; tsup `entry` gains `src/outbox-fs.ts`; `package.json`
  `exports` gains `"./outbox-fs": {types: "./dist/outbox-fs.d.ts", default: "./dist/outbox-fs.js"}`.
  `node:fs`/`node:path` imports live ONLY in this file — the root `.` and `./react` bundles remain
  browser-clean (verified by a test asserting the built `dist/index.js` contains no `node:`
  specifiers).
- No new dependencies.

## Testing

1. **Contract extraction (targeted improvement):** the CRUD/hydrate/meta behaviors currently
   duplicated across `outbox-storage.test.ts` (memory) and `outbox-idb.test.ts` (IDB) move into a
   shared `runOutboxStorageContract(name, factory, cleanup?)` helper (in `test/outbox-contract.ts`),
   run verbatim against all THREE backends: memory, IDB (fake-indexeddb), fs (tmpdir). Existing
   backend-specific describes (schema, write-behind batching, probe-fallback, persist) stay where
   they are.
2. **fs-specific unit tests** (`test/outbox-fs.test.ts`): torn-tail truncation (hand-write a
   partial last line → hydrate drops exactly that entry, file physically trimmed); corrupt-middle
   quarantine (bad line mid-file → entry skipped, line lands in `journal.quarantine`, rest intact);
   lock exclusion (second `fsOutbox` on the same dir with a live-pid lock → memory fallback +
   `onFallback` fired); stale-lock steal (dead pid → adapter opens normally); compaction (>4096
   ops → journal rewritten smaller, state identical before/after, tmp not left behind);
   restart-rehydrate (instance A appends, `await a.close()`, instance B on the same dir hydrates
   the same entries in order); same-process double-open without close → fallback + `onFallback`;
   own-pid stale lock (lockfile hand-written with our pid, registry empty → stolen, opens
   normally); fsync-promise ordering (append resolves only after flush — observable via injected
   fs spy).
3. **E2E through the shipped entrypoint** (the project rule): a scenario in
   `packages/cli/test/outbox-fs-e2e.test.ts` — a real Node `StackbaseClient` over a real WebSocket
   against a real `stackbase dev` server: process run 1 enqueues K mutations with the server DOWN
   (fs queue in a tmpdir) and exits WITHOUT draining; process run 2 (fresh client, same dir)
   connects and drains — exactly K rows committed, receipts absorb a mid-drain duplicate resend,
   pendingMutations() reaches empty. (The Node twin of the browser flagship.)

## Error handling

| Failure | Behavior |
|---|---|
| dir not creatable / journal unopenable | probe-and-fallback → `memoryOutbox()` + `onFallback(err)` |
| lock held by live pid | same fallback path |
| torn tail line | physically truncate; entry silently dropped (was never park-eligible) |
| corrupt middle line | quarantine + skip; op lines referencing it become no-ops |
| append/fsync I/O error after open | the returned promise rejects (park-eligibility correctly fails); the in-memory state still reflects the entry so the live session keeps working memory-equivalent |
| compaction failure | journal untouched (tmp discarded); adapter keeps appending to the old journal, retries at next threshold |

## Non-goals

- Cross-process SHARED live queues (two live processes writing one dir) — lock-and-fallback is the
  contract; receipts make even a violated lock safe-but-unsupported.
- `node:sqlite`/`bun:sqlite` backends (version-floor gamble; a ≤1000-entry queue needs no index).
- Windows CI validation (Electron/Windows is expected to work — `wx`, rename atomicity on NTFS —
  but our suites run macOS/Linux; documented as untested).
- Any change to drain, receipts, wire, or reconcile.

## Docs

`docs/enduser/offline.md`: a "Node, Electron, and Tauri hosts" section (fsOutbox usage, the
one-writer-per-dir rule, network-fs caveat, Electron main-vs-renderer note: renderer keeps
`indexedDBOutbox`, main/sidecar processes use `fsOutbox`); the deferred-table row moves to shipped.
CLAUDE.md's durable-offline entry gains the backend mention at merge.
