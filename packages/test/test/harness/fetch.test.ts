import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import * as http from "../fixtures/http";
import { defineSchema } from "@stackbase/values";

it("t.fetch routes a Request through http.ts and returns the Response", async () => {
  const t = await createTestStackbase({
    modules: { "http.ts": http, "schema.ts": { default: defineSchema({}) } },
  });
  try {
    const res = await t.fetch(
      new Request("http://localhost/webhooks/ping", {
        method: "POST",
        body: JSON.stringify({ n: 42 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: 42 });
  } finally {
    await t.close();
  }
});

it("t.fetch returns 404 for an unmatched path", async () => {
  const t = await createTestStackbase({
    modules: { "http.ts": http, "schema.ts": { default: defineSchema({}) } },
  });
  try {
    const res = await t.fetch(new Request("http://localhost/nope", { method: "GET" }));
    expect(res.status).toBe(404);
  } finally {
    await t.close();
  }
});
