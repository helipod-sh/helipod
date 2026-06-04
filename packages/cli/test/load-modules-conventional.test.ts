import { describe, it, expect } from "vitest";
import { loadConvexDir } from "../src/load-modules";

describe("loadConvexDir — conventional ./_generated/server imports", () => {
  it("loads a module that value-imports { query, mutation } from ./_generated/server", async () => {
    const loaded = await loadConvexDir("test/fixtures/conventional-app/convex");
    expect(loaded.schema).toBeTruthy(); // schema default export resolved
    // The notes module's exports are present — proving the extensionless ./_generated/server value
    // import resolved (query/mutation are the executor-built function definitions).
    expect(loaded.modules["notes"]).toBeTruthy();
    expect(loaded.modules["notes"]!.list).toBeTruthy();
    expect(loaded.modules["notes"]!.add).toBeTruthy();
  });
});
