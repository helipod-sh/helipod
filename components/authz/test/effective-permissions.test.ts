import { describe, it, expect } from "vitest";
import { expandRolePatterns, candidateKeys, configHash } from "../src/effective-permissions";
import type { AuthzConfig } from "../src/roles";

const config: AuthzConfig = {
  roles: {
    viewer: { documents: ["read"] },
    editor: { inherits: "viewer", documents: ["update"] },
    admin: { documents: ["*"], authz: ["manage"] },
  },
};

describe("expandRolePatterns", () => {
  it("expands a role to its permission patterns (with inheritance)", () => {
    expect(expandRolePatterns(config, "editor").sort()).toEqual(["documents:read", "documents:update"]);
  });
  it("keeps wildcards as patterns", () => {
    expect(expandRolePatterns(config, "admin").sort()).toEqual(["authz:manage", "documents:*"]);
  });
});

describe("candidateKeys", () => {
  it("returns the <=4 keys that could match a permission", () => {
    expect(candidateKeys("documents:read")).toEqual(["documents:read", "documents:*", "*:read", "*:*"]);
  });
});

describe("configHash", () => {
  it("is stable across key ordering and differs when a grant changes", () => {
    const a = configHash({ roles: { r: { a: ["x"], b: ["y"] } } });
    const b = configHash({ roles: { r: { b: ["y"], a: ["x"] } } });
    expect(a).toBe(b);
    expect(a).not.toBe(configHash({ roles: { r: { a: ["x", "z"], b: ["y"] } } }));
  });
});
