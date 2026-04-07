/**
 * Exponential backoff (with jitter) for a failed email/SMS send's Nth retry. Pure — takes its
 * randomness as an injected `rng` so it's deterministic-for-replay when called with a mutation's
 * seeded `ctx.random` (a mutation and its OCC-conflict replay draw the same sequence). Copied from
 * `@stackbase/scheduler`'s `backoff.ts` to keep `@stackbase/notifications` self-contained (no
 * cross-component dependency), the same choice made for `compact`.
 */
export interface BackoffOptions {
  initialBackoffMs: number;
  base: number;
}

/** `attempts` is the failure count AFTER this failure is recorded (post-increment) — so the first
 *  retry (attempts=1) backs off `initialBackoffMs * base^2`, jittered to 50–100%. */
export function computeBackoff(
  attempts: number,
  rng: () => number,
  o: BackoffOptions,
): number {
  const raw = o.initialBackoffMs * o.base ** (attempts + 1);
  return Math.round(raw * (0.5 + 0.5 * rng()));
}
