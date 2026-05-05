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

/** `request*` re-requested inside `requestCooldownMs` of the last issue for this (email, flow). */
export class EmailCooldownError extends UserError {
  override readonly code = "EMAIL_COOLDOWN";
  constructor() { super("EMAIL_COOLDOWN"); }
}
/** Deployment-global `emailSendsPerMinute` cap tripped (spec decision 6). */
export class EmailThrottledError extends UserError {
  override readonly code = "EMAIL_THROTTLED";
  constructor() { super("EMAIL_THROTTLED"); }
}
/** An A2 function invoked while `email` config is absent — defensive; normally unregistered. */
export class EmailNotConfiguredError extends UserError {
  override readonly code = "EMAIL_NOT_CONFIGURED";
  constructor() { super("EMAIL_NOT_CONFIGURED"); }
}

/** An A4 (MFA) function invoked while `mfa` config is absent — defensive; normally unregistered. */
export class MfaNotConfiguredError extends UserError {
  override readonly code = "MFA_NOT_CONFIGURED";
  constructor() { super("MFA_NOT_CONFIGURED"); }
}
/** `startMfaEnrollment` called while a CONFIRMED enrollment already exists (must `disableMfa` first). */
export class MfaAlreadyEnrolledError extends UserError {
  override readonly code = "MFA_ALREADY_ENROLLED";
  constructor() { super("MFA_ALREADY_ENROLLED"); }
}
/** `confirmMfaEnrollment`/`disableMfa`/`regenerateRecoveryCodes` called with no enrollment row present. */
export class MfaNotEnrolledError extends UserError {
  override readonly code = "MFA_NOT_ENROLLED";
  constructor() { super("MFA_NOT_ENROLLED"); }
}
/** `startMfaEnrollment` called by an anonymous (never-upgraded) caller — anon users can't enroll. */
export class MfaAnonymousNotAllowedError extends UserError {
  override readonly code = "MFA_ANONYMOUS_NOT_ALLOWED";
  constructor() { super("MFA_ANONYMOUS_NOT_ALLOWED"); }
}
/** Review fix: `completeMfaSignIn`'s per-USER windowed second-factor rate limit tripped (spans
 *  challenges — see `MfaConfig.verifyAttemptsPerWindow`/`verifyWindowMs`). Reached only with a valid
 *  `pendingToken` (i.e. post-first-factor), so a distinct code here is not an enumeration oracle —
 *  it never distinguishes a right vs. wrong code, only "too many recent guesses for this user". */
export class MfaRateLimitedError extends UserError {
  override readonly code = "MFA_RATE_LIMITED";
  constructor() { super("MFA_RATE_LIMITED"); }
}
