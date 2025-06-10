import { describe, it, expect } from "vitest";
import { roleGrants, type AuthzConfig } from "../src/roles";

const config: AuthzConfig = {
  permissions: { documents: ["read", "update", "delete"] },
  roles: {
    viewer: { documents: ["read"] },
    editor: { inherits: "viewer", documents: ["update"] },
    admin: { inherits: "editor", documents: ["delete"] },
  },
};

describe("roleGrants", () => {
  it("expands inherited permissions", () => {
    expect(roleGrants(config, "editor", "documents:read")).toBe(true);   // inherited from viewer
    expect(roleGrants(config, "editor", "documents:update")).toBe(true);
    expect(roleGrants(config, "editor", "documents:delete")).toBe(false);
    expect(roleGrants(config, "admin", "documents:read")).toBe(true);    // transitively inherited
  });
  it("honors wildcards", () => {
    expect(roleGrants({ roles: { god: { documents: ["*"] } } }, "god", "documents:delete")).toBe(true);
    expect(roleGrants({ roles: { god: { "*": ["*"] } } }, "god", "billing:manage")).toBe(true);
  });
  it("unknown role or permission grants nothing", () => {
    expect(roleGrants(config, "nope", "documents:read")).toBe(false);
    expect(roleGrants(config, "viewer", "documents:update")).toBe(false);
  });
});
