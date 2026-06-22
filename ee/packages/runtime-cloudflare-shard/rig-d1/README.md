# Deploy rig — multi-shard + `.global()`/D1 on real Cloudflare

The first-ever composition of the multi-shard router (`@stackbase/runtime-cloudflare-shard`) with the
`.global()`/D1 tier. Sharded tables (`messages`, one DO per room) live in each shard-DO's own
DO-SQLite; the `.global()` table (`counters`) lives in ONE shared D1 database that every shard-DO
binds as `env.DB`. This rig proves — on real Cloudflare, not the emulator — that a global row written
through one shard-DO is readable through another, and that the D1 unique index is enforced across
shards.

The only wiring difference from the sharded-only rig (`../rig`) is in `fixture/worker.ts`: it spreads
`d1: bindingD1Client(env.DB)` into every shard-DO's `appConfig` (from `@stackbase/docstore-d1`, added
as a devDependency of this package). The router entry (`createShardWorkerHandler`) is unchanged.

## What each assertion proves

| Step | Proves |
|---|---|
| `GET /api/health` → 200 | the shard-DO boots on real DO-SQLite with a D1 binding present |
| `messages:send`/`list` on roomA | sharded (per-DO) writes/reads still work alongside D1 |
| write `counters:create` via `?shard=roomA`, read `counters:getByKey` via `?shard=roomB` | `.global()` tables live in the **shared D1**, visible across shard boundaries (read-your-writes across shards) |
| duplicate-key `counters:create` via `?shard=roomC` → rejected, value unchanged | the D1 `by_key` **unique index is enforced globally**, across every shard |

## The exact commands a human runs

```bash
cd ee/packages/runtime-cloudflare-shard/rig-d1

# 1. authenticate
npx wrangler login

# 2. provision the shared D1 database, then paste its database_id into wrangler.jsonc's
#    d1_databases[0].database_id (the committed id is a throwaway from the original proof run).
npx wrangler d1 create stackbase-shard-d1

# 3. deploy (pass the admin key as a --var override so no secret/var conflict with the placeholder)
npx wrangler deploy --var STACKBASE_ADMIN_KEY:<a-strong-key>
#    → https://stackbase-do-shard-d1-fixture.<subdomain>.workers.dev

# 4. run the E2E against the live deployment
node e2e.mjs --url https://stackbase-do-shard-d1-fixture.<subdomain>.workers.dev --admin-key <same-key>

# 5. tear down
npx wrangler delete
npx wrangler d1 delete stackbase-shard-d1
```

## Notes

- `.global()` D1 tables/indexes are **auto-created on first DO boot** with `env.DB` present — there is
  no D1 migration step (only the DO-SQLite `new_sqlite_classes` migration in `wrangler.jsonc`).
- A `.global()`-only mutation writes to D1, not the local DO-SQLite MVCC store, so the `/api/run`
  `committed` flag (which reflects a *local* commit) is `false` for it — the durability+sharing proof
  is the cross-shard read-back, not that flag.
- Each shard-DO runs its own M2c global-reactivity poller against the shared `_global_versions`
  counter; that is redundant but correct across a multi-shard deployment. A push-based (CDC) global
  invalidation is the deferred upgrade.
