import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, webSocketTransport, anyApi, type OptimisticLocalStore } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation } from "@stackbase/client/react";
// Type-only import — erased at bundle time (verbatimModuleSyntax), so this never pulls the
// server-side `@stackbase/executor` re-exports in `_generated/server.ts` into the browser bundle.
// `Api` is codegen's typed surface (docs/enduser/optimistic-updates.md#return-type-typing): both
// `list` and `send` below declare `returns`, so `OptimisticLocalStore.getQuery`/`setQuery` and
// `useQuery`/`useMutation` all infer real arg/return types instead of falling back to `Value`.
import type { Api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";

const api = anyApi as Api;

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const client = new StackbaseClient(webSocketTransport(`${wsProtocol}://${location.host}/api/sync`));

// No real `conversations` row ever gets created in this example — "general" is used directly as
// the shard key (see convex/messages.ts). Cast once so every call site is a real `Id<"conversations">`.
const CONVERSATION_ID = "general" as Id<"conversations">;

type Message = Doc<"messages">;
// An optimistically-inserted row carries a `placeholderId()` in `_id` (a deterministic-but-
// non-decodable string, NOT a real `Id<"messages">`) until the real commit swaps it in via the
// same atomic reconcile pass that removes this layer — see
// docs/enduser/optimistic-updates.md#the-pending-row-type-widening-recipe for why this widened
// type, rather than a `pending: true` field on `Doc<"messages">` itself, is the v1 recipe.
type PendingMessage = Message | (Omit<Message, "_id"> & { _id: string; pending: true });

// Module-scoped (not an inline closure) so `useMutation(...).withOptimisticUpdate(appendOptimistic)`
// returns the SAME callable across re-renders (packages/client/src/react.tsx's identity contract) —
// an inline arrow here would churn every render.
function appendOptimistic(store: OptimisticLocalStore, args: { conversationId: Id<"conversations">; author: string; body: string }): void {
  const list = store.getQuery(api.messages.list, { conversationId: args.conversationId });
  if (list === undefined) return; // nothing subscribed locally yet — nothing to patch
  const pending: PendingMessage = {
    _id: store.placeholderId("messages"), // deterministic across replays — NOT crypto.randomUUID()
    _creationTime: store.now(), // fixed at entry creation — NOT Date.now()
    conversationId: args.conversationId,
    author: args.author,
    body: args.body,
    pending: true,
  };
  store.setQuery(api.messages.list, { conversationId: args.conversationId }, [...(list as PendingMessage[]), pending]);
}

function Chat() {
  const messages = useQuery(api.messages.list, { conversationId: CONVERSATION_ID }) as PendingMessage[] | undefined;
  const send = useMutation(api.messages.send).withOptimisticUpdate(appendOptimistic);
  const [author] = useState(() => `user-${Math.floor(Math.random() * 1000)}`);
  const [text, setText] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    void send({ conversationId: CONVERSATION_ID, author, body });
    setText("");
  }

  return (
    <div className="app">
      <header>
        <h1>💬 Stackbase Chat</h1>
        <span className="me">you are <b>{author}</b></span>
      </header>
      <ul className="messages">
        {messages === undefined && <li className="status">connecting…</li>}
        {messages?.length === 0 && <li className="status">No messages yet — say hi 👋</li>}
        {messages?.map((m) => (
          <li key={m._id} className={`${m.author === author ? "msg mine" : "msg"}${"pending" in m ? " pending" : ""}`}>
            <span className="author">{m.author}</span>
            <span className="body">{m.body}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" autoFocus />
        <button type="submit">Send</button>
      </form>
      <footer>Open this page in two tabs — messages appear live, no refresh. Sends render instantly (optimistic) and settle without a flicker.</footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StackbaseProvider client={client}>
        <Chat />
      </StackbaseProvider>
    </StrictMode>,
  );
}
