import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema } from "@helipod/values";
import { auth } from "../src/component";

async function makeRuntime(now: () => number) {
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} }, [auth]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders, now });
}

describe("auth: failed-attempt lockout", () => {
  it("locks the account after 5 wrong passwords; the correct password is then rejected until the lock expires", async () => {
    let nowMs = 1_000_000_000_000;
    const r = await makeRuntime(() => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "right" });
    for (let i = 0; i < 5; i++) {
      await expect(r.run("auth:signIn", { email: "a@b.co", password: "wrong" })).rejects.toThrow(/invalid credentials/i);
    }
    await expect(r.run("auth:signIn", { email: "a@b.co", password: "right" })).rejects.toThrow(/too many|locked/i);
    nowMs += 16 * 60 * 1000; // +16 min, past the 15-min lock
    expect(typeof (await r.run<{ token: string }>("auth:signIn", { email: "a@b.co", password: "right" })).value.token).toBe("string");
  });
});
