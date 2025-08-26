// Minimal stub so a Convex fixture's un-migrated `import ... from "convex/server"` (left as
// action-needed by the migration codemod — see rewrite-imports.ts) still resolves when the
// migrated tree is dynamically loaded by `loadConvexDir` during the migrate-command test's regen
// step. A real migrated project has the real `convex` package installed (it's an existing Convex
// app); this hermetic fixture has no node_modules install step, so the test wires this stub into
// a temp `node_modules/convex` at runtime instead (see `migrate-command.test.ts`'s `beforeEach`).
// Kept out of `test/fixtures/convex-app/` itself (and named without a literal "node_modules"
// path segment) so it isn't swept up by the repo's blanket `node_modules/` .gitignore rule.
export function cronJobs() {
  return {};
}
