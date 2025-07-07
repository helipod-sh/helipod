/**
 * Exponential backoff (with jitter) for a scheduler job's Nth failure. Pure and side-effect-free
 * so it's trivially unit-testable and safe to call from a deterministic mutation (`_complete` in
 * `./modules.ts`) — it takes its randomness as an injected `rng`, never touching `Math.random`
 * directly unless the caller passes none (the default, for callers outside a UDF's determinism
 * boundary — there are none in this codebase yet, but this keeps the function usable standalone).
 *
 * `_complete` passes `ctx.random` (the query/mutation guest ctx's seeded PRNG — see
 * `@stackbase/executor`'s `seeded-random.ts`), which is what actually gives the retry jitter its
 * determinism-for-replay property: a mutation and its OCC-conflict replay call `ctx.random()` in
 * the same sequence and get the same numbers, and tests get a computable, non-flaky result.
 */
export interface BackoffOptions {
  /** Backoff for the first retry (attempts=1), before jitter. */
  initialBackoffMs: number;
  /** Multiplier applied per additional attempt. */
  base: number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = { initialBackoffMs: 250, base: 2 };

/**
 * `attempts` is the failure count AFTER this failure is recorded (i.e. call with the
 * already-incremented `attempts`, not the pre-failure count) — so the first retry (attempts=1)
 * backs off `initialBackoffMs * base^2`, jittered to 50–100% of that.
 */
export function computeBackoff(
  attempts: number,
  rng: () => number = Math.random,
  o: BackoffOptions = DEFAULT_BACKOFF_OPTIONS,
): number {
  const raw = o.initialBackoffMs * o.base ** (attempts + 1);
  return Math.round(raw * (0.5 + 0.5 * rng())); // 50–100% jitter
}
