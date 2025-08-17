import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import * as http from "../fixtures/http";
import { identityProbe } from "../fixtures/whoami";
import { defineSchema } from "@stackbase/values";

it("t.fetch threads a view's withIdentity through to the httpAction's ctx identity", async () => {
  const t = await createTestStackbase({
    modules: { "http.ts": http, "schema.ts": { default: defineSchema({}) } },
    components: [identityProbe],
  });
  try {
    const base = await t.fetch(new Request("http://localhost/whoami"));
    expect(await base.json()).toEqual({ identity: null });

    const asAda = t.withIdentity("ada-token");
    const res = await asAda.fetch(new Request("http://localhost/whoami"));
    expect(await res.json()).toEqual({ identity: "ada-token" });
  } finally {
    await t.close();
  }
});

it("t.fetch falls back to the request's raw Authorization header when the view has no identity", async () => {
  const t = await createTestStackbase({
    modules: { "http.ts": http, "schema.ts": { default: defineSchema({}) } },
    components: [identityProbe],
  });
  try {
    const res = await t.fetch(
      new Request("http://localhost/whoami", { headers: { authorization: "Bearer raw-token" } }),
    );
    expect(await res.json()).toEqual({ identity: "Bearer raw-token" });
  } finally {
    await t.close();
  }
});
