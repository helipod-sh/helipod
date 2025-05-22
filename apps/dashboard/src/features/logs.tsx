import { useQuery } from "@tanstack/react-query";
import { adminGet, type LogEntry } from "@/lib/admin";
import { cn } from "@/lib/utils";

export function Logs() {
  const { data } = useQuery({ queryKey: ["logs"], queryFn: () => adminGet<LogEntry[]>("/logs"), refetchInterval: 2000 });
  const logs = data ?? [];
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Logs <span className="text-sm font-normal text-muted-foreground">(live, 2s)</span></h1>
      {logs.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">No executions yet — run a function or use the app.</div>
      ) : (
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-card">
              <tr>
                {["id", "function", "kind", "status", "ms"].map((h) => (
                  <th key={h} className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="hover:bg-card/60">
                  <td className="border-b border-border px-3 py-2 text-muted-foreground">{l.id}</td>
                  <td className="border-b border-border px-3 py-2"><code className="rounded bg-secondary px-1.5 py-0.5">{l.path}</code></td>
                  <td className="border-b border-border px-3 py-2"><span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{l.kind}</span></td>
                  <td className="border-b border-border px-3 py-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs", l.status === "ok" ? "bg-emerald-500/15 text-emerald-400" : "bg-destructive/15 text-destructive")}>{l.status}</span>
                    {l.error ? <span className="ml-2 text-destructive">{l.error}</span> : null}
                  </td>
                  <td className="border-b border-border px-3 py-2 text-muted-foreground">{l.durationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
