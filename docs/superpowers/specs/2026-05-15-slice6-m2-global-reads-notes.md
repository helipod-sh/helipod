# Slice 6 — M2 (`.global()` / D1 global reads): implementation note + STOP-and-report

**Date:** 2026-05-15
**Author:** implementation agent (worktree `worktree-agent-ae0c44b4015ccd9d2`)
**Parent spec:** `docs/superpowers/specs/2026-03-20-multishard-crossshard-slice6-design.md`
**Verdict:** **STOP before building.** M2 as spec'd is a full milestone (T5–T10), dominated by a
brand-new relational storage substrate (D1), and is **explicitly gated on unanswered human
decisions** (§6.3). Building it now would be a large speculative build that front-runs those
decisions. This note records the scoped understanding, the forks, and a recommended decomposition.

---

## 1. What "M2 / `.global()` reads" means in the spec (precise scope)

The task calls it "M2"; in the parent spec this is **Milestone 2** (§6.4, tasks **T5–T10**). It is NOT
a single feature — it is the entire "genuinely new engine surface" half of Slice 6. §6.4 opens:

> "Milestone 2 (`.global()`/D1 + fan-out) is the new surface — where cross-shard read + global-unique
> + global reactivity land, **all on D1**."

The constituent tasks:

- **T5 — D1 adapter package** (`@stackbase/docstore-d1` or a `.global()` store). Column-per-field DDL
  generated from `schema.ts`, `.unique()` → `CREATE UNIQUE INDEX`, `withSession(bookmark)`
  read-your-writes with the bookmark threaded via an `x-d1-bookmark` header end-to-end. Ship against
  a D1-backed behavior suite (mirror `@lunora/d1`). **This is a fundamentally different storage model
  from everything in the repo** (see §2).
- **T6 — `.global()` schema mode + routing.** `schema.ts` `.global()` marks a table D1-resident;
  write-through from the owning shard-DO's request; global reads route to D1 (bookmark to client);
  reject `.unique()` on a `.shardBy` table at schema-load.
- **T7 — global reactivity (poll first).** Reuse the DO wake/alarm seam: a due-timer re-reads each
  subscribed global shape's membership from D1 and invalidates. Gated on **real Cloudflare** (D1 write
  from one client seen by a global subscriber on another DO within the poll interval; global-unique
  violation rejected; read-your-writes via bookmark). CDC-notify upgrade deferred (§3.2).
- **T8 — opt-in non-reactive `fanOut` read** (only if human decision 3 = offer it). Port
  `mergeSortedAsyncGenerators` to a bounded DO-RPC fan-out over the registry's live shards.
- **T9 — reshard tool** (only if routing (B)).
- **T10 — docs + honest numbers.**

"`.global()` global reads" specifically = **T5 + T6 + T7** (the read path: a `.global()` table lives
in D1, reads route there with Sessions-API read-your-writes, live queries poll). T8 (fan-out) is the
*other* cross-shard-read answer and is independently gated.

## 2. What is already built vs. what M2 needs

**Already built (Milestone 1 routing + the seam references):**
- `ee/packages/runtime-cloudflare-shard/` — the stateless shard router: `resolveShard` (route.ts),
  `createShardWorkerHandler` (worker.ts), canonical name/hash modes (canonical.ts), typed errors
  (errors.ts), location hints (location.ts). Unit tests + miniflare `multishard.worker.test.ts`.
- The `.global()` references in `index.ts`/`route.ts` are **comments and error-message copy only** —
  they point a user toward a `.global()` table that does not yet exist. `CROSS_SHARD_UNSUPPORTED` is
  wired and returns 400 for fan-out / multi-valued keys. **There is no `.global()` code path.**
- Schema builder (`packages/values/src/schema.ts`) has `.shardKey(field)` (table-level, metadata,
  exported as `TableDefinitionJSON.shardKey`). **There is no `.global()` builder method, no table
  "mode" union, and no `unique` index concept at all** (indexes here are never unique).
- Shard-DO storage is `@stackbase/docstore-do-sqlite` (`do-adapter.ts`) — the **MVCC-log** DocStore on
  DO-SQLite, same log shape as every other adapter.

**What M2 needs that does not exist anywhere in the repo:**
1. A **relational, column-per-field D1 store** with real `CREATE TABLE`/`CREATE UNIQUE INDEX` DDL
   derived from `schema.ts`. Every existing adapter (sqlite/postgres/do-sqlite/objectstore) is the
   append-only MVCC log (`{ts,id,value,prev_ts}`); D1 `.global()` is a *different data model*. This is
   comparable in size to the whole Postgres adapter (which was its own shipped slice, 6c) — not a sub-task.
2. A **table-mode union** in the schema builder (`root | shardKey | global`) + engine routing that
   sends a `.global()` table's ops to D1 instead of the DocStore, **write-through from inside the
   owning DO's request**.
3. **Bookmark threading** (`x-d1-bookmark`) through client → Worker → DO → D1 and back — a new wire
   concern touching the client SDK, the Worker, and the DO host.
4. A **real D1 binding in the test rig** and a real-Cloudflare E2E (T7's gate is explicitly "real
   Cloudflare"). No D1 exists in any test harness today.

## 3. Why this is a STOP (the blockers)

1. **Unanswered human decisions (spec §6.3, marked "do not unilaterally decide").** The parent spec's
   own status line: *"Turns into a `superpowers:writing-plans` TDD plan only after the human decisions
   in §6.3 are answered."* Those answers do not exist — there is **no plan file** for slice-6 M2 (only
   the design spec) and **no decision record**. The three that gate M2 directly:
   - **Decision 4:** is `.global()`/D1 in v1 at all, or is global data a documented non-goal? (spec
     *recommends* yes-as-milestone-2, but recommends ≠ decided.)
   - **Decision 3:** offer the opt-in non-reactive `fanOut` read (T8), or non-goal it?
   - **Decision 5:** global-unique via D1-only (recommend), index-DO (don't), or non-goal?
   Building T5–T8 commits the project to all three before the human has chosen. That is exactly the
   "build the wrong thing" risk the task asks me to avoid.

2. **Milestone ordering.** The spec (§6.4) and roadmap (`:185`, "Depends on: everything above, in
   production") say **prove Milestone 1 in production FIRST**, and CLAUDE.md's build-order rule is "Do
   not start a later slice before the earlier one runs end-to-end." M1 exists in code with unit +
   miniflare tests, but there is **no evidence of the M1 real-Cloudflare shard-scoped reactive E2E
   (T3) having run**, nor a production proof. M2 is defined to build on that proof.

3. **Size + risk.** The roadmap calls Slice 6 "the heaviest in the program, possibly its own research
   first" and "the biggest risk"; the research calls the cross-shard/D1 layer "genuinely new engine
   surface." T5 alone (the D1 adapter) is a multi-week package. This is not a one-slice unit of work.

4. **A metadata-only `.global()` is a footgun, not a safe subset.** The one piece buildable without D1
   — adding `.global()` to the schema builder — would advertise a capability that does nothing at
   runtime (a user marks a table `.global()`, expects cross-shard reads, gets silence). It also
   front-runs decision 4. So there is no safe, valuable, self-contained sub-slice to land unilaterally.

## 4. Recommended decomposition (for when §6.3 is answered)

Assuming the human answers **4 = yes**, **3 = offer fan-out**, **5 = D1-only** (the spec's
recommendations), split Milestone 2 into independently-shippable slices, D1-store first:

- **M2a — D1 store package (T5), standalone.** `@stackbase/docstore-d1`: schema→DDL, column-per-field,
  `.unique()`→`CREATE UNIQUE INDEX`, `withSession(bookmark)`. Prove against a **miniflare D1** behavior
  suite (mirror `@lunora/d1`) — no DO, no routing yet. Engine stays D1-unaware (all D1 types in this
  package, per Global Constraints). *This is the load-bearing, riskiest piece; land it alone.*
- **M2b — `.global()` schema mode + write-through routing (T6).** Table-mode union in the schema
  builder; owning-DO write-through to D1; schema-load guard rejecting `.unique()` on `.shardBy`. Gate:
  a `.global()` write commits to D1 and a `.global()` read returns it with bookmark read-your-writes.
- **M2c — global reactivity, poll-first (T7).** Reuse the wake/alarm seam. Gate: **real Cloudflare** —
  cross-DO global subscriber sees the write within the poll interval; unique violation rejected.
- **M2d — opt-in non-reactive `fanOut` read (T8)** *(only if decision 3 = offer)*. Port
  `mergeSortedAsyncGenerators` to a bounded DO-RPC fan-out; failures-as-data; `fanOut`+`shardKey`
  together is a 400.
- **M2e — docs + honest numbers (T10)** and, only under routing (B), the reshard tool (T9).

Each of M2a–M2c is a `brainstorming → writing-plans → TDD` cycle of its own.

## 5. Recommendation

Do **not** build M2 in this pass. Take **decisions 3/4/5 (§6.3) to the human**; if approved, start
with **M2a (the D1 store)** as its own spec+plan, prove M1's real-Cloudflare E2E first, and land the
milestone in the M2a→M2e order above. No engine code changed in this pass — only this note.
