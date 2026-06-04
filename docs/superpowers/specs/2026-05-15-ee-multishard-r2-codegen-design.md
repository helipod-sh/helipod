# ee/ multishard R2 codegen wiring — design note

**Date:** 2026-05-15
**Status:** SMALL, scoped follow-on (confirmed small after investigation — not a rebuild)
**Touches:** `ee/packages/runtime-cloudflare-shard/src/worker-entry.ts` only (+ its test + README)

## What exists today

Two independent "multishard"-flavored things live under `ee/`, easy to conflate:

1. `ee/packages/objectstore-substrate` — the **portable** Tier-3 multi-node write-scale substrate
   (object store as the durable log; fs/S3/R2-agnostic via the `@stackbase/objectstore` seam). This
   backs `stackbase serve --object-store` on containers, NOT Cloudflare Workers. Not touched here.
2. `ee/packages/runtime-cloudflare-shard` — the **Cloudflare DO-native** multi-shard router (Slice 6,
   M1). Each shard key routes (by `getByName`) to its own **unmodified** free-tier
   `StackbaseDurableObject`, each with its own DO-SQLite. This package's `generateShardWorkerEntrySource`
   (`src/worker-entry.ts`) is the ee twin of the free host's `generateWorkerEntrySource`
   (`packages/runtime-cloudflare/src/worker-entry.ts`) — both emit a static-import Worker/DO entry file.

"R2 codegen" in this task's framing refers to the **file-storage R2 binding wiring inside the Worker-entry
generator**, not the objectstore-substrate package (which is unrelated and already has its own sharded
store, `sharded-object-doc-store.ts`, complete and shipped).

## The gap, precisely

The free host's `generateWorkerEntrySource` (`packages/runtime-cloudflare/src/worker-entry.ts`) has an
optional `r2BindingName` input: when set, the generated entry imports `R2BlobStore` from
`@stackbase/blobstore-r2` and wires it into the generated DO subclass's `appConfig(env)` as `blobStore`,
so `ctx.storage`/file storage works on the deployed DO (this is what commit `156d273` wired for the
single-shard host, closing audit gap #7/#2 from
`docs/superpowers/specs/2026-04-13-cloudflare-feature-completeness-audit.md`).

The ee twin, `generateShardWorkerEntrySource` (`ee/packages/runtime-cloudflare-shard/src/worker-entry.ts`),
emits the **same concrete DO class** (`StackbaseDO extends StackbaseDurableObject`, the free, unmodified
class — the package's own doc comment: "a shard-DO IS Slice 3"). Since `StackbaseDurableObject.appConfig()`
already accepts an optional `blobStore` (shared free code, unchanged), the shard-DO class is *already*
capable of serving file storage. But the ee generator's `appConfig(env)` body it emits is hardcoded to
`{ loaded, components, adminKey }` — no `r2BindingName` input exists on `ShardWorkerEntryInputs`, no R2
import, no `blobStore` construction. A multi-shard app that wants file storage today has to hand-edit the
generated/hand-written worker entry (as the deploy rig's `fixture/worker.ts` currently does — it has no
R2 either, consistent with this gap).

This is pure codegen-string wiring — no engine change, no new host behavior, no new package. The DO class
already does the right thing once `blobStore` is present in its `appConfig()` return value; the generator
just never offers a way to put it there.

## What's wired (this change)

Mirror the free generator's R2 support onto `ShardWorkerEntryInputs`/`generateShardWorkerEntrySource`,
verbatim in shape:

- New optional field `r2BindingName?: string` on `ShardWorkerEntryInputs`.
- When set: emit `import { R2BlobStore } from "@stackbase/blobstore-r2";`, and in the generated
  `appConfig(env)` body, read `env[r2BindingName]` into `__bucket` and conditionally spread
  `blobStore: new R2BlobStore({ bucket: __bucket })` into the returned config — same guarded shape as
  the free generator (missing binding degrades to byte-less rather than throwing at boot).
- When absent (default): zero R2 import, zero `blobStore` — byte-less deploy, unchanged output for every
  existing caller/test.

## Explicitly out of scope (do not build here)

- No new `@stackbase/blobstore-r2` dependency wiring beyond the generated string (the free package's own
  `worker-entry.ts` doesn't import `R2BlobStore` at the package's own runtime either — only the generated
  *app* code does, at deploy time, from the app's own `node_modules`). No package.json dependency change
  needed for `runtime-cloudflare-shard` itself.
- No `stackbase deploy`/CLI wiring for a turnkey multi-shard Cloudflare deploy command, and no
  `reconcileWrangler`-style multi-shard `wrangler.jsonc` R2-bucket generator. The free single-shard
  path's own turnkey deploy (`packages/deploy/src/targets/cloudflare.ts`) does not generate the worker
  entry either — it only reconciles bindings on a pre-existing `wrangler.jsonc`/`worker.ts` and shells to
  `wrangler deploy`. Building an ee-side deploy target is a materially bigger, separate task (new package
  or CLI dispatch changes) and was not billed as part of this "small" follow-on.
- No real-workerd (`vitest-pool-workers`) proof that R2 + multishard compose live. The free single-shard
  R2 wiring already has its own workerd proof (`test-workers/storage.worker.test.ts`); the shard-DO class
  is the SAME class, so the byte-moving mechanism is not new. A confirming multishard+R2 workerd fixture
  is a reasonable fast-follow but is proof-upgrade work, not this gap.
- The deploy rig (`ee/packages/runtime-cloudflare-shard/rig/`) is left untouched — it is a human-run,
  hand-written stand-in explicitly documented as such, not exercised by the automated test suite.

## Test plan

Extend `ee/packages/runtime-cloudflare-shard/test/worker.test.ts` with the same two-sided assertions the
free package's `test/worker-entry.test.ts` uses: (a) `r2BindingName` set → R2 import + `env[...]` read +
`new R2BlobStore(...)` present, byte-identical guard shape; (b) `r2BindingName` absent → neither
`@stackbase/blobstore-r2` nor `R2BlobStore` appear anywhere in the output. Both combined with the existing
`mode`/`regionPrefixedKeys` options to confirm no interaction/ordering bug.
