import { describe, it, expect } from "vitest";
import { resolveWhere, compileWhere, type RelationRegistry } from "../src/policy";
import { evaluateFilter } from "@helipod/query-engine";
import type { GuestDatabaseReader } from "../src/guest";
import type { DocumentValue } from "@helipod/docstore";

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
const ctx = { parentTable: "documents", relations, db: fakeDb, depth: 0 };

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
    expect(() => compileWhere({ x: { some: { a: 1 } } })).toThrow(/relation clause/);
    expect(() => compileWhere({ x: { is: { a: 1 } } })).toThrow(/relation clause/);
  });
});

describe("resolveWhere — none / every / isNot", () => {
  it("none → parent `_id notIn [matching back-refs]`", async () => {
    expect(await resolveWhere({ sharedWith: { none: { userId: "u1" } } }, ctx)).toEqual({
      op: "and", clauses: [{ op: "neq", field: "_id", value: "d3" }],
    });
  });

  it("every → parent `_id notIn [back-refs of children FAILING the leaf]` (vacuously true for none)", async () => {
    // children failing userId==u1 are s2 (userId u2) → back-ref d9 → notIn [d9]
    expect(await resolveWhere({ sharedWith: { every: { userId: "u1" } } }, ctx)).toEqual({
      op: "and", clauses: [{ op: "neq", field: "_id", value: "d9" }],
    });
  });

  it("isNot → parent `<fk> notIn [matching target _ids]`", async () => {
    expect(await resolveWhere({ orgId: { isNot: { ownerId: "u1" } } }, ctx)).toEqual({
      op: "and", clauses: [{ op: "neq", field: "orgId", value: "o1" }],
    });
  });

  it("empty match: none/isNot admit (notIn []→always-true)", async () => {
    expect(await resolveWhere({ sharedWith: { none: { userId: "nobody" } } }, ctx)).toEqual({ op: "and", clauses: [] });
  });

  it("null/missing to-one fk is excluded from isNot (fail-closed)", async () => {
    const expr = await resolveWhere({ orgId: { isNot: { ownerId: "u1" } } }, ctx); // orgId notIn [o1]
    // a parent doc with NO orgId field must NOT match (missing field fails neq)
    expect(evaluateFilter({ _id: "x", title: "no-org" } as never, expr!)).toBe(false);
    // a doc whose orgId is o2 (not o1) matches
    expect(evaluateFilter({ _id: "y", orgId: "o2" } as never, expr!)).toBe(true);
  });

  it("every is vacuously true — a parent with zero related rows is admitted", async () => {
    const expr = await resolveWhere({ sharedWith: { every: { userId: "u1" } } }, ctx);
    // "d_none" has no document_shares rows referencing it → not excluded → visible
    expect(evaluateFilter({ _id: "d_none", title: "no shares" } as never, expr!)).toBe(true);
  });
});

describe("resolveWhere — multi-level chains", () => {
  // documents --sharedWith(some)--> document_shares --team(is)--> teams --members(some)--> team_members
  const CHILD2 = {
    document_shares: [{ _id: "s1", documentId: "d3", team: "t1", _creationTime: 1 }],
    teams: [{ _id: "t1", _creationTime: 1 }, { _id: "t2", _creationTime: 2 }],
    team_members: [{ _id: "m1", teamId: "t1", userId: "u1", _creationTime: 1 }],
  } as Record<string, unknown[]>;
  const db2 = { query: (t: string) => ({ collect: async () => CHILD2[t] ?? [] }) } as never;
  const relations2 = {
    toMany: new Map([
      ["documents", new Map([["sharedWith", { table: "document_shares", field: "documentId" }]])],
      ["teams", new Map([["members", { table: "team_members", field: "teamId" }]])],
    ]),
    toOne: new Map([["document_shares", new Map([["team", "teams"]])]]),
  } as never;
  const ctx2 = { parentTable: "documents", relations: relations2, db: db2, depth: 0 };

  it("resolves a 3-hop chain to the correct parent membership", async () => {
    // doc d3 is shared with team t1, and u1 is a member of t1 → d3 visible
    expect(await resolveWhere(
      { sharedWith: { some: { team: { is: { members: { some: { userId: "u1" } } } } } } }, ctx2,
    )).toEqual({ op: "or", clauses: [{ op: "eq", field: "_id", value: "d3" }] });
  });

  it("throws when nesting exceeds max depth 4", async () => {
    // self-referential node.parent chain, 5 `is` levels deep
    const nodeRel = { toMany: new Map(), toOne: new Map([["node", new Map([["parent", "node"]])]]) } as never;
    const nctx = { parentTable: "node", relations: nodeRel, db: { query: () => ({ collect: async () => [] }) } as never, depth: 0 };
    const p5 = { parent: { is: { parent: { is: { parent: { is: { parent: { is: { parent: { is: { x: 1 } } } } } } } } } } };
    await expect(resolveWhere(p5, nctx)).rejects.toThrow(/max depth 4/);
  });
});

describe("compileWhere guard covers all relation keys", () => {
  it("throws on none/every/isNot keys too", () => {
    for (const k of ["none", "every", "isNot"]) {
      expect(() => compileWhere({ x: { [k]: { a: 1 } } } as never)).toThrow(/relation clause/);
    }
  });
});

describe("compileWhere — unknown field operator guard", () => {
  it("throws on an unrecognized field operator (e.g. contains)", () => {
    expect(() => compileWhere({ x: { contains: "a" } } as never)).toThrow(/unknown field operator/);
  });

  it("a recognized field operator (eq) still compiles correctly", () => {
    expect(compileWhere({ x: { eq: 1 } })).toEqual({ op: "eq", field: "x", value: 1 });
  });

  it("an empty FieldOps object does NOT throw and resolves to always-true", () => {
    expect(() => compileWhere({ x: {} })).not.toThrow();
    expect(compileWhere({ x: {} })).toEqual({ op: "and", clauses: [] });
  });
});
