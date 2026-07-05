import { describe, it, expect } from "vitest";
import { createTestHelipod } from "../../src";
import * as messages from "../fixtures/messages";
import schema from "../fixtures/schema";

describe("createTestHelipod — core", () => {
  it("runs a mutation then a query against the real engine (in-memory)", async () => {
    const t = await createTestHelipod({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
    try {
      const id = await t.mutation("messages:send", { body: "hi" });
      expect(typeof id).toBe("string");
      const rows = await t.query<{ body: string }[]>("messages:list", {});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe("hi");
    } finally {
      await t.close();
    }
  });

  it("rejects when a function throws", async () => {
    const t = await createTestHelipod({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
    try {
      await expect(t.query("messages:missing", {})).rejects.toThrow();
    } finally {
      await t.close();
    }
  });
});
