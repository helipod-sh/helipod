import { describe, it, expect } from "vitest";
import { generateDataModel } from "../src/generate";

describe("codegen emits the _storage system table", () => {
  it("includes _storage in DataModel with its fields, even for an app with no user tables", () => {
    const schema = { tables: {}, schemaValidation: true };
    const out = generateDataModel(schema);
    expect(out.content).toContain("_storage:");
    expect(out.content).toContain("status:");
    expect(out.content).toContain('Id<"_storage">');
  });

  it("emits the full _storage document shape (nullable metadata + union literals)", () => {
    const out = generateDataModel({ tables: {}, schemaValidation: true });
    // status/visibility are unions of string literals; metadata fields are `T | null`.
    expect(out.content).toContain('("pending" | "ready")');
    expect(out.content).toContain('("private" | "public")');
    expect(out.content).toContain("size: (number | null)");
    expect(out.content).toContain("contentType: (string | null)");
    expect(out.content).toContain("sha256: (string | null)");
    expect(out.content).toContain("expiresAt: (number | null)");
    expect(out.content).toContain("key: string");
    // _id/_creationTime are auto-added like every table.
    expect(out.content).toContain('_id: Id<"_storage">');
    expect(out.content).toContain("_creationTime: number");
  });

  it("emits system tables alongside user tables and never lets a user table shadow one", () => {
    const userSchema = {
      schemaValidation: true,
      tables: {
        messages: {
          documentType: { type: "object", value: { body: { fieldType: { type: "string" }, optional: false } } },
          indexes: [],
          searchIndexes: [],
          vectorIndexes: [],
          shardKey: null,
          relations: [],
        },
      },
    } as const;
    const out = generateDataModel(userSchema as never);
    expect(out.content).toContain("_storage:");
    expect(out.content).toContain("messages:");
    // exactly one `_storage:` entry in the DataModel interface.
    expect(out.content.match(/_storage:/g)?.length).toBe(1);
  });
});
