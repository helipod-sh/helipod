import { defineSchema, defineTable, v } from "@stackbase/values";

export const authSchema = defineSchema({
  // `email` is optional now: anonymous users have none (spec §8). `anonymous` is a new optional
  // flag. The `byEmail` index remains for real (password) users.
  users: defineTable({
    email: v.optional(v.string()),
    anonymous: v.optional(v.boolean()),
    emailVerified: v.optional(v.boolean()),    // A2: set true by magic/otp sign-in + verifyEmail
  }).index("byEmail", ["email"]),
  // Uniqueness of (provider, accountId) is enforced by the application-level duplicate guard
  // in signUp, which relies on single-writer OCC serialization. A multi-writer engine (Tier 2+)
  // will require a storage-level unique index on accounts(provider, accountId) to remain race-free.
  accounts: defineTable({
    userId: v.id("users"),
    provider: v.string(),
    accountId: v.string(), // for password: the email
    secret: v.string(),    // argon2id PHC string (legacy "salt:hash" scrypt accepted + rehashed on next login)
    failedAttempts: v.number(),
    lockedUntil: v.number(),
  }).index("byAccount", ["provider", "accountId"]),
  // A1 session model (spec "Schema"). ALL new fields optional at the storage layer for live-deploy
  // additivity; legacy pre-A1 rows keep only { userId, token, expiresAt } and resolve via `byToken`
  // until natural expiry. New mints store ONLY hashes (raw tokens never persisted).
  sessions: defineTable({
    userId: v.id("users"),
    token: v.optional(v.string()),            // legacy raw token — pre-A1 rows only
    tokenHash: v.optional(v.string()),        // SHA-256(access token), base64url
    expiresAt: v.number(),                    // access expiry: now + accessTtlMs
    refreshTokenHash: v.optional(v.string()), // SHA-256(current refresh token)
    prevRefreshTokenHash: v.optional(v.string()), // SHA-256(previous refresh token) — reuse detection
    refreshExpiresAt: v.optional(v.number()), // sliding: reset to now + refreshTtlMs on each rotation
    absoluteExpiresAt: v.optional(v.number()),// fixed at mint: mintTime + sessionTotalTtlMs — never slides
    deviceLabel: v.optional(v.string()),      // client-supplied (e.g. "Chrome on macOS")
    createdAt: v.optional(v.number()),
    lastRefreshAt: v.optional(v.number()),
  })
    .index("byToken", ["token"])
    .index("byTokenHash", ["tokenHash"])
    .index("byRefreshTokenHash", ["refreshTokenHash"])
    // Reuse detection is an INDEX lookup, never a table scan: a scan would make every garbage
    // refresh presentation an O(all-sessions) read inside the single-writer mutation AND widen its
    // OCC conflict range to the whole table — a DoS lever.
    .index("byPrevRefreshTokenHash", ["prevRefreshTokenHash"])
    // Per-user session ops (listSessions/revokeOtherSessions/upgrade) range over this, keeping the
    // reactive read-set scoped to ONE user's sessions instead of the whole table.
    .index("byUserId", ["userId"]),
  // Global anonymous-sign-in throttle (spec §12): a SINGLE counter row keyed by `name`. The
  // single-writer transactor makes contention a non-issue; a deployment-global window is used
  // because we carry no per-IP identifiers by design.
  authCounters: defineTable({ name: v.string(), windowStart: v.number(), count: v.number() }).index("byName", ["name"]),
  // A2 (spec "Schema"): one active hashed code per (email, flow). `byEmailFlow` is the natural key —
  // `_issueCode` overwrites the prior row through it (decision 2), redeems consume-before-validate.
  authCodes: defineTable({
    email: v.string(),      // normalized; the identity the code was issued for (cross-account guard, decision 9)
    flow: v.string(),       // "verify" | "reset" | "magic" | "otp"
    codeHash: v.string(),   // SHA-256 base64url of the raw code — never the raw code
    expiresAt: v.number(),
    attempts: v.number(),   // wrong-guess counter (OTP defense; commit-then-throw increments)
    createdAt: v.number(),  // also drives the request cooldown
  }).index("byEmailFlow", ["email", "flow"]),
  // A3 (spec Part 1). Single-use OAuth CSRF/PKCE state, TTL ~10min. `stateHash` = SHA-256(state)
  // (hashed at rest — we only COMPARE state). `codeVerifier`/`nonce` are stored RECOVERABLE (the
  // documented PKCE exception): PKCE requires re-sending the original verifier to the token endpoint,
  // so a hash won't do — safe as single-use, short-TTL, server-only, never-returned transaction secrets.
  oauthState: defineTable({
    stateHash: v.string(),
    provider: v.string(),
    codeVerifier: v.string(),
    nonce: v.optional(v.string()),
    redirectTo: v.string(),
    linkUserId: v.optional(v.id("users")),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("byStateHash", ["stateHash"]),
  // A3 (spec Part 1). Single-use mint AUTHORIZATION (holds NO session token), TTL ~2min. `handoffHash`
  // = SHA-256(handoff). The mint happens in `completeOAuthSignIn` (`_consumeHandoff`), tokens returned
  // directly to the app — A1's hashed-at-rest invariant preserved (no raw token ever written).
  oauthHandoff: defineTable({
    handoffHash: v.string(),
    userId: v.id("users"),
    deviceLabelHint: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("byHandoffHash", ["handoffHash"]),
  // A4 MFA/TOTP (spec "Schema", additive — no changes to any table above). One TOTP enrollment
  // per user in v1. `secretEncrypted` is ALWAYS the AES-256-GCM envelope from `mfa/secret-crypto.ts`
  // (`v1.<keyId>.<iv>.<ct>.<tag>`) — the raw secret is never persisted. `confirmedAt` absent means
  // enrollment is in-progress (started but not yet proven with a live code) and does NOT gate
  // sign-in; only a confirmed row does. `lastUsedStep` is the TOTP replay guard (decision 9).
  mfaEnrollments: defineTable({
    userId: v.id("users"),
    secretEncrypted: v.string(),
    algorithm: v.string(),
    digits: v.number(),
    period: v.number(),
    confirmedAt: v.optional(v.number()),
    lastUsedStep: v.optional(v.number()),
    createdAt: v.number(),
  }).index("byUserId", ["userId"]),
  // A4 MFA pending-sign-in state (spec decision 6, the `oauthHandoff` shape) — holds NO session
  // token, so it can never be mistaken for a live session by `authContext`. `challengeHash` =
  // sha256base64url(pendingToken); `failedAttempts` drives the `mfaAttempts` lockout
  // (commit-then-throw deletes the row at the limit, decision 10).
  mfaChallenges: defineTable({
    challengeHash: v.string(),
    userId: v.id("users"),
    deviceLabel: v.optional(v.string()),
    failedAttempts: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("byChallengeHash", ["challengeHash"])
    // Review fix: `finishSignIn` deletes a user's prior challenges via this range before inserting a
    // fresh one (caps live challenges at one per user, sweeps stale/expired rows) — never a table scan.
    .index("byUserId", ["userId"]),
  // A4 recovery codes (spec decision 7) — one row per code, hashed at rest
  // (`codeHash` = sha256base64url(rawCode)); consuming a code deletes its row.
  // `byUserCode` gives an O(1) consume-before-validate lookup by (userId, codeHash).
  mfaRecoveryCodes: defineTable({
    userId: v.id("users"),
    codeHash: v.string(),
    createdAt: v.number(),
  })
    .index("byUserId", ["userId"])
    .index("byUserCode", ["userId", "codeHash"]),
});
