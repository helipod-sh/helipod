import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminGet, adminSend, type FnInfo } from "@/lib/admin";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

export function FunctionRunner() {
  const { data: fns } = useQuery({ queryKey: ["functions"], queryFn: () => adminGet<FnInfo[]>("/functions") });
  const [path, setPath] = useState("");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!path && fns?.[0]) setPath(fns[0].path);
  }, [fns, path]);

  async function run() {
    setRunning(true);
    try {
      setResult(await adminSend("POST", "/run", { path, args: JSON.parse(args || "{}") }));
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Function runner</h1>
      <div className="mb-3 flex gap-2">
        <select
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className="h-9 max-w-80 rounded-md border border-input bg-secondary/40 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {(fns ?? []).map((f) => (
            <option key={f.path} value={f.path}>{f.path} ({f.kind})</option>
          ))}
        </select>
        <Button onClick={run} disabled={running || !path}>{running ? "Running…" : "Run"}</Button>
      </div>
      <div className="mb-1 text-sm text-muted-foreground">Arguments (JSON)</div>
      <Textarea value={args} onChange={(e) => setArgs(e.target.value)} className="min-h-28" />
      {result !== null ? (
        <>
          <div className="mb-1 mt-3 text-sm text-muted-foreground">Result</div>
          <pre className="overflow-auto rounded-lg border border-border bg-card p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>
        </>
      ) : null}
    </div>
  );
}
