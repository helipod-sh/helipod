import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation } from "@stackbase/client/react";

const api = anyApi as {
  messages: { list: { __path: string }; send: { __path: string } };
};

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const client = new StackbaseClient(webSocketTransport(`${wsProtocol}://${location.host}/api/sync`));

type Message = { _id: string; author: string; body: string; _creationTime: number };

function Chat() {
  const messages = useQuery<Message[]>(api.messages.list, { conversationId: "general" });
  const send = useMutation(api.messages.send);
  const [author] = useState(() => `user-${Math.floor(Math.random() * 1000)}`);
  const [text, setText] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    void send({ conversationId: "general", author, body });
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
          <li key={m._id} className={m.author === author ? "msg mine" : "msg"}>
            <span className="author">{m.author}</span>
            <span className="body">{m.body}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" autoFocus />
        <button type="submit">Send</button>
      </form>
      <footer>Open this page in two tabs — messages appear live, no refresh.</footer>
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
