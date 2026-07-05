// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { SimpleIndexCatalog, query, mutation, action, type RegisteredFunction } from "@helipod/executor";
import type { IndexSpec } from "@helipod/query-engine";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, loopbackTransport, anyApi } from "../src/index";
import type { OptimisticLocalStore } from "../src/optimistic-store";
import { HelipodProvider, useQuery, useMutation, useAction } from "../src/react";

const MESSAGES = 10001;
const byConversation: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_conversation"),
};
const modules: Record<string, RegisteredFunction> = {
  "messages:send": mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  "messages:list": query<{ conversationId: string }, unknown[]>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
  }),
  "messages:shout": action<{ body: string }, string>({
    handler: async (_ctx, { body }) => body.toUpperCase(),
  }),
};

const api = anyApi as { messages: { send: { __path: string }; list: { __path: string }; shout: { __path: string } } };

let runtime: EmbeddedRuntime;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  runtime = await createEmbeddedRuntime({ store, catalog, modules });
});

afterEach(cleanup);

function Chat() {
  const messages = useQuery<Array<{ _id: string; body: string }>>(api.messages.list, { conversationId: "c1" });
  const send = useMutation(api.messages.send);
  const shout = useAction<string>(api.messages.shout);
  const [shouted, setShouted] = useState("");
  return (
    <div>
      <ul aria-label="messages">{(messages ?? []).map((m) => <li key={m._id}>{m.body}</li>)}</ul>
      <button onClick={() => void send({ conversationId: "c1", body: "hello" })}>send</button>
      <button onClick={() => void shout({ body: "hi" }).then(setShouted)}>shout</button>
      <div aria-label="shouted">{shouted}</div>
    </div>
  );
}

// T5: `useMutation(ref).withOptimisticUpdate(fn)` — a module-level updater (stable identity across
// renders, so the stability probe below can prove the chained callable doesn't churn).
function appendOptimistic(store: OptimisticLocalStore, args: Record<string, unknown>): void {
  const { conversationId, body } = args as { conversationId: string; body: string };
  const list = (store.getQuery(api.messages.list, { conversationId }) as Array<{ _id: string; body: string }> | undefined) ?? [];
  store.setQuery(api.messages.list, { conversationId }, [...list, { _id: store.placeholderId("messages"), body }]);
}

function OptimisticChat() {
  const messages = useQuery<Array<{ _id: string; body: string }>>(api.messages.list, { conversationId: "c1" });
  const send = useMutation(api.messages.send).withOptimisticUpdate(appendOptimistic);
  return (
    <div>
      <ul aria-label="messages">{(messages ?? []).map((m) => <li key={m._id}>{m.body}</li>)}</ul>
      <button onClick={() => void send({ conversationId: "c1", body: "hello" })}>send</button>
    </div>
  );
}

function StabilityProbe({ tick, onCapture }: { tick: number; onCapture: (fn: unknown) => void }) {
  const send = useMutation(api.messages.send).withOptimisticUpdate(appendOptimistic);
  onCapture(send);
  return <div aria-label="tick">{tick}</div>;
}

describe("React useQuery / useMutation", () => {
  it("renders a reactive list that updates after a mutation", async () => {
    const client = new HelipodClient(loopbackTransport(runtime.connect("react")));
    render(
      <HelipodProvider client={client}>
        <Chat />
      </HelipodProvider>,
    );

    // Initially no messages.
    await waitFor(() => expect(screen.getByLabelText("messages").children.length).toBe(0));

    // Send a message via the mutation hook → the subscription pushes the update → re-render.
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(screen.getByLabelText("messages").children.length).toBe(1);
  });

  it("useAction: a callback that resolves with the action's return value (not reactive)", async () => {
    const client = new HelipodClient(loopbackTransport(runtime.connect("react-action")));
    render(
      <HelipodProvider client={client}>
        <Chat />
      </HelipodProvider>,
    );
    fireEvent.click(screen.getByText("shout"));
    await waitFor(() => expect(screen.getByLabelText("shouted").textContent).toBe("HI"));
  });

  it("useMutation(...).withOptimisticUpdate(...): renders the optimistic row instantly, before the server round trip settles", async () => {
    const client = new HelipodClient(loopbackTransport(runtime.connect("react-optimistic")));
    render(
      <HelipodProvider client={client}>
        <OptimisticChat />
      </HelipodProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("messages").children.length).toBe(0));

    fireEvent.click(screen.getByText("send"));
    // No `waitFor` — the updater ran synchronously inside the click handler (before any network
    // round trip), and React (via RTL's `act`-wrapped `fireEvent`) has already flushed that render.
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByLabelText("messages").children.length).toBe(1);

    // Let the real commit settle (the temp id swaps for the authoritative one, same one row).
    await waitFor(() => expect(screen.getByLabelText("messages").children.length).toBe(1));
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("useMutation(...).withOptimisticUpdate(...): the returned callable is stable across re-renders", () => {
    const client = new HelipodClient(loopbackTransport(runtime.connect("react-stability")));
    const captured: unknown[] = [];
    const { rerender } = render(
      <HelipodProvider client={client}>
        <StabilityProbe tick={0} onCapture={(fn) => captured.push(fn)} />
      </HelipodProvider>,
    );
    rerender(
      <HelipodProvider client={client}>
        <StabilityProbe tick={1} onCapture={(fn) => captured.push(fn)} />
      </HelipodProvider>,
    );
    expect(screen.getByLabelText("tick").textContent).toBe("1");
    expect(captured).toHaveLength(2);
    expect(captured[0]).toBe(captured[1]); // same client + path + updater reference -> no churn
  });
});
