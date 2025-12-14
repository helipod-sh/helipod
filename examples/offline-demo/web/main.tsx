import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  StackbaseClient,
  anyApi,
  indexedDBOutbox,
  type MutationFailedInfo,
  type OptimisticLocalStore,
  type OptimisticUpdateFn,
} from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation, usePendingMutations } from "@stackbase/client/react";
import { offlineToggleTransport } from "./offline-transport";
// Type-only imports — erased at bundle time, so the server-side `_generated/server.ts` re-exports
// never reach the browser bundle. `ids.ts` is a VALUE import (mintId runs in the browser); it pulls
// only `@stackbase/id-codec`, which is browser-safe.
import type { Api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { mintId } from "../convex/_generated/ids";

const api = anyApi as Api;

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
export const transport = offlineToggleTransport(`${wsProtocol}://${location.host}/api/sync`);

/* ------------------------------------------------------------------------------------------------
 * Optimistic updaters — module-scoped, PURE (replay-safe): minted ids come FROM args (never
 * mintId() in here), timestamps from store.now(), and an `undefined` baseline means "not
 * subscribed / no base yet" → render nothing rather than throw (the documented
 * offline-after-reload boundary). The SAME functions serve both the `withOptimisticUpdate` call
 * sites and the client-construction `optimisticUpdates` registry, so entries queued before a
 * reload — and other tabs' queued entries — render through identical logic.
 * ---------------------------------------------------------------------------------------------- */

// The documented pending-row type-widening recipe (docs/enduser/optimistic-updates.md): an
// optimistic row is a real Doc shape plus `pending: true`, dropped the same frame the
// authoritative row lands (drop-on-observed-inclusion — never a flicker).
type PendingList = Doc<"lists"> | (Doc<"lists"> & { pending: true });
type PendingItem = Doc<"items"> | (Doc<"items"> & { pending: true });

function createListOptimistic(store: OptimisticLocalStore, args: { _id?: string; name: string }): void {
  const listsQ = store.getQuery(api.lists.list, {});
  if (listsQ === undefined) return;
  const row: PendingList = {
    _id: (args._id ?? store.placeholderId("lists")) as Id<"lists">,
    _creationTime: store.now(),
    name: args.name,
    locked: false,
    pending: true,
  };
  store.setQuery(api.lists.list, {}, [...(listsQ as PendingList[]), row]);
}

function lockListOptimistic(store: OptimisticLocalStore, args: { id: Id<"lists"> }): void {
  const listsQ = store.getQuery(api.lists.list, {});
  if (listsQ === undefined) return;
  store.setQuery(
    api.lists.list,
    {},
    (listsQ as PendingList[]).map((l) => (l._id === args.id ? { ...l, locked: true } : l)),
  );
}

function addItemOptimistic(store: OptimisticLocalStore, args: { _id?: string; listId: Id<"lists">; label: string }): void {
  const itemsQ = store.getQuery(api.items.list, { listId: args.listId });
  if (itemsQ === undefined) return;
  const row: PendingItem = {
    _id: (args._id ?? store.placeholderId("items")) as Id<"items">,
    _creationTime: store.now(),
    listId: args.listId,
    label: args.label,
    done: false,
    pending: true,
  };
  store.setQuery(api.items.list, { listId: args.listId }, [...(itemsQ as PendingItem[]), row]);
}

function toggleItemOptimistic(store: OptimisticLocalStore, args: { id: Id<"items">; done: boolean }): void {
  for (const q of store.getAllQueries(api.items.list)) {
    if (q.value === undefined) continue;
    store.setQuery(
      api.items.list,
      q.args,
      (q.value as PendingItem[]).map((i) => (i._id === args.id ? { ...i, done: args.done } : i)),
    );
  }
}

/* ------------------------------------------------------------------------------------------------
 * The client — the durable outbox plus the hydrate-time registry (udfPath → updater). The registry
 * is what re-renders queued entries after a reload and mirrors other tabs' queued entries live.
 * ---------------------------------------------------------------------------------------------- */

const client = new StackbaseClient(transport, {
  outbox: indexedDBOutbox(),
  optimisticUpdates: {
    "lists:create": createListOptimistic as OptimisticUpdateFn,
    "lists:lock": lockListOptimistic as OptimisticUpdateFn,
    "items:add": addItemOptimistic as OptimisticUpdateFn,
    "items:toggle": toggleItemOptimistic as OptimisticUpdateFn,
  },
  onMutationFailed: (info: MutationFailedInfo) => {
    // The pending tray is the primary surface; this keeps a breadcrumb in the console too.
    console.error(`[packlist] ${info.udfPath} failed terminally: ${info.error.code ?? info.error.message}`);
  },
});

/* ---------------------------------------- components ------------------------------------------ */

function OfflineToggle() {
  const [offline, setOffline] = useState(transport.isOffline());
  useEffect(() => transport.onStateChange(setOffline), []);
  return (
    <button className={offline ? "toggle off" : "toggle on"} onClick={() => transport.setOffline(!offline)}>
      {offline ? "📴 Offline — tap to reconnect" : "🟢 Online — tap to go offline"}
    </button>
  );
}

function Lists(props: { selected: Id<"lists"> | null; onSelect: (id: Id<"lists">) => void }) {
  const lists = useQuery(api.lists.list, {}) as PendingList[] | undefined;
  const create = useMutation(api.lists.create).withOptimisticUpdate(createListOptimistic);
  const lock = useMutation(api.lists.lock).withOptimisticUpdate(lockListOptimistic);
  const [name, setName] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // The create-then-reference chain starts here: a REAL Id<"lists">, minted client-side at
    // args-construction time. Selecting it immediately means items can be added to this list
    // while its create is still queued offline — no await needed.
    const id = mintId("lists");
    void create({ _id: id, name: trimmed }).catch(() => {});
    props.onSelect(id);
    setName("");
  }

  return (
    <section className="pane lists">
      <h2>Lists</h2>
      <ul>
        {lists === undefined && <li className="status">waiting for first sync…</li>}
        {lists?.length === 0 && <li className="status">No lists yet — create one 👇</li>}
        {lists?.map((l) => (
          <li
            key={l._id}
            className={`row${l._id === props.selected ? " selected" : ""}${"pending" in l ? " pending" : ""}`}
            onClick={() => props.onSelect(l._id)}
          >
            <span className="grow">{l.name}</span>
            {l.locked ? (
              <span className="locked" title="locked — adds will be rejected">🔒</span>
            ) : (
              <button
                className="subtle"
                onClick={(e) => {
                  e.stopPropagation();
                  void lock({ id: l._id }).catch(() => {});
                }}
              >
                lock
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="New list…" />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}

function Items(props: { listId: Id<"lists"> }) {
  const items = useQuery(api.items.list, { listId: props.listId }) as PendingItem[] | undefined;
  const add = useMutation(api.items.add).withOptimisticUpdate(addItemOptimistic);
  const toggle = useMutation(api.items.toggle).withOptimisticUpdate(toggleItemOptimistic);
  const [label, setLabel] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    void add({ _id: mintId("items"), listId: props.listId, label: trimmed }).catch(() => {});
    setLabel("");
  }

  return (
    <section className="pane items">
      <h2>Items</h2>
      <ul>
        {items === undefined && <li className="status">waiting for first sync…</li>}
        {items?.length === 0 && <li className="status">Nothing packed yet.</li>}
        {items?.map((i) => (
          <li key={i._id} className={`row${"pending" in i ? " pending" : ""}`}>
            <input
              type="checkbox"
              checked={i.done}
              onChange={() => void toggle({ id: i._id, done: !i.done }).catch(() => {})}
            />
            <span className="grow">{i.done ? <del>{i.label}</del> : i.label}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add item…" />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}

function PendingTray() {
  const pending = usePendingMutations();
  if (pending.length === 0) return null;
  return (
    <section className="tray">
      <h2>
        Outbox — {pending.length} pending {transport.isOffline() ? "(offline: will drain on reconnect)" : ""}
      </h2>
      <ul>
        {pending.map((e) => (
          <li key={`${e.clientId}:${e.seq}`}>
            <code>{e.udfPath}</code>
            <span className="st">{e.status}</span>
            {e.error && <span className="err">{e.error.code ?? "error"}</span>}
            {e.status === "failed" && (
              <>
                <button className="subtle" onClick={() => void e.retry()}>
                  retry
                </button>
                <button className="subtle" onClick={() => void e.dismiss()}>
                  dismiss
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function App() {
  const [selected, setSelected] = useState<Id<"lists"> | null>(null);
  return (
    <div className="app">
      <header>
        <h1>🎒 Packlist</h1>
        <OfflineToggle />
      </header>
      <main>
        <Lists selected={selected} onSelect={setSelected} />
        {selected ? <Items listId={selected} /> : <section className="pane items"><p className="status">Select a list.</p></section>}
      </main>
      <PendingTray />
      <footer>
        Go offline → create a list and add items into it → reload → go online: everything drains exactly-once.
        Lock a list, queue adds to it offline, reconnect: watch them fail loudly (LIST_LOCKED). Open two tabs for cross-tab live rendering.
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StackbaseProvider client={client}>
        <App />
      </StackbaseProvider>
    </StrictMode>,
  );
}
