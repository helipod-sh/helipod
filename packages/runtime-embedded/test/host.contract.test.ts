import { describe, it, expect } from "vitest";
import type { EmbeddedRuntime } from "../src/runtime";
import type { RuntimeHost, ServeOptions, ServerHandle } from "../src/index";

/**
 * Compile-time contract for the `RuntimeHost` seam (Task 1). The real implementation
 * (`ProcessRuntimeHost`) lives in `@helipod/cli` and is asserted `satisfies RuntimeHost` there
 * (Task 2). Here we only prove the neutral seam is IMPLEMENTABLE with `@helipod`-only types — a
 * dummy host built from the runtime-embedded surface alone. If this file type-checks, the seam's
 * shape is coherent; the assertions below just keep vitest from complaining about an empty suite.
 */
describe("RuntimeHost seam contract", () => {
  it("is implementable with neutral (@helipod-only) types", () => {
    const handle: ServerHandle = {
      url: "http://127.0.0.1:0",
      port: 0,
      close: async () => {},
      setRoutes: () => {},
    };
    const host: RuntimeHost = {
      serve: (_runtime: EmbeddedRuntime, _options: ServeOptions) => Promise.resolve(handle),
    };
    expect(typeof host.serve).toBe("function");
    expect(handle.port).toBe(0);
  });
});
