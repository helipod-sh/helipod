# Auth slice A1 — session core hardening (implementation plan)

For agentic workers: use the `superpowers:subagent-driven-development` skill to execute this plan — each task below is an independently reviewable unit; dispatch one subagent per task, in order.

**Goal:** Upgrade `@stackbase/auth` from a single 30-day opaque bearer token to a hardened session core — short access tokens + rotating refresh tokens with reuse detection, hashed-at-rest tokens, session listing/revocation, anonymous auth with in-place upgrade, a single internal `mintSession` chokepoint, and a `createAuthClient` token-lifecycle manager — then correct the stale enduser auth doc.

**Architecture:** The auth component becomes `defineAuth(options?)` (following `defineScheduler`), whose module set is built by a `makeAuthModules(config)` factory closing over the resolved TTL config; every sign-in path mints through one internal `mintSession(ctx, config, userId, deviceLabel?)`. Tokens are stored only as SHA-256/base64url hashes; identity resolution stays a DB read inside the transaction (`byTokenHash`, legacy `byToken` fallback) so revocation remains instantly reactive through the existing read-set. The browser `createAuthClient` persists the mint result, schedules refresh at 80% of the access TTL, serializes rotation via Web Locks, and broadcasts the new pair to sibling tabs.

**Tech Stack:** TypeScript, Bun (runtime/pkg-manager), Turborepo, vitest under Node, `@stackbase/values`/`@stackbase/executor`/`@stackbase/component` engine seams, `@stackbase/errors` typed errors, `@stackbase/test` (`createTestStackbase`) for component tests, `node:crypto` for hashing, `hash-wasm` argon2id (unchanged).

## Global Constraints

Binding values copied verbatim from the design spec (`docs/superpowers/specs/2026-03-12-auth-session-core-design.md`). Do not relitigate these while implementing:

- **TTL defaults (config):** `accessTtlMs = 60*60*1000` (1h), `refreshTtlMs = 30*24*60*60*1000` (30d), `refreshGraceMs = 30_000` (30s), `sessionTotalTtlMs = 90*24*60*60*1000` (90d), `anonymousSignInsPerMinute = 60` (`0` disables). Config via `defineAuth(options?)`; `export const auth = defineAuth()` (defaults) — no breaking change for `stackbase.config.ts` files that compose `auth`.
- **Hashing:** tokens are hashed at rest with **SHA-256, base64url** (`createHash("sha256").update(token).digest("base64url")`). The DB stores only hashes after A1; raw tokens exist only in the client's hands. Legacy rows keep `{ token, expiresAt }` and resolve until natural expiry.
- **Rotation + reuse detection, per-session (the session row IS the family).** `refresh` rotates both hashes in place, remembers the previous refresh hash in `prevRefreshTokenHash`, slides `refreshExpiresAt = now + refreshTtlMs`, and updates `lastRefreshAt = now`. `absoluteExpiresAt` is fixed at mint (`mintTime + sessionTotalTtlMs`) and **NEVER slides**.
- **Grace window:** presented refresh == `prevRefreshTokenHash` AND `now - lastRefreshAt <= refreshGraceMs` → typed soft error `REFRESH_STALE`, **no revocation**. presented == `prevRefreshTokenHash` OUTSIDE the grace window → `REFRESH_REUSED`, thrown **after** the whole session row is deleted (**commit-then-throw** — the same mechanism the lockout counter uses; the theft response commits even though the call fails). Refresh presented with `now > refreshExpiresAt` → `REFRESH_EXPIRED`. Refresh presented with `now > absoluteExpiresAt` → `REFRESH_EXPIRED` (the ceiling, regardless of activity). Presented token matching NEITHER current nor previous hash → plain invalid (`invalid refresh token`).
- **Constant-time prev-hash compare — satisfied by construction:** spec decision 13's mandate covered "the one token comparison that happens in app code rather than via index lookup." In this plan reuse detection is a `byPrevRefreshTokenHash` **index equality lookup** (identical timing surface to the existing `byRefreshTokenHash` lookup), so no token comparison happens in app code at all and no `constantTimeEqual` helper ships. A full-table scan alternative was rejected: it would make every garbage-refresh presentation an O(all-sessions) read inside the single-writer mutation and widen its OCC conflict range to the entire table (a DoS lever).
- **Revoke = DELETE the session row** — no `revokedAt` tombstone. Delete is what keeps revocation reactive through the existing read-set.
- **`lastRefreshAt` updates only on refresh, never per-request** — per-request session writes would turn every authenticated query into write amplification.
- **Anonymous throttle:** `signInAnonymously` rejects when the caller's ambient identity already resolves to ANY user; global (deployment-wide) throttle via a **single counter row** capped at `anonymousSignInsPerMinute`, typed `ANONYMOUS_THROTTLED`.
- **Error code names** (cross the wire like other engine errors): `REFRESH_STALE`, `REFRESH_REUSED`, `REFRESH_EXPIRED`, `ANONYMOUS_THROTTLED`. `REFRESH_STALE`/`REFRESH_EXPIRED`/`ANONYMOUS_THROTTLED` are thrown as `UserError` subclasses (their `.code` rides `MutationResponse.code` — a non-retryable `StackbaseError`'s code is threaded onto the wire; see `packages/sync/src/handler.ts:735`). `REFRESH_REUSED` uses `commitThenThrow("REFRESH_REUSED")`, which surfaces as a plain `Error` whose **`.message` is the code string** (commit-then-throw carries no `.code`). Client detection therefore keys off `err.code ?? err.message` — and every auth error's message is set equal to its code so that check is uniform.
- **Additive-schema-only:** all new `sessions` fields are optional at the storage layer; `users.email` widens required→optional; `users.anonymous` is a new optional field; the throttle counter lives in a **new** table. Verified against the additive gate (`packages/cli/src/schema-diff.ts`): required→optional widening is accepted (strict `fieldType.type` equality holds; the `curV.optional && !nxtV.optional` reject-branch fires only optional→required), new optional fields are accepted, and a whole new table is accepted.
- **E2E through the real server:** the cross-package proof (`packages/cli/test/auth-session-e2e.test.ts`) drives a REAL `@stackbase/client` over a REAL WebSocket against a REAL `stackbase dev` server (`startDevServer` + `createEmbeddedRuntime`), per the e2e-through-shipped-entrypoint rule — not the loopback/mock harness.
- **Reference code is Apache-2.0 (`.reference/convex-auth`) / MIT (`.reference/better-auth`) — adapt with attribution comments, never copy FSL code.** Cite the adapted case in the test name/comment.
- **Build ordering / dist resolution:** tests run under Node/vitest; cross-package tests resolve deps via each package's built `dist/`. **After editing a dependency package, run `bun run build` (or `bun run --filter <pkg> build`) before running a dependent's tests** — editing a dep's `src` is a no-op for a dependent until the dep is rebuilt. Component functions get a deterministic `ctx.now()` (fixed per OCC attempt) — **never `Date.now()` in a query/mutation handler**.

Verification commands (package.json names confirmed: `@stackbase/auth`, `@stackbase/client`, `@stackbase/test`, `@stackbase/cli`):

```bash
bun run build                              # all packages, topological
bun run typecheck                          # all packages
bun run test                               # full vitest suite under Bun/Node
bun run --filter @stackbase/auth build
bun run --filter @stackbase/auth test
bun run --filter @stackbase/client build
bun run --filter @stackbase/client test
bun run --filter @stackbase/cli test
```

---

## Task 1 — Session model core

Schema (new optional session fields incl. `absoluteExpiresAt`, four new sessions indexes, `users.anonymous` + optional `email`, throttle table), crypto addition (`sha256base64url`), typed auth errors, `defineAuth(options?)` config following `defineScheduler`, internal `mintSession` chokepoint, `signUp`/`signIn` switched to mint pairs, `authContext.getUserId` + `auth:getUserId` byTokenHash with legacy byToken fallback, `signOut` accepting both token shapes.

### Files
- **Modify** `components/auth/src/schema.ts`
- **Modify** `components/auth/src/crypto.ts`
- **Create** `components/auth/src/errors.ts`
- **Create** `components/auth/src/config.ts`
- **Modify** `components/auth/src/functions.ts` (refactor to `makeAuthModules(config)` factory)
- **Modify** `components/auth/src/context.ts`
- **Modify** `components/auth/src/component.ts`
- **Modify** `components/auth/src/index.ts`
- **Modify** `components/auth/package.json` (add `@stackbase/test` devDependency)
- **Create** `components/auth/test/session-core.test.ts`

### Interfaces
- **Produces** `sha256base64url(input: string): string` (in `crypto.ts`).
- **Produces** `AuthConfig` and `resolveAuthConfig(opts?: AuthOptions): AuthConfig` (in `config.ts`).
- **Produces** `RefreshStaleError`, `RefreshExpiredError`, `AnonymousThrottledError` (in `errors.ts`, all `extends UserError`).
- **Produces** `makeAuthModules(config: AuthConfig): Record<string, RegisteredFunction>` and `mintSession(ctx, config, userId, deviceLabel?): Promise<MintResult>` (in `functions.ts`). `MintResult = { token: string; refreshToken: string; sessionId: string; userId: string; expiresAt: number }`.
- **Produces** `defineAuth(opts?: AuthOptions): ComponentDefinition`; `export const auth = defineAuth()` (in `component.ts`).
- **Consumes** `defineComponent`/`ComponentDefinition` (`@stackbase/component`), `mutation`/`query`/`commitThenThrow`/`ComponentContext` (`@stackbase/executor`), `UserError` (`@stackbase/errors`), `defineSchema`/`defineTable`/`v` (`@stackbase/values`), `createTestStackbase` (`@stackbase/test`).

### Steps

- [ ] **Rewrite `components/auth/src/schema.ts`** with the new additive shape (new fields optional; `users.email` optional; `users.anonymous` optional; new `byTokenHash`/`byRefreshTokenHash` indexes; new `authCounters` table for the global throttle):

```ts
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
```

- [ ] **Append to `components/auth/src/crypto.ts`** the hashing helper (add `createHash` to the existing `node:crypto` import; `timingSafeEqual` stays imported — `verifyScryptLegacy` still uses it). No `constantTimeEqual` helper is added: reuse detection resolves via the `byPrevRefreshTokenHash` index equality lookup (see Task 2), so there is no token comparison in app code at all — spec decision 13's constant-time mandate is satisfied by construction. Change the import line and append at the end:

Old (line 2):
```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
```
New:
```ts
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
```

Append after `generateToken`:
```ts
/** SHA-256 of `input`, base64url-encoded — how session tokens are hashed at rest (spec decision 2). */
export function sha256base64url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}
```

- [ ] **Create `components/auth/src/errors.ts`** — typed auth errors (message set equal to code so client `err.code ?? err.message` matching is uniform):

```ts
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
```

- [ ] **Create `components/auth/src/config.ts`** — the resolved config type + defaults (mirrors `defineScheduler(opts?)`'s config-value convention):

```ts
/** Auth component configuration (spec "Component surface"). All fields have defaults; a project
 *  overrides any subset via `defineAuth({ ... })`. */
export interface AuthConfig {
  /** Access-token lifetime (default 1h). Bounds how long a stolen access token is usable. */
  accessTtlMs: number;
  /** Refresh-token lifetime, sliding on each rotation (default 30d). */
  refreshTtlMs: number;
  /** Grace window: a previous-hash replay within this of `lastRefreshAt` is a soft `REFRESH_STALE`,
   *  not a theft signal (default 30s). */
  refreshGraceMs: number;
  /** Absolute session ceiling, fixed at mint, never slides (default 90d). */
  sessionTotalTtlMs: number;
  /** Deployment-global cap on anonymous user creation per minute; `0` disables anonymous throttling
   *  (default 60). */
  anonymousSignInsPerMinute: number;
}

export type AuthOptions = Partial<AuthConfig>;

const DEFAULTS: AuthConfig = {
  accessTtlMs: 60 * 60 * 1000,
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  refreshGraceMs: 30_000,
  sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000,
  anonymousSignInsPerMinute: 60,
};

export function resolveAuthConfig(opts?: AuthOptions): AuthConfig {
  return { ...DEFAULTS, ...(opts ?? {}) };
}
```

- [ ] **Rewrite `components/auth/src/functions.ts`** as a `makeAuthModules(config)` factory. Task 1 implements `signUp` (plain — no upgrade branch yet), `signIn`, `signOut`, `getUserId`, plus the internal `mintSession` chokepoint and the shared `resolveSession` helper. `refresh`/`signInAnonymously`/`listSessions`/`revokeSession`/`revokeOtherSessions` are added by later tasks into this same factory (their edits show exact old/new blocks). Full file:

```ts
import { mutation, query, commitThenThrow, type ComponentContext, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import { hashSecret, verifySecret, needsRehash, generateToken, sha256base64url } from "./crypto";
import type { AuthConfig } from "./config";

export const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

interface Creds { email: string; password: string; deviceLabel?: string }

/** The mint result every sign-in path returns (spec "Internal chokepoint"). A superset of the pre-A1
 *  `{ token, userId }`, so existing callers keep working. */
export interface MintResult {
  token: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Drop keys whose value is `undefined` — the syscall codec (`convexToJson`, see
 *  `GuestDatabaseWriter.insert/replace`) rejects `undefined`; omit rather than null it out.
 *  Same shape as `components/scheduler/src/facade.ts`'s `compact` (typed identically so the result
 *  stays assignable wherever the input was). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** Any ctx with a writable `db` and deterministic `now()` — a mutation ctx or the component cctx.
 *  Kept structural so `mintSession` is callable from both the app-facing `MutationCtx` and internal
 *  helpers. */
type WriteCtx = { db: MutationCtx["db"]; now(): number };

/** THE single internal chokepoint (spec decision + "Internal chokepoint"): generate both raw tokens,
 *  store ONLY hashes, return the raw pair to the caller. `signUp`/`signIn`/`signInAnonymously`/
 *  `refresh` (and A2/A3 flows) all mint through here. NOT a public module. */
export async function mintSession(
  ctx: WriteCtx,
  config: AuthConfig,
  userId: string,
  deviceLabel?: string,
): Promise<MintResult> {
  const token = generateToken();
  const refreshToken = generateToken();
  const now = ctx.now();
  const expiresAt = now + config.accessTtlMs;
  const sessionId = (await ctx.db.insert(
    "sessions",
    compact({
      userId,
      tokenHash: sha256base64url(token),
      expiresAt,
      refreshTokenHash: sha256base64url(refreshToken),
      refreshExpiresAt: now + config.refreshTtlMs,
      absoluteExpiresAt: now + config.sessionTotalTtlMs,
      deviceLabel,
      createdAt: now,
      lastRefreshAt: now,
    }),
  )) as string;
  return { token, refreshToken, sessionId, userId, expiresAt };
}

/** Resolve a presented ACCESS token to its live session row: `byTokenHash` first, legacy `byToken`
 *  fallback for pre-A1 rows (spec "Legacy compatibility"). Returns the row (regardless of expiry —
 *  callers check `expiresAt`) or null. Reads land in the read-set, so revocation stays reactive. */
export async function resolveSession(
  db: ComponentContext["db"],
  token: string,
): Promise<Record<string, unknown> | null> {
  const tokenHash = sha256base64url(token);
  const [byHash] = await db.query("sessions", "byTokenHash").eq("tokenHash", tokenHash).collect();
  if (byHash) return byHash as Record<string, unknown>;
  const [legacy] = await db.query("sessions", "byToken").eq("token", token).collect();
  return (legacy as Record<string, unknown>) ?? null;
}

/** Build the auth module set closing over `config`. `defineAuth` calls this (spec decision 10). */
export function makeAuthModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const signUp = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult> => {
    const normEmail = normalizeEmail(email);
    // Duplicate guard relies on single-writer OCC serialization — see schema.ts comment.
    const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    if (existing.length > 0) throw new Error("an account with that email already exists");
    const userId = await ctx.db.insert("users", { email: normEmail }) as string;
    await ctx.db.insert("accounts", {
      userId, provider: "password", accountId: normEmail,
      secret: await hashSecret(password),
      failedAttempts: 0, lockedUntil: 0,
    });
    return mintSession(ctx, config, userId, deviceLabel);
  });

  const signIn = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    const normEmail = normalizeEmail(email);
    const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    if (!account) throw new Error("invalid credentials");

    // Lockout gate — checked before password verification so timing does not leak validity.
    if (ctx.now() < (account.lockedUntil as number)) {
      throw new Error("too many attempts — account temporarily locked");
    }

    if (typeof account.secret !== "string" || !(await verifySecret(password, account.secret))) {
      // Persist the failure counter via commit-then-throw (writes only commit on a normal return).
      const failedAttempts = (account.failedAttempts as number) + 1;
      const lockedUntil = failedAttempts >= MAX_ATTEMPTS ? ctx.now() + LOCK_MS : (account.lockedUntil as number);
      await ctx.db.replace(account._id as string, { ...account, failedAttempts, lockedUntil });
      return commitThenThrow("invalid credentials");
    }

    // Success: reset counters, rehashing a legacy secret in the same replace.
    const next = { ...account, failedAttempts: 0, lockedUntil: 0 } as typeof account;
    if (needsRehash(account.secret as string)) next.secret = await hashSecret(password);
    await ctx.db.replace(account._id as string, next);

    return mintSession(ctx, config, account.userId as string, deviceLabel);
  });

  const signOut = mutation(async (ctx, { token }: { token: string }) => {
    const session = await resolveSession(ctx.db, token);
    if (session) await ctx.db.delete(session._id as string);
    return null;
  });

  const getUserId = query(async (ctx, { token }: { token: string }): Promise<string | null> => {
    const session = await resolveSession(ctx.db, token);
    if (!session || ctx.now() > (session.expiresAt as number)) return null;
    return session.userId as string;
  });

  return { signUp, signIn, signOut, getUserId };
}
```

Note for later tasks: `ctx.db` inside these mutation handlers is a full writer; `mintSession`'s `WriteCtx` type accepts it. `resolveSession` takes the read-capable `ComponentContext["db"]` so `context.ts` can reuse it.

- [ ] **Rewrite `components/auth/src/context.ts`** to resolve via `byTokenHash` + legacy fallback (reuse `resolveSession`):

```ts
import type { ComponentContext } from "@stackbase/executor";
import { resolveSession } from "./functions";

export interface AuthContext {
  getUserId(): Promise<string | null>;
}

/** ctx.auth — resolves the ambient session token to the current user's id. Reads the session row
 *  (byTokenHash, legacy byToken fallback) INSIDE the transaction, so it enters the read-set and a
 *  revoke (row delete) invalidates every subscribed query reactively (spec decision 1). */
export function authContext(cctx: ComponentContext): AuthContext {
  return {
    getUserId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const session = await resolveSession(cctx.db, token);
      if (!session || cctx.now > (session.expiresAt as number)) return null;
      return session.userId as string;
    },
  };
}
```

- [ ] **Rewrite `components/auth/src/component.ts`** to `defineAuth(opts?)`:

```ts
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { authSchema } from "./schema";
import { makeAuthModules } from "./functions";
import { authContext } from "./context";
import { resolveAuthConfig, type AuthOptions } from "./config";

/**
 * `defineAuth(options?)` — the `@stackbase/auth` component: password + hardened session auth. The
 * module set is built by `makeAuthModules(config)` closing over the resolved TTL config (spec
 * decision 10), following `defineScheduler`'s config-value convention. `ctx.auth.getUserId()`
 * resolves the ambient session token to a user id inside the transaction (read-set → reactive
 * revocation). `context` only reads, so no `contextWrite`.
 */
export function defineAuth(options?: AuthOptions): ComponentDefinition {
  const config = resolveAuthConfig(options);
  return defineComponent({
    name: "auth",
    schema: authSchema,
    modules: makeAuthModules(config),
    context: authContext,
    contextType: { import: "@stackbase/auth", type: "AuthContext" },
  });
}

/** The default-config component — unchanged import for `stackbase.config.ts` files composing `auth`. */
export const auth = defineAuth();
```

- [ ] **Update `components/auth/src/index.ts`** to export the new surface:

```ts
export * from "./crypto";
export * from "./schema";
export * from "./errors";
export type { AuthConfig, AuthOptions } from "./config";
export { resolveAuthConfig } from "./config";
export type { MintResult } from "./functions";
export { makeAuthModules, mintSession, resolveSession, normalizeEmail } from "./functions";
export { auth, defineAuth } from "./component";
export { authContext } from "./context";
export type { AuthContext } from "./context";
```

- [ ] **Add `@stackbase/test` to `components/auth/package.json` devDependencies** (needed by the new tests; `@stackbase/test` does NOT depend on `@stackbase/auth`, so no cycle). Edit the `devDependencies` block:

Old:
```json
  "devDependencies": {
    "@stackbase/docstore-sqlite": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*",
    "@types/node": "catalog:", "tsup": "catalog:", "typescript": "catalog:", "vitest": "catalog:"
  }
```
New:
```json
  "devDependencies": {
    "@stackbase/docstore-sqlite": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*",
    "@stackbase/test": "workspace:*",
    "@types/node": "catalog:", "tsup": "catalog:", "typescript": "catalog:", "vitest": "catalog:"
  }
```

- [ ] **Run `bun install`** to link the new workspace devDependency. Expected: completes with no error; `components/auth/node_modules/@stackbase/test` resolves.

- [ ] **Build the changed packages** so the test can resolve `@stackbase/auth` via its `dist`: `bun run --filter @stackbase/auth build`. Expected: tsup emits `dist/index.js` + `dist/index.d.ts` with no type error.

- [ ] **Create `components/auth/test/session-core.test.ts`** — component tests over the real engine via `createTestStackbase`. Inspects rows via the privileged `t.run` reading the namespaced `auth/sessions` table:

```ts
import { describe, it, expect } from "vitest";
import { query } from "@stackbase/executor";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, sha256base64url, type MintResult } from "../src"; // auth's own tests import via src (existing idiom — no dist rebuild needed)

// A protected query proving `ctx.auth` resolves the ambient identity (used for the legacy-fallback
// resolution check). `ctx` is `any` here to avoid leaking internal ctx types.
const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  whoami: { get: query(async (ctx: any) => ctx.auth.getUserId() as Promise<string | null>) },
};

async function harness(): Promise<TestStackbase> {
  return createTestStackbase({ modules: appModules, components: [defineAuth()], schema: false });
}

describe("auth A1: session model core", () => {
  it("signUp mints a hashed pair (token/refreshToken/sessionId/expiresAt/userId)", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(typeof r.token).toBe("string");
      expect(typeof r.refreshToken).toBe("string");
      expect(typeof r.sessionId).toBe("string");
      expect(typeof r.userId).toBe("string");
      expect(r.token).not.toEqual(r.refreshToken);
      expect(typeof r.expiresAt).toBe("number");
    } finally {
      await t.close();
    }
  });

  it("stores tokens hashed at rest — no raw token appears in any session row", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await t.run(async (ctx: any) => ctx.db.query("auth/sessions", "by_creation").collect())) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.token).toBeUndefined();                       // new mints never store the raw token
      expect(row.tokenHash).toBe(sha256base64url(r.token));    // stored as SHA-256/base64url
      expect(row.refreshTokenHash).toBe(sha256base64url(r.refreshToken));
      expect(row.tokenHash).not.toBe(r.token);                 // hash != raw
      expect(typeof row.absoluteExpiresAt).toBe("number");     // ceiling recorded at mint
      expect(row.lastRefreshAt).toBe(row.createdAt);           // set at mint
    } finally {
      await t.close();
    }
  });

  it("resolves a live token and null after signOut; accepts both new and legacy token shapes", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(await t.query("auth:getUserId", { token: r.token })).toBe(r.userId);
      await t.mutation("auth:signOut", { token: r.token });
      expect(await t.query("auth:getUserId", { token: r.token })).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("legacy fallback: a pre-A1 row { userId, token, expiresAt } still resolves via byToken", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const legacyToken = "legacy-raw-token-xyz";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await t.run(async (ctx: any) => {
        await ctx.db.insert("auth/sessions", { userId: r.userId, token: legacyToken, expiresAt: ctx.now() + 60_000 });
      });
      // Resolves through ctx.auth (context.ts legacy path) AND the auth:getUserId module.
      expect(await t.withIdentity(legacyToken).query("whoami:get")).toBe(r.userId);
      expect(await t.query("auth:getUserId", { token: legacyToken })).toBe(r.userId);
    } finally {
      await t.close();
    }
  });

  it("signIn verifies the password (fresh pair, same userId) and rejects a wrong one", async () => {
    const t = await harness();
    try {
      const up = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const inR = (await t.mutation("auth:signIn", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(inR.userId).toBe(up.userId);
      expect(inR.token).not.toBe(up.token);
      await expect(t.mutation("auth:signIn", { email: "a@b.co", password: "WRONG" })).rejects.toThrow(/invalid credentials/i);
    } finally {
      await t.close();
    }
  });
});
```

- [ ] **Run the Task 1 tests**: `bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Expected: all `session-core.test.ts` cases pass; the pre-existing auth tests either pass unchanged (`crypto.test.ts`, `sign-up-in.test.ts` — signUp/signIn still return `{token,userId,...}`) or are updated in a later task if they assert the removed byToken-only storage. If `sign-up-in.test.ts`/`session-flow.test.ts`/`ctx-auth.test.ts`/`expiry.test.ts` fail only because they construct the component via `EmbeddedRuntime` + the old `auth` export, they keep working (the `auth` export still exists); no change expected. Fix any genuine breakage inline before committing.

- [ ] **Typecheck**: `bun run --filter @stackbase/auth typecheck`. Expected: clean.

- [ ] **Commit**:
```
git add components/auth
git commit -m "feat(auth): A1 session model core — hashed pairs, mintSession chokepoint, defineAuth config"
```

---

## Task 2 — refresh (rotation + reuse detection)

Add the `refresh` module to `makeAuthModules`: rotation in place, `prevRefreshTokenHash` reuse detection via a `byPrevRefreshTokenHash` index equality lookup (constant-time by construction — no app-code compare), 30s grace → `REFRESH_STALE`, outside-grace → `REFRESH_REUSED` via commit-then-throw whole-session delete, sliding `refreshExpiresAt`, `absoluteExpiresAt` ceiling → `REFRESH_EXPIRED`.

### Files
- **Modify** `components/auth/src/functions.ts`
- **Create** `components/auth/test/refresh.test.ts`

### Interfaces
- **Produces** `auth:refresh` module — `refresh(refreshToken: string): MintResult` (mint-shaped, SAME `sessionId`).
- **Consumes** `RefreshStaleError`/`RefreshExpiredError` (`./errors`), `sha256base64url` (`./crypto`), the `byPrevRefreshTokenHash` index (Task 1 schema), `commitThenThrow` (already imported), `mintSession` (Task 1).

Note: `refresh` rotates the EXISTING row (never inserts a new one), so it does NOT go through `mintSession` (which inserts). It generates a fresh pair inline and `replace`s the row, then returns the mint-shaped result for the same `sessionId`.

### Steps

- [ ] **Edit the imports in `components/auth/src/functions.ts`** to bring in the error classes and crypto helpers:

Old:
```ts
import { hashSecret, verifySecret, needsRehash, generateToken, sha256base64url } from "./crypto";
import type { AuthConfig } from "./config";
```
New:
```ts
import { hashSecret, verifySecret, needsRehash, generateToken, sha256base64url } from "./crypto";
import type { AuthConfig } from "./config";
import { RefreshStaleError, RefreshExpiredError } from "./errors";
```

- [ ] **Add the `refresh` module inside `makeAuthModules`**, immediately before the `return { ... }` line. Insert:

```ts
  const refresh = mutation(async (ctx, { refreshToken }: { refreshToken: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    const presentedHash = sha256base64url(refreshToken);
    const now = ctx.now();

    // Fast path: the presented token is the session's CURRENT refresh token → rotate in place.
    const [current] = await ctx.db.query("sessions", "byRefreshTokenHash").eq("refreshTokenHash", presentedHash).collect();
    if (current) {
      // Ceiling (spec decision 11): the absolute cap never slides — an actively-refreshing session
      // still dies at it. Legacy rows (no absoluteExpiresAt) skip the ceiling check.
      const absolute = current.absoluteExpiresAt as number | undefined;
      const refreshExpires = current.refreshExpiresAt as number | undefined;
      if (absolute !== undefined && now > absolute) throw new RefreshExpiredError();
      if (refreshExpires !== undefined && now > refreshExpires) throw new RefreshExpiredError();

      const newToken = generateToken();
      const newRefresh = generateToken();
      // `compact` strips the `token: undefined` key: the syscall codec rejects `undefined`, and
      // omitting the key is what actually DROPS a legacy raw token on first rotation.
      await ctx.db.replace(current._id as string, compact({
        ...current,
        tokenHash: sha256base64url(newToken),
        expiresAt: now + config.accessTtlMs,
        prevRefreshTokenHash: current.refreshTokenHash,   // remember old hash for reuse detection
        refreshTokenHash: sha256base64url(newRefresh),
        refreshExpiresAt: now + config.refreshTtlMs,       // slide
        lastRefreshAt: now,
        // absoluteExpiresAt intentionally NOT touched — fixed at mint.
        token: undefined,                                   // legacy raw token dropped (key stripped)
      }));
      return {
        token: newToken,
        refreshToken: newRefresh,
        sessionId: current._id as string,
        userId: current.userId as string,
        expiresAt: now + config.accessTtlMs,
      };
    }

    // Not the current token: is it the PREVIOUS refresh token of some session? (reuse detection)
    // A single `byPrevRefreshTokenHash` INDEX equality lookup — never a table scan. A full scan
    // would make every garbage-refresh presentation an O(all-sessions) read inside the single-writer
    // mutation AND widen its OCC conflict range to the entire table — a DoS lever. The index lookup
    // has the identical timing surface as the `byRefreshTokenHash` lookup above, so spec decision
    // 13's constant-time mandate (which covered "the one token comparison in app code") is
    // satisfied by construction: with the index there IS no app-code compare.
    const [reused] = await ctx.db.query("sessions", "byPrevRefreshTokenHash").eq("prevRefreshTokenHash", presentedHash).collect();
    if (reused) {
      const lastRefreshAt = (reused.lastRefreshAt as number | undefined) ?? 0;
      if (now - lastRefreshAt <= config.refreshGraceMs) {
        // Honest racing tab lost to its sibling: soft error, NO revocation (spec decision 4). The
        // client waits for the winner's broadcast pair.
        throw new RefreshStaleError();
      }
      // Outside the grace window: theft signal. DELETE the whole session row (spec decision 3/6) and
      // commit-then-throw so the revocation COMMITS even though this call fails (the same mechanism
      // the lockout counter uses). `REFRESH_REUSED` rides the wire as the error MESSAGE (commit-then-
      // throw carries no `.code`).
      await ctx.db.delete(reused._id as string);
      return commitThenThrow("REFRESH_REUSED");
    }

    // Matches neither current nor previous hash → plain invalid.
    throw new Error("invalid refresh token");
  });
```

- [ ] **Add `refresh` to the returned module map**:

Old:
```ts
  return { signUp, signIn, signOut, getUserId };
```
New:
```ts
  return { signUp, signIn, signOut, getUserId, refresh };
```

- [ ] **Create `components/auth/test/refresh.test.ts`** — rotation happy path, grace, reuse, expiry (sliding + absolute ceiling), and the two divergence-pinning tests:

```ts
import { describe, it, expect } from "vitest";
import { query } from "@stackbase/executor";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, type MintResult } from "../src";

const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  whoami: { get: query(async (ctx: any) => ctx.auth.getUserId() as Promise<string | null>) },
};

// Harness with the harness-owned virtual clock (omit `now`) so `t.advanceTimers` moves auth time.
async function harness(opts?: Parameters<typeof defineAuth>[0]): Promise<TestStackbase> {
  return createTestStackbase({ modules: appModules, components: [defineAuth(opts)], schema: false });
}

const GRACE = 30_000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;

describe("auth A1: refresh rotation + reuse detection", () => {
  it("rotates in place: same sessionId, fresh usable pair, old access token stops resolving", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.advanceTimers(1000);
      const b = (await t.mutation("auth:refresh", { refreshToken: a.refreshToken })) as MintResult;
      expect(b.sessionId).toBe(a.sessionId);          // SAME session row (rotation in place)
      expect(b.token).not.toBe(a.token);
      expect(b.refreshToken).not.toBe(a.refreshToken);
      // The new access token resolves; identity continuity holds.
      expect(await t.query("auth:getUserId", { token: b.token })).toBe(a.userId);
      // The old access token no longer resolves (its hash was overwritten).
      expect(await t.query("auth:getUserId", { token: a.token })).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("reuse INSIDE grace returns REFRESH_STALE without revoking (adapted-by-inversion from convex-auth sessions.test.ts \"refresh token reuse with racing requests\")", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:refresh", { refreshToken: a.refreshToken })) as MintResult;
      await t.advanceTimers(GRACE - 5000);            // within the 30s window
      // Presenting the OLD refresh token again (== prevRefreshTokenHash) inside grace → soft error.
      await expect(t.mutation("auth:refresh", { refreshToken: a.refreshToken })).rejects.toThrow(/REFRESH_STALE/);
      // NOT revoked: the winner's current pair (b) still works.
      const c = (await t.mutation("auth:refresh", { refreshToken: b.refreshToken })) as MintResult;
      expect(c.sessionId).toBe(a.sessionId);
    } finally {
      await t.close();
    }
  });

  it("DIVERGENCE PIN — reuse OUTSIDE grace kills the WHOLE session (opposite of convex-auth sessions.test.ts \"refresh token invalidate subtree\"): NO surviving usable token after theft", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:refresh", { refreshToken: a.refreshToken })) as MintResult;
      await t.advanceTimers(GRACE + 5000);            // past the window
      // Presenting the stolen OLD refresh token outside grace → REFRESH_REUSED, and the session row
      // is DELETED (commit-then-throw), so the throw is surfaced AFTER the revocation commits.
      await expect(t.mutation("auth:refresh", { refreshToken: a.refreshToken })).rejects.toThrow(/REFRESH_REUSED/);
      // Whole-session death: the winner's still-current token `b` is now ALSO dead — unlike convex-auth,
      // where the untouched sibling would survive. Nobody "fixes" this toward subtree survival.
      await expect(t.mutation("auth:refresh", { refreshToken: b.refreshToken })).rejects.toThrow(/invalid refresh token/);
      expect(await t.query("auth:getUserId", { token: b.token })).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await t.run(async (ctx: any) => ctx.db.query("auth/sessions", "by_creation").collect())) as unknown[];
      expect(rows.length).toBe(0);                    // the family (the one row) is gone
    } finally {
      await t.close();
    }
  });

  it("DIVERGENCE PIN — the racing loser gets REFRESH_STALE, NEVER a fresh usable pair (opposite of convex-auth fork/replay; foreclosed by hashed-at-rest)", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.mutation("auth:refresh", { refreshToken: a.refreshToken });
      await t.advanceTimers(1000);                    // still within grace
      // The loser's replay resolves to a THROW, not a MintResult — assert the shape by catching.
      let threw: unknown;
      try {
        await t.mutation("auth:refresh", { refreshToken: a.refreshToken });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(Error);
      expect(String((threw as Error).message)).toContain("REFRESH_STALE");
    } finally {
      await t.close();
    }
  });

  it("expired refresh past the sliding window → REFRESH_EXPIRED (adapted from convex-auth sessions.test.ts \"refresh token expiration\")", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.advanceTimers(REFRESH_TTL + 60_000);    // past refreshExpiresAt
      await expect(t.mutation("auth:refresh", { refreshToken: a.refreshToken })).rejects.toThrow(/REFRESH_EXPIRED/);
    } finally {
      await t.close();
    }
  });

  it("absolute ceiling: an actively-refreshing session still dies at absoluteExpiresAt (spec decision 11)", async () => {
    // 90d ceiling; keep refreshing every ~29d so the sliding window never lapses — the absolute cap
    // must still terminate the session.
    const t = await harness({ sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000 });
    try {
      let cur = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const step = 29 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < 3; i++) {                   // ~87d of active refreshing — under the ceiling
        await t.advanceTimers(step);
        cur = (await t.mutation("auth:refresh", { refreshToken: cur.refreshToken })) as MintResult;
      }
      await t.advanceTimers(step);                    // now ~116d total — PAST the 90d ceiling
      await expect(t.mutation("auth:refresh", { refreshToken: cur.refreshToken })).rejects.toThrow(/REFRESH_EXPIRED/);
    } finally {
      await t.close();
    }
  });
});
```

- [ ] **Run**: `bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Expected: `refresh.test.ts` and Task 1 tests pass.

- [ ] **Typecheck**: `bun run --filter @stackbase/auth typecheck`. Expected: clean.

- [ ] **Commit**:
```
git add components/auth
git commit -m "feat(auth): A1 refresh — rotation, reuse detection, grace, absolute ceiling"
```

---

## Task 3 — session management + anonymous

`listSessions`/`revokeSession`/`revokeOtherSessions` (ownership checks, `current` flag, no hash material returned); `signInAnonymously` (+already-authed rejection, global `anonymousSignInsPerMinute` throttle via a single counter row); `signUp` upgrade path (same userId, clear `anonymous`, delete ALL sessions, fresh mint).

### Files
- **Modify** `components/auth/src/functions.ts`
- **Create** `components/auth/test/sessions-anon.test.ts`

### Interfaces
- **Produces** modules `auth:signInAnonymously(deviceLabel?): MintResult`, `auth:listSessions(): SessionSummary[]`, `auth:revokeSession(sessionId): null`, `auth:revokeOtherSessions(): null`. `SessionSummary = { sessionId, deviceLabel, createdAt, lastRefreshAt, current }` — never any hash material.
- **Produces** `AuthContext.getSessionId(): Promise<string | null>` — the ambient caller's own session row id (null when unauthenticated/expired). Added to `context.ts`.
- **Modifies** `auth:signUp` to add the anonymous-upgrade branch.
- **Consumes** `AnonymousThrottledError` (`./errors`), `resolveSession`/`mintSession` (Task 1), and **the `ctx.auth` facade for ambient identity**. Verified against source: the guest handler ctx (`packages/executor/src/executor.ts:581-624`) carries `db`/`random`/`now` plus every context-provider facade — there is **no `ctx.identity`** on `MutationCtx`/`QueryCtx` (`packages/executor/src/guest.ts:136-145`). The ambient `SetAuth` token reaches user code only through a provider's `build({ identity })`. Context providers are attached to EVERY function's ctx (no namespace exclusion), so auth's own modules see `ctx.auth` too — the ownership functions therefore read the caller's session via a new `ctx.auth.getSessionId()`, then `ctx.db.get(sessionId)` for the row (both reads land in the read-set, keeping revocation reactive). When no providers are composed (bare `EmbeddedRuntime` unit setups), `ctx.auth` is absent and the modules treat the caller as unauthenticated (optional-chained).

### Steps

- [ ] **Add `getSessionId` to `components/auth/src/context.ts`** (the ambient caller's own session row id — what the ownership functions key on):

Old:
```ts
export interface AuthContext {
  getUserId(): Promise<string | null>;
}
```
New:
```ts
export interface AuthContext {
  getUserId(): Promise<string | null>;
  /** The ambient caller's own session row id (for `listSessions`' `current` flag, revocation
   *  ownership, and the anonymous-upgrade branch) — null when unauthenticated or expired. */
  getSessionId(): Promise<string | null>;
}
```

Old:
```ts
    getUserId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const session = await resolveSession(cctx.db, token);
      if (!session || cctx.now > (session.expiresAt as number)) return null;
      return session.userId as string;
    },
```
New:
```ts
    getUserId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const session = await resolveSession(cctx.db, token);
      if (!session || cctx.now > (session.expiresAt as number)) return null;
      return session.userId as string;
    },
    getSessionId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const session = await resolveSession(cctx.db, token);
      if (!session || cctx.now > (session.expiresAt as number)) return null;
      return session._id as string;
    },
```

- [ ] **Edit the imports in `components/auth/src/functions.ts`** to add the throttle error:

Old:
```ts
import { RefreshStaleError, RefreshExpiredError } from "./errors";
```
New:
```ts
import { RefreshStaleError, RefreshExpiredError, AnonymousThrottledError } from "./errors";
```

- [ ] **Add a shared `currentSessionOf` helper and the `SessionSummary` type** near the top of `functions.ts` (after `resolveSession`):

```ts
/** A session as surfaced to `listSessions` — NEVER any hash/token material (spec "Component surface"). */
export interface SessionSummary {
  sessionId: string;
  deviceLabel: string | null;
  createdAt: number | null;
  lastRefreshAt: number | null;
  current: boolean;
}

/** The `ctx.auth` facade as visible from inside auth's own modules (context providers are attached
 *  to every function's ctx — including a component's own). Absent when no providers were composed
 *  (bare EmbeddedRuntime unit setups) → treated as unauthenticated. */
type FacadeCtx = { db: MutationCtx["db"] | QueryCtx["db"]; auth?: { getSessionId(): Promise<string | null> } };

/** The ambient caller's own session row, or null when unauthenticated/expired. Resolves the id via
 *  the `ctx.auth` facade (the only channel the ambient identity reaches user code), then reads the
 *  row through the module's own db so the read lands in the calling function's read-set. */
async function currentSessionOf(ctx: FacadeCtx): Promise<Record<string, unknown> | null> {
  const sessionId = await ctx.auth?.getSessionId();
  if (!sessionId) return null;
  return ((await ctx.db.get(sessionId)) as Record<string, unknown> | null) ?? null;
}
```

Also extend the executor type import at the top of `functions.ts` (needed by `FacadeCtx`):

Old:
```ts
import { mutation, query, commitThenThrow, type ComponentContext, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
```
New:
```ts
import { mutation, query, commitThenThrow, type ComponentContext, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@stackbase/executor";
```

- [ ] **Add `signInAnonymously`, `listSessions`, `revokeSession`, `revokeOtherSessions` inside `makeAuthModules`**, before the `return { ... }`. Insert:

```ts
  const signInAnonymously = mutation(async (ctx, { deviceLabel }: { deviceLabel?: string }): Promise<MintResult> => {
    // Reject if the caller already resolves to ANY user (spec §12 — prevents anon churn from
    // signed-in callers). Adapted from better-auth anon.test.ts "should reject subsequent anonymous
    // sign-in attempts once signed in".
    const existing = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (existing) throw new Error("already authenticated — sign out before signing in anonymously");

    // Deployment-global throttle via a single counter row (spec §12). `0` disables.
    if (config.anonymousSignInsPerMinute > 0) {
      const now = ctx.now();
      const [counter] = await ctx.db.query("authCounters", "byName").eq("name", "anonymousSignIns").collect();
      const windowMs = 60_000;
      if (!counter) {
        await ctx.db.insert("authCounters", { name: "anonymousSignIns", windowStart: now, count: 1 });
      } else {
        const windowStart = counter.windowStart as number;
        const count = counter.count as number;
        if (now - windowStart >= windowMs) {
          await ctx.db.replace(counter._id as string, { ...counter, windowStart: now, count: 1 }); // new window
        } else if (count >= config.anonymousSignInsPerMinute) {
          throw new AnonymousThrottledError();                                                     // over cap
        } else {
          await ctx.db.replace(counter._id as string, { ...counter, count: count + 1 });
        }
      }
    }

    const userId = (await ctx.db.insert("users", { anonymous: true })) as string; // real user, no email
    return mintSession(ctx, config, userId, deviceLabel);
  });

  const listSessions = query(async (ctx): Promise<SessionSummary[]> => {
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (!current) return [];
    const userId = current.userId as string;
    // `byUserId` range, never a table scan: this is a reactive QUERY — a full-table read-set would
    // make every subscribed device list re-run on EVERY sign-in in the deployment; the index range
    // keeps invalidation scoped to this one user's sessions.
    const rows = await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect();
    return rows
      .map((s) => ({
        sessionId: s._id as string,
        deviceLabel: (s.deviceLabel as string | undefined) ?? null,
        createdAt: (s.createdAt as number | undefined) ?? null,
        lastRefreshAt: (s.lastRefreshAt as number | undefined) ?? null,
        current: (s._id as string) === (current._id as string),
      }));
  });

  const revokeSession = mutation(async (ctx, { sessionId }: { sessionId: string }) => {
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (!current) throw new Error("not authenticated");
    const target = await ctx.db.get(sessionId);
    // Ownership check: only the owner may revoke; a missing/foreign row is a silent no-op-ish reject.
    if (!target || (target.userId as string) !== (current.userId as string)) throw new Error("session not found");
    await ctx.db.delete(sessionId);
    return null;
  });

  const revokeOtherSessions = mutation(async (ctx) => {
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (!current) throw new Error("not authenticated");
    const userId = current.userId as string;
    // `byUserId` range, never a table scan — reads (and OCC conflict range) stay scoped to this
    // one user's sessions.
    const rows = await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect();
    for (const s of rows) {
      if ((s._id as string) !== (current._id as string)) {
        await ctx.db.delete(s._id as string);
      }
    }
    return null;
  });
```

Note: the `ctx as unknown as FacadeCtx` cast is necessary because the executor's typed `MutationCtx`/`QueryCtx` don't declare the provider facades (they're attached dynamically at run time — the same reason app code casts `ctx.auth`); `FacadeCtx` names exactly the two fields these functions touch.

- [ ] **Add the upgrade branch to `signUp`.** Replace the existing `signUp` body's duplicate-guard + insert with the upgrade-aware version. Old:

```ts
  const signUp = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult> => {
    const normEmail = normalizeEmail(email);
    // Duplicate guard relies on single-writer OCC serialization — see schema.ts comment.
    const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    if (existing.length > 0) throw new Error("an account with that email already exists");
    const userId = await ctx.db.insert("users", { email: normEmail }) as string;
    await ctx.db.insert("accounts", {
      userId, provider: "password", accountId: normEmail,
      secret: await hashSecret(password),
      failedAttempts: 0, lockedUntil: 0,
    });
    return mintSession(ctx, config, userId, deviceLabel);
  });
```
New:
```ts
  const signUp = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult> => {
    const normEmail = normalizeEmail(email);
    // Duplicate guard relies on single-writer OCC serialization — see schema.ts comment.
    const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    if (existing.length > 0) throw new Error("an account with that email already exists");

    // Upgrade path (spec §8 / "Component surface"): if the caller currently holds an ANONYMOUS
    // session, attach the email+password account to that SAME userId, clear `anonymous`, and delete
    // ALL of that user's sessions (an upgrade is a credential boundary), then mint fresh. Every row
    // the anonymous user created survives (same userId). This is the in-place upgrade convex-auth
    // leaves to userland and better-auth implements by minting a NEW userId + copy-callback.
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    let userId: string;
    if (current) {
      const user = await ctx.db.get(current.userId as string);
      if (user && user.anonymous === true) {
        userId = current.userId as string;
        // `compact` strips `anonymous: undefined` — omitting the key is what clears the flag
        // (the syscall codec rejects `undefined` values).
        await ctx.db.replace(userId, compact({ ...user, email: normEmail, anonymous: undefined }));
        // Delete ALL of the user's sessions via the `byUserId` range (an upgrade is a credential
        // boundary) — never a table scan.
        const rows = await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect();
        for (const s of rows) await ctx.db.delete(s._id as string);
      } else {
        userId = (await ctx.db.insert("users", { email: normEmail })) as string; // authed non-anon caller: new account
      }
    } else {
      userId = (await ctx.db.insert("users", { email: normEmail })) as string;
    }

    await ctx.db.insert("accounts", {
      userId, provider: "password", accountId: normEmail,
      secret: await hashSecret(password),
      failedAttempts: 0, lockedUntil: 0,
    });
    return mintSession(ctx, config, userId, deviceLabel);
  });
```

- [ ] **Add the four new modules to the returned map**:

Old:
```ts
  return { signUp, signIn, signOut, getUserId, refresh };
```
New:
```ts
  return { signUp, signIn, signOut, getUserId, refresh, signInAnonymously, listSessions, revokeSession, revokeOtherSessions };
```

- [ ] **Export `SessionSummary`** from `index.ts`. Edit the functions re-export line:

Old:
```ts
export type { MintResult } from "./functions";
```
New:
```ts
export type { MintResult, SessionSummary } from "./functions";
```

- [ ] **Create `components/auth/test/sessions-anon.test.ts`**:

```ts
import { describe, it, expect } from "vitest";
import { query } from "@stackbase/executor";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, type MintResult, type SessionSummary } from "../src";

const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  whoami: { get: query(async (ctx: any) => ctx.auth.getUserId() as Promise<string | null>) },
};

async function harness(opts?: Parameters<typeof defineAuth>[0]): Promise<TestStackbase> {
  return createTestStackbase({ modules: appModules, components: [defineAuth(opts)], schema: false });
}

describe("auth A1: session management + anonymous", () => {
  it("listSessions returns the user's sessions with a `current` flag and NO hash material", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw", deviceLabel: "Chrome" })) as MintResult;
      // A second device: sign in again → a second session for the same user.
      const b = (await t.mutation("auth:signIn", { email: "a@b.co", password: "pw", deviceLabel: "Firefox" })) as MintResult;
      const list = (await t.withIdentity(a.token).query("auth:listSessions")) as SessionSummary[];
      expect(list.length).toBe(2);
      expect(list.every((s) => !("tokenHash" in s) && !("refreshTokenHash" in s) && !("token" in s))).toBe(true);
      const cur = list.find((s) => s.current);
      expect(cur?.sessionId).toBe(a.sessionId);
      expect(list.find((s) => s.sessionId === b.sessionId)?.current).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("revokeSession ownership: cannot revoke another user's session; can revoke own", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:signUp", { email: "b@b.co", password: "pw" })) as MintResult;
      // A tries to revoke B's session → rejected.
      await expect(t.withIdentity(a.token).mutation("auth:revokeSession", { sessionId: b.sessionId })).rejects.toThrow(/not found/i);
      // B revokes its own → the session stops resolving.
      await t.withIdentity(b.token).mutation("auth:revokeSession", { sessionId: b.sessionId });
      expect(await t.query("auth:getUserId", { token: b.token })).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("revokeOtherSessions keeps the current session, kills the rest", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:signIn", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.withIdentity(a.token).mutation("auth:revokeOtherSessions");
      expect(await t.query("auth:getUserId", { token: a.token })).toBe(a.userId); // current survives
      expect(await t.query("auth:getUserId", { token: b.token })).toBeNull();     // other gone
    } finally {
      await t.close();
    }
  });

  it("signInAnonymously creates a real anonymous user; rejects a caller who is already authed (adapted from better-auth anon.test.ts:394)", async () => {
    const t = await harness();
    try {
      const anon = (await t.mutation("auth:signInAnonymously", { deviceLabel: "Safari" })) as MintResult;
      expect(await t.query("auth:getUserId", { token: anon.token })).toBe(anon.userId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (await t.run(async (ctx: any) => ctx.db.get(anon.userId))) as Record<string, unknown> | null;
      expect(user?.anonymous).toBe(true);
      expect(user?.email).toBeUndefined();
      // Already authed → reject.
      await expect(t.withIdentity(anon.token).mutation("auth:signInAnonymously", {})).rejects.toThrow(/already authenticated/i);
    } finally {
      await t.close();
    }
  });

  it("anonymous global throttle trips at the cap and recovers after the window (spec §12)", async () => {
    const t = await harness({ anonymousSignInsPerMinute: 2 });
    try {
      await t.mutation("auth:signInAnonymously", {});
      await t.mutation("auth:signInAnonymously", {});
      await expect(t.mutation("auth:signInAnonymously", {})).rejects.toThrow(/ANONYMOUS_THROTTLED/);
      await t.advanceTimers(61_000);                 // next window
      const ok = (await t.mutation("auth:signInAnonymously", {})) as MintResult;
      expect(typeof ok.token).toBe("string");
    } finally {
      await t.close();
    }
  });

  it("upgrade: signUp while holding an anonymous session preserves userId, clears the flag, replaces sessions", async () => {
    const t = await harness();
    try {
      const anon = (await t.mutation("auth:signInAnonymously", {})) as MintResult;
      // A row written while anonymous — proven to survive via userId continuity below.
      const upgraded = (await t.withIdentity(anon.token).mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(upgraded.userId).toBe(anon.userId);      // SAME user id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (await t.run(async (ctx: any) => ctx.db.get(anon.userId))) as Record<string, unknown> | null;
      expect(user?.anonymous).toBeUndefined();        // flag cleared
      expect(user?.email).toBe("a@b.co");
      // The anonymous session was deleted (credential boundary); the fresh one resolves.
      expect(await t.query("auth:getUserId", { token: anon.token })).toBeNull();
      expect(await t.query("auth:getUserId", { token: upgraded.token })).toBe(anon.userId);
    } finally {
      await t.close();
    }
  });
});
```

- [ ] **Run**: `bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Expected: all `sessions-anon.test.ts` cases pass alongside Tasks 1–2.

- [ ] **Typecheck**: `bun run --filter @stackbase/auth typecheck`. Expected: clean.

- [ ] **Commit**:
```
git add components/auth
git commit -m "feat(auth): A1 session management + anonymous auth with in-place upgrade"
```

---

## Task 4 — Client (`createAuthClient`)

New `createAuthClient(client, { storage? })` token-lifecycle manager: pluggable storage seam (localStorage default + memory fallback), refresh scheduling at 80% TTL, Web-Locks single-refresher + BroadcastChannel pair broadcast, `REFRESH_STALE` wait-for-broadcast, terminal clears + `onSignedOut`, `setSession`/`clearSession`/`getSessionInfo`; the outbox fingerprint switches to `sessionId` when managed.

### Files
- **Create** `packages/client/src/auth-client.ts`
- **Modify** `packages/client/src/client.ts` (add `setSessionFingerprint` + guard the setAuth token-fingerprint recompute)
- **Modify** `packages/client/src/index.ts` (export the new surface)
- **Create** `packages/client/test/auth-client.test.ts`

### Interfaces
- **Produces** `createAuthClient(client, opts?): AuthClient`; `AuthClient = { setSession(m: MintResult): void; clearSession(): void; getSessionInfo(): SessionInfo | null; close(): void }`.
- **Produces** `SessionStorage` seam (`{ load(): SessionInfo | null; save(s: SessionInfo): void; clear(): void }`), `localStorageSession()`, `memorySession()`.
- **Produces** on `StackbaseClient`: `setSessionFingerprint(sessionId: string | null): void`.
- **Consumes** the `StackbaseClient` public surface (`setAuth`, `mutation`, `setSessionFingerprint`), and the existing `OutboxLockManager` shape idea (a minimal lock seam is defined locally to avoid coupling to the drain).

### Steps

- [ ] **Add `setSessionFingerprint` + a guard field to `StackbaseClient`.** In `packages/client/src/client.ts`, add a private field next to `outboxFingerprint` (line ~244):

Old:
```ts
  private outboxFingerprint = "anon";
```
New:
```ts
  private outboxFingerprint = "anon";
  /** When true, a managed `createAuthClient` owns the outbox fingerprint (derived from the stable
   *  `sessionId`, not the rotating token) — `setAuth`'s token-hash recompute is suppressed so
   *  rotation never orphans queued offline mutations mid-drain (spec decision 9). The raw
   *  `setAuth(token)` path (no `createAuthClient`) leaves this false and keeps token-hash
   *  fingerprinting byte-for-byte unchanged. */
  private sessionFingerprintActive = false;
  /** The `session:<sessionId>` key whose SHA-256 is the active managed fingerprint — guards a stale
   *  async digest from overwriting a newer session's fingerprint. */
  private sessionFingerprintKey: string | null = null;
```

- [ ] **Guard the token-fingerprint recompute in `setAuth`.** Edit the outbox block inside `setAuth` (lines ~702-714):

Old:
```ts
    if (this.outbox) {
      // `identityFingerprint` cache (verdict §(d) hazard 9 / spec §(k)7): SHA-256 of the token, or
      // "anon" for none/empty — computed here (async, SubtleCrypto) so `mutation()` can stamp the
      // cached value synchronously. Guarded against a stale resolution racing a LATER setAuth call.
      if (!token) {
        this.outboxFingerprint = "anon";
      } else {
        const forToken = token;
        void sha256Hex(forToken).then((hex) => {
          if (this.lastAuthToken === forToken) this.outboxFingerprint = hex;
        });
      }
    }
```
New:
```ts
    if (this.outbox && !this.sessionFingerprintActive) {
      // `identityFingerprint` cache (verdict §(d) hazard 9 / spec §(k)7): SHA-256 of the token, or
      // "anon" for none/empty — computed here (async, SubtleCrypto) so `mutation()` can stamp the
      // cached value synchronously. Guarded against a stale resolution racing a LATER setAuth call.
      // Suppressed when a managed auth client owns the fingerprint (derived from sessionId instead —
      // see `setSessionFingerprint`), so token rotation never re-fingerprints queued mutations.
      if (!token) {
        this.outboxFingerprint = "anon";
      } else {
        const forToken = token;
        void sha256Hex(forToken).then((hex) => {
          if (this.lastAuthToken === forToken) this.outboxFingerprint = hex;
        });
      }
    }
```

- [ ] **Add the `setSessionFingerprint` method** immediately after `setAuth` (after its closing brace, before `publishEphemeral`):

```ts
  /** Managed-session fingerprinting (spec decision 9): a `createAuthClient` calls this so the durable
   *  outbox's `identityFingerprint` derives from the STABLE `sessionId`, not the rotating access
   *  token — otherwise a rotation mid-drain would orphan queued offline mutations under a new
   *  fingerprint. Pass `null` to hand the fingerprint back to the raw `setAuth` token-hash path
   *  (e.g. on sign-out). No-op when no outbox is configured. */
  setSessionFingerprint(sessionId: string | null): void {
    this.sessionFingerprintActive = sessionId !== null;
    if (sessionId === null) {
      this.sessionFingerprintKey = null;
      // Fall back to the current token's fingerprint (or "anon"): re-run setAuth's cache path.
      if (this.outbox) {
        const token = this.lastAuthToken;
        if (!token) this.outboxFingerprint = "anon";
        else void sha256Hex(token).then((hex) => { if (this.lastAuthToken === token && !this.sessionFingerprintActive) this.outboxFingerprint = hex; });
      }
      return;
    }
    if (!this.outbox) return;
    const key = `session:${sessionId}`;
    this.sessionFingerprintKey = key;
    void sha256Hex(key).then((hex) => { if (this.sessionFingerprintKey === key) this.outboxFingerprint = hex; });
  }
```

- [ ] **Create `packages/client/src/auth-client.ts`** — the token-lifecycle manager (framework-agnostic; references auth by the fixed string paths `auth:refresh`):

```ts
/**
 * `createAuthClient` — a thin token-lifecycle manager over a `StackbaseClient` (auth slice A1).
 * Sign-in flows stay ordinary app mutations; the app hands the mint result to `setSession`. From
 * there this manages: persistence (default `localStorage`, memory fallback), applying the access
 * token via `client.setAuth` + re-applying on reconnect (SetAuth replay handles the wire side),
 * refresh scheduling at ~80% of the access TTL, a Web-Locks single-refresher, a BroadcastChannel
 * pair broadcast to sibling tabs, `REFRESH_STALE` wait-for-broadcast, and terminal-clear +
 * `onSignedOut` on `REFRESH_EXPIRED`/`REFRESH_REUSED`. The outbox fingerprint is switched to the
 * stable `sessionId` while a session is managed (spec decision 9).
 *
 * Non-browser hosts fall back to in-process serialization (no Web Locks) and a no-op broadcast; two
 * independent PROCESSES sharing one refresh token is documented as unsupported (spec decision 5).
 */

/** The persisted mint result — the raw pair + the stable ids the manager needs across a reload. */
export interface SessionInfo {
  token: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
  /** Absolute wall-clock ms when the ACCESS token expires (mint `expiresAt`). Drives the 80% schedule. */
  expiresAt: number;
}

/** The minimal `StackbaseClient` surface `createAuthClient` needs (kept structural for testability).
 *  `mutation` deliberately returns `Promise<unknown>` (not a generic) so `StackbaseClient`'s
 *  overloaded `mutation(...): Promise<Value>` is structurally assignable; call sites cast. */
export interface AuthManagedClient {
  setAuth(token: string | null): void;
  setSessionFingerprint(sessionId: string | null): void;
  mutation(ref: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** Pluggable synchronous session store (same shape idea as the outbox storage seam). */
export interface SessionStorage {
  load(): SessionInfo | null;
  save(info: SessionInfo): void;
  clear(): void;
}

/** A minimal single-refresher lock seam (a subset of the Web Locks API). Non-browser → in-process. */
export interface RefreshLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** A minimal cross-tab broadcast seam over the new pair. */
export interface PairBroadcast {
  post(info: SessionInfo): void;
  onMessage(cb: (info: SessionInfo) => void): void;
  close(): void;
}

export interface CreateAuthClientOptions {
  storage?: SessionStorage;
  lock?: RefreshLock;
  broadcast?: PairBroadcast;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Refresh at this fraction of the access TTL (default 0.8). */
  refreshAtFraction?: number;
  /** Called when the session terminally ends (REFRESH_EXPIRED / REFRESH_REUSED, or clearSession). */
  onSignedOut?: () => void;
  /** Fixed function path for the refresh mutation (default "auth:refresh"). */
  refreshPath?: string;
}

export interface AuthClient {
  setSession(info: SessionInfo): void;
  clearSession(): void;
  getSessionInfo(): SessionInfo | null;
  close(): void;
}

const KEY = "stackbase.session";

/** localStorage-backed store with an in-memory fallback wherever localStorage is unavailable/throws. */
export function localStorageSession(key = KEY): SessionStorage {
  let ls: Storage | undefined;
  try {
    ls = typeof localStorage !== "undefined" ? localStorage : undefined;
    if (ls) { ls.setItem(`${key}.probe`, "1"); ls.removeItem(`${key}.probe`); }
  } catch {
    ls = undefined;
  }
  if (!ls) return memorySession();
  return {
    load() {
      try { const raw = ls!.getItem(key); return raw ? (JSON.parse(raw) as SessionInfo) : null; } catch { return null; }
    },
    save(info) { try { ls!.setItem(key, JSON.stringify(info)); } catch { /* quota/private-mode: best-effort */ } },
    clear() { try { ls!.removeItem(key); } catch { /* best-effort */ } },
  };
}

/** In-memory store — nothing survives a reload; the default fallback and a test seam. */
export function memorySession(): SessionStorage {
  let cur: SessionInfo | null = null;
  return { load: () => cur, save: (i) => { cur = i; }, clear: () => { cur = null; } };
}

/** Web-Locks single-refresher when available (browser); otherwise a promise-chain in-process serializer. */
function defaultLock(): RefreshLock {
  const locks = typeof navigator !== "undefined" ? (navigator as unknown as { locks?: { request: (name: string, cb: () => Promise<unknown>) => Promise<unknown> } }).locks : undefined;
  if (locks) {
    return { run: <T>(fn: () => Promise<T>) => locks.request("stackbase:auth:refresh", fn as () => Promise<unknown>) as Promise<T> };
  }
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      tail = next.catch(() => {});
      return next as Promise<T>;
    },
  };
}

/** BroadcastChannel when available; a no-op otherwise. */
function defaultBroadcast(): PairBroadcast {
  const BC = typeof BroadcastChannel !== "undefined" ? BroadcastChannel : undefined;
  if (!BC) return { post: () => {}, onMessage: () => {}, close: () => {} };
  const ch = new BC("stackbase:auth:pair");
  return {
    post: (info) => ch.postMessage(info),
    onMessage: (cb) => { ch.onmessage = (e: MessageEvent) => cb(e.data as SessionInfo); },
    close: () => ch.close(),
  };
}

/** Extract the auth error code from a rejected mutation (spec: `err.code ?? err.message`). */
function codeOf(err: unknown): string {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

export function createAuthClient(client: AuthManagedClient, opts: CreateAuthClientOptions = {}): AuthClient {
  const storage = opts.storage ?? localStorageSession();
  const lock = opts.lock ?? defaultLock();
  const broadcast = opts.broadcast ?? defaultBroadcast();
  const now = opts.now ?? (() => Date.now());
  const fraction = opts.refreshAtFraction ?? 0.8;
  const refreshPath = opts.refreshPath ?? "auth:refresh";

  let info: SessionInfo | null = storage.load();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function apply(next: SessionInfo | null): void {
    info = next;
    if (next) {
      storage.save(next);
      client.setSessionFingerprint(next.sessionId);
      client.setAuth(next.token);
      schedule();
    } else {
      storage.clear();
      client.setSessionFingerprint(null);
      client.setAuth(null);
      if (timer) clearTimeout(timer);
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (!info || closed) return;
    // The access token was minted for `accessTtl = expiresAt - mintTime`; we don't store mintTime, so
    // approximate the remaining budget as `expiresAt - now` and fire at 80% of it (min 0). This is
    // exact right after a mint/rotation (the common case) and conservative afterward.
    const remaining = info.expiresAt - now();
    const delay = Math.max(0, remaining * fraction);
    timer = setTimeout(() => { void doRefresh(); }, delay);
  }

  async function doRefresh(): Promise<void> {
    if (!info || closed) return;
    const before = info;
    try {
      const result = await lock.run(async () => {
        // Another tab may have rotated (and broadcast) while we queued for the lock: re-read storage
        // and, if a newer pair is present, adopt it instead of refreshing again.
        const latest = storage.load();
        if (latest && latest.refreshToken !== before.refreshToken) return { adopted: latest };
        const next = (await client.mutation(refreshPath, { refreshToken: before.refreshToken })) as SessionInfo;
        return { minted: next };
      });
      if (closed) return;
      if ("adopted" in result && result.adopted) { apply(result.adopted); return; }
      if ("minted" in result && result.minted) {
        apply(result.minted);
        broadcast.post(result.minted);      // tell sibling tabs about the winning pair
      }
    } catch (err) {
      if (closed) return;
      const code = codeOf(err);
      if (code === "REFRESH_STALE") {
        // Honest race: the winner's broadcast should arrive shortly. Wait briefly, then re-read
        // storage; if a newer pair landed, adopt it — otherwise reschedule and try again.
        setTimeout(() => {
          if (closed) return;
          const latest = storage.load();
          if (latest && latest.refreshToken !== before.refreshToken) apply(latest);
          else schedule();
        }, 250);
        return;
      }
      if (code === "REFRESH_EXPIRED" || code === "REFRESH_REUSED") {
        apply(null);
        opts.onSignedOut?.();
        return;
      }
      // Transient/unknown: reschedule a retry.
      schedule();
    }
  }

  // Adopt a pair broadcast by another tab (it already committed the rotation server-side).
  broadcast.onMessage((incoming) => {
    if (closed || !info) return;
    if (incoming.refreshToken !== info.refreshToken) apply(incoming);
  });

  // Re-apply a persisted session on construction (reload continuity).
  if (info) apply(info);

  return {
    setSession(next) { apply(next); },
    clearSession() { apply(null); opts.onSignedOut?.(); },
    getSessionInfo() { return info; },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      broadcast.close();
    },
  };
}
```

- [ ] **Export the new surface from `packages/client/src/index.ts`.** Append after the headless-drain exports (before the `mintDocumentId` export):

```ts
// Auth slice A1 — the token-lifecycle manager over a `StackbaseClient` (rotation, refresh
// scheduling, single-refresher, cross-tab pair broadcast, sessionId-based outbox fingerprint).
export type {
  AuthClient,
  AuthManagedClient,
  CreateAuthClientOptions,
  PairBroadcast,
  RefreshLock,
  SessionInfo,
  SessionStorage,
} from "./auth-client";
export { createAuthClient, localStorageSession, memorySession } from "./auth-client";
```

- [ ] **Create `packages/client/test/auth-client.test.ts`** — fake timers + two-tab simulation + storage fallback, against a stub client:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAuthClient,
  localStorageSession,
  memorySession,
  type AuthManagedClient,
  type PairBroadcast,
  type RefreshLock,
  type SessionInfo,
} from "../src/auth-client"; // own-package tests import via src, per the existing client test idiom

// A stub `AuthManagedClient` recording setAuth/fingerprint calls and driving a scripted `mutation`.
function stubClient(): AuthManagedClient & { auths: (string | null)[]; fps: (string | null)[]; onRefresh: (rt: string) => Promise<SessionInfo> } {
  const s = {
    auths: [] as (string | null)[],
    fps: [] as (string | null)[],
    onRefresh: async (_rt: string) => { throw new Error("no refresh scripted"); },
    setAuth(t: string | null) { s.auths.push(t); },
    setSessionFingerprint(id: string | null) { s.fps.push(id); },
    async mutation(_ref: string, args?: Record<string, unknown>): Promise<unknown> {
      return s.onRefresh((args as { refreshToken: string }).refreshToken);
    },
  };
  return s;
}

// An in-process broadcast + lock shared across two simulated tabs.
function sharedBus(): { broadcast: () => PairBroadcast; lock: RefreshLock } {
  const subs = new Set<(i: SessionInfo) => void>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    broadcast: () => {
      let mine: ((i: SessionInfo) => void) | undefined;
      return {
        post: (i) => { for (const cb of subs) if (cb !== mine) cb(i); },
        onMessage: (cb) => { mine = cb; subs.add(cb); },
        close: () => { if (mine) subs.delete(mine); },
      };
    },
    lock: { run: <T>(fn: () => Promise<T>) => { const n = tail.then(fn, fn); tail = n.catch(() => {}); return n as Promise<T>; } },
  };
}

function mint(seq: number, expiresAt: number): SessionInfo {
  return { token: `at${seq}`, refreshToken: `rt${seq}`, sessionId: "s1", userId: "u1", expiresAt };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createAuthClient", () => {
  it("applies a session: setAuth + sessionId fingerprint, and schedules refresh at 80% of the TTL", async () => {
    const c = stubClient();
    const start = 1_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    let refreshed = false;
    c.onRefresh = async () => { refreshed = true; return mint(2, start + 3_600_000); };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} } });

    auth.setSession(mint(1, start + 3_600_000)); // 1h TTL
    expect(c.auths).toEqual(["at1"]);
    expect(c.fps).toEqual(["s1"]);                // fingerprint from sessionId, not token

    vi.advanceTimersByTime(3_600_000 * 0.8 - 1);
    expect(refreshed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);         // cross the 80% mark
    expect(refreshed).toBe(true);
    expect(c.auths.at(-1)).toBe("at2");           // rotated access token applied
    auth.close();
  });

  it("two tabs: only one refresher runs; the loser adopts the winner's broadcast pair", async () => {
    const bus = sharedBus();
    const start = 2_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();               // shared "storage" both tabs read/write
    const cA = stubClient();
    const cB = stubClient();
    let refreshCalls = 0;
    const winner = mint(9, start + 3_600_000);
    cA.onRefresh = async () => { refreshCalls++; storage.save(winner); return winner; };
    cB.onRefresh = async () => { refreshCalls++; storage.save(winner); return winner; };

    const tabA = createAuthClient(cA, { storage, now: () => Date.now(), lock: bus.lock, broadcast: bus.broadcast() });
    const tabB = createAuthClient(cB, { storage, now: () => Date.now(), lock: bus.lock, broadcast: bus.broadcast() });
    const initial = mint(1, start + 3_600_000);
    tabA.setSession(initial);
    tabB.setSession(initial);

    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5);
    await vi.runOnlyPendingTimersAsync();
    // The lock + storage re-read means only ONE network refresh actually happened; the other tab
    // adopted the winning pair (via storage re-read under the lock and/or the broadcast).
    expect(refreshCalls).toBe(1);
    expect(cA.auths.at(-1)).toBe("at9");
    expect(cB.auths.at(-1)).toBe("at9");
    tabA.close();
    tabB.close();
  });

  it("REFRESH_EXPIRED clears storage and fires onSignedOut", async () => {
    const c = stubClient();
    const start = 3_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    const signedOut = vi.fn();
    c.onRefresh = async () => { const e = new Error("REFRESH_EXPIRED"); (e as Error & { code?: string }).code = "REFRESH_EXPIRED"; throw e; };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} }, onSignedOut: signedOut });
    auth.setSession(mint(1, start + 3_600_000));
    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(storage.load()).toBeNull();
    expect(c.auths.at(-1)).toBeNull();
    auth.close();
  });

  it("REFRESH_STALE waits for the broadcast winner instead of signing out", async () => {
    const c = stubClient();
    const start = 4_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    const signedOut = vi.fn();
    const winner = mint(7, start + 3_600_000);
    c.onRefresh = async () => { const e = new Error("REFRESH_STALE"); (e as Error & { code?: string }).code = "REFRESH_STALE"; throw e; };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} }, onSignedOut: signedOut });
    auth.setSession(mint(1, start + 3_600_000));
    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5); // triggers refresh → REFRESH_STALE
    storage.save(winner);                                    // the winner tab's pair lands in storage
    await vi.advanceTimersByTimeAsync(300);                  // the 250ms wait-for-broadcast elapses
    expect(signedOut).not.toHaveBeenCalled();
    expect(c.auths.at(-1)).toBe("at7");                      // adopted the winner
    auth.close();
  });

  it("localStorageSession falls back to memory where localStorage is unavailable (Node)", () => {
    // Under Node/vitest there is no `localStorage` global — the probe must degrade to the
    // in-memory store transparently (same probe-and-fallback shape as `indexedDBOutbox`).
    const s = localStorageSession();
    expect(s.load()).toBeNull();
    const m = mint(1, 123);
    s.save(m);
    expect(s.load()).toEqual(m);
    s.clear();
    expect(s.load()).toBeNull();
  });
});
```

- [ ] **Build the client**: `bun run --filter @stackbase/client build`. Expected: tsup bundles `auth-client.ts` (it's imported by `index.ts`) with no type error.

- [ ] **Run the client tests**: `bun run --filter @stackbase/client test`. Expected: `auth-client.test.ts` passes; the pre-existing outbox/optimistic client tests are unaffected (the `setAuth` guard only adds a `!this.sessionFingerprintActive` condition, false for every non-managed client, so their behavior is byte-identical). If any pre-existing test asserts the exact `setAuth` fingerprint recompute, confirm it still holds (it should — the guard is false by default).

- [ ] **Typecheck**: `bun run --filter @stackbase/client typecheck`. Expected: clean.

- [ ] **Commit**:
```
git add packages/client
git commit -m "feat(client): createAuthClient — refresh scheduling, single-refresher, sessionId fingerprint"
```

---

## Task 5 — E2E + example

`packages/cli/test/auth-session-e2e.test.ts` through the real `stackbase dev` server (reactive revocation fan-out to a live subscription; rotate-while-subscribed identity continuity; anonymous→upgrade row-survival via a live subscription). Update `examples/auth-demo` (manage-devices panel, anonymous try-then-upgrade, `createAuthClient` usage) and its flow test.

### Files
- **Create** `packages/cli/test/auth-session-e2e.test.ts`
- **Modify** `packages/cli/package.json` (add `@stackbase/auth` devDependency — the cli today has no auth dep, verified)
- **Modify** `examples/auth-demo/convex/whoami.ts` (add a query that also reads a user-owned row, to prove anon-row survival)
- **Modify** `examples/auth-demo/convex/schema.ts` (a `notes` table the anonymous user writes)
- **Modify** `examples/auth-demo/web/main.tsx` (createAuthClient + manage-devices + anonymous→upgrade)
- **Modify** `examples/auth-demo/test/flow.test.ts` (consume the mint superset; add anon-upgrade + revoke reactive cases)

### Interfaces
- **Consumes** `loadProject`/`startDevServer`/`DevServer` (`../src/index`), `createEmbeddedRuntime` (`@stackbase/runtime-embedded`), `defineAuth` (`@stackbase/auth`), `StackbaseClient`/`webSocketTransport`/`anyApi` (`@stackbase/client`), `query`/`mutation` (`@stackbase/executor`).

### Steps

- [ ] **Add `@stackbase/auth` to `packages/cli/package.json` devDependencies** (the e2e imports `defineAuth`; the cli has no auth dep today). Locate the `devDependencies` block and add the line alphabetically among the other `@stackbase/*` entries:

```json
    "@stackbase/auth": "workspace:*",
```

Then run `bun install`. Expected: `packages/cli/node_modules/@stackbase/auth` resolves.

- [ ] **Grep for the runtime wiring the e2e needs** so the server-start helper passes context providers (auth contributes `ctx.auth`):
```bash
grep -n "createEmbeddedRuntime\|contextProviders\|componentNames\|bootSteps\|drivers" packages/cli/test/action-e2e.test.ts | head
```
Confirm the field names accepted by `createEmbeddedRuntime` (it accepts `contextProviders`, `componentNames`, `bootSteps`, `drivers`, `tableNumbers` — as `loadProject` returns them).

- [ ] **Create `packages/cli/test/auth-session-e2e.test.ts`**:

```ts
/**
 * Auth A1 — E2E through the real `stackbase dev` server (e2e-through-shipped-entrypoint rule).
 * A REAL `@stackbase/client` over a REAL WebSocket to a REAL server with `@stackbase/auth` composed.
 *
 *  (1) reactive revocation: a live `whoami` subscription flips to null when ANOTHER connection calls
 *      `auth:revokeSession` — the session-row delete fans out through the read-set;
 *  (2) rotate-while-subscribed: a full `auth:refresh` cycle keeps identity continuous (the client
 *      re-`setAuth`s the new access token; the subscription never loses the user);
 *  (3) anonymous → upgrade: a row written while anonymous is still readable by the upgraded user
 *      through the SAME live subscription (userId continuity).
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineAuth, type MintResult } from "@stackbase/auth";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

const appSchema = defineSchema({
  notes: defineTable({ userId: v.string(), body: v.string() }).index("byUser", ["userId"]),
});

const appModules = {
  whoami: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: query(async (ctx: any) => (ctx.auth ? await ctx.auth.getUserId() : null)),
    // Returns the caller's own notes — proves an anonymous-written row survives an upgrade.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    myNotes: query(async (ctx: any) => {
      const uid = ctx.auth ? await ctx.auth.getUserId() : null;
      if (!uid) return [];
      return (ctx.db.query("notes", "byUser") as any).eq("userId", uid).collect();
    }),
  },
  notes: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    add: mutation(async (ctx: any, { body }: { body: string }) => {
      const uid = await ctx.auth.getUserId();
      if (!uid) throw new Error("not authenticated");
      return ctx.db.insert("notes", { userId: uid, body });
    }),
  },
};

const api = anyApi as {
  auth: { signUp: { __path: string }; signInAnonymously: { __path: string }; refresh: { __path: string }; revokeSession: { __path: string } };
  whoami: { get: { __path: string }; myNotes: { __path: string } };
  notes: { add: { __path: string } };
};

const servers: DevServer[] = [];
async function startServer(): Promise<{ server: DevServer; wsUrl: string }> {
  const project = loadProject({ schema: appSchema, modules: appModules }, [defineAuth()]);
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  servers.push(server);
  return { server, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

afterAll(async () => { for (const s of servers) await s.close(); });

describe("auth A1 E2E through the real dev server", () => {
  it("(1) revocation fans out reactively to a live whoami subscription", async () => {
    const { wsUrl } = await startServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    const admin = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const s = (await c.mutation(api.auth.signUp, { email: "a@b.co", password: "pw", deviceLabel: "Chrome" })) as MintResult;
      c.setAuth(s.token);
      const seen: Array<string | null> = [];
      c.subscribe(api.whoami.get, {}, (v2) => seen.push(v2 as string | null));
      await waitFor(() => seen.some((x) => x === s.userId), 5000, "authed");
      // A second connection (the same user, holding the same token) revokes the session.
      admin.setAuth(s.token);
      await admin.mutation(api.auth.revokeSession, { sessionId: s.sessionId });
      await waitFor(() => seen.at(-1) === null, 5000, "reactive revoke");
      expect(seen.at(-1)).toBeNull();
    } finally {
      c.close();
      admin.close();
    }
  });

  it("(2) rotate-while-subscribed keeps identity continuous", async () => {
    const { wsUrl } = await startServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const s = (await c.mutation(api.auth.signUp, { email: "b@b.co", password: "pw" })) as MintResult;
      c.setAuth(s.token);
      const seen: Array<string | null> = [];
      c.subscribe(api.whoami.get, {}, (v2) => seen.push(v2 as string | null));
      await waitFor(() => seen.some((x) => x === s.userId), 5000, "authed");
      const rotated = (await c.mutation(api.auth.refresh, { refreshToken: s.refreshToken })) as MintResult;
      expect(rotated.sessionId).toBe(s.sessionId);
      c.setAuth(rotated.token);                       // client re-applies the new access token
      // Identity continuous: after re-setAuth the subscription resolves the same userId again. A
      // transient null frame between the rotation commit (old tokenHash overwritten) and the
      // setAuth re-run is EXPECTED and inherent to the design — do not assert its absence.
      await waitFor(() => seen.at(-1) === s.userId, 5000, "continuity");
      expect(seen.at(-1)).toBe(s.userId);
    } finally {
      c.close();
    }
  });

  it("(3) anonymous → upgrade: a row written while anonymous survives, readable by the upgraded user", async () => {
    const { wsUrl } = await startServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const anon = (await c.mutation(api.auth.signInAnonymously, {})) as MintResult;
      c.setAuth(anon.token);
      await c.mutation(api.notes.add, { body: "written-while-anon" });
      const notes: Array<Array<{ body: string }>> = [];
      c.subscribe(api.whoami.myNotes, {}, (v2) => notes.push(v2 as Array<{ body: string }>));
      await waitFor(() => notes.at(-1)?.some((n) => n.body === "written-while-anon") ?? false, 5000, "anon note");
      // Upgrade in place (same userId); re-apply the fresh session token.
      const up = (await c.mutation(api.auth.signUp, { email: "c@b.co", password: "pw" })) as MintResult;
      expect(up.userId).toBe(anon.userId);
      c.setAuth(up.token);
      // The SAME live subscription still shows the anon-written note under the upgraded identity.
      await waitFor(() => notes.at(-1)?.some((n) => n.body === "written-while-anon") ?? false, 5000, "survives upgrade");
      expect(notes.at(-1)?.some((n) => n.body === "written-while-anon")).toBe(true);
    } finally {
      c.close();
    }
  });
});
```

- [ ] **Update `examples/auth-demo/convex/schema.ts`** to add the `notes` table (check current contents first with a Read; if it's `defineSchema({})`, replace with):

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  notes: defineTable({ userId: v.string(), body: v.string() }).index("byUser", ["userId"]),
});
```

- [ ] **Update `examples/auth-demo/convex/whoami.ts`** to add `myNotes` and `add` (both stay in `whoami.ts`, so their function paths are `whoami:myNotes` / `whoami:add`). Replace `whoami.ts`:

```ts
import { query, mutation } from "./_generated/server";

export const get = query(async (ctx) => ctx.auth.getUserId());

export const myNotes = query(async (ctx) => {
  const uid = await ctx.auth.getUserId();
  if (!uid) return [];
  return ctx.db.query("notes", "byUser").eq("userId", uid).collect();
});

export const add = mutation(async (ctx, { body }: { body: string }) => {
  const uid = await ctx.auth.getUserId();
  if (!uid) throw new Error("not authenticated");
  return ctx.db.insert("notes", { userId: uid, body });
});
```

- [ ] **Regenerate the demo's `_generated`** if the codegen is part of its build. Run `bun run --filter @stackbase/example-auth-demo build` (or the demo's codegen script — check `examples/auth-demo/package.json` scripts first). Expected: `_generated/api.d.ts` includes `whoami.myNotes`/`whoami.add`. If the demo uses `anyApi` casts (it does in `main.tsx`), codegen output isn't load-bearing for the web bundle, but keep it consistent.

- [ ] **Rewrite `examples/auth-demo/web/main.tsx`** to use `createAuthClient`, a manage-devices panel, and anonymous try-then-upgrade. Full replacement (keeps the existing `AuthForm` component):

```tsx
import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi, type SessionInfo } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation } from "@stackbase/client/react";

const api = anyApi as {
  auth: {
    signUp: { __path: string };
    signIn: { __path: string };
    signOut: { __path: string };
    signInAnonymously: { __path: string };
    listSessions: { __path: string };
    revokeSession: { __path: string };
    revokeOtherSessions: { __path: string };
  };
  whoami: { get: { __path: string }; myNotes: { __path: string }; add: { __path: string } };
};

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const client = new StackbaseClient(webSocketTransport(`${wsProtocol}://${location.host}/api/sync`));

// A1: the token-lifecycle manager — persists the mint result, applies the access token, schedules
// refresh at ~80% of the access TTL, single-refreshes across tabs, and clears on terminal errors.
const authClient = createAuthClient(client, { onSignedOut: () => location.reload() });

type SessionSummary = { sessionId: string; deviceLabel: string | null; createdAt: number | null; lastRefreshAt: number | null; current: boolean };

function AuthForm({ label, onSubmit }: { label: string; onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Email</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
      <label>Password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={6} />
      <div className="btn-row">
        <button type="submit" disabled={busy}>{busy ? "…" : label}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function DevicesPanel() {
  const sessions = useQuery<SessionSummary[]>(api.auth.listSessions, {});
  const revoke = useMutation(api.auth.revokeSession);
  const revokeOthers = useMutation(api.auth.revokeOtherSessions);
  if (!sessions || sessions.length === 0) return null;
  return (
    <fieldset>
      <legend>Your devices</legend>
      <ul className="devices">
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <span>
              {s.deviceLabel ?? "unknown device"} {s.current ? "(this device)" : ""}
              {s.lastRefreshAt ? ` — active ${new Date(s.lastRefreshAt).toLocaleString()}` : ""}
            </span>
            {!s.current && (
              <button className="danger" onClick={() => void revoke({ sessionId: s.sessionId })}>Revoke</button>
            )}
          </li>
        ))}
      </ul>
      <div className="btn-row">
        <button className="danger" onClick={() => void revokeOthers({})}>Sign out everywhere else</button>
      </div>
    </fieldset>
  );
}

function NotesPanel() {
  const notes = useQuery<Array<{ _id: string; body: string }>>(api.whoami.myNotes, {});
  const add = useMutation(api.whoami.add);
  const [body, setBody] = useState("");
  return (
    <fieldset>
      <legend>Your notes (survive an anonymous upgrade)</legend>
      <ul>{(notes ?? []).map((n) => <li key={n._id}>{n.body}</li>)}</ul>
      <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) { void add({ body: body.trim() }); setBody(""); } }}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="write a note…" />
        <button type="submit">Add</button>
      </form>
    </fieldset>
  );
}

function AuthDemo() {
  const [session, setSession] = useState<SessionInfo | null>(() => authClient.getSessionInfo());
  const whoami = useQuery<string | null>(api.whoami.get, {});
  const signUpMut = useMutation<SessionInfo>(api.auth.signUp);
  const signInMut = useMutation<SessionInfo>(api.auth.signIn);
  const signInAnonMut = useMutation<SessionInfo>(api.auth.signInAnonymously);
  const signOutMut = useMutation(api.auth.signOut);

  function adopt(result: SessionInfo) {
    authClient.setSession(result);   // persist + setAuth + schedule refresh + sessionId fingerprint
    setSession(result);
  }

  async function handleSignUp(email: string, password: string) {
    adopt(await signUpMut({ email, password, deviceLabel: navigator.userAgent.slice(0, 60) }));
  }

  async function handleSignIn(email: string, password: string) {
    adopt(await signInMut({ email, password, deviceLabel: navigator.userAgent.slice(0, 60) }));
  }

  async function handleTryAnonymously() {
    adopt(await signInAnonMut({ deviceLabel: navigator.userAgent.slice(0, 60) }));
  }

  async function handleSignOut() {
    const info = authClient.getSessionInfo();
    if (info) await signOutMut({ token: info.token });   // delete the session row server-side
    authClient.clearSession();                            // clear storage + setAuth(null) + onSignedOut
    setSession(null);
  }

  const signedIn = session !== null;

  return (
    <div className="app">
      <h1>🔐 Stackbase Auth Demo</h1>

      <div className="status-box">
        <div className="label">Reactive identity (whoami.get)</div>
        {whoami === undefined ? (
          <div className="value empty">connecting…</div>
        ) : whoami ? (
          <div className="value">{whoami}</div>
        ) : (
          <div className="value empty">— not signed in —</div>
        )}
      </div>

      {signedIn ? (
        <>
          <NotesPanel />
          <DevicesPanel />
          <fieldset>
            <legend>Upgrade this anonymous account</legend>
            <p>Signing up while anonymous keeps your userId — your notes survive.</p>
            <AuthForm label="Attach email + password" onSubmit={handleSignUp} />
          </fieldset>
          <div className="btn-row" style={{ marginBottom: "1.5rem" }}>
            <button className="danger" onClick={handleSignOut}>Sign out</button>
          </div>
        </>
      ) : (
        <>
          <div className="btn-row">
            <button onClick={handleTryAnonymously}>Try anonymously</button>
          </div>
          <fieldset>
            <legend>Sign up</legend>
            <AuthForm label="Create account" onSubmit={handleSignUp} />
          </fieldset>
          <fieldset>
            <legend>Sign in</legend>
            <AuthForm label="Sign in" onSubmit={handleSignIn} />
          </fieldset>
        </>
      )}

      <footer>
        Open in two tabs — revoke a device (or sign out) in one tab and the identity clears
        everywhere, reactively. Tokens rotate automatically in the background.
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StackbaseProvider client={client}>
        <AuthDemo />
      </StackbaseProvider>
    </StrictMode>,
  );
}
```

The demo remains a build artifact — no test asserts its DOM. (The "Upgrade" panel is shown for every signed-in user for simplicity; a non-anonymous caller's `signUp` just creates a separate account, which the server handles.)

- [ ] **Update `examples/auth-demo/test/flow.test.ts`**: the existing cases still pass (mint result is a superset of `{token,userId}`), but compose auth via `defineAuth()` (it already imports `auth`; keep `[auth]` — unchanged since `auth === defineAuth()`). Add two cases: (a) `signInAnonymously` → whoami resolves the anon userId → `signUp` upgrade preserves userId; (b) `revokeSession` on one connection flips another's whoami subscription to null (mirror e2e case 1 but over the loopback runtime the flow test already builds). Extend the `api` cast with `auth.signInAnonymously` and `auth.revokeSession` (`auth.signUp`/`whoami.get` are already present). Append inside the existing `describe`:

```ts
  it("anonymous → signUp upgrade preserves the userId", async () => {
    const c = new StackbaseClient(loopbackTransport(runtime.connect("anon1")));
    const anon = await c.mutation(api.auth.signInAnonymously, {}) as { userId: string; token: string; sessionId: string };
    c.setAuth(anon.token);
    const seen: Array<string | null> = [];
    c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
    await waitFor(() => seen.some((v) => v === anon.userId));
    const up = await c.mutation(api.auth.signUp, { email: "up@example.com", password: "hunter2!" }) as { userId: string; token: string };
    expect(up.userId).toBe(anon.userId);
  });
```

(The `api` cast at the top of the file must add `signInAnonymously: { __path: string }` and keep `signUp`.)

- [ ] **Build dependencies then run**: `bun run build` (auth + client changed in earlier tasks must be built for the cli/demo tests to resolve them via `dist`). Then `bun run --filter @stackbase/cli test -- auth-session-e2e` and `bun run --filter @stackbase/example-auth-demo test`. Expected: the three e2e cases pass; the demo flow test (old + new cases) passes.

- [ ] **Commit**:
```
git add packages/cli/test/auth-session-e2e.test.ts examples/auth-demo
git commit -m "test(auth): A1 E2E through real dev server + auth-demo createAuthClient/devices/anonymous"
```

---

## Task 6 — Docs

Rewrite `docs/enduser/build/auth.md` to describe reality (password + session model, rotation, device management, anonymous, `createAuthClient`, localStorage-vs-cookie tradeoff note, JWKS moved to a clearly-marked roadmap note); re-baseline `components/auth/README.md` limitations.

### Files
- **Modify** `docs/enduser/build/auth.md` (full rewrite)
- **Modify** `components/auth/README.md`

### Steps

- [ ] **Rewrite `docs/enduser/build/auth.md`** to describe the shipped A1 component. Replace the whole file:

```md
---
title: Authentication
---

# Authentication

Stackbase ships a first-party, self-hosted auth component: **`@stackbase/auth`** — email + password
accounts, a hardened session model (short access tokens + rotating refresh tokens with reuse
detection), device management ("manage your sessions"), and anonymous sign-in with in-place upgrade.
Identity flows over the WebSocket sync connection via `SetAuth`, and `ctx.auth.getUserId()` resolves
the current user inside your query/mutation — so **revoking a session reactively flips every
subscribed query**, no polling.

## Enabling it

`@stackbase/auth` is a component you compose in `stackbase.config.ts`:

```ts
import { defineConfig } from "@stackbase/component";
import { auth } from "@stackbase/auth";

export default defineConfig({ components: [auth] });
```

`auth` is `defineAuth()` with defaults. To tune lifetimes:

```ts
import { defineAuth } from "@stackbase/auth";

defineAuth({
  accessTtlMs: 60 * 60 * 1000,          // access token lifetime (default 1h)
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000, // refresh token lifetime, slides on rotation (default 30d)
  refreshGraceMs: 30_000,               // honest-race grace window (default 30s)
  sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000, // absolute ceiling, never slides (default 90d)
  anonymousSignInsPerMinute: 60,        // deployment-global anon throttle; 0 disables (default 60)
});
```

## The session model

- **Sign-in mints a pair**: a short-lived **access token** (used as the `SetAuth` identity) and a
  longer-lived **refresh token**. Both are stored **hashed at rest** (SHA-256); the raw tokens exist
  only in the client. A database leak is not a session-hijack.
- **`ctx.auth.getUserId()`** resolves the ambient access token to a user id via a DB read inside the
  transaction — so identity is part of your query's read-set and **revocation is reactive**.
- **Rotation + reuse detection**: `auth:refresh(refreshToken)` rotates both tokens in place (same
  session id) and remembers the previous refresh hash. Presenting a *previous* refresh token:
  - within the 30s **grace window** → a soft `REFRESH_STALE` (an honest racing tab lost to its
    sibling; no revocation);
  - outside the window → `REFRESH_REUSED`, and the **whole session is deleted** (a theft signal —
    stricter than a surgical subtree invalidation).
- **Expiry**: `REFRESH_EXPIRED` when the sliding refresh window lapses, and when the fixed
  **absolute ceiling** (`sessionTotalTtlMs`) is reached — an actively-refreshing session still forces
  re-authentication at the cap.

## Using it from the client — `createAuthClient`

Sign-in flows are ordinary mutations; hand the result to `createAuthClient`, which manages the token
lifecycle for you (persistence, applying the access token, scheduling refresh at ~80% of the access
TTL, a single-refresher across tabs via Web Locks, and broadcasting the rotated pair to sibling
tabs):

```ts
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi } from "@stackbase/client";

const client = new StackbaseClient(webSocketTransport(url));
const auth = createAuthClient(client, { onSignedOut: () => location.reload() });

const result = await client.mutation(anyApi.auth.signUp, { email, password, deviceLabel: "Chrome on macOS" });
auth.setSession(result);        // persists + applies the access token + schedules refresh
// ... later:
auth.clearSession();            // sign out locally
```

`createAuthClient` persists to `localStorage` by default (with an in-memory fallback where it is
unavailable); pass `{ storage }` for a custom store (Node/Electron hosts). When a session is managed
this way, the durable offline outbox fingerprints by the stable **session id** (not the rotating
token), so a rotation never orphans queued offline mutations.

## Device management

For a "manage your devices" screen:

```ts
const sessions = await client.query(anyApi.auth.listSessions);     // [{ sessionId, deviceLabel, createdAt, lastRefreshAt, current }]
await client.mutation(anyApi.auth.revokeSession, { sessionId });    // kill one device (ownership-checked)
await client.mutation(anyApi.auth.revokeOtherSessions);            // keep this device, kill the rest
```

`listSessions` never returns token or hash material. A revoke deletes the session row, so any tab
authenticated with it flips to signed-out on the next reactive push.

## Anonymous auth

```ts
const anon = await client.mutation(anyApi.auth.signInAnonymously, { deviceLabel: "Safari" });
auth.setSession(anon);
// ... the user does real work, creating rows owned by their (anonymous) userId ...
const upgraded = await client.mutation(anyApi.auth.signUp, { email, password });  // same userId, in place
auth.setSession(upgraded);
```

An anonymous user is a **real user** (`users.anonymous: true`, no email). `signUp` while holding an
anonymous session attaches the email+password account to the **same userId**, clears the flag, and
replaces the sessions — **every row the anonymous user created survives**. `signInAnonymously` is
rejected for an already-authenticated caller and is subject to a deployment-global throttle
(`anonymousSignInsPerMinute`).

## localStorage vs. cookies

Stackbase is **WebSocket-first**: identity flows over the `SetAuth` message, not request headers, so
the client holds the access token in JS (`localStorage` by default) rather than an httpOnly cookie.
The theft mitigation is the session model itself — a short access TTL, refresh rotation, and reuse
detection — not cookie isolation. httpOnly-cookie mode + CSRF is intentionally **out of scope** for
A1 (it would rearchitect identity transport for marginal gain). If your threat model requires cookie
isolation, front Stackbase with your own auth-terminating proxy.

## Roadmap — external identity (not yet shipped)

Third-party identity providers (OAuth) and JWT/JWKS/OIDC token verification for issuers like Clerk or
Auth0 are **planned for the external-identity slice (A3)** and are **not implemented today**. When
they land, JWT verification will apply to third-party issuers only; Stackbase's own sessions stay DB
rows so revocation remains reactive. Email flows (verification, password reset, magic links, OTP) are
the **A2 slice**. This page will be updated as those ship.
```

- [ ] **Re-baseline `components/auth/README.md`** limitations to match reality:

```md
# @stackbase/auth

First-party authentication for Stackbase: email + password accounts (argon2id hashing, per-call
random salt, constant-time verification, legacy-scrypt migration), a hardened session model (short
access tokens + rotating refresh tokens with reuse detection, all hashed at rest), device
management (`listSessions`/`revokeSession`/`revokeOtherSessions`), and anonymous sign-in with
in-place upgrade. `ctx.auth.getUserId()` resolves identity inside the transaction, so session
revocation is reactive. Runtime-agnostic (`node:crypto`) — Node.js and Bun.

Configure via `defineAuth(options?)`; `export const auth = defineAuth()` uses the defaults.
Session/token details and the client `createAuthClient` are documented in
`docs/enduser/build/auth.md`.

Reference implementations consulted: convex-auth (Apache-2.0) and better-auth (MIT) — adapted with
attribution, never copied.

## Known limitations

1. **No storage-level unique index on `accounts(provider, accountId)`** — uniqueness is enforced by
   an application-level duplicate check in `signUp`, correct under single-writer OCC serialization
   (Tier 0 / Tier 1). A multi-writer engine (Tier 2+) would require a DB-level unique constraint.
2. **Sessions in one browser context** — the client single-refresher serializes rotation across tabs
   via Web Locks; two independent *processes* sharing one refresh token is unsupported.
3. **No httpOnly-cookie / CSRF mode** — Stackbase is WebSocket-first; identity flows over `SetAuth`,
   not headers. The session model (short access TTL + rotation + reuse detection) is the theft
   mitigation. See the auth doc's "localStorage vs. cookies" note.
4. **Email flows (verification / reset / magic-link / OTP) and external identity (OAuth, JWKS/OIDC)
   are not implemented** — deferred to the A2 (email) and A3 (external identity) slices.
```

- [ ] **Sanity-check** the docs render (no broken frontmatter): `grep -c "REFRESH_" docs/enduser/build/auth.md` (>0) and confirm no `JWKS ... Supported` claim remains: `grep -in "supported" docs/enduser/build/auth.md` should show only roadmap-framed mentions. Expected: the stale JWKS/OIDC "supported" table is gone.

- [ ] **Commit**:
```
git add docs/enduser/build/auth.md components/auth/README.md
git commit -m "docs(auth): rewrite enduser auth doc to the shipped A1 model; re-baseline README limitations"
```

---

## Final verification (run after all tasks)

```bash
bun run build && bun run typecheck && bun run test
```

Expected: green across all packages. If a cross-package test fails to resolve a change, confirm the
dependency package was rebuilt (`bun run build`) before the dependent's tests ran.
