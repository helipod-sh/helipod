# Fleet reshard tool (B5 Part 1) — implementation plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the B5 design
> (`docs/dev/research/write-sharding/b5-reshard-and-object-storage.md`, Part 1) and a full recon of the
> shipped fleet (`ee/packages/fleet/src/lease.ts`, `packages/cli/src/boot.ts`/`serve.ts`, `id-codec`).

**Goal:** `stackbase fleet reshard --shards M --database-url <pg>` changes a stopped Postgres fleet's
shard count N→M. Because shards are LOGICAL commit-serialization lanes over one shared store (the
`documents.shard_id` stamp is decorative — nothing reads it for correctness), resharding MOVES NO ROWS:
it updates the persist-once `fleet:numShards` global + creates/deletes the `shard_leases` lane rows
(new lanes seeded at `MAX(ts)` per the F1 invariant), atomically, against a stopped fleet. Fills the one
operational gap the shipped fleet has: today N is fixed at first boot and can never change.

**Why now / why safe (B5 Part 1, verbatim):** the fleet's shard_id is write-only decoration; routing
always recomputes `shardIdForKeyValue(key, numShards)`. So N→M changes only which lane FUTURE commits
for a key serialize through — the historical MVCC log is untouched. The one-doc-one-ring invariant
governs only CONCURRENT forks; the stopped-fleet precondition makes the old-N and new-M epochs
non-overlapping in time, so a key's lane changing between them is as safe as any config change to a
quiesced system. `F = min(frontier_ts)` is monotone across the reshard (retained rows unchanged, new
rows seeded ≥ MAX(ts), deleting rows can only raise/hold a min).

**Scope boundary:** ONLINE reshard (straddling a shard-count change with live writers) is explicitly out
of scope — it needs an epoch-fence vocabulary the protocol doesn't have. The OBJECT-STORAGE reshard
(physical lanes → a real data-reorg) is separately deferred (needs multi-shard-object-storage-serve
first). This is the FLEET (Postgres, logical-lane) reshard only.

## Global constraints
- ee-gated: the reshard LOGIC lives in `@stackbase/fleet` (commercial-licensed, owns the shard_leases/
  fleet_nodes SQL); the CLI `fleet reshard` command DYNAMICALLY imports it, gated on the package being
  present — mirror `serve --fleet`'s `await import(fleetSpecifier)` + `FLEET_ERR_NO_PACKAGE` pattern
  (`serve.ts:470-472`), so core `packages/cli` keeps zero static dep on `@stackbase/fleet`.
- STOPPED-FLEET precondition is a HARD gate (no `--force`): refuse if any `fleet_nodes` OR `shard_leases`
  row is live (`expires_at >= now()`), with an instructive error naming the live node(s).
- Reuse verbatim: the `frontierSeedExpr` fragment `(SELECT COALESCE(MAX(ts), 0) FROM documents)`; the
  UNACQUIRED lane-row shape from `lease.ts` setup (`epoch=0, writer_url=NULL, writer_app_name=NULL,
  expires_at=now(), frontier_ts=<seed>, prev_ts=0`); `shardIdList(M)` (= `["default","s1",…,"s{M-1}"]`,
  default always present, NEVER deleted) + `DEFAULT_NUM_SHARDS` from `@stackbase/id-codec`; the
  `PgClient.transaction(fn)` seam; the `NodePgClient`-from-`--database-url` open/probe/close template
  (`serve.ts:242-251`). The `fleet:numShards` global is JSON-encoded — write `JSON.stringify(String(M))`
  so `resolveNumShards`'s `Number(JSON.parse(getGlobal(...)))` reads M back (match `boot.ts:495-513`).
- Tests run against embedded-postgres (real PG 16) per the 3-tier substrate rule (NOT Docker, NOT PGlite
  for lease semantics) — mirror the existing fleet embedded-PG tests.

## Task 9.1 — `reshardFleet` core (precondition + one-tx operation + post-verify)
**Files:** `ee/packages/fleet/src/reshard.ts` (new); `ee/packages/fleet/src/index.ts` (export); tests.
- `interface ReshardResult { previousShards: number; newShards: number; created: string[]; deleted: string[]; frontierFloor: string; }`
- `async function reshardFleet(client: PgClient, opts: { targetShards: number }): Promise<ReshardResult>`:
  1. **Validate** `targetShards >= 1` (else throw a clear RangeError).
  2. **Precondition — stopped fleet.** Query for ANY live node:
     `SELECT advertise_url AS url FROM fleet_nodes WHERE expires_at >= now() UNION SELECT writer_url AS url FROM shard_leases WHERE writer_url IS NOT NULL AND expires_at >= now()`.
     If non-empty → throw a `ReshardFleetLiveError` naming the live urls ("refusing to reshard: N node(s)
     still live: … — scale the fleet to zero first").
  3. **Read current state:** the existing `shard_leases` shard_id set (the current lanes) + the current
     `fleet:numShards` global (`getGlobal` via a `PostgresDocStore` over the client, or a raw SELECT +
     `Number(JSON.parse(value))`; `previousShards` = that, defaulting to the lane count if the global is
     absent). `target = shardIdList(targetShards)`. `created = target \ currentLanes`, `deleted =
     currentLanes \ target`. (Assert `"default"` is never in `deleted` — it's always in `target` for M≥1.)
  4. **One transaction** (`client.transaction(async (tx) => {…})`):
     - Probe `documentsExist`: `SELECT to_regclass('documents') IS NOT NULL AS exists` → boolean; the seed
       fragment is `documentsExist ? "(SELECT COALESCE(MAX(ts), 0) FROM documents)" : "0"`.
     - Update the global: upsert `persistence_globals` key `fleet:numShards` value `JSON.stringify(String(targetShards))`
       (`INSERT … ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`).
     - Create new lanes: for each `shard_id` in `created`, `INSERT INTO shard_leases (shard_id, epoch,
       writer_url, writer_app_name, expires_at, frontier_ts, prev_ts) VALUES ($1, 0, NULL, NULL, now(),
       ${seedFragment}, 0)`.
     - Delete surplus lanes: for each `shard_id` in `deleted`, `DELETE FROM shard_leases WHERE shard_id = $1`.
  5. **Post-verify** (read-only, after commit): `count(*) === targetShards` AND the shard_id set equals
     `shardIdList(targetShards)`; `min(frontier_ts) >= MAX(ts)` over documents (the F1 floor — re-checked);
     the global reads back as `targetShards` via `Number(JSON.parse(getGlobal))`. Throw a clear
     `ReshardVerificationError` if any fails (should be impossible — a guard against a logic bug).
     Return `ReshardResult` with `frontierFloor = min(frontier_ts).toString()`.
- Export `reshardFleet` + the error types from `src/index.ts`.
- [ ] 9.1a Failing test (grow, embedded PG): seed a fleet store (create `shard_leases`/`fleet_nodes`/
      `documents` via the fleet setup or minimal DDL; insert `shardIdList(2)` lanes + some `documents`
      rows with a `MAX(ts) = T`; `fleet:numShards = 2`; NO live nodes). `reshardFleet(client, {targetShards: 4})`
      → shard_leases set === `shardIdList(4)`, the 2 new lanes (`s2`,`s3`) seeded `frontier_ts === T`, the
      global reads 4, `min(frontier_ts) >= T`. Existing lanes' frontier_ts unchanged.
- [ ] 9.1b Failing test (shrink): from `shardIdList(4)` → `reshardFleet({targetShards: 2})` → set ===
      `shardIdList(2)`, `s2`/`s3` deleted, `"default"`/`s1` retained (never deletes default), global reads 2,
      `min(frontier_ts)` did not regress.
- [ ] 9.1c Failing test (refuse on live fleet): insert a live `fleet_nodes` row (`expires_at = now() +
      interval '30s'`) → `reshardFleet` throws `ReshardFleetLiveError` naming it, and the shard_leases
      set + global are UNCHANGED (no partial reshard).
- [ ] 9.1d Implement. Build/typecheck/test green. Commit.

**Gate:** grow/shrink change the lane set + the global atomically, new lanes are born at MAX(ts), F never
regresses, the default lane is never deleted, and a live fleet is refused with no partial effect.

## Task 9.2 — the CLI `fleet reshard` command + dispatch + gate
**Files:** `packages/cli/src/fleet.ts` (new — `fleetCommand`); `packages/cli/src/cli.ts` (`case "fleet"` +
help line); the `FleetModule` dynamic-import surface (add `reshardFleet`); tests.
- `fleetCommand(args: string[]): Promise<number>` sub-dispatches `reshard` (`args[0]`); unknown/absent
  sub → a clear usage error + return 1.
- `fleet reshard`: parse `--shards <M>` (required int ≥ 1) + `--database-url <url>` (required, `isPostgresUrl`;
  fall back to `STACKBASE_DATABASE_URL`). Missing/invalid → clear `✗` error + return 1.
  - **Dynamic import + gate:** `await import(fleetSpecifier)` (the same specifier `serve --fleet` uses) →
    on failure print `FLEET_ERR_NO_PACKAGE` (`✗ … requires @stackbase/fleet — install it`) + return 1.
    Add `reshardFleet` to the local `FleetModule` structural type.
  - Open `new NodePgClient({ connectionString })`, in a `try/finally` (close), call `reshardFleet(client,
    {targetShards})`; print a clear success summary (`✓ resharded N → M shards (created: …, deleted: …,
    frontier floor: …); update STACKBASE_FLEET_SHARDS to M (or unset) before restarting the fleet`); on a
    `ReshardFleetLiveError`/validation error print `✗ <message>` + return 1. Return 0 on success.
- `cli.ts`: add `case "fleet": return fleetCommand(rest);` to the dispatch (`cli.ts:134-160`) + a
  `printHelp()` line ("fleet reshard --shards M --database-url <url>   Change a STOPPED fleet's shard count").
- [ ] 9.2a Test (arg parsing + gate, no PG needed): `fleet reshard` without `--shards` / with `--shards 0`
      / without `--database-url` → the respective `✗` error + exit 1. `fleet <unknown-sub>` → usage error.
      (If the `@stackbase/fleet`-missing gate is testable without uninstalling the package, assert it; else
      note it's covered by the serve --fleet gate's own test pattern.)
- [ ] 9.2b Test (happy path through the CLI command, embedded PG): seed a stopped fleet store; run
      `fleetCommand(["reshard","--shards","4","--database-url",<embeddedPgUrl>])` → returns 0, the store's
      shard_leases === `shardIdList(4)` + global reads 4. A live-fleet variant → returns 1 with the refuse
      message, store unchanged.
- [ ] 9.2c Implement + wire dispatch/help. Build/typecheck green; `bun run --filter @stackbase/cli test`
      green (existing CLI tests unchanged — the new `case` is additive). Commit.

**Gate:** `stackbase fleet reshard --shards M --database-url <pg>` reshards a stopped fleet end to end,
refuses a live one, validates args, and is gated on the ee package — with the existing CLI dispatch
untouched for all other commands.

## Task 9.3 — E2E: stop → reshard → the new lanes are writable (smoke commit per lane)
**Files:** `packages/cli/test/fleet-reshard-e2e.test.ts` (reuse the existing fleet embedded-PG E2E harness).
- Scenario (embedded PG, the 3-tier substrate): bring up a real fleet WRITER node at `numShards = N`
  (mirror an existing fleet-e2e's node bring-up), commit some data, then STOP it (relinquish/expire so no
  live node). Run `reshardFleet(client, {targetShards: M})` (M > N). Bring up a fresh writer node at
  `numShards = M`. Fire ONE trivial mutation for a set of synthetic keys chosen so `shardIdForKeyValue(key,
  M)` covers EVERY lane in `shardIdList(M)` (a spread hitting each of the M lanes — the B5 "smoke commit
  per lane"); assert each commits AND that lane's `shard_leases.frontier_ts` advanced (the new lanes are
  writable + their rings/leases initialize). Also assert the pre-reshard committed data is still readable
  (the log was untouched).
- [ ] 9.3a Implement (reuse the fleet E2E harness; embedded PG). Build/typecheck/test green. If a
      full-node bring-up is too heavy, an acceptable lighter proof: after `reshardFleet`, a fresh
      `LeaseManager`/writer `tryAcquire`s each new lane (epoch 0→1) + a commit routed to it advances its
      frontier — proving the new lanes are acquirable + writable. Commit.

**Gate (headline):** a stopped fleet resharded N→M comes back up at M with EVERY lane writable (each
acquires + commits + advances its frontier) and all pre-reshard data intact — proving the reshard
produced a working M-shard fleet, not just row surgery.

## Self-review
- Implements B5 Part 1 (the fleet reshard) verbatim: stopped-fleet gate, global + lane-row surgery in one
  tx, new lanes seeded at MAX(ts) (F1), post-verify (count/set/frontier-floor/global). Online reshard and
  object-storage reshard remain explicitly out of scope.
- Reuse honored: `frontierSeedExpr` fragment, the UNACQUIRED-row shape, `shardIdList`/`DEFAULT_NUM_SHARDS`,
  `PgClient.transaction`, the `NodePgClient`-from-URL template, the `serve --fleet` dynamic-import gate, the
  `fleet:numShards` JSON encoding (matches `resolveNumShards`).
- Type consistency: `reshardFleet(client: PgClient, {targetShards})`; shard ids are the id-codec `ShardId`
  strings (`"default"`,`"s1"`,…); the global is `JSON.stringify(String(M))`; `frontier_ts` is a BIGINT
  (carried as a decimal string in the result).
