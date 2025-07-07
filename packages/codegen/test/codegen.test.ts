import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { v, defineSchema, defineTable } from "@stackbase/values";
import {
  validatorToTsType,
  generateDataModel,
  generateApi,
  generateInternalApi,
  generateServer,
  generateAll,
  writeGenerated,
  type AnalyzedFunctionManifest,
} from "../src/index";

describe("validatorToTsType", () => {
  it("maps each validator kind to the right TS type", () => {
    expect(validatorToTsType(v.null().toJSON())).toBe("null");
    expect(validatorToTsType(v.boolean().toJSON())).toBe("boolean");
    expect(validatorToTsType(v.number().toJSON())).toBe("number");
    expect(validatorToTsType(v.int64().toJSON())).toBe("bigint");
    expect(validatorToTsType(v.string().toJSON())).toBe("string");
    expect(validatorToTsType(v.bytes().toJSON())).toBe("ArrayBuffer");
    expect(validatorToTsType(v.id("users").toJSON())).toBe('Id<"users">');
    expect(validatorToTsType(v.array(v.string()).toJSON())).toBe("Array<string>");
    expect(validatorToTsType(v.record(v.string(), v.number()).toJSON())).toBe("Record<string, number>");
  });

  it("emits literals and unions", () => {
    expect(validatorToTsType(v.literal("open").toJSON())).toBe('"open"');
    expect(validatorToTsType(v.literal(5).toJSON())).toBe("5");
    expect(validatorToTsType(v.literal(5n).toJSON())).toBe("5n");
    expect(validatorToTsType(v.literal(true).toJSON())).toBe("true");
    expect(validatorToTsType(v.union(v.literal("a"), v.literal("b")).toJSON())).toBe('("a" | "b")');
  });

  it("round-trips a v.object validator into an object type with optionality", () => {
    const validator = v.object({
      body: v.string(),
      authorId: v.id("users"),
      pinned: v.optional(v.boolean()),
      tags: v.array(v.string()),
    });
    expect(validatorToTsType(validator.toJSON())).toBe(
      '{ body: string; authorId: Id<"users">; pinned?: boolean; tags: Array<string> }',
    );
  });
});

const schema = defineSchema({
  users: defineTable({ name: v.string() }),
  conversations: defineTable({ title: v.string() }),
  messages: defineTable({
    conversationId: v.id("conversations"),
    authorId: v.id("users"),
    body: v.string(),
    pinned: v.optional(v.boolean()),
  }),
}).export();

const manifest: AnalyzedFunctionManifest = [
  {
    path: "messages",
    functions: [
      { name: "list", type: "query", visibility: "public", argsType: "{ conversationId: string }", returnsType: "any[]" },
      { name: "send", type: "mutation", visibility: "public", argsType: "{ conversationId: string; body: string }", returnsType: "string" },
      { name: "purge", type: "mutation", visibility: "internal" },
    ],
  },
];

describe("generateDataModel", () => {
  it("emits Doc/Id/DataModel with system + user fields", () => {
    const dm = generateDataModel(schema);
    expect(dm.path).toBe("dataModel.d.ts");
    expect(dm.content).toContain("export type TableNames = keyof DataModel;");
    expect(dm.content).toContain("export type Doc<TableName extends TableNames> = DataModel[TableName][\"document\"];");
    expect(dm.content).toContain("export type Id<TableName extends TableNames> = GenericId<TableName>;");
    expect(dm.content).toContain(
      'messages: { document: { _id: Id<"messages">; _creationTime: number; conversationId: Id<"conversations">; authorId: Id<"users">; body: string; pinned?: boolean } };',
    );
  });
});

describe("generateApi", () => {
  it("emits FunctionReferences for public functions and excludes internal ones", () => {
    const api = generateApi(manifest);
    expect(api.content).toContain("export type Api =");
    expect(api.content).toContain('"messages": {');
    expect(api.content).toContain('list: FunctionReference<"query", "public", { conversationId: string }, any[]>;');
    expect(api.content).toContain('send: FunctionReference<"mutation", "public", { conversationId: string; body: string }, string>;');
    expect(api.content).not.toContain("purge"); // internal
  });
});

describe("generateInternalApi", () => {
  it("emits FunctionReferences for internal functions and excludes public ones", () => {
    const internal = generateInternalApi(manifest);
    expect(internal.content).toContain("export type Internal =");
    expect(internal.content).toContain('"messages": {');
    expect(internal.content).toContain('purge: FunctionReference<"mutation", "internal", any, any>;');
    expect(internal.content).not.toContain("list:"); // public
    expect(internal.content).not.toContain("send:"); // public
  });
});

describe("generateServer", () => {
  it("re-exports the runtime function builders and the generated types", () => {
    const server = generateServer(schema);
    expect(server.content).toContain('export { query, mutation, action } from "@stackbase/executor";');
    expect(server.content).toContain('export type { DataModel, TableNames, Doc, Id } from "./dataModel";');
    expect(server.content).toContain('export type { Internal } from "./internal";');
  });

  it("emits runtime `api`/`internal` proxy values typed against the generated Api/Internal", () => {
    const server = generateServer(schema);
    expect(server.content).toContain('import { anyApi } from "@stackbase/client";');
    expect(server.content).toContain("export const api = anyApi as Api;");
    expect(server.content).toContain("export const internal = anyApi as Internal;");
  });

  it("re-exports a component's serverExports from its contextType.import", () => {
    const server = generateServer(schema, {
      components: [{ name: "scheduler", contextType: { import: "@stackbase/scheduler", type: "SchedulerContext" }, serverExports: ["cronJobs"] }],
    });
    expect(server.content).toContain('export { cronJobs } from "@stackbase/scheduler";');
  });

  it("does not emit a re-export for a component with serverExports but no contextType", () => {
    const server = generateServer(schema, { components: [{ name: "noCtx", serverExports: ["something"] }] });
    expect(server.content).not.toContain("something");
  });
});

describe("generated output is syntactically valid TypeScript", () => {
  const assertParses = (content: string, name: string) => {
    const out = ts.transpileModule(content, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
    });
    const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")), `${name} should parse`).toEqual([]);
  };

  it("dataModel, api, internal, and server all parse cleanly", () => {
    const bundle = generateAll({ schema, manifest });
    assertParses(bundle.dataModel.content, "dataModel.d.ts");
    assertParses(bundle.api.content, "api.d.ts");
    assertParses(bundle.internal.content, "internal.d.ts");
    assertParses(bundle.server.content, "server.ts");
  });
});

describe("writeGenerated", () => {
  it("writes every generated file to the output directory", () => {
    const bundle = generateAll({ schema, manifest });
    const dir = mkdtempSync(join(tmpdir(), "sb-codegen-"));
    const result = writeGenerated(bundle.files, dir);
    expect(result.written).toHaveLength(4);
    expect(existsSync(join(dir, "dataModel.d.ts"))).toBe(true);
    expect(existsSync(join(dir, "api.d.ts"))).toBe(true);
    expect(existsSync(join(dir, "internal.d.ts"))).toBe(true);
    expect(readFileSync(join(dir, "server.ts"), "utf8")).toContain("query, mutation, action");
  });
});
