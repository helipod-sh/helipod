# Real-cloud object-store benchmark harness (2026-02-20)

## Goal

Extend `bun run bench:objectstore` (`benchmarks/runner/src/objectstore-bench.ts` +
`benchmarks/runner/src/cores/objectstore.ts`) so it can run the SAME primitive measurements
(`putImmutable`/`casPut`/`get` p50/p99, one-flush latency, CAS one-winner under concurrency,
1/2/4/8/16-prefix shard-scaling) against a REAL cloud bucket (AWS S3 / Cloudflare R2 / any
S3-compatible), env-var gated, cleaning up after itself. This is the follow-up the design doc's
§13 explicitly flagged: the MinIO run measured a *floor* (single-node, local loopback); §9's
"10-100ms commit latency floor" and §13's "per-prefix scaling on distributed S3" claims need a
real-cloud run to actually quantify — which nobody in this sandboxed environment has credentials
to do. So: build the harness correctly and leave real numbers as TBD.

## Approach

1. **Reuse the production adapter, not a bench-only reimplementation.** `cores/objectstore.ts`
   currently hand-rolls its own minimal `ObjectStore` class over the AWS SDK. Refactor
   `runObjectStoreBench` to accept a narrow structural interface (`ObjectStoreLike`: `putImmutable`/
   `casPut`/`get`/`list`/`delete`) instead of the concrete class, so the REAL `S3ObjectStore` from
   `@stackbase/objectstore-s3` (the actual Tier-3 adapter) can be passed in directly for the
   real-cloud path. The MinIO path keeps using the existing local `ObjectStore` class, unchanged
   behavior.
2. **Key-prefix scoping.** Add an optional `keyPrefix` to `runObjectStoreBench` so every key the
   bench writes lives under one run-scoped root (`bench-runs/<runId>/...`). Add a
   `cleanupObjectStoreBenchKeys(os, keyPrefix)` helper that lists and deletes everything under that
   prefix — called in a `finally` so a real bucket is left clean even if the bench throws partway
   through.
3. **Env-var gated real-cloud mode** in `objectstore-bench.ts`: if
   `STACKBASE_OBJECTSTORE_S3_BUCKET` + `STACKBASE_OBJECTSTORE_S3_ACCESS_KEY_ID` +
   `STACKBASE_OBJECTSTORE_S3_SECRET_ACCESS_KEY` are all set, construct a real `S3ObjectStore`
   (endpoint/region optional — omitting endpoint targets real AWS S3 with virtual-hosted-style;
   setting it targets R2/MinIO/any S3-compatible with path-style), run `assertCasSupported()`
   (the real production boot probe) then the same primitive bench under a unique run-scoped
   prefix, then clean up. Unset → existing MinIO docker path, byte-for-byte unchanged.
4. **Docs**: `benchmarks/docs/realcloud-objectstore-bench.md` — how to run it against AWS S3 or
   R2, what it measures, how to interpret the numbers against the MinIO floor, a results table
   left as TBD placeholders (no credentials available here), and a safety/cost note.
5. **Validate the new code path** against MinIO itself (point the new real-cloud env vars at a
   MinIO container) — this proves the `S3ObjectStore` path + cleanup work end-to-end against a
   real S3-compatible endpoint, without needing real AWS credentials.

## Non-goals

- No real numbers against AWS/R2 (no credentials in this sandbox) — the doc says so plainly.
- No change to the default (unset-env) MinIO behavior.
