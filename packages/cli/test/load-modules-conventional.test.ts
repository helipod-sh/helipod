import { describe, it, expect } from "vitest";
import { loadFunctionsDir } from "../src/load-modules";

describe("loadFunctionsDir — conventional ./_generated/server imports", () => {
  it("loads a module that value-imports { query, mutation } from ./_generated/server", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/conventional-app/helipod");
    expect(loaded.schema).toBeTruthy(); // schema default export resolved
    // The notes module's exports are present — proving the extensionless ./_generated/server value
    // import resolved (query/mutation are the executor-built function definitions).
    expect(loaded.modules["notes"]).toBeTruthy();
    expect(loaded.modules["notes"]!.list).toBeTruthy();
    expect(loaded.modules["notes"]!.add).toBeTruthy();
  });
});
