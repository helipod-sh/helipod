# Parked fleet benchmarks

These are benchmark scripts (not tests — renamed `*.bench.ts` so vitest's `*.test.ts` glob skips them),
relocated out of `test/` during the Phase-0 harness slice. They exercise the commercial `@helipod/fleet`
package and so stay under the EE license here rather than moving into the MIT `benchmarks/` tree.

They will be converted into `@helipod/bench` scenarios (write / scaled-write axes) when those axes are
activated. Until then, run one directly with vitest if needed:

    bun run --filter @helipod/fleet exec vitest run bench/overhead-pg.bench.ts
