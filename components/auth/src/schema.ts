import { defineSchema, defineTable, v } from "@stackbase/values";

export const authSchema = defineSchema({
  // `email` is optional now: anonymous users have none (spec §8). `anonymous` is a new optional
  // flag. The `byEmail` index remains for real (password) users.
  users: defineTable({ email: v.optional(v.string()), anonymous: v.optional(v.boolean()) }).index("byEmail", ["email"]),
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
});
