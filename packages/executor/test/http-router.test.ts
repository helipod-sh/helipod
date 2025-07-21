import { describe, it, expect } from "vitest";
import { httpRouter, matchRoute, isReservedHttpPath, type RouteEntry } from "../src";

const fn = (n: string) => ({ type: "httpAction" as const, handler: () => new Response(n) });

describe("httpRouter registration", () => {
  it("requires exactly one of path / pathPrefix", () => {
    const r = httpRouter();
    expect(() => r.route({ method: "GET", handler: fn("a") } as never)).toThrow(/exactly one of/);
    expect(() => r.route({ path: "/a", pathPrefix: "/a/", method: "GET", handler: fn("a") } as never)).toThrow(/exactly one of/);
  });
  it("rejects reserved prefixes at registration", () => {
    const r = httpRouter();
    expect(() => r.route({ path: "/api/run", method: "POST", handler: fn("x") })).toThrow(/reserved/);
    expect(() => r.route({ pathPrefix: "/_admin/", method: "GET", handler: fn("x") })).toThrow(/reserved/);
  });
  it("records routes", () => {
    const r = httpRouter();
    const h = fn("s");
    r.route({ path: "/stripe", method: "POST", handler: h });
    expect(r.routes).toEqual([{ method: "POST", path: "/stripe", handler: h }]);
  });
});

describe("matchRoute", () => {
  const routes: RouteEntry[] = [
    { method: "POST", path: "/stripe", handler: fn("exact") },
    { method: "GET", pathPrefix: "/oauth/", handler: fn("short") },
    { method: "GET", pathPrefix: "/oauth/google/", handler: fn("long") },
  ];
  it("exact path + method", () => {
    expect(matchRoute(routes, "POST", "/stripe")?.handler).toBe(routes[0]!.handler);
  });
  it("method mismatch -> undefined", () => {
    expect(matchRoute(routes, "GET", "/stripe")).toBeUndefined();
  });
  it("longest matching prefix wins", () => {
    expect(matchRoute(routes, "GET", "/oauth/google/cb")?.handler).toBe(routes[2]!.handler);
    expect(matchRoute(routes, "GET", "/oauth/github/cb")?.handler).toBe(routes[1]!.handler);
  });
  it("no match -> undefined", () => {
    expect(matchRoute(routes, "GET", "/nope")).toBeUndefined();
  });
});

describe("isReservedHttpPath", () => {
  it("reserves /api/* and /_*", () => {
    expect(isReservedHttpPath("/api/run")).toBe(true);
    expect(isReservedHttpPath("/_admin/x")).toBe(true);
    expect(isReservedHttpPath("/_dashboard")).toBe(true);
    expect(isReservedHttpPath("/stripe")).toBe(false);
    expect(isReservedHttpPath("/webhooks/x")).toBe(false);
  });
});
