// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { IndexSpec } from "@stackbase/query-engine";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, loopbackTransport, anyApi } from "../src/index";
import { StackbaseProvider, useQuery, useMutation } from "../src/react";

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
};

const api = anyApi as { messages: { send: { __path: string }; list: { __path: string } } };

let runtime: EmbeddedRuntime;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  runtime = await createEmbeddedRuntime({ store, catalog, modules });
});

function Chat() {
  const messages = useQuery<Array<{ _id: string; body: string }>>(api.messages.list, { conversationId: "c1" });
  const send = useMutation(api.messages.send);
  return (
    <div>
      <ul aria-label="messages">{(messages ?? []).map((m) => <li key={m._id}>{m.body}</li>)}</ul>
      <button onClick={() => void send({ conversationId: "c1", body: "hello" })}>send</button>
    </div>
  );
}

describe("React useQuery / useMutation", () => {
  it("renders a reactive list that updates after a mutation", async () => {
    const client = new StackbaseClient(loopbackTransport(runtime.connect("react")));
    render(
      <StackbaseProvider client={client}>
        <Chat />
      </StackbaseProvider>,
    );

    // Initially no messages.
    await waitFor(() => expect(screen.getByLabelText("messages").children.length).toBe(0));

    // Send a message via the mutation hook → the subscription pushes the update → re-render.
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(screen.getByLabelText("messages").children.length).toBe(1);
  });
});
