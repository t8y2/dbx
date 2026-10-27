import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSchemaTreeCache } from "@/lib/metadata/schemaTreeCache";
import type { ConnectionConfig, TreeNode } from "@/types/database";
const mocks = vi.hoisted(() => ({
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([{ name: "smart" }, { name: "postgres" }]),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listInstalledAgents: vi.fn().mockResolvedValue([]),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadSchemaCache.mockResolvedValue(null);
  mocks.listDatabases.mockResolvedValue([{ name: "smart" }, { name: "postgres" }]);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
});
async function stores(overrides: Partial<ConnectionConfig> = {}) {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useQueryStore } = await import("@/stores/queryStore");
  const connection = { id: "pg", name: "PG", db_type: "postgres", host: "localhost", port: 5432, username: "viewer", password: "", database: "smart", ...overrides } as ConnectionConfig;
  const connections = useConnectionStore();
  connections.addEphemeralConnection(connection);
  connections.connectedIds.add("pg");
  connections.treeNodes = [{ id: "pg", label: "PG", type: "connection", connectionId: "pg", children: [] }];
  return { connections, queries: useQueryStore() };
}
describe("PostgreSQL administration navigation through stores", () => {
  it("reuses each tool tab and updates the selected information category", async () => {
    const { queries } = await stores();
    const locks = queries.openPostgresLocks("pg");
    expect(queries.openPostgresLocks("pg")).toBe(locks);
    const info = queries.openPostgresSystemInfo("pg", "extensions");
    expect(queries.openPostgresSystemInfo("pg", "languages")).toBe(info);
    const sessions = queries.openProcessList("pg");
    expect(queries.openProcessList("pg")).toBe(sessions);
    expect(queries.tabs).toHaveLength(3);
    expect(queries.tabs.find((tab) => tab.id === info)).toMatchObject({ database: "smart", postgresSystemCategory: "languages" });
    expect(queries.tabs.find((tab) => tab.id === sessions)?.title).toBe("PG - postgresAdmin.sessions");
  }, 30000);
  it("normalizes flat caches and keeps group state during refresh without stale databases", async () => {
    const { connections } = await stores();
    const flat: TreeNode[] = [{ id: "pg:smart", label: "smart", type: "database", connectionId: "pg", database: "smart", children: [] }];
    mocks.loadSchemaCache.mockResolvedValue(encodeSchemaTreeCache(flat));
    await connections.loadDatabases("pg");
    const root = connections.treeNodes[0];
    const group = root.children!.find((node) => node.type === "postgres-databases")!;
    expect(group.children!.map((node) => node.id)).toEqual(["pg:smart"]);
    group.isExpanded = false;
    mocks.listDatabases.mockResolvedValue([{ name: "other" }]);
    await connections.loadDatabases("pg", { force: true });
    const refreshed = root.children!.find((node) => node.type === "postgres-databases")!;
    expect(refreshed.isExpanded).toBe(false);
    expect(refreshed.children!.map((node) => node.id)).toEqual(["pg:other"]);
    expect(root.children!.filter((node) => node.type === "postgres-admin")).toHaveLength(1);
    await connections.loadDatabases("pg");
    expect(root.children!.filter((node) => node.type === "postgres-admin")).toHaveLength(1);
  });
  it("retains visible database filtering under the new group", async () => {
    const { connections } = await stores({ visible_databases: ["smart"] });
    await connections.loadDatabases("pg", { force: true });
    const group = connections.treeNodes[0].children!.find((node) => node.type === "postgres-databases")!;
    expect(group.children!.map((node) => node.database)).toEqual(["smart"]);
  });
});
