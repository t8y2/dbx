import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const api = vi.hoisted(() => ({
  loadConnections: vi.fn(),
  saveConnections: vi.fn(),
  loadEditorSettings: vi.fn(),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  loadPinnedTreeNodeIds: vi.fn().mockResolvedValue([]),
  loadSidebarLayout: vi.fn().mockResolvedValue(null),
  loadTableVGroups: vi.fn().mockResolvedValue({}),
  loadTunnelProfiles: vi.fn().mockResolvedValue([]),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/api", () => api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

const config = (id: string): ConnectionConfig => ({ id, name: id, db_type: "oracle", host: "localhost", port: 1521, username: id, password: "fixture", connect_timeout_inherit: false, query_timeout_inherit: false, connect_timeout_secs: 15, query_timeout_secs: 25 });
let rows: Map<string, string>;
function wire(value: ConnectionConfig) {
  const { show_database_links: _links, show_native_jobs: _jobs, show_user_admin: _users, ...saved } = value;
  return saved;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
  rows = new Map(["A", "B"].map((id) => [id, JSON.stringify({ ...config(id), show_database_links: false, show_native_jobs: false, show_user_admin: false }, null, 2)]));
  api.loadEditorSettings.mockResolvedValue({ timeoutInheritanceMigrationVersion: 2, executeModeDefaultVersion: 1 });
  api.loadConnections.mockImplementation(async () => [...rows.values()].map((raw) => wire(JSON.parse(raw))));
  api.saveConnections.mockImplementation(async (configs: ConnectionConfig[], removedIds: string[] = []) => {
    for (const id of removedIds) rows.delete(id);
    for (const value of configs) rows.set(value.id, JSON.stringify(wire(value)));
  });
});

describe("connection persistence upsert scope", () => {
  it("saves navigation visibility without losing sessions, secrets or other database filters", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { connectionConfigFingerprint } = await import("@/lib/connection/connectionDatabaseInfo");
    const store = useConnectionStore();
    await store.initFromDisk();
    store.connectedIds.add("A");
    store.getConfig("A")!.visible_schemas = { keep: ["OTHER"] };
    const before = connectionConfigFingerprint(store.getConfig("A")!);
    await store.updateNavigationVisibility("A", "target", { showSystemSchemas: true, filterSchemas: true, schemaNames: [] });
    expect(store.connectedIds.has("A")).toBe(true);
    expect(store.getConfig("A")?.visible_schemas).toEqual({ keep: ["OTHER"], target: [] });
    expect(store.getConfig("A")?.password).toBe("fixture");
    expect(connectionConfigFingerprint(store.getConfig("A")!)).toBe(before);
    expect(api.saveConnections.mock.calls.at(-1)![0].map((value: ConnectionConfig) => value.id)).toEqual(["A"]);
    api.saveConnections.mockRejectedValueOnce(new Error("save failed"));
    await expect(store.updateNavigationVisibility("A", "target", { showSystemSchemas: false, filterSchemas: true, schemaNames: ["X"] })).rejects.toThrow("save failed");
    expect(store.getConfig("A")?.show_system_schemas).toBe(true);
    expect(store.getConfig("A")?.visible_schemas?.target).toEqual([]);
    store.getConfig("A")!.visible_databases = ["LEGACY"];
    store.getConfig("A")!.visible_database_patterns = ["APP%"];
    await store.updateNavigationVisibility("A", "target", { filterSchemas: true, schemaNames: undefined, clearLegacyDatabaseFilter: true });
    expect(store.getConfig("A")?.visible_schemas).toEqual({ keep: ["OTHER"] });
    expect(store.getConfig("A")?.visible_databases).toBeUndefined();
    expect(store.getConfig("A")?.visible_database_patterns).toBeUndefined();
  });
  it("does not migrate on load and saves only explicitly saved A, even with unchanged fields", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const originalB = rows.get("B");
    await store.initFromDisk();
    expect(api.saveConnections).not.toHaveBeenCalled();
    rows.set("external-C", JSON.stringify(config("external-C")));
    await store.updateConnection({ ...store.getConfig("A")! });
    expect(api.saveConnections.mock.calls.map(([configs]) => configs.map((value: ConnectionConfig) => value.id))).toEqual([["A"]]);
    expect(JSON.parse(rows.get("A")!)).not.toHaveProperty("show_native_jobs");
    expect(rows.get("B")).toBe(originalB);
    expect(rows.has("external-C")).toBe(true);
    expect(store.connections.map((value) => value.id)).toEqual(["A", "B"]);
    await store.updateConnection({ ...store.getConfig("A")! });
    expect(api.saveConnections).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("writes only inherited timeouts that actually change", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.initFromDisk();
    store.getConfig("A")!.connect_timeout_inherit = true;
    const originalB = rows.get("B");
    await store.applyGlobalTimeouts({ connectTimeoutSecs: 30 });
    expect(api.saveConnections.mock.calls.map(([configs]) => configs.map((value: ConnectionConfig) => value.id))).toEqual([["A"]]);
    expect(store.getConfig("A")?.connect_timeout_secs).toBe(30);
    expect(store.getConfig("B")?.connect_timeout_secs).toBe(15);
    expect(rows.get("B")).toBe(originalB);
    await store.applyGlobalTimeouts({ connectTimeoutSecs: 30 });
    expect(api.saveConnections).toHaveBeenCalledTimes(1);
  });

  it("does not include survivors when renaming, changing visibility, or adding a connection", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.initFromDisk();
    const originalB = rows.get("B");
    await store.renameConnection("A", "Renamed");
    store.getConfig("A")!.visible_databases = ["old"];
    await store.ensureVisibleDatabase("A", "new");
    await store.addConnection(config("C"));
    expect(api.saveConnections.mock.calls.map(([configs]) => configs.map((value: ConnectionConfig) => value.id))).toEqual([["A"], ["A"], ["C"]]);
    expect(rows.get("B")).toBe(originalB);
    expect([...rows.keys()]).toEqual(["A", "B", "C"]);
  });
});
