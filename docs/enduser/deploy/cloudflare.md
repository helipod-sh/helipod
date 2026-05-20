---
title: Cloudflare
---

# Cloudflare

> `stackbase deploy --target cloudflare` provisions a **Durable-Object-native** host —
> `@stackbase/runtime-cloudflare` — via `wrangler deploy`. One Durable Object owns the writer,
> DO-SQLite, every WebSocket, and the wake alarm. Scheduled functions, crons, and triggers **do**
> fire here (the DO's own alarm wakes them), unlike the alternative Containers-based path.

> **This is one of two Cloudflare deployment paths.** If you specifically want to run the same
> portable `stackbase serve` image (SQLite/Postgres storage options) you'd run anywhere else, inside
> a Cloudflare Container instead of a Durable Object, see
> [Cloudflare via Containers](/deploy/cloudflare-containers) — a different, more manual, and more
> limited path (no `stackbase deploy` integration, scheduled functions don't fire). Most projects
> targeting Cloudflare want this page.

## What it provisions

`@stackbase/runtime-cloudflare`'s Durable Object is a **unified** host: one object is the OCC
writer, the DO-SQLite store, the hibernatable WebSocket set, the subscription index, and the wake
alarm (`ctx.storage.setAlarm`) that fires `@stackbase/scheduler`/`@stackbase/triggers`/the storage
reaper's due timers even though the DO itself idles between requests. It is a **single global DO**
in v1 — one Durable Object, not a sharded fleet (the many-shard router,
`@stackbase/runtime-cloudflare-shard`, is a separate paid-tier follow-on, not this).

## Prerequisites

- **`wrangler`**, as a project dependency:

  ```bash
  npm i -D wrangler
  ```

- **Authentication**:
  - Locally: `wrangler login` (opens a browser) once, or `wrangler` will already be authenticated
    from a prior session.
  - In CI: `CLOUDFLARE_API_TOKEN` (and typically `CLOUDFLARE_ACCOUNT_ID`) as environment variables —
    **never** `wrangler login` in CI. `stackbase deploy`'s `cloudflare` target's `preflight` checks
    for `CLOUDFLARE_API_TOKEN` whenever it detects a non-interactive session (`!stdin.isTTY ||
    process.env.CI`) and fails fast with an actionable error if it's missing — it never prompts or
    hangs waiting on stdin.
- **A `wrangler.jsonc`** in your project root, with a `main` entry pointing at your Worker/DO
  source — see the required shape below. `stackbase deploy --target cloudflare` **reconciles**
  bindings into an existing `wrangler.jsonc`; it does not scaffold the file or your worker source
  for you. Use `packages/runtime-cloudflare/rig/fixture/worker.ts` in the Stackbase repo as a
  reference for the handful of lines a worker entry needs (`export class StackbaseDO extends
  StackbaseDurableObject { … }` + `export default createWorkerHandler("STACKBASE_DO")`).
- **A `convex/` directory with committed `_generated/`** — same requirement as `stackbase serve`.
  `package` refreshes codegen before packaging, same as every other target.

## The required `wrangler.jsonc` shape

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "main": "worker.ts",
  "compatibility_date": "2024-11-27",
  // node:crypto (used for fingerprint/resume hashing) needs nodejs_compat.
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "STACKBASE_DO", "class_name": "StackbaseDO" }]
  },
  "migrations": [
    // DO-SQLite needs the SQLite-backed class migration tag — new_sqlite_classes, NOT new_classes.
    { "tag": "v1", "new_sqlite_classes": ["StackbaseDO"] }
  ]
  // Optional: an R2 binding for file storage — see "File storage (R2)" below.
}
```

Three things `stackbase deploy --target cloudflare` checks/adds **additively** — never dropping a
field you've hand-written — if they're missing:

- `durable_objects.bindings` — the `STACKBASE_DO` → `StackbaseDO` binding.
- `migrations` — a `new_sqlite_classes: ["StackbaseDO"]` entry (picks the next unused tag if you
  already have migrations).
- `compatibility_flags` — `nodejs_compat`.

If nothing was missing, your `wrangler.jsonc` is left byte-for-byte unchanged (including comments).
If something *was* added, the file is rewritten as plain JSON (comments are not preserved on that
rewrite — this only happens the first time, or after you manually remove a binding).

## Usage

```bash
stackbase deploy --target cloudflare --env production
```

- `--env <name>` maps directly to wrangler's own `env.<name>` sections — Stackbase doesn't reinvent
  environments for this target, it passes `--env <name>` straight through to `wrangler deploy`
  whenever your config's `environments.<name>` sets `wranglerEnv`:

  ```ts
  // stackbase.config.ts
  deploy: {
    targets: {
      cloudflare: {
        provider: "cloudflare",
        environments: {
          production: {},                       // wrangler deploy   (top-level env)
          staging: { wranglerEnv: "staging" },   // wrangler deploy --env staging
        },
      },
    },
  },
  ```

  Set up the corresponding `env.staging { … }` block in `wrangler.jsonc` yourself — that's
  wrangler's own mechanism, unchanged.

- `--dry-run` runs `preflight` + `package` (validates wrangler is installed and authenticated,
  refreshes codegen, reconciles `wrangler.jsonc`) and skips `wrangler deploy`. Useful for validating
  a PR without actually deploying.
- `--check` fails if your committed `convex/_generated/` has drifted from a fresh codegen run — a
  gate for CI, independent of and never itself deploying.

On success, `stackbase deploy` prints the deployed URL (parsed from wrangler's own output — the
first `https://…workers.dev` line wrangler prints).

## Secrets

Set `STACKBASE_ADMIN_KEY` (required — the DO fail-fasts on an empty admin key) as a **secret**, not
a plaintext `vars` entry:

```bash
wrangler secret put STACKBASE_ADMIN_KEY
```

`stackbase deploy` doesn't manage secrets — `wrangler secret put` is a one-time, out-of-band step
(same as `CLOUDFLARE_API_TOKEN` itself never belonging in `wrangler.jsonc`).

## File storage (R2)

If your app uses [file storage](/files), reconcile in an R2 binding by setting `r2: true` on the
target's settings:

```ts
cloudflare: {
  provider: "cloudflare",
  r2: true,
  r2BucketName: "my-app-storage", // optional — defaults to "stackbase-storage"
},
```

`stackbase deploy --target cloudflare` then additively reconciles an `r2_buckets` binding
(`STORAGE_BUCKET` → your bucket name) into `wrangler.jsonc`. Create the bucket itself once,
out-of-band:

```bash
wrangler r2 bucket create my-app-storage
```

## Placement: pinning the DO's region

A Durable Object is single-homed and never moves once created — by default it lands near whoever
first reaches it. To pin it explicitly, set `STACKBASE_DO_LOCATION_HINT` (one of the 11 Cloudflare
region codes, e.g. `enam`) as a Worker environment variable. Only the *first* request after a fresh
deploy honors the hint (the DO is pinned thereafter); an invalid hint fails loudly at the edge
rather than silently mis-placing the DO. Leave it unset for the default (place-near-first-requester)
behavior.

## What works, and what's v1-scoped

| | |
|---|---|
| Reactive queries/mutations, WebSocket sync | Full support — the DO's writer and subscription index are the same in-process object, so the shipped ordering guarantees hold with no RPC hop. |
| Scheduled functions, crons, [triggers](/triggers) | **Work** — the DO's own alarm wakes due driver timers even through idle/hibernation, unlike the Containers path. |
| File storage | Supported via an R2 binding (above). Byte I/O runs in the DO's own `fetch` handler. |
| Scale | **Single global DO** in v1 — not a sharded fleet. If you need many-shard geographic scale-out, that's the separate paid-tier `@stackbase/runtime-cloudflare-shard` router, not this target. |
| Multi-region placement | One DO, one region (optionally pinned — see above), not a multi-region topology. See [Scaling Blueprint](/deploy/scaling) for what a multi-region topology *does* look like on other platforms. |

## Related

- [Deploy Targets](/deploy/targets) — the general `--target`/`--env` model this target lives under.
- [Cloudflare via Containers](/deploy/cloudflare-containers) — the alternative path (portable
  `serve` image in a Container; no `stackbase deploy` integration; scheduler gap).
- [GitHub Actions](/deploy/ci-github-actions) — a copy-paste CI workflow deploying this target.
- [Scaling Blueprint](/deploy/scaling) — why this target isn't the multi-region topology.
