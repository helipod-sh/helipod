import { Miniflare } from "miniflare";
import { d1BehaviorSuite } from "./d1-behavior";
import { bindingD1Client } from "../src/index";

/** Boot a fresh miniflare D1 (workerd's real SQLite) per client. This proves the real D1 SQL dialect
 *  + Sessions bookmark path — the fidelity the better-sqlite3 fast lane can't. Serial lane. */
async function realD1Client() {
  const mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: ":memory:" } });
  const db = await mf.getD1Database("DB");
  return bindingD1Client(db as never);
}

d1BehaviorSuite("miniflare real D1", () => realD1Client());
