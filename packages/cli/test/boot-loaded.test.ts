import { describe, it, expect, afterEach } from "vitest";
import { loadFunctionsDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";
import { rmSync } from "node:fs";

const DATA = "./.tmp-bootloaded/db.sqlite";
afterEach(() => rmSync("./.tmp-bootloaded", { recursive: true, force: true }));

describe("bootLoaded", () => {
  it("boots a runtime from an already-loaded project (no dir re-scan) and runs a mutation", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/deploy-v1/stackbase"); // existing fixture: notes table + notes:list
    const { runtime, adminApi, store } = await bootLoaded({
      loaded, components: [], dataPath: DATA, adminKey: "k",
    });
    expect(typeof runtime.run).toBe("function");
    expect(adminApi.getSchema().tableNumbers.notes).toBe(10001);
    store.close();
  });
});
