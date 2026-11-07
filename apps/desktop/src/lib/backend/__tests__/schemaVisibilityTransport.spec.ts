import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "../http";
import * as tauri from "../tauri";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

describe("schema visibility read options", () => {
  const fetch = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetch);
    fetch.mockImplementation(async () => new Response(JSON.stringify(["APP"]), { status: 200, headers: { "Content-Type": "application/json" } }));
    invoke.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, false, true])("preserves optional system visibility %s through both adapters", async (showSystemSchemas) => {
    await tauri.listSchemas("connection", "DB", false, showSystemSchemas);
    expect(invoke).toHaveBeenLastCalledWith("list_schemas", { connectionId: "connection", database: "DB", applyVisibleFilter: false, ...(showSystemSchemas === undefined ? {} : { showSystemSchemas }) });
    await tauri.listSchemaInfos("connection", "DB", showSystemSchemas);
    expect(invoke).toHaveBeenLastCalledWith("list_schema_infos", { connectionId: "connection", database: "DB", ...(showSystemSchemas === undefined ? {} : { showSystemSchemas }) });
    expect(await http.listSchemaInfos("connection", "DB", showSystemSchemas)).toEqual([{ name: "APP", comment: null }]);
    const url = new URL(String(fetch.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/schema/schemas");
    expect(url.searchParams.get("show_system_schemas")).toBe(showSystemSchemas === undefined ? null : String(showSystemSchemas));
    expect(url.searchParams.has("apply_visible_filter")).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
