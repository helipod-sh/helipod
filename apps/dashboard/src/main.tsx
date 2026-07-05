import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
  RouterProvider,
  Outlet,
  Link,
  useParams,
} from "@tanstack/react-router";
import { adminGet, type TableInfo } from "@/lib/admin";
import { DataBrowser } from "@/features/data-browser";
import { FunctionRunner } from "@/features/function-runner";
import { Logs } from "@/features/logs";
import { cn } from "@/lib/utils";
import "./index.css";

const navItem =
  "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground hover:bg-accent";
const navActive = "bg-primary text-primary-foreground hover:bg-primary";

function Sidebar() {
  const { data: tables } = useQuery({ queryKey: ["tables"], queryFn: () => adminGet<TableInfo[]>("/tables") });
  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-r border-border bg-card p-4">
      <div className="mb-4 text-base font-bold">⚡ Helipod</div>
      <div className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-muted-foreground">Tables</div>
      {(tables ?? []).map((t) => (
        <Link key={t.name} to="/data/$table" params={{ table: t.name }} className={navItem} activeProps={{ className: cn(navItem, navActive) }}>
          <span>{t.name}</span>
          <span className="rounded-full bg-secondary px-1.5 text-xs text-muted-foreground">{t.documentCount}</span>
        </Link>
      ))}
      <div className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-muted-foreground">Tools</div>
      <Link to="/functions" className={navItem} activeProps={{ className: cn(navItem, navActive) }}>Functions</Link>
      <Link to="/logs" className={navItem} activeProps={{ className: cn(navItem, navActive) }}>Logs</Link>
    </aside>
  );
}

function Shell() {
  return (
    <div className="flex h-dvh">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <div className="py-12 text-center text-muted-foreground">Select a table or tool from the sidebar.</div>,
});
const tableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data/$table",
  component: function TableView() {
    const { table } = useParams({ from: "/data/$table" });
    return <DataBrowser key={table} table={table} />;
  },
});
const functionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/functions", component: FunctionRunner });
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", component: Logs });

const routeTree = rootRoute.addChildren([indexRoute, tableRoute, functionsRoute, logsRoute]);
const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
