import { describe, it, expect, vi } from "vitest";
import { consoleEmail, consoleSms } from "../src/provider-console";

describe("console providers", () => {
  it("consoleEmail logs the email and returns an empty SendResult", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await consoleEmail().send({ to: "a@b.test", from: "no-reply@x", subject: "Hi", text: "line1\nline2" });
      expect(res).toEqual({});
      expect(spy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("stackbase notifications] email") && a.includes("a@b.test") && a.includes("Hi")))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("consoleSms logs whatsapp-kind messages distinctly", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await consoleSms().send({ to: "+1555", from: "+1999", body: "yo", kind: "whatsapp" });
      expect(spy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("whatsapp →") && a.includes("+1555")))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
