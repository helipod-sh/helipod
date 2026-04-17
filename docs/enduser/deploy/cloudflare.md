---
title: Cloudflare (Experimental)
---

# Cloudflare (Experimental)

> Stackbase runs on Cloudflare via **Workers + Containers + R2**. It works, it scales to zero — and
> scheduled functions don't fire yet. Read the gap before you pick this.

This is **not a turnkey deploy target**. There is no `stackbase deploy`-to-Cloudflare command
([`stackbase deploy`](/deploying) pushes to a running `stackbase serve`, and has nothing to do with
Cloudflare). You hand-write a small Worker and a `wrangler.jsonc`, and Cloudflare runs the same
generic `stackbase serve` image you'd run anywhere else. No engine rewrite, no Cloudflare-specific
build of Stackbase.

Everything on this page was measured against real Cloudflare and real R2 on 2026-03-12/16.

## Read this first: the scheduler gap

Cloudflare **stops your container ~5 seconds after the last request**. That's the same mechanism
that gives you scale-to-zero, and it is currently a **correctness break**:

> **Scheduled functions, crons, [triggers](/triggers), and the file-storage reaper DO NOT FIRE on
> Cloudflare today.** `ctx.scheduler.runAfter(300_000, …)` schedules work into a process that will
> not exist in five seconds. A cron set for 03:00 only runs if traffic happens to arrive at 03:00.

This is invisible until someone notices their emails never sent. A fix (waking the container from a
Durable Object alarm) is **designed but not shipped** — do not plan around it.

**Use Cloudflare only if your app is request-driven.** If you depend on `@stackbase/scheduler`,
[triggers](/triggers), or [file storage](/files)'s orphan reaper, use
[Docker self-hosting](/self-hosting) or the [standalone binary](/deploy/standalone-binary) instead.

## What it actually uses

| Service | Role |
|---|---|
| **Workers** | Stateless router in front of the container. |
| **Containers** | Runs the shipped `stackbase serve` image. |
| **Durable Objects** | Automatic — the `Container` class *is* a DO. You don't write one. |
| **R2** | The object-store substrate: **the source of truth**. |

**Not needed, despite what you may expect:** D1, KV, Vectorize, Hyperdrive, Queues. Stackbase's
storage seam is satisfied by R2 alone.

### Why R2 has to be the source of truth

Container disk is **ephemeral**. That's survivable *only* on the object-store build, where R2 holds
the truth and the container's local SQLite is a disposable materialized cache that rehydrates on
boot. This is proven: wiping the local SQLite and rebooting produced a full rehydrate from R2, same
`_id`/`_creationTime`.

**A plain SQLite deployment would silently lose data on every restart.** `--object-store` is not
optional here.

## Requirements

- **Workers Paid plan** (~$5/mo minimum). Containers and Durable Objects have **no free tier**. R2
  has a free tier.
- An R2 bucket, and an R2 API token (access key id + secret).
- A `convex/` directory with **committed `_generated/`** — `serve` never runs codegen.
- Wrangler, and Docker able to build **`linux/amd64`**.

### The amd64 requirement

Cloudflare Containers require `linux/amd64` images. On Apple Silicon, building natively gives you
an arm64 image and a deploy that fails with an opaque `no match for platform in manifest`.
Cross-build explicitly:

```bash
docker build --platform linux/amd64 -t my-app-backend .
```

### The bake-in requirement

Containers have **no bind mounts**, so the `docker-compose.yml` pattern of mounting `./convex` into
a generic image doesn't apply. Your app must be **baked into the image** — the immutable path from
[Docker self-hosting](/self-hosting):

```dockerfile
FROM stackbase:latest
COPY ./convex /app/convex
```

Rebuild and redeploy the image to ship a change. There is no live hot-swap on this path.

## Wiring it up

Point `serve` at R2 with `--object-store` (or `STACKBASE_OBJECT_STORE`). R2's S3-compatible
endpoint needs `region=auto` (R2 has no regions) and path-style addressing:

```
s3+https://<account-id>.r2.cloudflarestorage.com/<bucket>?region=auto&forcePathStyle=true
```

Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, or inline as
`s3+https://<key>:<secret>@…`. Set them, plus the required `STACKBASE_ADMIN_KEY`, as container
environment variables in your `wrangler.jsonc` — keep the secrets in
`wrangler secret put`, not in the file.

The Worker forwards requests to the container; the container runs `serve` exactly as it does under
Docker. Health is at `GET /api/health`, the dashboard at `/_dashboard`.

## Behavior you should expect

| | |
|---|---|
| **Scale to zero** | Cloudflare stops the container ~5s after the last request. You aren't billed for an idle backend. |
| **Cold start** | ~4.5s warm-image, ~7.3s on the first boot. The first request after idle pays this. |
| **Reads** | Local to the container, fast — they hit the materialized SQLite. |
| **Writes** | **Structurally slower than a local-disk host.** Every commit is an R2 CAS round trip. That is the definition of "object storage is the linearization point"; no configuration fixes it. |

**We have not measured the real container→R2 write latency**, and won't quote a number we haven't
taken. (The 1.2s/op figure from the R2 conformance run was WAN from a laptop and is *not*
representative of a container sitting next to R2.) If write latency matters to your app, measure it
on your own deployment before committing.

## Should you use this?

**Good fit:** a request-driven app that idles a lot, where scale-to-zero economics and Cloudflare's
edge matter more than write latency, and cold starts are acceptable.

**Bad fit:** anything using scheduled functions, crons, triggers, or the storage reaper (they don't
run); write-heavy workloads; anything needing predictable low-latency writes or no cold start.

For most deployments, [Docker self-hosting](/self-hosting) is the baseline and the
[standalone binary](/deploy/standalone-binary) is the simplest. Cloudflare is the interesting
option, not the default.
