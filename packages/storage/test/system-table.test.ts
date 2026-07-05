import { describe, it, expect } from "vitest";
import { v, validate, isValid } from "@helipod/values";
import { STORAGE_TABLE, STORAGE_TABLE_NUMBER, storageTableDefinition } from "../src/index";

describe("_storage system-table definition", () => {
  it("names the reserved table and stable number", () => {
    expect(STORAGE_TABLE).toBe("_storage");
    expect(STORAGE_TABLE_NUMBER).toBe(20);
  });

  it("has exactly the seven document fields (no _id/_creationTime — those are auto-added)", () => {
    const fields = Object.keys(storageTableDefinition.fields).sort();
    expect(fields).toEqual(
      ["contentType", "expiresAt", "key", "sha256", "size", "status", "visibility"].sort(),
    );
  });

  it("validates a well-formed pending row (nullable metadata present-and-null)", () => {
    const pending = {
      status: "pending",
      key: "u/abc",
      size: null,
      contentType: null,
      sha256: null,
      visibility: "private",
      expiresAt: null,
    };
    expect(validate(storageTableDefinition.documentValidator, pending)).toEqual([]);
  });

  it("validates a well-formed ready row and rejects a bad status literal", () => {
    const ready = {
      status: "ready",
      key: "u/abc",
      size: 1234,
      contentType: "image/png",
      sha256: "deadbeef",
      visibility: "public",
      expiresAt: 1730000000000,
    };
    expect(isValid(storageTableDefinition.documentValidator, ready)).toBe(true);
    expect(isValid(storageTableDefinition.documentValidator, { ...ready, status: "bogus" })).toBe(false);
  });
});

describe("Id<\"_storage\"> is a valid runtime reference on a user table", () => {
  // The id validator's runtime `check` only asserts the id is a string (the table name is a
  // compile-time brand), so a user field typed `v.id(\"_storage\")` validates as long as its value
  // is a string. This proves the round-trip point 2 of the task at the unit level; the id CODEC's
  // table-number stability is proven in @helipod/id-codec's registry test.
  const userTable = v.object({ image: v.id("_storage"), caption: v.string() });

  it("accepts a document whose image field is a storage id string", () => {
    expect(isValid(userTable, { image: "storage_id_string", caption: "hi" })).toBe(true);
  });

  it("rejects a non-string in the storage id field", () => {
    const failures = validate(userTable, { image: 123, caption: "hi" });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.message).toContain('Id<"_storage">');
  });
});
