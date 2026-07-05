import { it, expect } from "vitest";
import { createTestHelipod } from "../../src";
import * as http from "../fixtures/http";
import { identityProbe } from "../fixtures/whoami";
import { defineSchema } from "@helipod/values";

it("t.fetch threads a view's withIdentity through to the httpAction's ctx identity", async () => {
  const t = await createTestHelipod({
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

it("t.fetch falls back to the request's Authorization header (Bearer-stripped, engine parity) when the view has no identity", async () => {
  const t = await createTestHelipod({
    modules: { "http.ts": http, "schema.ts": { default: defineSchema({}) } },
    components: [identityProbe],
  });
  try {
    // Mirrors `packages/cli/src/http-handler.ts`: `Bearer abc123` -> `abc123` (prefix stripped).
    const res = await t.fetch(
      new Request("http://localhost/whoami", { headers: { authorization: "Bearer abc123" } }),
    );
    expect(await res.json()).toEqual({ identity: "abc123" });

    // A non-Bearer Authorization header is NOT treated as identity (also engine parity) -> null.
    const other = await t.fetch(
      new Request("http://localhost/whoami", { headers: { authorization: "Basic Zm9vOmJhcg==" } }),
    );
    expect(await other.json()).toEqual({ identity: null });
  } finally {
    await t.close();
  }
});
