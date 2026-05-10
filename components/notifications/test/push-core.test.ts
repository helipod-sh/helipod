import { describe, it, expect } from "vitest";
import type { PushProvider, PushSendResult } from "../src/provider";

describe("push channel — seam types", () => {
  it("a minimal PushProvider satisfies the interface", async () => {
    const captured: unknown[] = [];
    const provider: PushProvider = {
      channel: "push",
      async send(m): Promise<PushSendResult> { captured.push(m); return { providerMessageId: "x" }; },
    };
    const res = await provider.send({ to: ["tok1"], title: "T", body: "B" });
    expect(res.providerMessageId).toBe("x");
    expect(captured).toHaveLength(1);
  });
});
