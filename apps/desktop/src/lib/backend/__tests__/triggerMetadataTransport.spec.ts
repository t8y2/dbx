import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const cases = [
  { method: "listObjects", command: "list_objects", route: "/api/schema/objects", args: ["connection", "database", " Owner ", ["TRIGGER"], "mix", 1, 2, "catalog", undefined, undefined, { identityMode: "exact" }] },
  { method: "listTriggers", command: "list_triggers", route: "/api/schema/triggers", args: ["connection", "database", " Parent Owner ", " Parent ", "catalog", { identityMode: "exact" }] },
  { method: "getObjectSource", command: "get_object_source", route: "/api/schema/object-source", args: ["connection", "database", " Owner ", " Trigger ", "TRIGGER", undefined, undefined, { identityMode: "exact", catalog: "catalog" }] },
] as const;

describe("opt-in trigger identity dual transport", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it.each(cases)("Tauri $method transports exact options and raw identities", async ({ method, command, args }) => {
    const response = { marker: "unchanged metadata" };
    mocks.invoke.mockResolvedValue(response);
    const transport = await import("@/lib/backend/tauri");
    const call = transport[method] as (...args: unknown[]) => Promise<unknown>;
    await expect(call(...args)).resolves.toBe(response);
    expect(mocks.invoke).toHaveBeenCalledWith(command, expect.objectContaining({ identityMode: "exact", catalog: "catalog", schema: args[2] }));
    if (method === "listTriggers") expect(mocks.invoke.mock.calls[0][1].table).toBe(" Parent ");
    if (method === "getObjectSource") expect(mocks.invoke.mock.calls[0][1].name).toBe(" Trigger ");
  });

  it.each(cases)("Web $method transports the same options and raw identities", async ({ method, route, args }) => {
    const response = { marker: "unchanged metadata" };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(response) });
    vi.stubGlobal("fetch", fetch);
    const transport = await import("@/lib/backend/http");
    const call = transport[method] as (...args: unknown[]) => Promise<unknown>;
    await expect(call(...args)).resolves.toBe(response);
    const url = new URL(String(fetch.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe(route);
    expect(url.searchParams.get("identity_mode")).toBe("exact");
    expect(url.searchParams.get("catalog")).toBe("catalog");
    expect(url.searchParams.get("schema")).toBe(args[2]);
    if (method === "listTriggers") expect(url.searchParams.get("table")).toBe(" Parent ");
    if (method === "getObjectSource") expect(url.searchParams.get("table")).toBe(" Trigger ");
    if (method === "listObjects") {
      expect(url.searchParams.get("object_types")).toBe("TRIGGER");
      expect(url.searchParams.get("limit")).toBe("1");
      expect(url.searchParams.get("offset")).toBe("2");
    }
  });

  it("does not add exact preconditions or source catalog to default Tauri callers", async () => {
    mocks.invoke.mockResolvedValue({});
    const transport = await import("@/lib/backend/tauri");
    await transport.getObjectSource("connection", "database", "owner", "trigger", "TRIGGER");
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty("identityMode");
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty("catalog");
  });

  it("keeps the default Web read contract", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) });
    vi.stubGlobal("fetch", fetch);
    const transport = await import("@/lib/backend/http");
    await transport.listTriggers("connection", "database", "owner", "table");
    const url = new URL(String(fetch.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.has("identity_mode")).toBe(false);
  });

  it.each(["tauri", "http"] as const)("%s forwards pure trigger SQL preparation without changing target text", async (kind) => {
    const input = { databaseType: "oracle", owner: " Owner ", name: ' Tr"ig ', source: "-- 原始正文\nCREATE TRIGGER ...", purpose: "replace", enabled: false, binding: { scope: "VIEW", owner: " Parent Owner ", name: " View ", pluggable: false } };
    const response = { definition: "prepared definition", header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, inlineEnabled: false, exportEnabled: null, requiresStateRestore: false };
    mocks.invoke.mockResolvedValue(response);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(response) });
    vi.stubGlobal("fetch", fetch);
    const transport = (kind === "tauri" ? await import("@/lib/backend/tauri") : await import("@/lib/backend/http")) as unknown as { prepareOracleTriggerSql: (input: unknown) => Promise<unknown> };
    await expect(transport.prepareOracleTriggerSql(input)).resolves.toBe(response);
    if (kind === "tauri") expect(mocks.invoke).toHaveBeenCalledWith("prepare_oracle_trigger_sql", { input });
    else {
      expect(String(fetch.mock.calls[0][0])).toContain("/api/query/prepare-oracle-trigger-sql");
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ input });
    }
  });
});
