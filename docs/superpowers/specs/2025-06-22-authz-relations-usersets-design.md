# authz Relationship Tuples + Single-Level Usersets — design

**Status:** approved (brainstorming) — 2025-06-22
**Slice:** `@stackbase/authz` — the ReBAC sharing primitive. Successor to the merged effectivePermissions slice (`25ba236`).
**Predecessor context:** Per-resource sharing exists today via developer-declared typed child tables (`.relation(name, { table, field })`) + the `{ some/is }` semi-join relation predicates. `can()`/`scopesWith()` are backed by the `effective_permissions` index. Read policies consume a set as `{ field: { in: await auth.setResolver(...) } }` (the `scopesWith` pattern). Invalidation is range-precise (a write only re-runs subscriptions whose read-set its range intersects).

---

## 1. Goal

A generic relationship-tuple store — `authz/relations` holding `(object, relation, subject)` tuples — with:
- `authz:addRelation` / `authz:removeRelation` (gated mutation modules) and `ctx.authz.hasRelation` / `ctx.authz.objectsWith` (facade reads).
- **Single-level usersets:** a tuple's subject may be a *userset* (a group, `team:eng#member`), so a resource shared with a group is visible to that group's members — and adding/removing a member propagates with **zero per-resource writes**.

This is the README's Level-3 "relations & sharing" capability. It coexists with the shipped `.relation()` typed-child-table mechanism (that stays for app-owned typed relations; this is authz's own generic sharing primitive).

---

## 2. Locked decisions (from brainstorming)

1. **One slice: the tuple store + single-level usersets.** The tuple store alone is weak sugar over `.relation()`; usersets are the actual capability and belong with it. Single-level = user → one group → object (the `team:eng#member` example).
2. **Deferred:** nested/transitive usersets (team-of-teams — a recursive closure + cycle + fan-out problem for its own slice); negative/exclusion relations; wildcard relations; folding relations into the `effective_permissions` RBAC index (relations stay data-driven, per-object).
3. **Share gate:** `addRelation`/`removeRelation` require `can(\`${object.type}:share\`, { type, id })` — a per-object *share* permission (enables user-driven sharing; composes with roles + the effective-permissions index). NOT admin-only.

---

## 3. Data model

One table, Zanzibar-shaped:

```ts
authz/relations: {
  objectType: string; objectId: string; relation: string;
  subjectType: string; subjectId: string; subjectRelation: string;
}
```

- **Direct user subject** → `subjectRelation = ""`: `(document, 1, viewer, user, alice, "")` = "alice is a viewer of document 1".
- **Userset subject** → `subjectRelation` set: `(document, 1, viewer, team, eng, "member")` = "members of team eng are viewers of document 1" (the `team:eng#member` userset).
- **Membership is a relation whose object is the group**: `(team, eng, member, user, alice, "")` = "alice is a member of team eng".

The model is uniform and closed: a userset's `subjectRelation` (e.g. `"member"`) is exactly the `relation` of the membership tuples that populate it.

**Indexes:**
- `byObject [objectType, objectId, relation, subjectType, subjectId, subjectRelation]` — point-read a specific tuple (for `hasRelation`, and idempotent add / exact remove).
- `bySubject [subjectType, subjectId, subjectRelation, relation]` — list the objects a subject relates to (for `objectsWith` and membership lookups).

---

## 4. Public API

### 4.1 Mutation modules (gated)
```ts
authz:addRelation({ subject, relation, object })
authz:removeRelation({ subject, relation, object })
```
- `subject`: `{ type: string; id: string }` (a user) or `{ type: string; id: string; relation: string }` (a userset, e.g. `{ type: "team", id: "eng", relation: "member" }`).
- `object`: `{ type: string; id: string }`.
- **Gate:** both require `can(\`${object.type}:share\`, { type: object.type, id: object.id })`. Managing a group's membership (`object.type === "team"`) therefore requires `team:share` on that team.
- `addRelation` is idempotent (skip if the exact tuple exists); `removeRelation` deletes the exact matching tuple(s).
- A missing `subject.relation` normalizes to `subjectRelation = ""` (direct user).

### 4.2 Facade reads
```ts
ctx.authz.hasRelation(subject, relation, object): Promise<boolean>
ctx.authz.objectsWith(relation, objectType): Promise<string[]>
```
- `hasRelation` — a specific relationship check (imperative; e.g. in a write policy or app code), with single-level userset expansion.
- `objectsWith(relation, objectType)` — the object ids of type `objectType` the **caller** relates to via `relation`, direct or through their groups. Used in read policies: `read: ({ auth }) => ({ _id: { in: await auth.objectsWith("viewer", "document") } })`, reusing the shipped semi-join `in` lowering. Anonymous caller → `[]`.

---

## 5. Single-level userset expansion

The membership relation is **not** hardcoded to `member` — a userset may use any relation (`team:eng#owner`). Expansion discovers the caller's memberships across all relations and matches each against the usersets that grant `rel`.

**Caller's memberships** = all tuples where the caller is a *direct* subject: `bySubject(user, u, "")` (eq on `subjectType=user`, `subjectId=u`, `subjectRelation=""`). Each such tuple `(objectType=gt, objectId=gid, relation=mRel)` means "u is `mRel` of `(gt, gid)`", i.e. u belongs to the userset `(gt, gid, mRel)`. (This scan also returns u's direct object-relations, which are harmless as userset candidates — they simply won't be referenced as a subject.)

**`objectsWith(rel, type)` for the caller `u`:**
1. **Direct:** `bySubject(user, u, "", rel)` → `objectId` where `objectType === type`.
2. **Memberships:** the caller's membership tuples (above) → usersets `(gt, gid, mRel)`.
3. **Group objects:** for each userset `(gt, gid, mRel)`, `bySubject(gt, gid, mRel, rel)` → `objectId` where `objectType === type`.
4. Union of (1) + (3), deduped.

**`hasRelation({ user, u }, rel, object)`:**
1. **Direct:** point-read `byObject(object.type, object.id, rel, user, u, "")` — exists?
2. **Via a userset:** for each of `u`'s membership usersets `(gt, gid, mRel)`, point-read `byObject(object.type, object.id, rel, gt, gid, mRel)` — exists?
3. `true` if (1) or any (2).

Exactly one level of group indirection (user → userset → object). Bounded by the caller's direct-membership count. A userset *subject* passed to `hasRelation` (e.g. "does `team:eng#member` have viewer on doc 1?") is a direct `byObject` point-read (no expansion — usersets expand only on the caller/user side).

---

## 6. Reactivity

Every read in `objectsWith`/`hasRelation` (the direct-subject scan, the membership scan, the per-group scans) goes through the txn-bound `ctx.db` reader, so its consumed index range joins the querying function's read-set. Consequences (range-precise, per the shipped invalidation):
- **Share/unshare** an object (`addRelation`/`removeRelation` on `(object, rel, subject)`) → re-runs subscriptions whose `objectsWith(rel, type)` read intersects that tuple's range.
- **Membership change** (`addRelation`/`removeRelation` on `(group, member, user)`) → re-runs subscriptions that read that user's membership scan → **the headline: adding alice to team eng live-reveals every doc shared with `team:eng#member`, with no per-doc writes.**

---

## 7. Guards & performance

- `addRelation` idempotent; `removeRelation` exact-match.
- `objectsWith` dedups object ids. Cost is O(direct tuples + caller's groups × group tuples) per evaluation — bounded, no closure. A user in many groups incurs more `bySubject` reads; documented. Nested groups (which would require transitive closure + cycle handling) are out of scope, so single-level cannot loop.
- Self-relation (`object === subject`) is allowed and unremarkable.
- No max-expansion guard needed (bounded by the caller's direct group membership, not a recursive graph).

---

## 8. Testing

- **Direct roundtrip:** `addRelation(alice, viewer, doc)`; `hasRelation(alice, viewer, doc)` = true; `objectsWith("viewer","document")` for alice = `[doc]`; `removeRelation` → both false/empty.
- **Userset headline:** `addRelation({user,alice}, member, {team,eng})` and `addRelation({team,eng,member}, viewer, {document,1})`; `hasRelation(alice, viewer, document:1)` = true; `objectsWith("viewer","document")` for alice = `["1"]`; remove alice from the team → both drop. A user NOT in the team → false.
- **Gate:** a caller lacking `documents:share` on the object → `addRelation` rejects (`/Forbidden/`); a caller granted `documents:share` on it (via a role) succeeds.
- **Reactive contract (headline):** a `documents` read policy `{ _id: { in: await auth.objectsWith("viewer", "document") } }`; a subscribed `docs:list`; adding the caller to a team that is a viewer of a doc live-reveals it; removing them hides it — asserted through the sync handler.
- **Regression:** RBAC, row-policy, relation-predicate, and effective-permissions suites stay green.

---

## 9. File structure

**New**
- `components/authz/src/relations.ts` — tuple normalization, `addRelationTuple`/`removeRelationTuple`, `hasRelation`, `objectsWith` (single-level expansion).
- `authz/relations` table (+ two indexes) in `components/authz/src/schema.ts`.
- `components/authz/test/relations.test.ts`.

**Modify**
- `components/authz/src/context.ts` — add `hasRelation`/`objectsWith` to the `AuthzContext` facade.
- `components/authz/src/functions.ts` — add `addRelation`/`removeRelation` to `authzModules(config)`.
- `components/authz/README.md` — document the tuple API, usersets, the share gate, and that it coexists with `.relation()`.

---

## 10. Out of scope (later slices)

Nested/transitive usersets (team-of-teams, membership closure, cycle handling, transitive read-set fan-out); negative/exclusion relations (`NOT` a member); wildcard/hierarchical relations; folding relation grants into the `effective_permissions` index (relations remain data-driven, evaluated per query); typed per-relation tables (the shipped `.relation()` covers that); a dashboard for browsing relations.
