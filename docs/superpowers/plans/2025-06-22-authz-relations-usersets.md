# authz Relationship Tuples + Single-Level Usersets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `authz/relations` tuple store with `addRelation`/`removeRelation`/`hasRelation`/`objectsWith` and single-level usersets, so a resource shared with a group is visible to its members — with membership changes propagating reactively and zero per-resource writes.

**Architecture:** One Zanzibar-shaped table `authz/relations (objectType,objectId,relation,subjectType,subjectId,subjectRelation)` where membership is just a relation whose object is the group. Pure helpers in `relations.ts` do add/remove/hasRelation/objectsWith with one level of userset expansion (user → group → object, any membership relation). `addRelation`/`removeRelation` are gated mutation modules; `hasRelation`/`objectsWith` are facade reads consumed by read policies via the shipped `{ _id: { in: … } }` path. Reactive via the shipped range-precise invalidation.

**Tech Stack:** TypeScript, Bun (package manager + runtime), Turborepo, vitest. Builds on the shipped authz component (`authzModules(config)` factory, `AuthzContext` facade with `uid()`/`can()`, the `effective_permissions` index that backs the `can()` share-gate).

## Global Constraints

- **Bun toolchain:** `bun run build`, `bun run typecheck`, `bun run test`; single package `bun run --filter <pkg> test`. Never pnpm/npm.
- **Tuple model:** `authz/relations { objectType, objectId, relation, subjectType, subjectId, subjectRelation }`. Direct user subject → `subjectRelation = ""`; userset subject → `subjectRelation` set (e.g. `team:eng#member` = `(team, eng, "member")`); membership → `(group, memberRel, user, "")`.
- **Single-level usersets only:** user → group → object, one hop. The membership relation is NOT hardcoded (`member`, `owner`, … all work). No nested groups (out of scope).
- **Share gate:** `addRelation`/`removeRelation` require `can(\`${object.type}:share\`, { type: object.type, id: object.id })`.
- **Reads join the read-set** (facade reads go through the txn-bound `cctx.db`), so sharing/unsharing and membership changes are reactive (range-precise).
- **Coexists** with the shipped `.relation()` typed-child-table mechanism — additive, not a replacement.
- **TDD, frequent commits.** Each task ends green (`build`/`typecheck`/`test`) with one commit.
- `noUncheckedIndexedAccess: true`.

---

## File Structure

- `components/authz/src/relations.ts` (**new**) — `RelSubject`/`RelObject` types; `addRelationTuple`, `removeRelationTuple`, `hasRelation`, `objectsWith`.
- `components/authz/src/schema.ts` (**modify**) — `relations` table + `byObject`/`bySubject` indexes.
- `components/authz/src/context.ts` (**modify**) — `hasRelation`/`objectsWith` on the `AuthzContext` facade.
- `components/authz/src/functions.ts` (**modify**) — `addRelation`/`removeRelation` in `authzModules`.
- `components/authz/src/index.ts` (**modify**) — export `relations.ts`.
- `components/authz/README.md` (**modify**) — the tuple API, usersets, share gate.
- Tests: `components/authz/test/relations.test.ts`.

---

## Task 1: `relations` table + helpers + facade reads

**Files:**
- Create: `components/authz/src/relations.ts`
- Modify: `components/authz/src/schema.ts`, `components/authz/src/context.ts`, `components/authz/src/index.ts`
- Test: `components/authz/test/relations.test.ts`

**Interfaces:**
- Consumes: `GuestDatabaseWriter`/`GuestDatabaseReader` (type) from `@stackbase/executor`; the facade's `uid()` caller-resolver + `cctx.db` (used exactly as `scopesWith` does).
- Produces:
  - `RelSubject = { type: string; id: string; relation?: string }`; `RelObject = { type: string; id: string }`.
  - `addRelationTuple(db, subject: RelSubject, relation: string, object: RelObject): Promise<void>` (idempotent).
  - `removeRelationTuple(db, subject, relation, object): Promise<void>`.
  - `hasRelation(db, subject: RelSubject, relation: string, object: RelObject): Promise<boolean>` (single-level expansion).
  - `objectsWith(db, userId: string, relation: string, objectType: string): Promise<string[]>`.
  - `AuthzContext` gains `hasRelation(subject, relation, object): Promise<boolean>` and `objectsWith(relation, objectType): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

Create `components/authz/test/relations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

function systemModules(): Record<string, RegisteredFunction> {
  return { "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.insert(a.table, a.fields as any)) };
}
const authz = defineAuthz({ roles: { admin: { "*": ["*"] } } });

async function makeRuntime() {
  const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
    "me:objectsWith": query(async (ctx, { rel, type }: { rel: string; type: string }) =>
      (ctx as unknown as { authz: { objectsWith(r: string, t: string): Promise<string[]> } }).authz.objectsWith(rel, type)),
    "check:has": query(async (ctx, a: { subject: any; relation: string; object: any }) =>
      (ctx as unknown as { authz: { hasRelation(s: any, r: string, o: any): Promise<boolean> } }).authz.hasRelation(a.subject, a.relation, a.object)),
  } }, [auth, authz]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps });
}
const seedRel = (r: EmbeddedRuntime, f: Record<string, string>) =>
  r.runSystem("_system:insertDocument", { table: "authz/relations", fields: { subjectRelation: "", ...f } });

describe("relations reads + single-level usersets", () => {
  it("objectsWith and hasRelation resolve direct + userset; removal drops them", async () => {
    const r = await makeRuntime();
    const alice = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "alice@b.co", password: "pw" })).value;
    // alice is a direct viewer of document 2
    await seedRel(r, { objectType: "document", objectId: "2", relation: "viewer", subjectType: "user", subjectId: alice.userId });
    // team eng#member is a viewer of document 1; alice is a member of team eng
    await seedRel(r, { objectType: "document", objectId: "1", relation: "viewer", subjectType: "team", subjectId: "eng", subjectRelation: "member" });
    const membershipId = (await seedRel(r, { objectType: "team", objectId: "eng", relation: "member", subjectType: "user", subjectId: alice.userId })).value;

    // objectsWith (as alice) → doc 1 (via team) + doc 2 (direct)
    expect((await r.run<string[]>("me:objectsWith", { rel: "viewer", type: "document" }, { identity: alice.token })).value.sort()).toEqual(["1", "2"]);
    // hasRelation: alice is a viewer of doc 1 via the userset
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: alice.userId }, relation: "viewer", object: { type: "document", id: "1" } })).value).toBe(true);
    // a different user (bob) is not
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: "bob" }, relation: "viewer", object: { type: "document", id: "1" } })).value).toBe(false);

    // remove alice from team eng → she loses doc 1 (keeps direct doc 2)
    await r.runSystem("_system:deleteDocument", { id: membershipId });
    expect((await r.run<string[]>("me:objectsWith", { rel: "viewer", type: "document" }, { identity: alice.token })).value).toEqual(["2"]);
    // anonymous → []
    expect((await r.run<string[]>("me:objectsWith", { rel: "viewer", type: "document" })).value).toEqual([]);
  });
});
```

> This test seeds tuples via the privileged `_system` path (full table name `authz/relations`) and needs `_system:deleteDocument`; add it to `systemModules()` if missing: `"_system:deleteDocument": mutation(async (ctx, a: { id: string }) => { await ctx.db.delete(a.id); return null; })`.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/authz test relations`
Expected: FAIL — the `relations` table / `objectsWith` / `hasRelation` don't exist.

- [ ] **Step 3: Add the `relations` table (`schema.ts`)**

Add to `authzSchema`:

```ts
  relations: defineTable({
    objectType: v.string(), objectId: v.string(), relation: v.string(),
    subjectType: v.string(), subjectId: v.string(), subjectRelation: v.string(),
  }).index("byObject", ["objectType", "objectId", "relation", "subjectType", "subjectId", "subjectRelation"])
    .index("bySubject", ["subjectType", "subjectId", "subjectRelation", "relation"]),
```

- [ ] **Step 4: Implement `relations.ts`**

Create `components/authz/src/relations.ts`:

```ts
import type { GuestDatabaseReader, GuestDatabaseWriter } from "@stackbase/executor";

export interface RelSubject { type: string; id: string; relation?: string }
export interface RelObject { type: string; id: string }

/** The subject's (type, id, subjectRelation) triple; a missing `relation` means a direct subject. */
function subj(s: RelSubject): [string, string, string] { return [s.type, s.id, s.relation ?? ""]; }

/** Query a specific object#relation@subject tuple (exact point-read via byObject). */
function tupleRows(db: GuestDatabaseReader, obj: RelObject, relation: string, st: string, si: string, sr: string) {
  return db.query("relations", "byObject")
    .eq("objectType", obj.type).eq("objectId", obj.id).eq("relation", relation)
    .eq("subjectType", st).eq("subjectId", si).eq("subjectRelation", sr).collect();
}

export async function addRelationTuple(db: GuestDatabaseWriter, subject: RelSubject, relation: string, object: RelObject): Promise<void> {
  const [st, si, sr] = subj(subject);
  if ((await tupleRows(db, object, relation, st, si, sr)).length > 0) return; // idempotent
  await db.insert("relations", { objectType: object.type, objectId: object.id, relation, subjectType: st, subjectId: si, subjectRelation: sr });
}

export async function removeRelationTuple(db: GuestDatabaseWriter, subject: RelSubject, relation: string, object: RelObject): Promise<void> {
  const [st, si, sr] = subj(subject);
  for (const row of await tupleRows(db, object, relation, st, si, sr)) await db.delete(row._id as string);
}

/** The usersets a direct subject belongs to: every tuple where it is a direct subject → (objectType, objectId, relation). */
async function memberships(db: GuestDatabaseReader, st: string, si: string): Promise<Array<[string, string, string]>> {
  const rows = await db.query("relations", "bySubject").eq("subjectType", st).eq("subjectId", si).eq("subjectRelation", "").collect();
  return rows.map((r) => [r.objectType as string, r.objectId as string, r.relation as string]);
}

/** Does `subject` have `relation` to `object`? Direct, or (for a direct subject) via one of its usersets. */
export async function hasRelation(db: GuestDatabaseReader, subject: RelSubject, relation: string, object: RelObject): Promise<boolean> {
  const [st, si, sr] = subj(subject);
  if ((await tupleRows(db, object, relation, st, si, sr)).length > 0) return true;
  if (sr !== "") return false; // a userset subject is checked directly only
  for (const [gt, gid, mRel] of await memberships(db, st, si))
    if ((await tupleRows(db, object, relation, gt, gid, mRel)).length > 0) return true;
  return false;
}

/** Object ids of type `objectType` that `userId` has `relation` to — direct or via a group they belong to. */
export async function objectsWith(db: GuestDatabaseReader, userId: string, relation: string, objectType: string): Promise<string[]> {
  const out = new Set<string>();
  const direct = await db.query("relations", "bySubject").eq("subjectType", "user").eq("subjectId", userId).eq("subjectRelation", "").eq("relation", relation).collect();
  for (const r of direct) if (r.objectType === objectType) out.add(r.objectId as string);
  for (const [gt, gid, mRel] of await memberships(db, "user", userId)) {
    const grp = await db.query("relations", "bySubject").eq("subjectType", gt).eq("subjectId", gid).eq("subjectRelation", mRel).eq("relation", relation).collect();
    for (const r of grp) if (r.objectType === objectType) out.add(r.objectId as string);
  }
  return [...out];
}
```

> Note: `memberships` reads ALL of the subject's direct tuples (its usersets *and* its direct object-relations); the direct object-relations simply won't be referenced as a subject elsewhere, so they're harmless. This scan is the caller's whole direct-subject range — bounded, and the read-set that makes membership changes reactive.

Append to `components/authz/src/index.ts`:

```ts
export * from "./relations";
```

- [ ] **Step 5: Add `hasRelation`/`objectsWith` to the facade (`context.ts`)**

Add to the `AuthzContext` interface:

```ts
  hasRelation(subject: { type: string; id: string; relation?: string }, relation: string, object: { type: string; id: string }): Promise<boolean>;
  objectsWith(relation: string, objectType: string): Promise<string[]>;
```

Add the import:

```ts
import { hasRelation as relHasRelation, objectsWith as relObjectsWith } from "./relations";
```

Add to the returned facade object (alongside `can`/`scopesWith`; reuse the same `uid()` caller-resolver `scopesWith` uses):

```ts
    async hasRelation(subject, relation, object) {
      return relHasRelation(cctx.db, subject, relation, object);
    },
    async objectsWith(relation, objectType) {
      const u = await uid(); if (!u) return [];
      return relObjectsWith(cctx.db, u, relation, objectType);
    },
```

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/authz test relations`
Expected: PASS — direct + userset resolution; removal drops; anonymous → [].

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (additive; the new table/facade methods don't touch existing behavior).

```bash
git add components/authz/src/relations.ts components/authz/src/schema.ts components/authz/src/context.ts components/authz/src/index.ts components/authz/test/relations.test.ts
git commit -m "feat(authz): relations table + hasRelation/objectsWith facade (single-level usersets)"
```

---

## Task 2: `addRelation`/`removeRelation` modules + reactive sharing contract

**Files:**
- Modify: `components/authz/src/functions.ts`, `components/authz/README.md`
- Test: extend `components/authz/test/relations.test.ts`

**Interfaces:**
- Consumes: Task 1's `RelSubject`/`RelObject`/`addRelationTuple`/`removeRelationTuple`; the facade `objectsWith` (Task 1); the `authzModules(config)` factory + `WithAuthz`/`GuestDatabaseWriter` already in `functions.ts`.
- Produces: `authz:addRelation` / `authz:removeRelation` modules, gated by `can(\`${object.type}:share\`, { type, id })`.

- [ ] **Step 1: Write the failing test**

First extend the test file's `@stackbase/values` import (Task 1 imported only `defineSchema`) to `import { defineSchema, defineTable, v } from "@stackbase/values";` — the reactive test defines a `documents` table. Then append:

```ts
describe("addRelation/removeRelation (gated) + reactive sharing", () => {
  it("share gate: only a caller with <type>:share on the object may add/remove", async () => {
    const r = await makeRuntime();
    const admin = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "admin@b.co", password: "pw" })).value;
    // bootstrap admin with the superadmin role "admin" ({"*":["*"]}) → holds document:share (via *:*)
    await r.run("authz:bootstrapFirstAdmin", { userId: admin.userId, role: "admin" });
    const mallory = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "m@b.co", password: "pw" })).value;

    // mallory has no document:share → rejected
    await expect(r.run("authz:addRelation", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } }, { identity: mallory.token })).rejects.toThrow(/Forbidden/);
    // admin can share
    await expect(r.run("authz:addRelation", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } }, { identity: admin.token })).resolves.toBeDefined();
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } })).value).toBe(true);
    await r.run("authz:removeRelation", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } }, { identity: admin.token });
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } })).value).toBe(false);
  });

  it("REACTIVE headline: adding a caller to a viewer-team live-reveals the shared doc (zero per-doc writes)", async () => {
    // A `documents` read policy filtered by the caller's objectsWith("viewer","document").
    // `read` may be async and return a WhereInput; `RuleAuth.objectsWith` is added in Step 3.
    const appSchema = defineSchema({ documents: defineTable({ title: v.string() }) });
    const c = composeComponents({ schemaJson: appSchema.export(), moduleMap: {
      "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
    } }, [auth, defineAuthz({ roles: { admin: { "*": ["*"] } }, policies: {
      documents: { read: async ({ auth }) => ({ _id: { in: await auth.objectsWith("viewer", "document") } }) },
    } })]);
    const r = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps });
    const admin = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "admin@b.co", password: "pw" })).value;
    await r.run("authz:bootstrapFirstAdmin", { userId: admin.userId, role: "admin" });
    const alice = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "alice@b.co", password: "pw" })).value;
    const doc1 = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "spec" } })).value;
    await r.run("authz:addRelation", { subject: { type: "team", id: "eng", relation: "member" }, relation: "viewer", object: { type: "document", id: doc1 } }, { identity: admin.token });

    const sent: any[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    const last = (): unknown => {
      for (let i = sent.length - 1; i >= 0; i--)
        for (const m of [...(sent[i]?.modifications ?? [])].reverse())
          if (m.type === "QueryUpdated" && m.queryId === 1) return m.value;
      return undefined;
    };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: alice.token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:list", args: {} }], remove: [] }));
    expect(last()).toEqual([]); // alice not on the team yet

    await r.run("authz:addRelation", { subject: { type: "user", id: alice.userId }, relation: "member", object: { type: "team", id: "eng" } }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect((last() as any[]).map((d) => d.title)).toEqual(["spec"]); // joined team → doc appears live

    await r.run("authz:removeRelation", { subject: { type: "user", id: alice.userId }, relation: "member", object: { type: "team", id: "eng" } }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]); // left team → doc hidden live
  });
});
```

> Two implementer notes for the reactive test: (1) the read policy calls `auth.objectsWith(...)`, so `RuleAuth` (in `components/authz/src/policies.ts`, `buildRuleAuth`) must expose `objectsWith` — add it delegating to the `ctx.authz` facade exactly as `scopesWith` is delegated. (2) The policy body must `await`/`.then` the async `objectsWith` and return a `WhereInput` — the shown `.then((ids) => ({ _id: { in: ids } }))` form works because `read` may return a `Promise<PolicyPredicate>`.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/authz test relations`
Expected: FAIL — `authz:addRelation`/`removeRelation` don't exist; `auth.objectsWith` not on `RuleAuth`.

- [ ] **Step 3: Add `objectsWith` to `RuleAuth` (`policies.ts`)**

In `components/authz/src/policies.ts`, `buildRuleAuth` builds the rule-context `auth` from the `authz` facade. Add `objectsWith` and `hasRelation` to the returned object, delegating to the facade (mirror the existing `scopesWith` delegation):

```ts
    objectsWith: (relation, objectType) => authzFacade.objectsWith(relation, objectType),
    hasRelation: (subject, relation, object) => authzFacade.hasRelation(subject, relation, object),
```

Add the corresponding fields to the `AuthzFacade`/`RuleAuth` type(s) used there (mirror `scopesWith`'s signature).

- [ ] **Step 4: Add the gated modules (`functions.ts`)**

Add the import:

```ts
import { addRelationTuple, removeRelationTuple, type RelSubject, type RelObject } from "./relations";
```

Inside `authzModules(config)`, before `return`:

```ts
  const addRelation = mutation(async (ctx, { subject, relation, object }: { subject: RelSubject; relation: string; object: RelObject }) => {
    await (ctx as unknown as WithAuthz).authz.require(`${object.type}:share`, { type: object.type, id: object.id });
    await addRelationTuple(ctx.db as unknown as GuestDatabaseWriter, subject, relation, object);
    return null;
  });
  const removeRelation = mutation(async (ctx, { subject, relation, object }: { subject: RelSubject; relation: string; object: RelObject }) => {
    await (ctx as unknown as WithAuthz).authz.require(`${object.type}:share`, { type: object.type, id: object.id });
    await removeRelationTuple(ctx.db as unknown as GuestDatabaseWriter, subject, relation, object);
    return null;
  });
```

Add `addRelation`, `removeRelation` to the returned modules object (alongside `assignRole`, `revokeRole`, `rebuild`, `bootstrapFirstAdmin`).

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/authz test relations`
Expected: PASS — gate rejects a caller without `document:share`, allows the admin; the reactive test flips `docs:list` `[]`→`[spec]` when alice joins the team and back when she leaves.

- [ ] **Step 6: Document in `components/authz/README.md`**

In the "Relations & sharing" region, add a concise note:

```markdown
**Relationship tuples & usersets.** `authz:addRelation({ subject, relation, object })` / `removeRelation(...)`
write `(object, relation, subject)` tuples into `authz/relations`; both require `can(\`${object.type}:share\`,
{ type, id })` (a per-object *share* permission — grant it to owners). `subject` is a user `{ type, id }` or a
**userset** `{ type, id, relation }` (e.g. `{ type: "team", id: "eng", relation: "member" }` = `team:eng#member`).
Membership is just a relation whose object is the group: `addRelation({ type:"user", id }, "member", { type:"team", id:"eng" })`.

- `ctx.authz.hasRelation(subject, relation, object)` — a specific check (single-level userset expansion).
- `ctx.authz.objectsWith(relation, objectType)` — the object ids the caller relates to (direct + via their groups),
  for read policies: `read: ({ auth }) => ({ _id: { in: await auth.objectsWith("viewer", "document") } })`.

Both are **reactive**: sharing/unsharing and membership changes live-update subscriptions — adding someone to a
team reveals every resource shared with `team:…#member`, with zero per-resource writes. Only single-level usersets
(user → group → object) are supported; nested groups are not yet. This coexists with the typed `.relation()` predicates.
```

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (all prior authz/engine suites green).

```bash
git add components/authz/src/functions.ts components/authz/src/policies.ts components/authz/README.md components/authz/test/relations.test.ts
git commit -m "feat(authz): addRelation/removeRelation (share-gated) + reactive userset sharing; RuleAuth.objectsWith"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 tuple model + indexes → Task 1 schema. §4.1 add/remove modules + gate → Task 2. §4.2 hasRelation/objectsWith facade → Task 1. §5 single-level expansion (any membership relation) → Task 1 `relations.ts`. §6 reactivity → Task 2 reactive test. §7 guards (idempotent/dedup/bounded) → Task 1. §8 testing → Tasks 1–2. §9 file structure → matches. §10 out-of-scope → not built. ✅ (Task 2 also adds `objectsWith`/`hasRelation` to `RuleAuth` so read policies can call them — an integration point the spec implies in its `objectsWith` policy example but doesn't spell out; called out explicitly in Task 2 Step 3.)

**Placeholder scan:** No TBD/TODO; every product-code and test step is complete, executable code. The reactive test's read policy uses `async ({ auth }) => ({ _id: { in: await auth.objectsWith(...) } })` (an async `read` returning a `WhereInput`, which `resolveReadPolicy` awaits) and depends on Task 2 Step 3 adding `objectsWith` to `RuleAuth` — both stated explicitly. ✅

**Type consistency:** `RelSubject`/`RelObject` defined in Task 1, consumed by Task 2's modules. `addRelationTuple`/`removeRelationTuple`/`hasRelation`/`objectsWith` signatures identical between `relations.ts` (Task 1) and their callers (facade Task 1, modules Task 2, RuleAuth Task 2). Index names `byObject`/`bySubject` and field order consistent between schema (Task 1) and all `.eq(...)` chains. The share-gate string `\`${object.type}:share\`` matches the spec's §5 gate. ✅
```
