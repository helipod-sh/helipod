import { d1BehaviorSuite } from "./d1-behavior";
import { sqliteD1Client } from "./support/sqlite-d1-client";
d1BehaviorSuite("better-sqlite3", () => sqliteD1Client());
