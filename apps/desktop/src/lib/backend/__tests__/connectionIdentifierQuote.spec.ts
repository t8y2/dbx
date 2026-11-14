import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "../http";
import * as tauri from "../tauri";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

describe("connection identifier quote transport", () => {
  const fetch = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetch);
    fetch.mockImplementation(async () => new Response(JSON.stringify("`"), { headers: { "Content-Type": "application/json" } }));
    invoke.mockResolvedValue("`");
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, { existingOnly: true }])("preserves existing-only mode on both adapters (%j)", async (options) => {
    const request = { connectionId: "A", database: "app", ...(options?.existingOnly ? { existingOnly: true } : {}) };
    await expect(tauri.connectionIdentifierQuote("A", "app", options)).resolves.toBe("`");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("connection_identifier_quote", request);
    await expect(http.connectionIdentifierQuote("A", "app", options)).resolves.toBe("`");
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url), "http://localhost").pathname).toBe("/api/connection/identifier-quote");
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it("propagates an absent-pool error without falling back to a connecting request", async () => {
    invoke.mockRejectedValueOnce(new Error("Connection is not open"));
    fetch.mockImplementationOnce(async () => new Response("Connection is not open", { status: 400 }));
    await expect(tauri.connectionIdentifierQuote("A", undefined, { existingOnly: true })).rejects.toThrow("Connection is not open");
    await expect(http.connectionIdentifierQuote("A", undefined, { existingOnly: true })).rejects.toThrow("Connection is not open");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
