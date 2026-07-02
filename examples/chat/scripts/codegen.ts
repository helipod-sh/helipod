/**
 * Regenerate stackbase/_generated from the schema + functions. Run with `bun run scripts/codegen.ts`.
 * The dev CLI does this automatically; this script also backs the "generated is up to date" test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { push } from "@stackbase/cli";
import schema from "../stackbase/schema";
import * as messages from "../stackbase/messages";
import * as audit from "../stackbase/audit";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(here, "../stackbase/_generated");

const { generated } = push({ schema, modules: { messages, audit } });
mkdirSync(generatedDir, { recursive: true });
for (const file of generated.files) writeFileSync(join(generatedDir, file.path), file.content, "utf8");
process.stdout.write(`generated: ${generated.files.map((f) => f.path).join(", ")}\n`);
