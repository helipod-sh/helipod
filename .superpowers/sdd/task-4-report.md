# Task 4 report: @stackbase/fleet — LeaseManager + fleet_lease

## Status: DONE

Worktree: `/Volumes/Projects/concave-dev/.claude/worktrees/agent-a4717ae5aea9bb202`
Branch: `worktree-agent-a4717ae5aea9bb202`
Commits:
- `6ef7641` feat(fleet): LeaseManager — advisory-lock lease + fleet_lease discovery row
- `d3b88c3` fix(fleet): acquireLoop survives a transient tryAcquire() rejection

## Implemented

- `ee/packages/fleet/src/lease.ts` (new): `LeaseState` interface, `LeaseManager` class matching
  the brief's shape exactly:
  - `constructor(client: PgClient, opts: { advertiseUrl: string; retryMs?: number })` — `retryMs`
    defaults to 2000.
  - `setup(): Promise<void>` — idempotent `CREATE TABLE IF NOT EXISTS fleet_lease (id INTEGER
    PRIMARY KEY, epoch BIGINT NOT NULL, writer_url TEXT NOT NULL, acquired_at TIMESTAMPTZ NOT
    NULL)`.
  - `tryAcquire(): Promise<LeaseState | null>` — calls `client.tryAcquireWriterLock()`; on `false`
    returns `null` without touching the table; on `true` runs the exact upsert SQL from the brief
    (`INSERT … ON CONFLICT (id) DO UPDATE SET epoch = fleet_lease.epoch + 1, …  RETURNING epoch,
    writer_url`) and returns the new `LeaseState`.
  - `acquireLoop(onAcquired)` — schedules `tryAcquire()` via `setTimeout` every `retryMs`; on a
    truthy result invokes `onAcquired` once and stops rescheduling; `stop()` sets a `stopped` flag
    and clears the pending timer.
  - `read(): Promise<LeaseState | null>` — `SELECT epoch, writer_url FROM fleet_lease WHERE id =
    1`; `null` if no row yet.
- `ee/packages/fleet/src/index.ts`: appended exactly one export line (`export { LeaseManager, type
  LeaseState } from "./lease";`) — did not touch the existing `FLEET_VERSION` export or reorganize
  the file.
- `ee/packages/fleet/test/pglite-client.ts` (new, local to fleet, NOT imported from
  `docstore-postgres/test/`): a minimal `PgClient` implementation over `@electric-sql/pglite`,
  mirroring `packages/docstore-postgres/test/pglite-client.ts`'s int8 (OID 20) parser setup
  (`parsers: { 20: (v) => BigInt(v) }`) so bigint columns normalize consistently. Dropped the
  `listen`/`notify` stubs from the original since `PgClient` (as consumed here) doesn't require
  them and fleet's lease tests don't need them.
- `ee/packages/fleet/test/lease.test.ts` (new): 5 tests, all against `PgliteClient`.

## TDD RED/GREEN evidence

RED (before `src/lease.ts` existed):
```
FAIL  test/lease.test.ts [ test/lease.test.ts ]
Error: Failed to load url ../src/lease (resolved id: ../src/lease) ... Does the file exist?
```

GREEN (after implementing `lease.ts` + wiring the export):
```
✓ test/lease.test.ts (4 tests) 1272ms
   ✓ LeaseManager > setup() creates the fleet_lease table 496ms
Test Files  1 passed (1)
     Tests  4 passed (4)
```

A 5th test (transient-rejection resilience, added during self-review — see below) also passes;
final full-suite run:
```
@stackbase/fleet test:  ✓ test/smoke.test.ts (1 test) 1ms
@stackbase/fleet test:  ✓ test/lease.test.ts (5 tests) 1352ms
Test Files  2 passed (2)
     Tests  6 passed (6)
@stackbase/fleet typecheck: Exited with code 0
```

## Test behaviors covered (per brief Step 1)

1. `setup()` creates the table — asserted via `information_schema.tables`.
2. `tryAcquire()` returns `{epoch: 1n, writerUrl: advertiseUrl}` on first call (PGlite try-lock is
   always true).
3. A second `tryAcquire()` on the same manager returns `epoch: 2n` (upsert increments) — both this
   and #2 are one test (`tryAcquire() returns epoch 1 on first call, epoch 2 on second`).
4. `read()` returns the latest row (checked at `null` pre-acquire, then after each of two
   `tryAcquire()` calls).
5. `acquireLoop` fires `onAcquired` once then `stop()` halts it — uses `vi.useFakeTimers()` +
   `retryMs: 10`, asserts exactly one call after advancing past the first retry interval and no
   further calls after `stop()` + advancing 10 more intervals.
6. (Added beyond the brief, see below) `acquireLoop()` survives a transient `tryAcquire()`
   rejection and keeps retrying instead of dying silently.

Per the brief's note, real advisory-lock *contention* (a second writer failing to acquire while
the first holds it) is explicitly NOT covered here — `PgliteClient.tryAcquireWriterLock()` is a
single in-process connection where contention is unobservable; that path is deferred to the
Task 7 E2E against real Postgres with two independent connections. This is called out in a comment
at the top of `test/lease.test.ts`.

## Self-review

During review of the initial implementation I found and fixed one robustness issue before
declaring done:

- **`acquireLoop`'s `.then()` chain had no `.catch()`.** If `tryAcquire()` ever rejected (e.g. a
  dropped connection or query error), the promise rejection went unhandled and the loop silently
  stopped rescheduling — `onAcquired` would never fire again, with no error surfaced anywhere.
  Fixed by adding a `.catch()` that reschedules the same as a failed (non-throwing) attempt, so a
  transient error behaves like "didn't acquire this round, try again in `retryMs`" rather than
  killing the loop. Added a regression test (`acquireLoop() survives a transient tryAcquire()
  rejection and keeps retrying`) using `vi.spyOn` to make the first call throw and the second
  delegate to the real implementation.

Other things checked and found fine:
- `tryAcquire()`'s `rows[0]` after the `RETURNING` upsert is technically `| undefined` per the
  `PgRow[]` return type — added an explicit throw (`fleet_lease upsert returned no row`) rather
  than an unsafe cast, which is what made `tsc --noEmit` fail initially and is now fixed.
  Practically unreachable (an `INSERT … RETURNING` always returns exactly one row on success) but
  keeps the code honest under the type checker without an `as` escape hatch.
- The upsert SQL matches the brief's block verbatim (single statement, no read-modify-write,
  `ON CONFLICT (id) DO UPDATE SET epoch = fleet_lease.epoch + 1, writer_url = $1, acquired_at =
  now()`).
- `acquireLoop()` schedules its *first* attempt after one `retryMs` tick (not immediately) — this
  matches "loop tryAcquire() every retryMs" read literally and is consistent with the fake-timer
  test's `advanceTimersByTimeAsync(10)` before the first assertion. Flagging this as a design
  choice in case the Task 7 E2E or a downstream consumer expects an immediate first attempt with
  only *subsequent* retries spaced by `retryMs` — trivial to change if so (move the first
  `tryAcquire()` call outside the `setTimeout`).
- `stop()` is idempotent and safe to call before any `acquireLoop()` call or multiple times.
- No `ORDER BY`/`LIMIT` ambiguity concerns since `fleet_lease` is a single-row table keyed by
  `id = 1` (per the brief's SQL), so `read()`'s plain `WHERE id = 1` is correct and there's no
  multi-row race to worry about.

## Concerns / open questions for Task 6/7 integration

- `acquireLoop`'s "wait `retryMs` before first attempt" behavior (noted above) — worth confirming
  against whatever Task 6 (the consumer) expects for failover latency semantics. Cheap to flip
  either way.
- Real advisory-lock contention across two separate Postgres connections is untested here by
  design (per the brief) — that coverage lives in the Task 7 E2E; if that E2E doesn't materialize,
  `LeaseManager`'s core mutual-exclusion guarantee is unverified beyond `PgClient`'s own contract.
- `fleet_lease.id` is hardcoded to `1` (single global lease row, per brief SQL) — fine for a single
  fleet-wide writer lease; would need a different key shape if fleet ever needs per-shard leases.

## Files touched

- `/Volumes/Projects/concave-dev/.claude/worktrees/agent-a4717ae5aea9bb202/ee/packages/fleet/src/lease.ts` (new)
- `/Volumes/Projects/concave-dev/.claude/worktrees/agent-a4717ae5aea9bb202/ee/packages/fleet/src/index.ts` (append-only edit)
- `/Volumes/Projects/concave-dev/.claude/worktrees/agent-a4717ae5aea9bb202/ee/packages/fleet/test/lease.test.ts` (new)
- `/Volumes/Projects/concave-dev/.claude/worktrees/agent-a4717ae5aea9bb202/ee/packages/fleet/test/pglite-client.ts` (new)

## Spec compliance fix: CHECK (id = 1) constraint

**Commit:** `305b402`

The design spec (`docs/superpowers/specs/2025-08-28-fleet-slice1-design.md` §2) requires:
```sql
CREATE TABLE IF NOT EXISTS fleet_lease (
  id         int PRIMARY KEY CHECK (id = 1),
  epoch      bigint NOT NULL,
  writer_url text   NOT NULL,
  acquired_at timestamptz NOT NULL
);
```

The initial implementation at `src/lease.ts` line 42 had the PRIMARY KEY but was missing the `CHECK (id = 1)` constraint. This allows `fleet_lease` to remain a true singleton row (enforced at the database level) rather than relying solely on application logic.

**Fix applied:**
1. Updated `lease.ts` line 42: `id INTEGER PRIMARY KEY` → `id INTEGER PRIMARY KEY CHECK (id = 1)`
2. Added test to `lease.test.ts`: `"CHECK (id = 1) constraint is enforced on the fleet_lease table"` — verifies that a raw `INSERT INTO fleet_lease (id, epoch, writer_url, acquired_at) VALUES (2, 1, 'http://test:4000', now())` rejects with a constraint violation.

**Test results:**
```
cd ee/packages/fleet && ../../../node_modules/.bin/vitest run test/lease.test.ts
✓ test/lease.test.ts (6 tests) 1666ms
   ✓ LeaseManager > setup() creates the fleet_lease table
   ✓ LeaseManager > tryAcquire() returns epoch 1 on first call, epoch 2 on second
   ✓ LeaseManager > read() returns the latest lease row
   ✓ LeaseManager > acquireLoop() fires onAcquired once then stop() halts further retries
   ✓ LeaseManager > acquireLoop() survives a transient tryAcquire() rejection and keeps retrying
   ✓ LeaseManager > CHECK (id = 1) constraint is enforced on the fleet_lease table

Test Files  1 passed (1)
     Tests  6 passed (6)
```

**Typecheck:** `bun run --filter @stackbase/fleet typecheck` — Exited with code 0.
