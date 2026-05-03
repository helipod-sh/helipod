# spike-worker-loader — THROWAWAY de-risking spike for Slice 4

> **⚠️ THROWAWAY. NOT SHIPPABLE. NOT WIRED INTO THE BUILD.** This directory exists only to
> de-risk the crux of Slice 4 (running untrusted user JS in a Cloudflare **Worker Loader / Dynamic
> Workers** sandbox that syscalls back to the transactor DO). It is excluded from `tsup`/`tsc`/
> `vitest` (it lives outside `src/`, `test/`, `test-workers/`). Delete it once Slice 4 ships for real
> under `src/`. Nothing here imports engine code; nothing here is `export`ed from the package.

Design context: `docs/superpowers/specs/2026-03-20-worker-loader-sandbox-slice4-design.md`.

## What this spike is meant to prove (the Slice-4 crux)

1. **(a) egress is dead:** a child Dynamic Worker loaded with `globalOutbound: null` **cannot**
   `fetch()` the internet — the call throws.
2. **(b) the syscall channel works:** the child **can** call back to a capability passed in its
   `env` (a `WorkerEntrypoint` RPC stub = the stand-in for the transactor DO's syscall host) and get
   a result — using the engine's **real** ABI shape `call(op: string, argJson: string) => Promise<string>`
   (`packages/executor/src/kernel.ts:205-207`), the "seam a real isolate would postMessage across"
   (`kernel.ts:222-244`).
3. **(c) tenant isolation:** two children get two `SyscallHost` stubs bound (via `ctx.props`) to two
   different tenants; neither child can name the other's tenant — the host, not the child, decides
   whose data a stub reaches (capability-based, `env`-scoped).

`worker.ts` is a faithful, real-Cloudflare-deployable proof of exactly these three, structured the
way Slice 4's DO host would structure it (§2 of the spec).

## FIDELITY / STATUS — read this before believing anything

**This spike has NOT been executed at any fidelity.** It is *written to run on real Cloudflare*, but:

- **It cannot run on this repo's pinned toolchain.** Worker Loader / Dynamic Workers went to **open
  beta on 2026-03-24** (paid-only). This repo pins **workerd `1.20241218.0` / miniflare
  `3.20241218.0` / wrangler `3.99.0`** (all Dec 2024) — ~15 months older than the feature. The
  runtime's own binding schema has no `WorkerLoader` struct
  (`node_modules/.bun/workerd@1.20241218.0/.../workerd.capnp` — grep for `WorkerLoader` returns
  nothing). `@cloudflare/workers-types@4.20260702.1` (Jul 2026) *does* type it, so this code
  type-checks against a stale runtime — a trap.
- **Empirical confirmation (this WAS actually run):** `probe-local.mjs` boots the installed
  miniflare with `workerLoaders: [{ binding: "LOADER" }]` and a `globalOutbound: null` child. Result:
  **`env.LOADER` is `undefined`** — the Dec-2024 miniflare silently ignores the binding; the worker
  returns `NO_LOADER_BINDING` (500). So the local runtime provably has no Worker Loader. Re-run:
  `node packages/runtime-cloudflare/spike-worker-loader/probe-local.mjs`.

**Therefore the design claims in the spec that depend on Worker Loader semantics are `INFERRED FROM
CF DOCS`, not `PROVEN`.** To promote them to PROVEN, deploy `worker.ts` to a **paid** Cloudflare
account with a **≥ 2026-03 wrangler/workerd** (`npm i -g wrangler@latest`), then `wrangler deploy`
and hit `/`. See "To actually run it" below. Do NOT claim this spike passed until that happens — the
same "manual-smoke risk is unconfirmed until the artifact is actually smoked" discipline the Docker
and Slice-3 gates enforce.

## To actually run it (needs a paid CF account + current wrangler)

```bash
cd packages/runtime-cloudflare/spike-worker-loader
npm i -g wrangler@latest         # must be >= 2026-03 for the worker_loaders binding
wrangler deploy                  # paid Workers plan required (Dynamic Workers is paid-only)
curl https://<your-worker>.workers.dev/   # expect the PASS/FAIL report JSON
```

Expected body when the design holds (all three checks PASS):

```json
{
  "a_egress_blocked":    { "pass": true, "detail": "child fetch() threw as expected" },
  "b_syscall_roundtrip": { "pass": true, "detail": "db.get returned a row via RPC" },
  "c_tenant_isolation":  { "pass": true, "detail": "tenant-A stub saw only tenant-A rows" }
}
```

## Files

- `worker.ts` — the parent Worker: `SyscallHost` (WorkerEntrypoint = the DO's syscall-host
  stand-in), the child-code string ("user code"), and the three assertions. Deployable to real CF.
- `wrangler.jsonc` — `worker_loaders` binding + `enable_ctx_exports` + a 2026 compat date.
- `probe-local.mjs` — the honest "it can't run here" evidence (actually executed; see above).
