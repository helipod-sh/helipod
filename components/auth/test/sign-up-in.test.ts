import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { auth } from "../src/component";

async function makeRuntime() {
  const { catalog, moduleMap, componentNames } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [auth],
  );
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames });
}

describe("auth: signUp / signIn", () => {
  it("signUp creates an identity + session and returns a token", async () => {
    const r = await makeRuntime();
    const out = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect(typeof out.token).toBe("string");
    expect(typeof out.userId).toBe("string");
  });
  it("signIn verifies the password; rejects a wrong one", async () => {
    const r = await makeRuntime();
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });
    const ok = (await r.run<{ token: string }>("auth:signIn", { email: "a@b.co", password: "pw" })).value;
    expect(typeof ok.token).toBe("string");
    await expect(r.run("auth:signIn", { email: "a@b.co", password: "WRONG" })).rejects.toThrow(/invalid credentials/i);
  });
  it("rejects a duplicate signUp", async () => {
    const r = await makeRuntime();
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });
    await expect(r.run("auth:signUp", { email: "a@b.co", password: "pw2" })).rejects.toThrow(/already exists/i);
  });
  it("normalizes email casing/whitespace for signUp and signIn", async () => {
    const r = await makeRuntime();
    await r.run("auth:signUp", { email: "  Alice@B.co ", password: "pw" });
    const ok = (await r.run<{ token: string }>("auth:signIn", { email: "alice@b.co", password: "pw" })).value;
    expect(typeof ok.token).toBe("string");
    await expect(r.run("auth:signUp", { email: "ALICE@b.co", password: "x" })).rejects.toThrow(/already exists/i);
  });
});
