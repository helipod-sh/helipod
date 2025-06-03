import { describe, it, expect } from "vitest";
import { StackbaseClient } from "../src/client";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

class MinimalTransport {
  readonly sent: ClientMessage[] = [];
  private readonly msgListeners = new Set<(m: ServerMessage) => void>();
  private readonly closeListeners = new Set<() => void>();

  send(m: ClientMessage): void {
    this.sent.push(m);
  }
  onMessage(l: (m: ServerMessage) => void): () => void {
    this.msgListeners.add(l);
    return () => this.msgListeners.delete(l);
  }
  onClose(l: () => void): () => void {
    this.closeListeners.add(l);
    return () => this.closeListeners.delete(l);
  }
  close(): void {
    for (const l of this.closeListeners) l();
  }
}

describe("client.setAuth", () => {
  it("sends a SetAuth message with the given token over the transport", () => {
    const t = new MinimalTransport();
    const client = new StackbaseClient(t);

    client.setAuth("tok-9");
    expect(t.sent).toContainEqual({ type: "SetAuth", token: "tok-9" });
  });

  it("sends a SetAuth message with null to clear the session identity", () => {
    const t = new MinimalTransport();
    const client = new StackbaseClient(t);

    client.setAuth(null);
    expect(t.sent).toContainEqual({ type: "SetAuth", token: null });
  });

  it("sends both token and null in sequence", () => {
    const t = new MinimalTransport();
    const client = new StackbaseClient(t);

    client.setAuth("tok-9");
    client.setAuth(null);
    expect(t.sent).toContainEqual({ type: "SetAuth", token: "tok-9" });
    expect(t.sent).toContainEqual({ type: "SetAuth", token: null });
  });
});
