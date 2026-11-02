import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "../http";
import * as tauri from "../tauri";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

describe("connection visibility migration transport", () => {
  const fetch = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetch);
    fetch.mockImplementation(async () => new Response("[]", { headers: { "Content-Type": "application/json" } }));
    invoke.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps ordinary reads free of migration input", async () => {
    await tauri.loadConnections();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("load_connections", undefined);
    await http.loadConnections();
    const url = new URL(String(fetch.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/connection/list");
    expect(url.search).toBe("");
  });

  it.each([false, true])("preserves an explicit legacy value of %s on both adapters", async (visible) => {
    await tauri.loadConnections(visible);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("load_connections", { legacySidebarShowUserAdmin: visible });
    await http.loadConnections(visible);
    const url = new URL(String(fetch.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.get("legacySidebarShowUserAdmin")).toBe(String(visible));
  });
});
