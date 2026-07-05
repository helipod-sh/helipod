import { describe, it, expect } from "vitest";
import { createTestHelipod } from "../../src";
import * as files from "../fixtures/files";
import { defineSchema } from "@helipod/values";

describe("ctx.storage", () => {
  it("ctx.storage works: generateUploadUrl (mutation) + store/get bytes (action)", async () => {
    const t = await createTestHelipod({
      modules: { "files.ts": files, "schema.ts": { default: defineSchema({}) } },
    });
    try {
      const up = await t.mutation<{ storageId: unknown }>("files:makeUpload", {});
      expect(up.storageId).toBeDefined();
      const id = await t.action<string>("files:storeBytes", { text: "hello" });
      expect(await t.action("files:readBytes", { id })).toBe("hello");
    } finally {
      await t.close();
    }
  });
});
