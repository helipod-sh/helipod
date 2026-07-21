# @helipod/client

The framework-agnostic Helipod client SDK: `HelipodClient` over a reactive WebSocket connection, with React bindings (`useQuery`/`useMutation`/`useAction`) at the `@helipod/client/react` subpath.

Most users should install the umbrella package [`helipod`](https://www.npmjs.com/package/helipod) instead — it re-exports this package, and the React hooks are available there as `helipod/react`.

```sh
bun add helipod   # or: npm install helipod
```

## Usage

```tsx
import { HelipodClient, webSocketTransport } from "@helipod/client";
import { HelipodProvider, useQuery, useMutation } from "@helipod/client/react";
import { api } from "../helipod/_generated/api";

const client = new HelipodClient(webSocketTransport("ws://localhost:3210/api/sync"));

function Chat() {
  const messages = useQuery(api.messages.list, { conversationId });
  const send = useMutation(api.messages.send);
  // `messages` re-renders automatically whenever a mutation changes the data it reads.
  return <button onClick={() => send({ conversationId, body: "hi" })}>Send</button>;
}

// <HelipodProvider client={client}><Chat /></HelipodProvider>
```

## Features

- Live queries: subscribe once, get pushed updates whenever a committed write intersects the query's read set — no polling.
- Typed end-to-end: function references from your app's generated `api` carry argument and return types into `useQuery`/`useMutation`/`useAction`.
- Optimistic updates: `useMutation(ref).withOptimisticUpdate((store, args) => ...)` for instant local UI with exact rollback and flicker-free reconciliation.
- Durable offline outbox (opt-in): `indexedDBOutbox()` in the browser, `fsOutbox()` (via `@helipod/client/outbox-fs`) for Node/Electron/Tauri, `memoryOutbox()` for tests — queued mutations survive reloads and drain exactly once on reconnect, with `usePendingMutations()` for status UI and `drainOutboxOnce()` for Service Worker Background Sync.
- Client-minted ids: `mintId` from your app's `_generated/ids` lets offline code create a document and reference it in a later queued mutation without waiting for the server.
- Auth session management: `createAuthClient` handles token rotation, refresh scheduling, and cross-tab session broadcast over a `HelipodClient`.
- Automatic reconnection with resubscribe, auth replay, and bandwidth-saving resume for unchanged query results.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
