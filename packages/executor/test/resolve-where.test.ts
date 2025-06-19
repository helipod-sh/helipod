import { describe, it, expect } from "vitest";
import { resolveWhere, compileWhere, type RelationRegistry } from "../src/policy";
import type { GuestDatabaseReader } from "../src/guest";
import type { DocumentValue } from "@stackbase/docstore";

const CHILD: Record<string, DocumentValue[]> = {
  document_shares: [
    { _id: "s1", documentId: "d3", userId: "u1", _creationTime: 1 } as unknown as DocumentValue,
    { _id: "s2", documentId: "d9", userId: "u2", _creationTime: 2 } as unknown as DocumentValue,
  ],
  orgs: [
    { _id: "o1", ownerId: "u1", _creationTime: 1 } as unknown as DocumentValue,
    { _id: "o2", ownerId: "u2", _creationTime: 2 } as unknown as DocumentValue,
  ],
};
const fakeDb = { query: (t: string) => ({ collect: async () => CHILD[t] ?? [] }) } as unknown as GuestDatabaseReader;
const relations: RelationRegistry = {
  toMany: new Map([["documents", new Map([["sharedWith", { table: "document_shares", field: "documentId" }]])]]),
  toOne: new Map([["documents", new Map([["orgId", "orgs"]])]]),
};
const ctx = { parentTable: "documents", relations, db: fakeDb };

describe("resolveWhere", () => {
  it("some → parent `_id in [collected back-refs]`", async () => {
    expect(await resolveWhere({ sharedWith: { some: { userId: "u1" } } }, ctx)).toEqual({
      op: "or", clauses: [{ op: "eq", field: "_id", value: "d3" }],
    });
  });

  it("is → parent `<fk> in [matching target _ids]`", async () => {
    expect(await resolveWhere({ orgId: { is: { ownerId: "u1" } } }, ctx)).toEqual({
      op: "or", clauses: [{ op: "eq", field: "orgId", value: "o1" }],
    });
  });

  it("empty match → always-false (deny)", async () => {
    expect(await resolveWhere({ sharedWith: { some: { userId: "nobody" } } }, ctx)).toEqual({ op: "or", clauses: [] });
  });

  it("combines field + relation clauses under OR", async () => {
    const r = await resolveWhere({ OR: [{ ownerId: "u1" }, { sharedWith: { some: { userId: "u1" } } }] }, ctx);
    expect(r).toEqual({
      op: "or",
      clauses: [
        { op: "eq", field: "ownerId", value: "u1" },
        { op: "or", clauses: [{ op: "eq", field: "_id", value: "d3" }] },
      ],
    });
  });

  it("a no-relation predicate resolves like compileWhere", async () => {
    expect(await resolveWhere({ ownerId: "u1" }, ctx)).toEqual(compileWhere({ ownerId: "u1" }));
  });

  it("throws on an unknown relation name", async () => {
    await expect(resolveWhere({ nope: { some: { userId: "u1" } } }, ctx)).rejects.toThrow(/unknown relation "nope"/);
  });

  it("throws on `is` over a non-reference field", async () => {
    await expect(resolveWhere({ ownerId: { is: { x: 1 } } }, ctx)).rejects.toThrow(/not a reference/);
  });
});

describe("compileWhere relation-key guard", () => {
  it("throws on a some/is key (nested relations are a hard error, never silent-allow)", () => {
    expect(() => compileWhere({ x: { some: { a: 1 } } })).toThrow(/relation clauses .* top level/);
    expect(() => compileWhere({ x: { is: { a: 1 } } })).toThrow(/relation clauses .* top level/);
  });
});
