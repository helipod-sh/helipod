import { describe, it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import * as files from "../fixtures/files";
import { defineSchema } from "@stackbase/values";

describe("ctx.storage", () => {
  it("ctx.storage works: generateUploadUrl (mutation) + store/get bytes (action)", async () => {
    const t = await createTestStackbase({
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
