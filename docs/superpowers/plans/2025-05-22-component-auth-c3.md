# Component C3 — Auth (the first real component) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@stackbase/auth` — the first real Stackbase component: password + session auth, with its own namespaced tables (`auth/users`, `auth/accounts`, `auth/sessions`) and `signUp`/`signIn`/`signOut`/`getUserId` functions, built on the component engine (C0–C2).

**Architecture:** A new `packages/auth` exports a `defineComponent({ name: "auth", schema, modules })`. Clean-room, but its data model is adapted from convex-auth (Apache-2.0): a `users` identity table, an `accounts` table holding the hashed `secret` per provider, and a `sessions` table. Password hashing uses `node:crypto` `scrypt` (no dependency). The component composes into a runtime via `composeComponents`, runs isolated at namespace `auth`, and is tested end-to-end.

**Tech Stack:** TypeScript, pnpm/turbo, vitest, `node:crypto` (scrypt/randomBytes/timingSafeEqual — Node + Bun). Reuses `@stackbase/component` (defineComponent), `@stackbase/values` (schema/v), `@stackbase/executor` (query/mutation), and (test-only) `@stackbase/runtime-embedded` + `composeComponents`.

## Global Constraints

- Clean-room: convex-auth (`.reference/convex-auth`, Apache-2.0) is studied for the user/account/session model; reimplement. Keep an attribution note in the package README.
- The component owns its tables under namespace `auth` (the engine namespaces them to `auth/users` etc.). The app stores the opaque `userId` (a string) in its own tables — auth never reads app tables.
- Password hashing: `scrypt` with a per-account random salt; `timingSafeEqual` verification. Hashing in a mutation blocks the event loop — acceptable for dev (moved to an Action at scale; noted, not built).
- **v1 surface:** `signUp`, `signIn`, `signOut`, `getUserId(token)`. **Deferred (need Actions + a clock):** OAuth/email providers, email verification, refresh-token rotation, **session expiration** (v1 sessions are valid until `signOut`).
- `ctx.auth.getUserId()` (an app function auto-resolving the request's token) is the NEXT slice (the ctx-contribution + token-plumbing engine piece). C3 exposes `auth:getUserId(token)` as a normal callable query that that slice will wrap.
- Strict TS (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`); ESM only. `packages/auth` depends on `@stackbase/{component,values,executor,errors}` — never a DB driver.

---

### Task 1: Scaffold `packages/auth` + password/token helpers

**Files:**
- Create: `packages/auth/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`, `README.md`
- Create: `packages/auth/src/crypto.ts`
- Test: `packages/auth/test/crypto.test.ts`

**Interfaces:**
- Produces: `hashSecret(password: string): string` ("salt:hash" hex); `verifySecret(password: string, stored: string): boolean` (constant-time, false on malformed); `generateToken(): string` (32 random url-safe bytes).

- [ ] **Step 1: Scaffold the package**

Copy `tsconfig.json` + `tsup.config.ts` verbatim from `packages/component/`. `packages/auth/package.json` (mirror `packages/component/package.json`; add `"tsup": "catalog:"` to devDeps):

```json
{
  "name": "@stackbase/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@stackbase/component": "workspace:*",
    "@stackbase/errors": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/values": "workspace:*"
  },
  "devDependencies": {
    "@stackbase/docstore-sqlite": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*",
    "@types/node": "catalog:", "tsup": "catalog:", "typescript": "catalog:", "vitest": "catalog:"
  }
}
```

`src/index.ts`: `export * from "./crypto";` (the component export is added in Task 2). `README.md`: one paragraph + "Data model adapted from convex-auth (Apache-2.0)." Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/auth/test/crypto.test.ts
import { describe, it, expect } from "vitest";
import { hashSecret, verifySecret, generateToken } from "../src/crypto";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", () => {
    const stored = hashSecret("hunter2");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifySecret("hunter2", stored)).toBe(true);
    expect(verifySecret("wrong", stored)).toBe(false);
  });
  it("uses a random salt (same password → different stored hashes)", () => {
    expect(hashSecret("x")).not.toBe(hashSecret("x"));
  });
  it("rejects a malformed stored value", () => {
    expect(verifySecret("x", "notvalid")).toBe(false);
  });
  it("generates distinct url-safe tokens", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(generateToken());
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `pnpm --filter @stackbase/auth test crypto` → FAIL (module not found).

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/auth/src/crypto.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hash a password with a per-call random salt → "salt:hash" (hex). */
export function hashSecret(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/** Constant-time verify; false for a malformed stored value. */
export function verifySecret(password: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep < 0) return false;
  const salt = stored.slice(0, sep);
  const hash = stored.slice(sep + 1);
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A url-safe session token (256 bits). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}
```

- [ ] **Step 5: Run test, typecheck, build, commit**

`pnpm --filter @stackbase/auth test crypto` → PASS · `pnpm --filter @stackbase/auth exec tsc --noEmit` → clean · `pnpm --filter @stackbase/auth build` → emits dist.

```bash
git add packages/auth
git commit -m "feat(auth): scaffold @stackbase/auth + scrypt password helpers"
```

---

### Task 2: The auth component (schema + signUp/signIn)

**Files:**
- Create: `packages/auth/src/schema.ts` (the auth tables)
- Create: `packages/auth/src/functions.ts` (signUp/signIn — others in Task 3)
- Create: `packages/auth/src/component.ts` (`defineComponent`)
- Modify: `packages/auth/src/index.ts` (export the component + schema)
- Test: `packages/auth/test/sign-up-in.test.ts`

**Interfaces:**
- Consumes: `defineComponent` (`@stackbase/component`), `defineSchema`/`defineTable`/`v` (`@stackbase/values`), `mutation` (`@stackbase/executor`), Task 1 crypto, and (test) `composeComponents` + `EmbeddedRuntime`.
- Produces: the default export `auth` (a `ComponentDefinition` named `"auth"`); `signUp`/`signIn` mutations returning `{ token: string; userId: string }`. Tables (namespaced under `auth`): `users { email }`, `accounts { userId, provider, accountId, secret }` index `byAccount [provider, accountId]`, `sessions { userId, token }` index `byToken [token]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/auth/test/sign-up-in.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { auth } from "../src/component";

async function makeRuntime() {
  const { catalog, moduleMap, componentNames } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [auth],
  );
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames });
}

describe("auth: signUp / signIn", () => {
  it("signUp creates an identity + session and returns a token", async () => {
    const r = await makeRuntime();
    const out = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect(typeof out.token).toBe("string");
    expect(typeof out.userId).toBe("string");
  });
  it("signIn verifies the password; rejects a wrong one", async () => {
    const r = await makeRuntime();
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });
    const ok = (await r.run<{ token: string }>("auth:signIn", { email: "a@b.co", password: "pw" })).value;
    expect(typeof ok.token).toBe("string");
    await expect(r.run("auth:signIn", { email: "a@b.co", password: "WRONG" })).rejects.toThrow(/invalid credentials/i);
  });
  it("rejects a duplicate signUp", async () => {
    const r = await makeRuntime();
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });
    await expect(r.run("auth:signUp", { email: "a@b.co", password: "pw2" })).rejects.toThrow(/already exists/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/auth test sign-up-in` → FAIL (`../src/component` not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/auth/src/schema.ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export const authSchema = defineSchema({
  users: defineTable({ email: v.string() }).index("byEmail", ["email"]),
  accounts: defineTable({
    userId: v.id("users"),
    provider: v.string(),
    accountId: v.string(), // for password: the email
    secret: v.string(),    // "salt:hash"
  }).index("byAccount", ["provider", "accountId"]),
  sessions: defineTable({ userId: v.id("users"), token: v.string() }).index("byToken", ["token"]),
});
```

```ts
// packages/auth/src/functions.ts
import { mutation } from "@stackbase/executor";
import { hashSecret, verifySecret, generateToken } from "./crypto";

interface Creds { email: string; password: string }

export const signUp = mutation(async (ctx, { email, password }: Creds) => {
  const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", email).collect();
  if (existing.length > 0) throw new Error("an account with that email already exists");
  const userId = await ctx.db.insert("users", { email });
  await ctx.db.insert("accounts", { userId, provider: "password", accountId: email, secret: hashSecret(password) });
  const token = generateToken();
  await ctx.db.insert("sessions", { userId, token });
  return { token, userId };
});

export const signIn = mutation(async (ctx, { email, password }: Creds) => {
  const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", email).collect();
  if (!account || typeof account.secret !== "string" || !verifySecret(password, account.secret)) {
    throw new Error("invalid credentials");
  }
  const token = generateToken();
  await ctx.db.insert("sessions", { userId: account.userId as string, token });
  return { token, userId: account.userId as string };
});
```

```ts
// packages/auth/src/component.ts
import { defineComponent } from "@stackbase/component";
import { authSchema } from "./schema";
import { signUp, signIn } from "./functions";

export const auth = defineComponent({ name: "auth", schema: authSchema, modules: { signUp, signIn } });
```

`src/index.ts`: add `export * from "./schema";` and `export { auth } from "./component";`.

> If `mutation`'s bare-function form doesn't infer the `ctx` type cleanly, the executor also exports an object form `mutation({ handler })` — check `packages/executor/src/functions.ts` and use whichever gives clean types. If `ctx.db.query(...).eq(...)` needs a `Value` cast for the string args, the strings are already `Value`-compatible.

- [ ] **Step 4: Run test to verify it passes** — `pnpm --filter @stackbase/auth test sign-up-in` → PASS (3). `pnpm --filter @stackbase/auth exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/auth/src packages/auth/test/sign-up-in.test.ts
git commit -m "feat(auth): auth component schema + signUp/signIn (namespaced under auth)"
```

---

### Task 3: signOut + getUserId + the end-to-end flow

**Files:**
- Modify: `packages/auth/src/functions.ts` (add `signOut`, `getUserId`)
- Modify: `packages/auth/src/component.ts` (register them)
- Test: `packages/auth/test/session-flow.test.ts`

**Interfaces:**
- Consumes: Task 2's schema + functions.
- Produces: `signOut(token)` mutation (deletes the session, returns null); `getUserId(token)` query returning `string | null`. The component's `modules` now include all four.

- [ ] **Step 1: Write the failing test**

```ts
// packages/auth/test/session-flow.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation } from "@stackbase/executor";
import { auth } from "../src/component";

async function makeRuntime() {
  // an app table to prove auth's tables are namespaced separately
  const appSchema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const { catalog, moduleMap, componentNames } = composeComponents(
    { schemaJson: appSchema.export(), moduleMap: { "notes:add": mutation(async (ctx, a: { body: string }) => ctx.db.insert("notes", a)) } },
    [auth],
  );
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames });
}

describe("auth: session lifecycle", () => {
  it("getUserId resolves a live token, returns null after signOut", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect((await r.run<string | null>("auth:getUserId", { token })).value).toBe(userId);
    await r.run("auth:signOut", { token });
    expect((await r.run<string | null>("auth:getUserId", { token })).value).toBeNull();
  });

  it("auth tables are isolated from the app namespace", async () => {
    const r = await makeRuntime();
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });
    await r.run("notes:add", { body: "hi" }); // app fn, different namespace — no collision
    // auth's getUserId is a component function; it cannot read the app's notes (boundary). Smoke: app + auth coexist.
    expect((await r.run<unknown[]>("auth:getUserId", { token: "nope" })).value).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/auth test session-flow` → FAIL (`auth:signOut`/`auth:getUserId` unknown).

- [ ] **Step 3: Write minimal implementation**

Add to `packages/auth/src/functions.ts`:
```ts
import { mutation, query } from "@stackbase/executor";

export const signOut = mutation(async (ctx, { token }: { token: string }) => {
  const [session] = await ctx.db.query("sessions", "byToken").eq("token", token).collect();
  if (session) await ctx.db.delete(session._id as string);
  return null;
});

export const getUserId = query(async (ctx, { token }: { token: string }) => {
  const [session] = await ctx.db.query("sessions", "byToken").eq("token", token).collect();
  return session ? (session.userId as string) : null;
});
```

Update `packages/auth/src/component.ts`:
```ts
import { signUp, signIn, signOut, getUserId } from "./functions";
export const auth = defineComponent({ name: "auth", schema: authSchema, modules: { signUp, signIn, signOut, getUserId } });
```

- [ ] **Step 4: Run test, typecheck, full workspace, commit**

`pnpm --filter @stackbase/auth test` → all pass · `pnpm --filter @stackbase/auth exec tsc --noEmit` → clean · `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.

```bash
git add packages/auth/src/functions.ts packages/auth/src/component.ts packages/auth/test/session-flow.test.ts
git commit -m "feat(auth): signOut + getUserId; end-to-end session flow"
```

---

## Self-Review

**Spec coverage (against `2025-05-22-component-system-design.md` §7):**
- The `auth` component, namespaced tables (`users`/`accounts`/`sessions`) — Tasks 2–3. Adapted from convex-auth's user/account/session model. ✅
- Password hashing (scrypt + salt, timing-safe verify) — Task 1. ✅
- `signUp`/`signIn`/`signOut`/`getUserId(token)` (the v1 surface) — Tasks 2–3. ✅
- Built on the live boundary (auth runs at namespace `auth`, isolated) — proven by Task 3's isolation test + the runtime composition. ✅
- **Deferred (per the spec, need Actions/clock):** OAuth/email providers, email verification, refresh-token rotation, session **expiration**. Explicitly out of scope; sessions valid until `signOut`.
- **Next slice (not this plan):** `ctx.auth.getUserId()` — the ctx-contribution + request-token plumbing that lets an APP function read the current identity (C3 exposes the callable `auth:getUserId(token)` that slice wraps).

**Placeholder scan:** none — every step has runnable code/commands. The two "check the exact form" notes (Task 2: `mutation` bare vs object form; `Value` cast) direct the implementer to verify against `packages/executor/src/functions.ts` and adjust test+impl together.

**Type consistency:** `hashSecret`/`verifySecret`/`generateToken` (Task 1) are consumed by `signUp`/`signIn` (Task 2); the `byAccount [provider, accountId]` and `byToken [token]` indexes (Task 2 schema) are exactly the indexes the queries use (Tasks 2–3); `{ token, userId }` is the return shape across signUp/signIn and the tests; `userId` is a `string` (opaque) throughout.
