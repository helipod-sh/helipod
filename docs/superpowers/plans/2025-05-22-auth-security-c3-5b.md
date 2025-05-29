# C3.5b — Auth Security Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `@stackbase/auth` to the security floor decided in the C3.5 design: **argon2id** password hashing (via pure-WASM `hash-wasm`, with scrypt-fallback + rehash-on-login), **absolute session expiry** (via a real injected wall-clock, not the logical commit counter), and **failed-attempt lockout**.

**Architecture:** Replace `node:crypto` scrypt with `hash-wasm` argon2id (encoded PHC strings that embed salt+params); keep scrypt verification for migrating C3 accounts. Add a controlled wall-clock `now` to the execution context (`KernelContext.now`, sourced from the executor's existing `deps.now ?? Date.now`, fixed per execution) — exposed as `ctx.now()` to functions and `cctx.now` to facades — and use it to stamp/`check` `sessions.expiresAt`. Add `failedAttempts`/`lockedUntil` to `accounts` and gate `signIn`.

**Tech Stack:** TypeScript, pnpm/turbo, vitest, `hash-wasm` (pure WASM argon2id — Node + Bun, no native build). Touches `@stackbase/auth` (crypto, schema, functions, context), `@stackbase/executor` (`KernelContext.now` + `ComponentContext.now` + `ctx.now`), `@stackbase/runtime-embedded` (inject `now`).

## Global Constraints

- **Why a separate `now`:** the commit-timestamp oracle is a logical monotonic counter (`MonotonicTimestampOracle.allocateTimestamp` = `+= 1n`), NOT wall-clock — so expiry must use a real clock. The executor already has `deps.now ?? Date.now`; thread it into the context, **captured once per execution** (so it's fixed/deterministic within an OCC attempt, like Convex's `Date.now()` in a mutation). Do NOT change the timestamp oracle (it orders the MVCC log).
- **Migration:** C3 accounts have scrypt `secret`s (`"salt:hash"` hex). `verifySecret` must still accept those; on a successful `signIn` with a legacy hash, **rehash to argon2id** and store it.
- `hash-wasm` argon2id params: **memorySize 19456 KiB (19 MiB), iterations 3, parallelism 1, hashLength 32, outputType "encoded"** → a PHC string `$argon2id$v=19$m=19456,t=3,p=1$<salt>$<hash>`.
- Hashing blocks the single writer for tens of ms (in-mutation) — acceptable for dev/self-host; the production fix (move to an Action) is deferred. Documented, not built.
- Strict TS; ESM. `@stackbase/auth` may add `hash-wasm` to dependencies.
- **Separately recorded finding (NOT this plan):** `_creationTime` is currently the logical counter, not wall-clock ms — a Convex-compat bug to fix in its own slice.

---

### Task 1: argon2id hashing (hash-wasm) + scrypt-fallback + rehash-on-login

**Files:**
- Modify: `packages/auth/package.json` (add `hash-wasm`)
- Rewrite: `packages/auth/src/crypto.ts` (argon2id async; scrypt-legacy verify; `needsRehash`)
- Modify: `packages/auth/src/functions.ts` (`await` hashing; rehash on signIn)
- Modify: `packages/auth/test/crypto.test.ts` (async + PHC format + legacy-verify)

**Interfaces:**
- Produces: `hashSecret(password): Promise<string>` (argon2id PHC); `verifySecret(password, stored): Promise<boolean>` (argon2 if PHC, else legacy scrypt); `needsRehash(stored): boolean` (true for legacy scrypt); `generateToken()` unchanged.

- [ ] **Step 1: Add the dep** — add `"hash-wasm": "^4.12.0"` to `packages/auth/package.json` dependencies; run `pnpm install`. Then a quick sanity check it imports under the test runner:
```bash
node --input-type=module -e "import('hash-wasm').then(m=>console.log('argon2id' in m, 'argon2Verify' in m))"
```
Expected: `true true`. (If it fails, escalate BLOCKED — the WASM path is a load-bearing assumption.)

- [ ] **Step 2: Write the failing test** — rewrite `packages/auth/test/crypto.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scryptSync, randomBytes } from "node:crypto";
import { hashSecret, verifySecret, needsRehash, generateToken } from "../src/crypto";

describe("password hashing (argon2id)", () => {
  it("hashes to an argon2id PHC string and verifies", async () => {
    const stored = await hashSecret("hunter2");
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(await verifySecret("hunter2", stored)).toBe(true);
    expect(await verifySecret("wrong", stored)).toBe(false);
  });
  it("uses a random salt (same password → different hashes)", async () => {
    expect(await hashSecret("x")).not.toBe(await hashSecret("x"));
  });
  it("still verifies a legacy scrypt secret (migration), and flags it for rehash", async () => {
    const salt = randomBytes(16).toString("hex");
    const legacy = `${salt}:${scryptSync("legacypw", salt, 64).toString("hex")}`;
    expect(await verifySecret("legacypw", legacy)).toBe(true);
    expect(await verifySecret("nope", legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(await hashSecret("x"))).toBe(false);
  });
  it("rejects a malformed stored value without throwing", async () => {
    expect(await verifySecret("x", "notvalid")).toBe(false);
  });
  it("generates distinct url-safe tokens", () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateToken()).not.toBe(generateToken());
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `pnpm --filter @stackbase/auth test crypto` → FAIL (PHC format / async).

- [ ] **Step 4: Write minimal implementation** — `packages/auth/src/crypto.ts`:
```ts
import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ARGON = { parallelism: 1, iterations: 3, memorySize: 19456, hashLength: 32, outputType: "encoded" as const };

/** Hash a password with argon2id → an encoded PHC string (embeds salt + params). */
export async function hashSecret(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), ...ARGON });
}

/** Verify against an argon2id PHC string, or a legacy scrypt "salt:hash" (for migration). */
export async function verifySecret(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$argon2")) {
    try { return await argon2Verify({ password, hash: stored }); } catch { return false; }
  }
  return verifyScryptLegacy(password, stored);
}

/** True when `stored` is a legacy scrypt hash that should be upgraded to argon2id on next login. */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith("$argon2");
}

function verifyScryptLegacy(password: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep < 0) return false;
  const salt = stored.slice(0, sep), hash = stored.slice(sep + 1);
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}
```
In `packages/auth/src/functions.ts`: `signUp` → `secret: await hashSecret(password)`; `signIn` → `await verifySecret(password, account.secret)`. After a successful `signIn` verify, rehash legacy hashes:
```ts
  if (needsRehash(account.secret)) {
    await ctx.db.replace(account._id as string, { ...account, secret: await hashSecret(password) });
  }
```
(Import `needsRehash`. `account` is the full doc; `replace` whole-doc.)

- [ ] **Step 5: Run test, typecheck, commit** — `pnpm --filter @stackbase/auth test` → all pass · `pnpm --filter @stackbase/auth exec tsc --noEmit` → clean.
```bash
git add packages/auth/package.json packages/auth/src/crypto.ts packages/auth/src/functions.ts packages/auth/test/crypto.test.ts
git commit -m "feat(auth): argon2id hashing via hash-wasm (scrypt-fallback + rehash-on-login)"
```

---

### Task 2: Injected wall-clock `now` + absolute session expiry

**Files:**
- Modify: `packages/executor/src/kernel.ts` (`KernelContext.now`)
- Modify: `packages/executor/src/executor.ts` (`ComponentContext.now`; set `kctx.now`; `guestCtx.now`; pass `now` into provider `build`)
- Modify: `packages/runtime-embedded/src/runtime.ts` (`EmbeddedRuntimeOptions.now` → executor `deps.now`)
- Modify: `packages/auth/src/schema.ts` (`sessions.expiresAt`), `functions.ts` (stamp + check), `context.ts` (check)
- Test: `packages/auth/test/expiry.test.ts`

**Interfaces:**
- Produces: `KernelContext.now: number` (wall-clock ms, fixed per execution); guest `ctx.now(): number`; `ComponentContext.now: number`; `EmbeddedRuntimeOptions.now?: () => number`. `sessions` gains `expiresAt: number`. Sessions older than `expiresAt` resolve to `null`.

- [ ] **Step 1: Write the failing test**
```ts
// packages/auth/test/expiry.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { auth } from "../src/component";

describe("auth: absolute session expiry", () => {
  it("getUserId returns null after the session expires (clock advanced)", async () => {
    let nowMs = 1_000_000_000_000; // fixed virtual clock
    const appModules = { "me:get": query(async (ctx) => (ctx as unknown as { auth: { getUserId(): Promise<string | null> } }).auth.getUserId()) };
    const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
      { schemaJson: defineSchema({}).export(), moduleMap: appModules }, [auth]);
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders,
      now: () => nowMs,
    });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect((await r.run<string | null>("me:get", {}, { identity: token })).value).toBe(userId); // live
    nowMs += 31 * 24 * 60 * 60 * 1000; // +31 days
    expect((await r.run<string | null>("me:get", {}, { identity: token })).value).toBeNull(); // expired
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/auth test expiry` → FAIL (`now` not accepted / no expiry).

- [ ] **Step 3: Write minimal implementation**

`kernel.ts`: add `readonly now: number;` to `KernelContext`.
`executor.ts`: add `now: number` to `ComponentContext`; in `run()` set `now: startedAt` in the `kctx` literal (reuse the existing `const startedAt = clock();`); add `now: () => kctx.now` to `guestCtx`; in the provider loop pass `now: kctx.now` to `build({ db: preader, identity: kctx.identity, now: kctx.now })`.
`runtime.ts`: `EmbeddedRuntimeOptions.now?: () => number`; pass it into the executor: `new InlineUdfExecutor({ transactor, queryRuntime, catalog: options.catalog, logSink: options.logSink, now: options.now })`.
`auth/src/schema.ts`: `sessions: defineTable({ userId: v.id("users"), token: v.string(), expiresAt: v.number() }).index("byToken", ["token"])`.
`auth/src/functions.ts`: add `const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;` (export it). In `signUp` and `signIn`, the session insert becomes `{ userId, token, expiresAt: ctx.now() + THIRTY_DAYS }`. In the standalone `getUserId` query, after fetching the session: `if (!session || ctx.now() > (session.expiresAt as number)) return null; return session.userId as string;`.
`auth/src/context.ts`: `authContext` uses `cctx.now`:
```ts
return {
  getUserId: async (): Promise<string | null> => {
    if (!cctx.identity) return null;
    const [session] = await cctx.db.query("sessions", "byToken").eq("token", cctx.identity).collect();
    if (!session || cctx.now > (session.expiresAt as number)) return null;
    return session.userId as string;
  },
};
```

- [ ] **Step 4: Run test, full workspace, commit** — `pnpm --filter @stackbase/auth test` → all pass (existing auth tests: signUp/signIn now write `expiresAt`; the sessions schema change is backward-compatible since all inserts set it) · `pnpm --filter @stackbase/executor test` + `pnpm --filter @stackbase/runtime-embedded test` → pass (guest `ctx.now` additive; `now` defaults to `Date.now`) · `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.
```bash
git add packages/executor/src packages/runtime-embedded/src/runtime.ts packages/auth/src packages/auth/test/expiry.test.ts
git commit -m "feat(executor,auth): injected wall-clock ctx.now + absolute session expiry"
```

---

### Task 3: Failed-attempt lockout

**Files:**
- Modify: `packages/auth/src/schema.ts` (`accounts.failedAttempts`, `accounts.lockedUntil`)
- Modify: `packages/auth/src/functions.ts` (`signUp` init; `signIn` gate/increment/reset)
- Test: `packages/auth/test/lockout.test.ts`

**Interfaces:**
- Produces: `accounts` gains `failedAttempts: number` + `lockedUntil: number`. `signIn` rejects while `ctx.now() < lockedUntil`; a wrong password increments `failedAttempts` and sets `lockedUntil = ctx.now() + LOCK_MS` once it reaches `MAX_ATTEMPTS`; a correct password resets both.

- [ ] **Step 1: Write the failing test**
```ts
// packages/auth/test/lockout.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { auth } from "../src/component";

async function makeRuntime(now: () => number) {
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} }, [auth]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders, now });
}

describe("auth: failed-attempt lockout", () => {
  it("locks the account after 5 wrong passwords; the correct password is then rejected until the lock expires", async () => {
    let nowMs = 1_000_000_000_000;
    const r = await makeRuntime(() => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "right" });
    for (let i = 0; i < 5; i++) {
      await expect(r.run("auth:signIn", { email: "a@b.co", password: "wrong" })).rejects.toThrow(/invalid credentials/i);
    }
    await expect(r.run("auth:signIn", { email: "a@b.co", password: "right" })).rejects.toThrow(/too many|locked/i);
    nowMs += 16 * 60 * 1000; // +16 min, past the 15-min lock
    expect(typeof (await r.run<{ token: string }>("auth:signIn", { email: "a@b.co", password: "right" })).value.token).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/auth test lockout` → FAIL (no lockout).

- [ ] **Step 3: Write minimal implementation**

`auth/src/schema.ts`: `accounts` gains `failedAttempts: v.number(), lockedUntil: v.number()`.
`auth/src/functions.ts`:
- Add `const MAX_ATTEMPTS = 5; const LOCK_MS = 15 * 60 * 1000;`
- `signUp`'s account insert sets `failedAttempts: 0, lockedUntil: 0`.
- `signIn` (after fetching `account`, before/around the password check):
```ts
  if (!account) throw new Error("invalid credentials");
  if (ctx.now() < (account.lockedUntil as number)) throw new Error("too many attempts — account temporarily locked");
  if (typeof account.secret !== "string" || !(await verifySecret(password, account.secret))) {
    const failedAttempts = (account.failedAttempts as number) + 1;
    const lockedUntil = failedAttempts >= MAX_ATTEMPTS ? ctx.now() + LOCK_MS : (account.lockedUntil as number);
    await ctx.db.replace(account._id as string, { ...account, failedAttempts, lockedUntil });
    throw new Error("invalid credentials");
  }
  // success: reset counters (+ rehash from Task 1)
  const next = { ...account, failedAttempts: 0, lockedUntil: 0 };
  if (needsRehash(account.secret)) next.secret = await hashSecret(password);
  await ctx.db.replace(account._id as string, next);
```
(Merge with Task 1's rehash so there is a single `replace` on success.)

- [ ] **Step 4: Run test, full workspace, commit** — `pnpm --filter @stackbase/auth test` → all pass · `pnpm --filter @stackbase/auth exec tsc --noEmit` → clean · `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.
```bash
git add packages/auth/src packages/auth/test/lockout.test.ts
git commit -m "feat(auth): per-account failed-attempt lockout"
```

---

## Self-Review

**Spec coverage (against `2025-05-22-ctx-contribution-auth-c3-5-design.md` §2 D1/D4/D6 + build-order C3.5b):**
- D1 argon2id via `hash-wasm` + scrypt-fallback + rehash-on-login — Task 1. ✅
- D4 absolute expiry — Task 2, corrected to use an injected wall-clock `ctx.now` (the commit-timestamp oracle is a logical counter, so the spec's "from commit timestamp" can't work; this is the surgical fix). ✅
- D6 failed-attempt lockout — Task 3. ✅
- **Out of scope (per spec):** D5 signUp anti-enumeration beyond the existing generic signIn error (needs email/Actions for a non-leaking duplicate path — documented limitation); robust windowed/per-IP rate-limiting (a `ratelimit` component); moving hashing into an Action; sliding/idle expiry (needs a write on read — incompatible with queries); the Tier-2 unique index; **fixing `_creationTime` to wall-clock ms (separate recorded finding).**

**Placeholder scan:** none — runnable code/commands throughout. The merge of Task 1's rehash and Task 3's reset into one `replace`-on-success is called out in Task 3 Step 3.

**Type consistency:** `KernelContext.now: number` (Task 2) is set in `run()` and read via `ctx.now()` (guest) + `cctx.now` (facade, `ComponentContext.now`); `EmbeddedRuntimeOptions.now` → `ExecutorDeps.now`. `hashSecret`/`verifySecret` are async (Task 1) and every caller `await`s them (Tasks 1, 3). `expiresAt`/`failedAttempts`/`lockedUntil` are `number` everywhere (schema, stamp, check). `needsRehash` (Task 1) is consumed in `signIn` (Tasks 1 & 3, single success-path `replace`).
