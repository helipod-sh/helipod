import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import { me, identityProbe } from "../fixtures/whoami";
import { defineSchema } from "@stackbase/values";

it("withIdentity sets the ambient identity token on the same backend (via a context provider — the real path)", async () => {
  const t = await createTestStackbase({
    modules: { "whoami.ts": { me }, "schema.ts": { default: defineSchema({}) } },
    components: [identityProbe],
  });
  try {
    expect(await t.query("whoami:me", {})).toBeNull();
    const asAda = t.withIdentity("ada-token");
    expect(await asAda.query("whoami:me", {})).toBe("ada-token");
    expect(await t.query("whoami:me", {})).toBeNull(); // base view unaffected
  } finally {
    await t.close();
  }
});
