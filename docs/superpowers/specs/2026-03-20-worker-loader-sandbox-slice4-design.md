# Slice 4 — the Worker Loader sandbox for untrusted user JS: design spec

**Date:** 2026-03-20
**Status:** DESIGN SPEC + de-risking SPIKE (no engine code changed). Turns into a
`superpowers:writing-plans` TDD plan next — IF the recommendation to build is accepted (see §9).
**Branch:** `slice4/worker-loader-sandbox`, from `spike/cloudflare-r2-gate`.
**Scope:** Slice 4 of `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:141-155` —
move user query/mutation/action JS OUT of the DO isolate (where Slice 3 runs it inline) INTO a
per-tenant Cloudflare **Worker Loader / Dynamic Workers** sandbox with `globalOutbound: null` (no
egress) whose ONLY capability is a syscall channel back to the transactor DO. This is the
multi-tenant safety story.

**Reads this builds on (all committed on this branch):**
- Roadmap Slice 4 (`…/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:141-155`)
- Research: Worker Loader is open-beta, paid-only, `globalOutbound: null` blocks egress
  (`docs/dev/research/cloudflare-do-native-host.md:25`, `:59`)
- Slice 3 DO host — SHIPPED (`packages/runtime-cloudflare/src/durable-object.ts`, its
  `docs/superpowers/specs/2026-03-20-do-host-slice3-design.md` §5: "run user JS inline first")
- The engine's isolate-ready syscall ABI (`packages/executor/src/kernel.ts`, `guest.ts`,
  `executor.ts`, `profile.ts`) — the seam that makes sandboxing possible.
- THE SPIKE: `packages/runtime-cloudflare/spike-worker-loader/` (throwaway; see its README).

**CF documentation cited (dated):**
- Dynamic Workers open beta, paid-only: CF changelog **2026-03-24**
  (`developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/`).
- API reference (`load`/`get`/`WorkerCode`/`globalOutbound`/`getEntrypoint`):
  `developers.cloudflare.com/dynamic-workers/api-reference/` (page dateModified 2026-04-21).
- Passing bindings / `ctx.exports` RPC stubs: `…/dynamic-workers/usage/bindings/` +
  `…/workers/runtime-apis/context/#exports` (`enable_ctx_exports` flag; loopback bindings shipped
  2025-09-26).
- Egress control (`globalOutbound: null` → `fetch()`/`connect()` throw; or a gateway
  WorkerEntrypoint): `…/dynamic-workers/usage/egress-control/`.
- Limits (`limits: { cpuMs, subRequests }`, default = your Workers plan): `…/dynamic-workers/usage/limits/`.
- Perf/pricing ("a few ms" startup, "a few MB", `$0.002` per unique Worker loaded/day, waived in
  beta, "no global concurrent sandbox limits or sandbox creation rate limits"): CF blog
  `blog.cloudflare.com/dynamic-workers/` + InfoQ 2026-04.

---

## TL;DR — the load-bearing findings, up front

1. **The ABI is the cleanest possible fit — no impedance on the *data* path.** The engine's syscall
   channel is ALREADY `SyscallChannel.call(op: string, argJson: string): Promise<string>`
   (`kernel.ts:205-207`) — **async, JSON-string in / JSON-string out, op-string-discriminated**. The
   inline channel is literally commented as **"The seam a real isolate would postMessage across"**
   (`kernel.ts:222-244`). Worker Loader's callback mechanism is a Cap'n Web RPC method call. So a
   Slice-4 `RpcSyscallChannel` is a ~20-line class: `call(op, argJson) => this.host.syscall(op, argJson)`.
   There is **no sync→async rewrite** (the ABI was async from day one) and **no serialization
   redesign** (it's already JSON). This is why the roadmap's "de-risk the ABI marshals across the
   boundary" is, on the data path, **already answered by construction** (§2, §3). Confirm it live; do
   not re-litigate it.

2. **The crux is NOT marshalling — it's REENTRANCY into the transaction turn.** A mutation's user
   handler runs OFF the DO (in the dynamic worker); the transaction lives ON the DO (Slice 3's single
   thread = the mutex). Each `ctx.db.insert` becomes an RPC *back into the same DO* while the DO is
   *awaiting* the handler. Whether workerd lets a DO service that reentrant syscall RPC mid-`await`
   (without deadlocking its input gate or letting a second write turn interleave) is the ONE thing
   this design cannot prove from docs or the pinned toolchain. It is the spike's real target (§5, §8.1).

3. **The sandbox does NOT change read-set tracking, determinism, or the reactive contract — because
   those live HOST-side.** The read-set is recorded where the DO *answers* `db.query`/`db.get`
   syscalls (`kernel.ts` host handlers), not in the guest; determinism is enforced by the capability
   profile + injected `ctx.now()`/`ctx.random()` (`profile.ts:28-46`, `executor.ts:571/581`), which
   travel with the guest. Moving the guest into an isolate that ALSO has `globalOutbound: null`
   *strengthens* isolation (network is now physically dead, not merely contract-forbidden) without
   touching the invalidation math. §3.

4. **Sandbox is OPT-IN; inline stays the default.** Worker Loader is open-beta + paid-only + adds
   per-handler RPC latency, and most self-hosters run their OWN (trusted) app code. The multi-tenant
   platform operator is the only caller who needs it. A deployment flag (`sandbox: true` /
   `--sandbox`) selects it; absent it, Slice 3's inline path runs byte-for-byte. §4, Human decision 1.

5. **Actions need a DIFFERENT sandbox profile than queries/mutations.** `globalOutbound: null` is
   correct for queries/mutations (no network, ever). But an `action` legitimately uses `fetch`
   (`profile.ts:38-46` — `network: "native"`). Sandboxing an untrusted action with `null` egress
   would BREAK it. Untrusted actions want a `globalOutbound` **gateway** WorkerEntrypoint (inspect/
   filter/log egress), not a kill switch. The sandbox profile is per-function-type. §3.4, §8.6.

6. **RECOMMENDATION: do the real-CF spike deploy NOW to settle reentrancy; DEFER building the full
   slice until after Slice 5, and keep it opt-in.** Slice 4 is a parallel branch off Slice 3 — it is
   NOT on the critical path to a shippable single-tenant DO host (Slice 5 depends on Slice 3, not
   Slice 4 — roadmap graph `:45-52`). The design is low-surprise *because* the ABI is already
   isolate-ready, but the platform is open-beta and the reentrancy question is unproven. A
   beta-pricing-waived real-CF deploy of the spike (§5) converts the crux from INFERRED to PROVEN for
   near-$0 before we commit engineering weeks. Build the slice when (a) the spike deploy passes AND
   (b) a real multi-tenant customer needs it. Ship single-tenant inline first. §9.

---

## 1. Worker Loader status + hard limits (2026)

### 1.1 What it is now, and its maturity

"Worker Loader" is the binding; the product is **Dynamic Workers**. A parent Worker (or DO) spins up
child Workers at runtime from code strings, in isolates, "a lightweight alternative to containers for
securely sandboxing code you don't trust" (CF docs).

| Fact | Value | Source (dated) |
|---|---|---|
| Status | **Open beta** | changelog 2026-03-24 |
| Availability | **Paid Workers plan only** | blog `dynamic-workers`, InfoQ 2026-04 |
| Startup | **"a few milliseconds"** (isolate, not container) | blog 2026-03 |
| Memory | **"a few megabytes"** per isolate | blog 2026-03 |
| Per-account caps | **"no global concurrent sandbox limits or sandbox creation rate limits"** | blog 2026-03 |
| Pricing | **$0.002 / unique Worker loaded / day**, WAIVED during beta | blog 2026-03 |
| Per-invocation limits | default = your Workers plan's CPU/subrequests; overridable `limits: { cpuMs, subRequests }` | `…/usage/limits/` |
| Egress kill | `globalOutbound: null` → `fetch()`/`connect()` **throw** | `…/usage/egress-control/` |
| Local runtime | **NOT in this repo's toolchain** (workerd/miniflare Dec 2024; feature is Mar 2026) | spike probe, §5 |

### 1.2 The API shape (as of 2026-04, NOT the roadmap's sketch)

The roadmap sketched `env.LOADER.get(id, () => ({ modules, globalOutbound, env }))`. The **current**
documented API (verify at deploy — beta APIs move):

```ts
// wrangler.jsonc:  "worker_loaders": [{ "binding": "LOADER" }]
const worker = env.LOADER.get(id /* string */, async () => ({
  compatibilityDate: "2025-05-15",       // required
  compatibilityFlags: [...],             // optional
  mainModule: "user.js",                 // required
  modules: { "user.js": "<code string>" }, // required — code as strings, no build step
  globalOutbound: null,                  // ServiceStub | null  (null = egress dead)
  env: { HOST: syscallStub, ... },       // structured-clonable + Service Bindings (RPC stubs)
}));
const entry = worker.getEntrypoint();    // default export; or getEntrypoint("Named")
const res = await entry.fetch(request);  // or call an RPC method on it
```

- `load(code)` = one-shot fresh isolate (equivalent to `get()` with a null id). `get(id, cb)` =
  warm-pooled by id, `cb` only runs on a cache miss. **We want `get()`** (warm pool, §4).
- `env` is "serialized and transferred into the dynamic Worker … used directly as the value of `env`
  there" and **may contain Service Bindings** (RPC stubs) — this is the callback door (§2).

### 1.3 Is it production-viable for per-tenant isolation NOW?

**Technically yes, operationally "not for a default path."** The isolation primitive is the same V8
isolate tech that runs all of Workers, and there are no sandbox count/rate caps — so per-tenant
fan-out scales. But: it is **open beta** (API can change), **paid-only** (breaks our free single-node
promise if made mandatory), and its post-beta **per-unique-Worker/day** billing means a platform with
many apps pays per distinct loaded bundle. Verdict: **viable as an opt-in multi-tenant feature; NOT
viable as the default execution path.** This directly drives Human decision 1 (opt-in) and the defer
recommendation (§9).

---

## 2. The sandbox model — how the guest reaches the DO

### 2.1 The host/guest split (what moves where)

Today `InlineUdfExecutor.run()` (`executor.ts:441-446`) runs BOTH halves in one process: it owns the
host-side router (`createKernelRouter()`, `executor.ts:442`), opens the transaction
(`transactor.runInTransaction`, `executor.ts:557`), builds the guest ctx (`executor.ts:580-624`), and
calls `fn.handler(guestCtx, args)` (`executor.ts:626`) — all inline, the syscalls dispatched to the
in-process router via `InlineSyscallChannel` (`executor.ts:621-624`).

Slice 4 cuts along the seam the ABI already names:

```
   ┌─────────────────────── transactor DO (Slice 3, single thread) ───────────────────────┐
   │  /api/run → transactor.runInTransaction(txn => {                                       │
   │     kctx  = build KernelContext(txn, profile, seed, now, identity, catalog)  [HOST]    │
   │     host  = createHostDispatch(kctx)      // wraps createKernelRouter().dispatch       │
   │     result = await dynWorker.runHandler({fnPath,args,seed,now,identity}, host) ────────┼──┐
   │     // commit happens here, AFTER the guest returns                                     │  │
   │  })                                                                                     │  │ RPC (Cap'n Web)
   └────────────────────────────────────────────────────────────────────────────────────────┘  │  env.HOST.syscall(op,argJson)
                                                                                                 │  ← JSON string
   ┌──────────── Worker Loader isolate (globalOutbound:null, per tenant) ─────────────────┐  ◄──┘
   │  runHandler({fnPath,args,seed,now,identity}, HOST) {                        [GUEST]   │
   │     channel = new RpcSyscallChannel(HOST)   // call(op,argJson)=>HOST.syscall(op,...)  │
   │     guestCtx = buildGuestCtx(channel, {seed,now,identity})  // guest.ts facades        │
   │     return await userModules[fnPath].handler(guestCtx, args)                           │
   │  }                                                                                      │
   └─────────────────────────────────────────────────────────────────────────────────────┘
```

- **HOST half (DO):** the router + transaction + store + read-set tracking. Unchanged from Slice 3
  except it now answers syscalls over RPC instead of in-process.
- **GUEST half (dynamic worker):** the user handler + the `guest.ts` db/scheduler/storage facades +
  the channel. This is `executor.ts:580-626` with the channel *injected* rather than
  `new InlineSyscallChannel(...)`.

### 2.2 How the guest reaches the DO — the callback capability

Per CF docs (`…/usage/bindings/`, `…/context/#exports`): the parent creates a `WorkerEntrypoint` RPC
stub via `ctx.exports.SyscallHost({ props: { … } })` and places it in the child's `env`. The child
calls `env.HOST.syscall(...)`; workerd auto-establishes a **Cap'n Web RPC bridge** (blog 2026-03) and
the method runs back in the parent's context. `ctx.props` is trusted (only the deployer can set it —
`…/context/#props`), so it is the safe place to carry the **tenant scope** and the **turn identity**.

**Two candidate wirings for binding the syscall host to the in-flight transaction — the load-bearing
mechanism choice (Human decision 2):**

- **(A) Live callback stub (preferred).** Pass a stub that *closes over the live `kctx`/`txn`* into
  the child's `env.HOST`. Cap'n Web supports passing object references bidirectionally; the syscall
  method then executes in the DO's isolate against the exact in-flight transaction — no lookup table,
  no second DO request. This is what the "automatic Cap'n Web RPC bridge between the sandbox and your
  harness" is *for*. **Risk:** must confirm `env`/`ctx.exports` can carry a stub bound to
  per-invocation closure state (not only a stateless top-level class export).

- **(B) turnId + reentrant DO call (fallback).** The DO keeps `Map<turnId, KernelContext>`; passes its
  own namespace stub + `turnId` (in `ctx.props`) to the child; the syscall is
  `env.HOST.syscall(turnId, op, argJson)` reentrant into the SAME DO (same id → same isolate → sees
  the in-flight txn in the map). Works with only stateless loopback exports, but relies on the DO
  servicing a reentrant call while awaiting the handler (§8.1) and adds a map + turn lifecycle.

Both need the real-CF spike to choose between them. (A) is cleaner if it works; (B) is the guaranteed
fallback. **The engine does not care which** — both sit behind the neutral `SyscallChannel`.

### 2.3 The neutral engine seam (no CF types leak down)

The ONLY new engine surface is a neutral split of `executor.run` into a **host dispatch** and a
**guest runner**, both parameterized on the EXISTING `SyscallChannel` interface (`kernel.ts:205-207`):

```ts
// packages/executor — NEUTRAL, no cloudflare types:
export interface HostDispatch { syscall(op: string, argJson: string): Promise<string>; }   // == router.dispatch bound to a kctx
export function createHostDispatch(kctx: KernelContext, router: SyscallRouter): HostDispatch;
export class GuestUdfExecutor {                       // the guest half of InlineUdfExecutor
  runGuest(fn, args, channel: SyscallChannel, opts): Promise<UdfResult>;   // builds guestCtx over `channel`, calls handler
}
```

`RpcSyscallChannel implements SyscallChannel` and the DO↔dynamic-worker RPC transport live ONLY in
`packages/runtime-cloudflare` (roadmap Global Constraints `:27`). `packages/executor` never imports a
cloudflare type — it just gains the ability to run the guest half against an *injected* channel, which
the inline path already does (`InlineSyscallChannel`). **This is the minimum engine change and it is
CF-agnostic.** (It also incidentally lets a future true-V8-isolate host reuse the exact same
`GuestUdfExecutor` — the deferred "V8-isolate global sandboxing" seam CLAUDE.md names.)

### 2.4 The `COLLECT_BRAND` caveat (must fix for the split)

The DLR reactive-diff optimization stamps an in-process-only `Symbol` brand on collect/paginate
results (`kernel.ts:101-110`, `executor.ts:340-343`) that is **explicitly documented as not surviving
a real isolate boundary**. Across the RPC split it is dropped by JSON serialization. The classifier's
brand check must **move guest-side and travel as an explicit wire flag** (the code already says so:
"would have to move guest-side and travel as an explicit wire flag"). This is a bounded, already-named
change and a required Slice-4 task (§7 Task 3). It affects diffability optimization only, not
correctness of results.

---

## 3. Determinism + the reactive contract (why the sandbox preserves them)

### 3.1 Read-set tracking is HOST-side — unaffected

A query's read-set is recorded where the DO **answers** `db.query`/`db.get`/`db.paginate` syscalls
(the host router handlers, `kernel.ts:452-733`; `readRanges` returned up through
`UdfResult`/`SyncUdfExecutor.runQuery`, per the ABI report), NOT in the guest. Moving the guest into
an isolate changes *where the handler computes*, not *where reads are recorded*. **The invalidation
math (write-set ∩ read-set) is byte-identical** whether the guest is inline or sandboxed. This is the
single most important reason the reactive contract survives the sandbox untouched.

### 3.2 Determinism travels with the guest

Queries/mutations must be pure. The engine enforces this via the capability **profile** + injected
deterministic clock/RNG, NOT by trusting the isolate: `QUERY_PROFILE`/`MUTATION_PROFILE` set
`random:"seeded"`, `clock:"forbidden"`, `network:"forbidden"` (`profile.ts:28-36`); the guest gets
`ctx.now()` = a fixed `startedAt` and `ctx.random()` = seeded mulberry32 (`executor.ts:571/581`,
`seeded-random.ts:11-21`). These are constructed from the RPC payload's `seed`/`now` inside
`buildGuestCtx`, so they are deterministic per invocation regardless of which isolate runs.

### 3.3 What the sandbox ADDS: physical network death

The inline executor does **not** hard-override the isolate globals `Date.now`/`Math.random`/`fetch`
(`profile.ts:1-11` defers that to "the V8-isolate executor"). The Worker Loader sandbox with
`globalOutbound: null` makes `fetch()`/`connect()` **throw** (`…/usage/egress-control/`) — so a query
that reaches for the network fails hard instead of silently leaking, *without* the engine overriding
any global. That is a genuine determinism/isolation upgrade the inline DO path cannot offer.

**Residual footgun (unchanged from inline, documented, not fixed here):** a query calling `Date.now()`
or `Math.random()` *directly* (instead of `ctx.now()`/`ctx.random()`) still reads the real isolate
clock/RNG → nondeterministic result → possible reactive drift. Options: (i) leave as-is (same risk the
inline executor ships today; catch via codegen lint), or (ii) in `load()`-per-invocation mode ONLY,
freeze the globals in the guest bootstrap (safe because a fresh isolate isn't shared). In `get()`
warm-pool mode, per-invocation global override is unsafe (a shared isolate may serve concurrent
invocations), so determinism stays contract-based. **Recommendation: contract-based (unchanged),
document the footgun** — Human decision 3.

### 3.4 How the async syscall composes with the DO's single-threaded turn

- **Mutations:** the DO opens the transaction, then `await`s the guest handler; each guest syscall is
  a reentrant RPC that mutates the SAME `txn` (§2.2). The single-writer invariant holds because the DO
  is single-threaded and `runInTransaction` holds the writer for the whole turn — a second `/api/run`
  mutation queues behind the DO's input gate until this turn commits. The commit stays INLINE in the
  write turn (Slice-3 §2.2's G4 rule is unchanged: no `waitUntil` defer). **The open question is
  purely whether the reentrant syscall RPC is *serviced* while the DO awaits the handler** (§8.1) — a
  liveness question, not a correctness-of-ordering one.
- **Queries:** no transaction to hold; the guest issues read syscalls, the host records ranges. Simple.
- **Actions:** run OUTSIDE any transaction (`ACTION_PROFILE` all-native, `executor.ts:679-724`); their
  inner `ctx.runQuery`/`runMutation`/`runAction` already go through `deps.invoke` — those become RPCs
  too, but with no enclosing txn, so no reentrancy-into-a-turn hazard. Actions DO need egress → a
  gateway `globalOutbound`, not `null` (§8.6).

---

## 4. Cost / perf — and the opt-in recommendation

### 4.1 The latency delta

- **Isolate startup:** `get(id)` warm ≈ 0 (cache hit skips the `cb`); cold ≈ "a few ms" (blog). Keyed
  per `(tenant, deployVersion)`, the common case is warm.
- **Per-handler cost:** N sequential syscalls = N local RPC round trips DO↔isolate. In-colo loopback
  RPC is sub-millisecond, but it is **sequential** (the guest `await`s each `call`, `guest.ts`), so a
  handler doing 10 reads/writes adds ~10 hops. Mitigation: Cap'n Web **promise pipelining** batches
  dependent calls; and most handlers issue few syscalls. Measure on the gate (§5, §7 Task 8).
- **Against the 133ms write (Slice 3, live workers.dev):** the added cost is N in-colo hops (single-
  digit ms for typical handlers), plus one warm isolate dispatch. Non-trivial but bounded; unacceptable
  ONLY if made the default for the single-tenant path — which we don't (opt-in).

### 4.2 When the sandbox is worth it

- **Worth it:** multi-tenant — a platform running *other people's* untrusted functions on shared DO
  infra. The sandbox is the only thing that stops tenant A's function from reading tenant B's data or
  calling out to the network. This is the "Platforms: run applications uploaded by your users" use
  case (CF docs).
- **Not worth it:** single-tenant / trusted — the app owner deploys their OWN code (today's Slice 3
  default, and every self-host). Inline in the DO is faster and free.

### 4.3 Recommendation: OPT-IN, inline default

Select the sandbox with a deployment flag (`sandbox: true` in `wrangler.jsonc` vars / `--sandbox`).
Absent it, Slice 3's inline path runs byte-for-byte (no Worker Loader binding needed, works on the
free tier, no added latency). This also contains the open-beta/paid-only risk to callers who opt in.
**Human decision 1** — recommendation: **opt-in, inline default.**

---

## 5. THE SPIKE — what it proves, and at what fidelity

Delivered: `packages/runtime-cloudflare/spike-worker-loader/` (throwaway, clearly labeled, outside
`src/`/`test/` so it is not built or run by CI). Contents:

- `worker.ts` — a real-CF-deployable parent Worker that: exports `SyscallHost` (a `WorkerEntrypoint`
  = the DO's syscall host stand-in, scoped to a tenant via `ctx.props`), loads a child dynamic worker
  per tenant with `globalOutbound: null` passing the stub in `env`, and asserts the three crux
  properties. The child "user code" calls back with the engine's REAL ABI shape
  `env.HOST.syscall(op, argJson)`.
- `wrangler.jsonc` — `worker_loaders` binding + `enable_ctx_exports` + `nodejs_compat` + a 2026 compat
  date.
- `probe-local.mjs` — the honest local-toolchain probe.

### What it is designed to prove (on real CF)

1. **(a)** child `fetch()` throws under `globalOutbound: null` (egress dead).
2. **(b)** child `env.HOST.syscall("db.get", json)` round-trips and returns a JSON string (the ABI
   marshals across the boundary).
3. **(c)** a tenant-scoped stub only reaches its own tenant's data even when the child names another
   tenant in args (capability-based isolation: the host scopes by `ctx.props`, not by child input).

### FIDELITY — what was ACTUALLY proven (do not overclaim)

**Nothing has been executed on Worker Loader. The three claims above are INFERRED FROM CF DOCS, not
PROVEN.** Reason, with evidence:

- This repo pins **workerd `1.20241218.0` / miniflare `3.20241218.0` / wrangler `3.99.0`** (all Dec
  2024) — ~15 months older than Dynamic Workers (Mar 2026). The runtime's own binding schema has no
  `WorkerLoader` struct (`workerd.capnp`, Dec 2024). `@cloudflare/workers-types@4.20260702.1` (Jul
  2026) *does* type it — so the spike type-checks against a runtime that can't run it (a trap).
- **Empirically confirmed (this WAS run):** `node …/spike-worker-loader/probe-local.mjs` →
  **`RESULT: 500 NO_LOADER_BINDING`** — the Dec-2024 miniflare silently ignores `workerLoaders`;
  `env.LOADER` is `undefined`. Reproducible from the repo root.

So `vitest-pool-workers` (the local workerd) **cannot** host this spike. Upgrading the whole CF
toolchain to ≥2026-03 just to run a spike would risk the shipped Slice-3 workerd tests (which pin the
Dec-2024 stack + `compatibility_date: 2024-11-27`) — out of scope. **To promote the claims to PROVEN:
deploy the spike to a paid CF account with current wrangler and hit `/`** (README has the steps). This
is the roadmap's "de-risk Worker Loader EARLY" step; it is cheap (beta pricing waived) and decisive,
and §9 recommends doing exactly this before committing the slice.

**What IS proven today:** (i) the local toolchain has no Worker Loader (probe, above); (ii) the engine
ABI is already async/JSON/op-discriminated and thus maps onto the RPC boundary with no data-path
rewrite (ABI report, §2); (iii) the spike code is written and type-shaped against the current CF API.

---

## 6. Adversarial — where Worker Loader does NOT fit

1. **Reentrancy into the transaction turn (THE risk).** The whole model hinges on the DO servicing a
   reentrant syscall RPC while it `await`s the off-DO handler, without deadlocking its input gate or
   admitting a second write turn. This is unproven locally and is the spike-deploy's real job. If
   workerd serializes the reentrant call *behind* the awaited outbound call, the mutation deadlocks —
   in which case the fallback is wiring (B) with an explicit turn queue, or (worst case) keeping
   mutations inline and sandboxing only queries/actions. **Flag as the #1 must-verify.**
2. **Open beta.** The `load`/`get`/`WorkerCode` API can change before GA; `env`-carried-stub semantics
   (mechanism A) are exactly the kind of thing that shifts. Pin a compat date, re-verify at build, and
   keep the transport behind the neutral channel so an API change is contained to `runtime-cloudflare`.
3. **Paid-only + per-unique-Worker/day billing.** Post-beta, a platform loading K distinct app bundles
   pays ~`$0.002·K`/day. Keying `get(id)` per `(tenant, version)` (not per-invocation) keeps K = number
   of live app versions, not requests. Still, this makes the sandbox a *paid platform feature*, never
   part of the free single-node promise — reinforcing opt-in.
4. **Sequential syscall latency.** N hops per handler; pathological handlers (hundreds of reads in a
   loop) get slow. Pipelining helps only dependent calls. Document the cost; it is the price of
   isolation and only paid by opt-in multi-tenant callers.
5. **Actions vs `globalOutbound: null`.** Blocking egress breaks actions (§3.4). Untrusted actions need
   a gateway WorkerEntrypoint as `globalOutbound` to filter, not kill, egress — a separate, larger
   design (allow-lists, credential injection) that this slice should scope as queries/mutations FIRST,
   actions as a follow-on. **Flag: do not ship untrusted-action egress in the first cut.**
6. **`node:crypto` in the guest.** If any guest-side code path needs the handler's `createHash`
   (fingerprint/drift), the dynamic worker needs `nodejs_compat` in its `compatibilityFlags` too — but
   the drift/fingerprint is HOST-side (the DO), so the guest likely doesn't. Verify no guest path
   imports `node:crypto`; if it does, add the flag to the child `WorkerCode`.
7. **`COLLECT_BRAND` drops across the boundary** (§2.4) — a correctness-of-*diffability* regression if
   not moved guest-side + wire-flagged. Named; bounded; a required task.
8. **Cold-start variance under eviction.** "No sandbox caps" is good, but warm isolates CAN be evicted;
   a cold `get()` pays the few-ms load. Fine for the opt-in path; note it in the perf report.

---

## 7. Build order (bite-sized, TDD) + human decisions

> All Cloudflare/Worker-Loader types live in `packages/runtime-cloudflare` (+ the spike). The
> `packages/executor` changes are NEUTRAL (channel-parameterized) — enforced by the same neutrality
> source-scan Slice 1/3 ship. **Do NOT start these until §9's gate (spike-deploy PASS + a real
> multi-tenant need) is met.**

**Task 0 — Real-CF spike deploy (the gate, do FIRST).** Deploy `spike-worker-loader/` to a paid CF
account; confirm (a)/(b)/(c) (§5). Record the reentrancy result (mechanism A vs B). No engine code.
*Gate:* all three PASS on real CF, and mechanism A-or-B chosen from observed behavior.

**Task 1 — Neutral host/guest split in `packages/executor`.** Extract `GuestUdfExecutor.runGuest(fn,
args, channel, opts)` (the guest half of `executor.ts:580-626`) + `createHostDispatch(kctx, router)`
(§2.3). Prove the INLINE path still works by re-expressing `InlineUdfExecutor.run` as
`createHostDispatch` + `runGuest` over an in-process channel — zero behavior change, full existing
suite green. *Gate:* executor tests unchanged; neutrality scan (no cloudflare types).

**Task 2 — Wire-flag the `COLLECT_BRAND`** (§2.4). Move the passthrough-identity check guest-side; carry
an explicit `__collectToken`/`__brandToken` wire flag (the paginate path already has `__brandToken`,
`kernel.ts:723-727` — generalize to collect). *Gate:* DLR diff tests pass with the guest and host in
SEPARATE heaps (simulate with a JSON round-trip channel in a Node test).

**Task 3 — `RpcSyscallChannel` + the sandbox host in `runtime-cloudflare`.** `RpcSyscallChannel
implements SyscallChannel` = `call(op,argJson) => hostStub.syscall(op,argJson)`; the `SyscallHost`
WorkerEntrypoint bound to the in-flight `kctx` (mechanism from Task 0). *Gate:* unit test the channel
against a fake host (Node); neutrality scan.

**Task 4 — The child bootstrap module (guest entry).** The statically-shaped `runHandler({fnPath, args,
seed, now, identity}, HOST)` entry that builds the guest ctx over `RpcSyscallChannel` and calls the
user handler. User modules are bundled into the `WorkerCode.modules` map at codegen (reuse the Slice-3
static-import bundling — the app code is already baked; the sandbox just re-targets it into the child
`modules`). *Gate:* workerd-independent unit test of `runHandler` over a fake channel.

**Task 5 — DO integration: sandbox dispatch path.** In the transactor DO, when `sandbox: true`, route
`/api/run` through `env.LOADER.get((tenant,version), …)` + `SyscallHost` instead of the inline
executor; commit stays inline in the write turn (G4). *Gate:* the sandbox path is selected only under
the flag; inline path byte-identical when off.

**Task 6 — Per-function-type sandbox profiles.** Query/mutation → `globalOutbound: null`. Action →
gateway (or, first cut, inline-only for actions with a documented TODO). *Gate:* a query/mutation in
the sandbox has no egress; an action either uses a gateway or is documented-deferred.

**Task 7 — `wrangler.jsonc` template + codegen.** Emit the `worker_loaders` binding + `enable_ctx_exports`
when `sandbox: true`; bundle user modules into the child `modules` map. *Gate:* codegen produces a
deployable Worker.

**Task 8 — The flagship real-CF E2E (the gate).** Deploy a 2-tenant fixture on the sandbox DO host;
prove: a `fetch()`-attempting user function is blocked; a `ctx.db.insert` user function commits via the
syscall path AND fans out reactively to a subscription; tenant A cannot read tenant B; **measure the
added write latency vs Slice 3's inline number** (controls, not vibes — same vantage). *Gate:* all
pass; latency delta recorded honestly.

**Task 9 — Deploy-anywhere + neutrality regression.** Full suite + typecheck green with `sandbox` off
(container+R2 and inline-DO paths unchanged); `WorkerLoader`/cloudflare types appear nowhere under
`packages/executor`/`runtime-embedded`/`sync`/`transactor`.

### Human decisions to confirm (do not unilaterally decide)

1. **Opt-in sandbox vs default** (§4.3). Recommendation: **opt-in flag, inline default.** Load-bearing:
   determines whether the free/single-tenant path pays any Worker-Loader cost (it shouldn't).
2. **Syscall-host wiring: (A) live callback stub vs (B) turnId + reentrant DO call** (§2.2). Recommendation:
   **decide from Task 0's observed behavior** — (A) if `env` can carry a closure-bound stub, else (B).
3. **Determinism: contract-based (unchanged) vs freeze-globals-in-`load()`-mode** (§3.3). Recommendation:
   **contract-based + document the `Date.now`-in-a-query footgun** (matches inline; avoids warm-isolate
   global-override races).
4. **Isolate pool: `get(id)` warm per (tenant, version) vs `load()` per invocation** (§4.1). Recommendation:
   **`get()` warm pool** (latency + billing), accepting that warm-isolate sharing rules out per-invocation
   global override (ties to decision 3).
5. **Actions in the first cut** (§8.5): gateway-egress now vs actions-inline-only with a documented TODO.
   Recommendation: **queries/mutations sandboxed first; actions inline-only in v1**, gateway egress a
   follow-on (it is a whole allow-list/credential design of its own).
6. **BUILD NOW vs DEFER behind Slice 5** (§9). Recommendation: **spike-deploy now; defer the full build.**

---

## 8. Evidence index (file:line)

| Concern | Where |
|---|---|
| Roadmap Slice 4 scope | `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:141-155`; slice graph `:45-52` |
| Worker Loader = open-beta/paid/`globalOutbound` | `docs/dev/research/cloudflare-do-native-host.md:25`, `:59`; CF changelog 2026-03-24; CF egress-control page |
| Syscall ABI: `call(op,argJson):Promise<string>` | `packages/executor/src/kernel.ts:205-207` |
| "The seam a real isolate would postMessage across" | `packages/executor/src/kernel.ts:222-244` |
| Boundary is pure JSON strings (isolate-ready) | `packages/executor/src/kernel.ts:1-6`; `index.ts:1-5`; `guest.ts:1-6` |
| Guest `ctx.db.*` → `channel.call(...)` | `packages/executor/src/guest.ts:70-133` (get `:112`, insert `:124`, query `:70-83`) |
| Executor entry `InlineUdfExecutor.run` (owns router + txn) | `packages/executor/src/executor.ts:441-446`, router `:442`, txn `:557`, guest ctx `:580-626` |
| Determinism profiles (query/mutation forbid clock+network) | `packages/executor/src/profile.ts:12-46`; seeded RNG `seeded-random.ts:11-21`; injected now/random `executor.ts:571`,`:581` |
| Global-override deferred to "the V8-isolate executor" (== this slice) | `packages/executor/src/profile.ts:1-11` |
| `COLLECT_BRAND` in-process-only; move guest-side + wire flag | `packages/executor/src/kernel.ts:101-110`, `executor.ts:340-343`; paginate brand token `kernel.ts:723-727` |
| ctx factory + contextProviders (scheduler/storage) reach host via same channel | `packages/executor/src/executor.ts:580-624`, providers `:583-592`; storage provider `packages/storage/src/context.ts:177-194` |
| Host wiring (router → transactor → store) | `packages/runtime-embedded/src/runtime.ts:496`; `RuntimeHost.serve` seam `host.ts:98-109` |
| Slice 3 DO host (inline execution today) | `packages/runtime-cloudflare/src/durable-object.ts`; boot `boot.ts:63-107`; §5 "run user JS inline first" `…/specs/2026-03-20-do-host-slice3-design.md:348-368` |
| G4: commit fan-out inline in the write turn (unchanged) | `…/specs/2026-03-20-do-host-slice3-design.md:170-179` |
| Local toolchain has NO Worker Loader (proven) | `packages/runtime-cloudflare/spike-worker-loader/probe-local.mjs` → `500 NO_LOADER_BINDING`; workerd.capnp (Dec 2024) has no `WorkerLoader` |

---

## 9. Recommendation — build now or defer?

**DEFER the full build behind Slice 5; do the real-CF spike deploy NOW.**

Reasoning:
- **The design is low-surprise.** The ABI is already async/JSON/op-discriminated — the data path
  marshals across the isolate boundary with a ~20-line channel and one neutral executor split. There
  is no architectural unknown on the marshalling the roadmap flagged; it is answered by construction
  (§2).
- **But the platform is open-beta + paid-only, and the reentrancy question is unproven** (§8.1). A
  beta-pricing-waived real-CF deploy of the delivered spike settles reentrancy + globalOutbound +
  tenant isolation for near-$0 — do that first (Task 0). An honest "reentrant syscalls work on real CF"
  beats building weeks of engine plumbing on an assumption.
- **Slice 4 is off the critical path.** Slice 5 (migration + polish) depends on Slice 3, not Slice 4
  (roadmap graph `:45-52`). The single-tenant DO host is fully shippable inline. Multi-tenant sandbox
  is a *paid platform feature* only some operators need.
- **So:** ship Slice 3 → Slice 5 (single-tenant, free, inline). Run the spike deploy now to keep the
  Worker-Loader risk retired early. Build Slice 4 when (a) the spike passes AND (b) a real multi-tenant
  customer needs it — keeping it opt-in, queries/mutations first, actions and cross-shard later.

This is the honest "not yet, but here's exactly what makes it a yes" — the crux is de-risked in
design and staged for a cheap real-CF proof, without betting the default execution path on an
open-beta primitive.
