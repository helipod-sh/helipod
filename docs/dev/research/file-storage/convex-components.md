---
title: Convex File-Storage Components — Research
status: research
---

# Convex File-Storage Components — Research

> Researched 2025-07-31. Sources: convex.dev/components/*, convex.dev/components,
> and clean-room structural inspection of `.reference/rate-limiter`,
> `.reference/workpool`, `.reference/action-retrier` (real installed Convex
> components, read for packaging conventions only — no code copied). Convex's
> `/components` directory page itself repeatedly timed out on fetch; its framing
> is reconstructed from the component READMEs, which all quote the same
> "what is a component" boilerplate, plus the local reference packages' actual
> `convex.config.ts`/`schema.ts` structure.

## 1. What a Convex "component" is

A Convex **component** is an installable, namespaced mini-backend: its own
tables (`schema.ts`), its own functions (queries/mutations/actions), and
optionally its own cron jobs — all defined with the exact same primitives an
app itself uses (`defineSchema`, `defineTable`, `mutation`, `action`,
`cronJobs()`), but compiled into an **isolated namespace** the host app cannot
reach except through the component's declared public API.

Structurally (confirmed from the three local reference packages), every
component repo has the same shape:

- `src/component/convex.config.ts` — a one-line manifest: `export default defineComponent("rateLimiter")`. This is what registers the component's *name* in the composed app.
- `src/component/schema.ts` — the component's own private tables (e.g. rate-limiter's single `rateLimits` table with a `(name, key, shard)` index). These tables live in a storage namespace the app's own `ctx.db` cannot query directly.
- `src/component/*.ts` (`lib.ts`, `internal.ts`, `public.ts`, `run.ts`, `worker.ts`, etc.) — the component's own queries/mutations/actions, again written with the same `mutation`/`query`/`action` builders as app code.
- `src/component/crons.ts` — components can register their own recurring jobs (workpool and action-retrier both do), independent of anything the host app schedules.
- `src/client/index.ts` — a thin **wrapper class/functions** (e.g. `class RateLimiter`) that the app imports and instantiates. Internally the wrapper calls into the component's public functions via `ctx.runMutation(components.rateLimiter.lib.someFn, args)` / `ctx.runQuery(...)` — i.e., component calls are just another kind of Convex function call, routed through a `components.<name>.<file>.<export>` address rather than the app's own `api.*`/`internal.*`.

**Installation, app-side:**

```ts
// convex/convex.config.ts (the APP's config, not the component's)
import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const app = defineApp();
app.use(rateLimiter);
export default app;
```

`app.use(component)` is the composition point — analogous to Stackbase's
`stackbase.config.ts` composing `defineScheduler()`/`defineWorkflow()` via a
`ComponentDefinition`. After `app.use`, the generated `components` object
gains a `components.rateLimiter` entry the app's own functions can address.

**Calling in, app-side:**

```ts
const rateLimiter = new RateLimiter(components.rateLimiter, { ... });
const status = await rateLimiter.limit(ctx, "sendMessage", { key: userId });
```

The app never touches the component's tables directly — no raw `ctx.db.query("rateLimits")` from app code. All access is mediated by the typed client wrapper, which itself is just calling the component's exposed functions. This is the same isolation discipline Stackbase already has for `@stackbase/scheduler`/`@stackbase/workflow`: a component owns its tables, exposes a typed action/mutation surface, and the host app's functions never see the component's raw schema.

**Why this exists as a packaging concept (inferred from the pattern, not a quoted manifesto):** it lets Convex ship optional, swappable backend behavior — rate limiting, workpools, retriers, and (per this research) file storage backends — as versioned npm packages with their own schema migrations, own cron jobs, and own test suites, **without bloating the core product** and without every app paying the schema/cron cost of features it doesn't use. A component can be swapped for a competing implementation (e.g. `@convex-dev/r2` vs `@hasoo/convex-s3`) without touching the app's own schema, because the component's tables are the component's private implementation detail.

## 2. The four file-storage components

### 2.1 `convex-fs` (npm: `convex-fs`)

**Role:** a *filesystem-shaped* abstraction over an external CDN/blob backend (Bunny.net), not over Convex's own built-in blob store. Its pitch is path-based organization ("filesystem-like operations") layered on a real CDN, as opposed to Convex's built-in storage which is flat/ID-addressed with no path hierarchy.

**Key features (from its own marketing copy):**
- Path-based file organization (directories, not just opaque storage IDs)
- Atomic transactions for file operations, with preconditions (e.g. compare-and-swap on a path)
- Reference-counted blob deduplication — identical bytes uploaded twice share one underlying blob
- Time-limited signed URLs served through Bunny.net's edge network
- Soft-delete with a configurable recovery grace period before hard delete
- Flexible auth hooks (bring your own authorization check per operation)
- Automatic file expiration (TTL)
- Custom CDN transform parameters (e.g. image resizing query params) passed through to Bunny

**Backend:** Bunny.net storage zones + pull zones — an *external* CDN/storage provider, configured via four env vars (storage zone name, CDN hostname, token key, API key). This is the clearest "core vs. component" data point: file storage backend choice (which CDN/bucket provider) is explicitly NOT baked into Convex core; it's a per-component decision, and different components pick different providers (Bunny vs. R2 vs. S3).

**API surface:** billed as "type-safe APIs that match Convex patterns" usable directly inside mutations/queries for transactional metadata bookkeeping, though the fetched page did not expose concrete method signatures.

### 2.2 `@convex-dev/r2` (Cloudflare R2)

**Role:** direct integration between Convex functions and a Cloudflare R2 bucket — R2 is S3-API-compatible but with **zero egress fees**, which is the component's headline differentiator over raw S3.

**Capabilities:**
- Upload handling from mutations/actions, including multipart upload for large files
- Global CDN delivery via Cloudflare's edge network
- Streaming support so large files don't blow serverless memory limits
- Custom domain support (serve from a branded hostname configured in R2, not just the raw R2 URL)
- Handles arbitrary binary formats (images, video, documents)

**Auth/config:** Cloudflare account ID + R2 access key + secret key, stored as Convex environment variables — the standard "component reads its backend credentials from env vars set on the Convex deployment" pattern, not passed as constructor args in app code.

**Relationship to `ctx.storage`:** positioned as going "beyond Convex's built-in storage capabilities" — i.e. an alternative backend for when the built-in storage's constraints (likely: no custom domain, no zero-egress guarantee, no direct-to-bucket presigned flow — see §4) don't fit.

### 2.3 `@gilhrpenner/convex-files-control` ("files-control")

**Role:** the odd one out — this is NOT a storage-backend component. It's a **policy/lifecycle layer that sits on top of** Convex's existing storage (built-in `ctx.storage`, presumably usable on top of any of the other three too), adding exactly the things a raw blob store doesn't have an opinion on:

1. **Access control** — native `ctx.storage` has no notion of "who can download this file"; this component adds user-based authorization/role checks before granting access.
2. **Lifecycle management** — configurable retention policies and scheduled deletion of orphaned files, so storage cost doesn't grow unboundedly from abandoned uploads.
3. **Secure temporary access** — "time-limited download grants with user-specific access validation," replacing permanent/guessable file URLs with expiring, per-user grants.

**API surface:** mutations/queries that *wrap* native storage calls — upload validation with a permission check before the file is stored, download-grant generation producing expiring per-user URLs, and lifecycle-policy definitions (retention window + cleanup schedule, almost certainly implemented as a component-owned cron, matching the `crons.ts` pattern seen in workpool/action-retrier).

**Explicit framing (quoted from its own docs):** it adds "access control and lifecycle management without changing how files are stored" — i.e., it is a pure metadata/policy layer, storage-backend-agnostic.

### 2.4 `@hasoo/convex-s3`

**Role:** direct S3 integration, but with a narrower, sharper focus than R2: **presigned URLs for direct client-to-bucket transfer**, explicitly to avoid proxying file bytes through the Convex backend at all.

**API surface:**
- `generateUploadUrl` — presigned URL for the client to `PUT` directly to S3, with configurable cache-control headers
- `getSignedUrl` — presigned, time-limited download URL for private objects, with custom response headers
- Also supports stable public URLs (not just signed) for objects that should be publicly cacheable

**Requirements:** IAM permissions scoped to `s3:PutObject`/`s3:GetObject` only (least-privilege), plus S3 bucket CORS configured to allow GET/PUT from the app's origins — because the whole point is the browser talks to S3 directly, not through Convex.

**CDN integration:** `S3_PUBLIC_BASE_URL` env var lets a CloudFront (or equivalent) distribution front the bucket for the public/stable-URL case.

## 3. Division of labor: what these components add beyond a hypothetical built-in

Reading all four together, a clean decomposition falls out:

| Concern | Owned by |
|---|---|
| Bytes-in-a-bucket (put/get/delete) | Each component's own thin wrapper around its chosen backend SDK (Bunny/R2/S3) |
| Presigned/direct-to-bucket upload URLs | `convex-s3` and (implicitly) `r2`'s multipart handling — bypasses the Convex function's own body-size/memory limits |
| Metadata bookkeeping (which Convex row owns which blob) | Left to the *app's own schema* in all four — none of these components appear to impose a fixed "files" table shape on the app; they hand back a key/URL and the app decides how to store the association. `files-control` is the exception in spirit (it *does* seem to track ownership) but frames itself as sitting beside storage, not owning it. |
| Access control / auth on downloads | `files-control` only — none of the pure storage-backend components (`fs`, `r2`, `s3`) do authorization themselves |
| Lifecycle / GC of orphaned files | `files-control` (retention policies + scheduled deletion) and `convex-fs` (soft-delete + auto-expiration) — each storage-shaped component reinvents *some* lifecycle story rather than delegating to a shared lifecycle component, suggesting Convex's ecosystem hasn't converged on a single canonical GC layer |
| CDN delivery / custom domains | Each backend component individually (Bunny pull zone, R2 custom domain, CloudFront via `S3_PUBLIC_BASE_URL`) |
| Dedup / reference counting | `convex-fs` only (Bunny-specific) |
| Path-based (hierarchical) naming | `convex-fs` only — the other two backends are flat key/bucket-object addressed, matching S3/R2's native object model |

**What Convex keeps as "core":** presumably a flat, ID-addressed built-in `ctx.storage` (upload URL generation, `ctx.storage.getUrl`, `ctx.storage.delete`) backed by Convex's own hosted storage — good enough for the common case, not reachable/fetched in this research pass but referenced by all four components as the baseline they go "beyond." **What Convex pushes to components:** every *choice* — which bucket provider, custom domains, presigned direct-upload ergonomics, path hierarchies, dedup, and all authorization/lifecycle policy. None of the four bakes authz or GC into the storage layer itself except `files-control`, and even that one frames itself as a separate, composable layer rather than a replacement backend.

## 4. R2/S3 specifics: presigned URLs, metadata sync, CDN serving

Both `r2` and `convex-s3` follow the same shape, which is also the standard "S3 direct-upload" pattern outside Convex entirely:

1. **App mutation/action asks the component for an upload URL** (`generateUploadUrl` in `convex-s3`; R2's equivalent isn't named on its page but multipart upload handling implies the same presigned-URL primitive under the hood). This is a short-lived, cryptographically signed URL scoped to a specific object key and (in S3's case) specific headers like cache-control.
2. **Client uploads directly to the bucket** — the browser/app issues the `PUT` straight to S3/R2, never routing file bytes through the Convex deployment. This sidesteps Convex function payload-size and execution-time limits entirely, and is the core reason these exist as separate components rather than just widening `ctx.storage`'s own limits.
3. **Metadata sync back into Convex tables** happens as a *separate* step the app authors itself: after the direct upload succeeds (client-side confirmation, or a bucket-side event webhook in fancier setups), the app calls its own mutation to record the object key/URL/size/owner in its own table. None of the four components' fetched pages describe an automatic "bucket event → Convex row" sync mechanism (e.g. no S3 event notification wiring is mentioned) — this really is left to the app, another data point for "these components hand you a URL, not a managed record."
4. **Serving reads**: `getSignedUrl` (S3) mints a time-limited signed GET; the "stable public URL" alternative exists specifically so cacheable/public assets don't need per-request signing overhead and can sit behind a real CDN (`S3_PUBLIC_BASE_URL` → CloudFront). R2's angle is the same but leans on R2's zero-egress-fee pricing plus Cloudflare's own edge network as the "CDN," with custom-domain support so the app can serve from its own hostname instead of the raw `r2.dev` URL.

## Implications for Stackbase

Stackbase already has a working component system (`components/`, `ComponentDefinition`, `stackbase.config.ts`, proven by `@stackbase/scheduler`/`@stackbase/workflow`) — so the question isn't "should we build components," it's "which file-storage concerns belong in core vs. as opt-in components," mirroring the SQLite-core / Postgres-adapter split we already made for the database layer.

**Recommended split, directly modeled on what Convex's own ecosystem converged on:**

**Core (`BlobStore` seam, ships with the engine, always present, mirrors `DatabaseAdapter`):**
- A minimal, backend-agnostic `BlobStore` interface analogous to `DatabaseAdapter` — `put`/`get`/`delete`/`getUrl`(/`getUploadUrl`) — that the engine depends on only through the interface, never a concrete provider. This is the one piece Convex does NOT expose as swappable-by-app-code (their built-in `ctx.storage` has no adapter seam at all, as far as any of the four component pages reveal) — and it's exactly the mistake our own `CLAUDE.md` warns against for the DB layer ("never let the engine know which database it's on"). We should not repeat Convex's coupling here.
- One **default, zero-config `BlobStore` implementation** for local/self-hosted dev — local filesystem, or SQLite-blob-backed — so `stackbase dev`/`stackbase serve` work out of the box with no bucket account, matching our "zero-config local dev" locked decision for SQLite. This is Stackbase's answer to `convex-fs`'s Bunny dependency: ours should need zero external account for the default path.
- `ctx.storage.getUrl`/`store`/`delete` as first-class syscalls in query/mutation/action context, exactly like Convex's built-in — this is core DX, not a nicety, and none of the four researched components would exist to "go beyond" if there weren't already a working baseline to beat.

**Opt-in components (installed via `stackbase.config.ts`, exactly like `defineScheduler()`/`defineWorkflow()`):**
- `@stackbase/storage-s3` / `@stackbase/storage-r2` — alternate `BlobStore` implementations for production-scale/external-bucket deploys, each providing presigned direct-to-bucket upload URLs (client bypasses the Stackbase server entirely for the PUT, same as both researched components) and CDN-serving config (custom domain / public base URL). These should implement the *same* core `BlobStore` interface so the app's `ctx.storage` calls don't change when swapping backends — a strict improvement over Convex's model, where `r2`/`convex-s3`/`convex-fs` are three unrelated APIs with no shared interface, forcing an app to rewrite storage code to switch providers.
- A `@stackbase/files-control`-equivalent **only if/when demand shows up** — access control, retention/GC policies, and expiring per-user download grants are policy concerns properly built on top of core `ctx.storage`/`BlobStore`, not baked into it, exactly as Convex's own ecosystem decomposed it. This is the clearest "yes, definitely a component, never core" verdict from the whole research pass: authz and GC policy are app-specific enough that Convex shipped it as a *third-party* component, not even an official `@convex-dev/*` package.
- Path-hierarchy/dedup/soft-delete-with-recovery (the `convex-fs`-style filesystem ergonomics) is a nice-to-have layered convenience, not core — flat ID/key-addressed storage (matching S3/R2's native object model, and simpler to adapter-ize) should be the core `BlobStore` shape; hierarchical paths, if wanted, become a thin component built on top, not a core engine feature.

**One place to deliberately diverge from Convex, not just mirror it:** metadata sync. Convex's own components leave "record the uploaded object in a table" entirely to the app, with no mention of an automatic bucket-event → row sync. Given Stackbase's reactivity model is the whole point of the product, core `ctx.storage.store()` should transactionally write a system metadata row (key, size, contentType, owner) as part of the *same mutation* that requested the upload URL — so a client subscribed to "my files" gets the reactive push the moment upload completes, without the app having to hand-roll that plumbing the way every one of the four Convex components implicitly requires. This is a place where Stackbase's core reactive-transaction primitive can make file storage strictly better DX than Convex's own component split achieved, at zero cost to the core-vs-component boundary.

**Bottom line:** built-in = one interface (`BlobStore`) + one zero-config local backend + the reactive metadata write. Components = each external bucket backend (S3, R2, ...) as a swappable `BlobStore` implementation, plus optional policy layers (access control, lifecycle/GC, path hierarchies) built on top — never inside — the core seam.
