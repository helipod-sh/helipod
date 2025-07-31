import { describe, it, expect, afterEach } from "vitest";
import { loadConvexDir } from "../src/load-modules";
import { resolveBinaryOptions, startBinaryServer } from "../src/binary-main";
import { rmSync } from "node:fs";

afterEach(() => rmSync("./.tmp-binmain", { recursive: true, force: true }));

describe("resolveBinaryOptions", () => {
  it("defaults port 3000 / 0.0.0.0 / ./data and reads flags + admin key env", () => {
    const o = resolveBinaryOptions(["--port", "8080", "--hostname", "127.0.0.1", "--data-dir", "/d"], { STACKBASE_ADMIN_KEY: "sek" });
    expect(o).toEqual({ port: 8080, ip: "127.0.0.1", dataDir: "/d", adminKey: "sek" });
    const d = resolveBinaryOptions([], {});
    expect(d).toEqual({ port: 3000, ip: "0.0.0.0", dataDir: "./data", adminKey: "" });
  });
});

describe("startBinaryServer", () => {
  it("serves a committing mutation from a pre-loaded project (no convex dir at runtime)", async () => {
    const loaded = await loadConvexDir("test/fixtures/deploy-v2/convex"); // notes:list + notes:add
    const { server, store } = await startBinaryServer(loaded, [], { port: 0, ip: "127.0.0.1", dataDir: "./.tmp-binmain", adminKey: "k" });
    const add = await fetch(`${server.url}/api/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes:add", args: { box: "a", text: "hi" } }),
    });
    expect((await add.json()).committed).toBe(true);
    await server.close(); store.close();
  });
});
