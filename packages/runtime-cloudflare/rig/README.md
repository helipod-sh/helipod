# Deploy rig — the real-Cloudflare E2E (§6.2)

This is the **deploy-ready-but-unrun** flagship gate. The build worktree has **no Cloudflare
account/login**, so the `wrangler deploy` + real-`*.workers.dev` E2E is scripted here for a human to
run — it is **not faked**. The lower fidelity tiers (real-workerd via `vitest-pool-workers`, and Node
API-shape) already pass in CI; this closes the last gap: real Cloudflare, real cross-datacenter write
latency, real hibernation eviction.

## What's here

- `wrangler.jsonc` — the deploy config: `nodejs_compat`, the `STACKBASE_DO` Durable Object binding, a
  `new_sqlite_classes` migration (DO-SQLite needs the SQLite-backed class tag).
- `fixture/worker.ts` — the Worker/DO entry (hand-written stand-in for what
  `generateWorkerEntrySource` codegens): static imports of the fixture `convex/`, `export class
  StackbaseDO extends StackbaseDurableObject`, `export default createWorkerHandler("STACKBASE_DO")`.
- `fixture/convex/` — a minimal reactive app (one indexed table, no file storage, no components).
- `e2e.mjs` — the assertion script (health → subscribe → commit → reactive push → latency →
  persistence).

## The exact commands a human runs

```bash
# 0. from this dir, with the repo built (bun run build) and wrangler available (npx wrangler ...):
cd packages/runtime-cloudflare/rig

# 1. authenticate (opens a browser)
npx wrangler login

# 2. set the admin key as a SECRET (do NOT leave the placeholder in wrangler.jsonc)
npx wrangler secret put STACKBASE_ADMIN_KEY      # paste a strong secret

# 3. deploy — builds fixture/worker.ts into a Worker + the StackbaseDO Durable Object
npx wrangler deploy
#    → prints a URL like https://stackbase-do-fixture.<subdomain>.workers.dev

# 4. run the E2E against the real deployment
node e2e.mjs --url https://stackbase-do-fixture.<subdomain>.workers.dev

# 5. hibernation-resume sub-test (the silence IS the test — do NOT poll /api/health while waiting):
#    - keep a WS subscribed (e2e.mjs leaves the pattern), stay SILENT ~60s so the DO hibernates,
#      then commit from a second client and assert the hibernated socket still receives the push
#      with its read-set REHYDRATED from the 16 KB attachment (not lost). A harness that polls health
#      keeps the DO alive and passes for the wrong reason.

# 6. tear down when done
npx wrangler delete
```

## Placement (optional): pin the DO's home region

A Durable Object is **single-homed** — pinned to one data center at creation, and it never moves; by
default it lands near whoever **first** `get()`s it. To pin this single DO to a specific region, set
`STACKBASE_DO_LOCATION_HINT` (e.g. `enam`) as a container/Worker env var (alongside
`STACKBASE_ADMIN_KEY`). The Worker threads it into `get(id, { locationHint })`; only the **first**
`get()` is honored (pinned thereafter). Unset ⇒ no hint (placed near the first requester — today's
behavior). An invalid hint fails loudly (500). Valid hints: `wnam enam sam weur eeur apac apac-ne
apac-se oc afr me`. This is one DO in one region — placing *many* shard-DOs near their own audiences is
the paid [`@stackbase/runtime-cloudflare-shard`](../../../ee/packages/runtime-cloudflare-shard) router.

## What each assertion proves

| Step | Proves |
|---|---|
| `GET /api/health` → 200 | the DO boots on real DO-SQLite |
| subscribe → commit (2nd client) → push | reactivity across a **real** DO (G1/G4 in-process fan-out) |
| write-latency measurement | the co-located DO-SQLite write vs the container→R2 ≈1.5 s WAN number — **report the real in-CF number** (methodology: measure from the SAME vantage; do not compare a laptop→R2 WAN number against an in-datacenter DO number) |
| persistence read-back | DO-SQLite is durable |
| hibernation-resume (silent) | the attachment-based rehydrate (§3) works on real hibernation |

If a single-shard write-storm sub-test saturates at ~200–500 writes/s, that is the **expected,
by-design single-shard ceiling** (§8.6) — record the number, don't paper over it. Sharding is Slice 6.

## Fidelity ladder (what is already proven vs. what this closes)

| Tier | Runtime | Status |
|---|---|---|
| Node API-shape (`test/`) | Node + DO-SQLite stand-in | ✅ passing (`bun run test`) |
| real workerd (`test-workers/`) | workerd via vitest-pool-workers | ✅ passing (`bun run --filter @stackbase/runtime-cloudflare test:workers`) |
| real Cloudflare (this rig) | deployed DO | ⏳ **deploy-ready-but-unrun** — needs a Cloudflare login |
