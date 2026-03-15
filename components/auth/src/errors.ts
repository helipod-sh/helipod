import { UserError } from "@stackbase/errors";

/** Refresh presented the PREVIOUS refresh hash within the grace window — an honest racing-tab replay.
 *  No revocation; the loser waits for the winner's broadcast pair (spec decision 4). */
export class RefreshStaleError extends UserError {
  override readonly code = "REFRESH_STALE";
  constructor() {
    super("REFRESH_STALE");
  }
}

/** Refresh presented past `refreshExpiresAt` (sliding) OR past `absoluteExpiresAt` (the fixed 90d
 *  ceiling — spec decision 11). Terminal: the client clears its session and signs out. */
export class RefreshExpiredError extends UserError {
  override readonly code = "REFRESH_EXPIRED";
  constructor() {
    super("REFRESH_EXPIRED");
  }
}

/** `signInAnonymously` exceeded the deployment-global `anonymousSignInsPerMinute` throttle (spec §12). */
export class AnonymousThrottledError extends UserError {
  override readonly code = "ANONYMOUS_THROTTLED";
  constructor() {
    super("ANONYMOUS_THROTTLED");
  }
}
