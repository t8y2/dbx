import { describe, expect, it } from "vitest";
import { apiUrl, apiWebSocketUrl, dbxWebBasePath, webPath } from "@/lib/webPath";

describe("webPath", () => {
  it("keeps root deployments on root-relative API paths", () => {
    expect(dbxWebBasePath("/", "/")).toBe("");
    expect(apiUrl("/api/auth/check", "")).toBe("/api/auth/check");
  });

  it("uses an explicit build base path", () => {
    expect(dbxWebBasePath("/", "/dbx/")).toBe("/dbx");
    expect(webPath("/login", "/dbx")).toBe("/dbx/login");
    expect(webPath("/", "/dbx")).toBe("/dbx/");
    expect(webPath("/icons/database/mysql.svg", "/dbx")).toBe("/dbx/icons/database/mysql.svg");
    expect(webPath("/icons/ai/openai.svg", "/dbx")).toBe("/dbx/icons/ai/openai.svg");
    expect(apiUrl("/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
    expect(apiUrl("/api/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
    expect(apiUrl("api/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
  });

  it("infers the runtime base path from the login URL for relative builds", () => {
    expect(dbxWebBasePath("/dbx/login", "./")).toBe("/dbx");
    expect(dbxWebBasePath("/tools/dbx/login", "./")).toBe("/tools/dbx");
  });

  it("infers the runtime base path from a mounted relative build", () => {
    expect(dbxWebBasePath("/dbx/", "./")).toBe("/dbx");
    expect(dbxWebBasePath("/tools/dbx/", "./")).toBe("/tools/dbx");
  });

  it("builds websocket URLs with the configured base path", () => {
    expect(apiWebSocketUrl("/redis/session/123", "/dbx", { protocol: "https:", host: "example.test" })).toBe("wss://example.test/dbx/api/redis/session/123");
  });
});
