import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { freePort } from "../src/free-port";

describe("freePort", () => {
  it("returns a positive port number that is actually bindable", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    // Prove it's usable: we can listen on it (it was released after probing).
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(port, () => srv.close(() => resolve()));
    });
  });
});
