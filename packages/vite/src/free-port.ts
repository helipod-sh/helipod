import { createServer } from "node:net";

/** Resolve an OS-assigned free TCP port (listen on 0, read it, release it). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not resolve a free port"))));
    });
  });
}
