import { describe, it, expect } from "vitest";
import { createTestHelipod } from "../../src";
import * as messages from "../fixtures/messages";
import schema from "../fixtures/schema";

it("t.run gives direct ctx.db access for setup and assertions", async () => {
  const t = await createTestHelipod({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
  try {
    const id = await t.run(async (ctx) => ctx.db.insert("messages", { body: "seeded" }));
    expect(typeof id).toBe("string");
    const rows = await t.query("messages:list", {});
    expect(rows).toHaveLength(1);
    const doc = await t.run(async (ctx) => ctx.db.get(id));
    expect(doc.body).toBe("seeded");
  } finally {
    await t.close();
  }
});
