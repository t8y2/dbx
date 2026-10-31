import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryStore } from "@/stores/queryStore";

const mocks = vi.hoisted(() => ({ ensureConnected: vi.fn(async () => undefined) }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => ({ id, name: "Cosmos dev", db_type: "plugin", plugin_id: "io.test.cosmos", plugin_connection_provider: "connection", plugin_connection_type: "cosmosdb-nosql" }),
    ensureConnected: mocks.ensureConnected,
  }),
}));
vi.mock("@/lib/backend/api", () => ({
  listPlugins: async () => [
    {
      compatibility: { compatible: true },
      manifest: {
        id: "io.test.cosmos",
        name: "Cosmos",
        version: "1.0.0",
        drivers: [],
        contributions: [
          { type: "connection-provider", id: "connection", label: "Cosmos", workbench: "main", database_type: "cosmosdb-nosql", fields: [] },
          { type: "workbench", id: "main", label: "Cosmos" },
        ],
      },
    },
  ],
}));

describe("plugin connection New Query", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    setActivePinia(createPinia());
    mocks.ensureConnected.mockClear();
  });
  it("keeps sidebar reopen stable but creates independent workbenches for explicit New Query", async () => {
    const store = useQueryStore();
    const first = await store.openPluginConnection("dev");
    const original = JSON.parse(JSON.stringify(store.tabs.find((t) => t.id === first)?.pluginWorkbench?.context));
    expect(await store.openPluginConnection("dev")).toBe(first);
    const second = await store.openPluginConnection("dev", { forceNew: true, sourceWorkbenchId: original?.workbenchId as string });
    const third = await store.openPluginConnection("dev", { forceNew: true });
    expect(new Set([first, second, third]).size).toBe(3);
    const tabs = store.tabs;
    expect(tabs.map((t) => t.title)).toEqual(["Cosmos dev", "Cosmos dev (1)", "Cosmos dev (2)"]);
    expect(tabs[0]?.pluginWorkbench?.context).toEqual(original);
    const secondContext = tabs[1]?.pluginWorkbench?.context;
    expect(secondContext).toMatchObject({ connectionId: "dev", newQuery: true, sourceWorkbenchId: original?.workbenchId });
    expect(secondContext?.workbenchId).not.toBe(original?.workbenchId);
    expect(tabs[2]?.pluginWorkbench?.context).toMatchObject({ connectionId: "dev", newQuery: true });
    expect(tabs[2]?.pluginWorkbench?.context).not.toHaveProperty("sourceWorkbenchId");
    expect(store.groups.find((g) => g.tabIds.includes(second!))).toBeDefined();
    expect(await store.openPluginConnection("dev")).toBe(first);
  });
  it("does not open a tab when connection setup fails", async () => {
    mocks.ensureConnected.mockRejectedValueOnce(new Error("offline"));
    const store = useQueryStore();
    await expect(store.openPluginConnection("dev", { forceNew: true })).rejects.toThrow("offline");
    expect(store.tabs).toHaveLength(0);
  });
});
