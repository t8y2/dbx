import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function duckDbConnection(visibleDatabases?: string[]): ConnectionConfig {
  return {
    id: "duckdb-1",
    name: "DuckDB",
    db_type: "duckdb",
    host: "",
    port: 0,
    username: "",
    password: "",
    database: "main",
    visible_databases: visibleDatabases,
  } as ConnectionConfig;
}

function connectionNode(connection: ConnectionConfig): TreeNode {
  return {
    id: connection.id,
    label: connection.name,
    type: "connection",
    connectionId: connection.id,
    isExpanded: false,
    children: [],
  };
}

function rootEntries(node: TreeNode | undefined) {
  return (node?.children ?? []).map((child) => ({
    type: child.type,
    database: child.database,
    schema: child.schema,
    label: child.label,
  }));
}

async function setupStore(visibleDatabases?: string[]) {
  const listDatabases = vi.fn().mockResolvedValue([{ name: "main" }, { name: "analytics" }, { name: "warehouse" }]);
  const listSchemas = vi.fn().mockResolvedValue(["main", "reporting"]);
  const saveConnections = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listDatabases,
    listSchemas,
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections,
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  const connection = duckDbConnection(visibleDatabases);
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  store.sidebarLayout = { groups: [], order: [{ type: "connection", id: connection.id }] };
  store.treeNodes = [connectionNode(connection)];
  return { store, connection, saveConnections };
}

describe("connectionStore DuckDB visible databases", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("keeps main schemas and hides attached databases when only main is visible", async () => {
    const { store, connection } = await setupStore();

    await store.loadDatabases(connection.id, { force: true });
    await store.setVisibleDatabases(connection.id, ["main"]);

    expect(rootEntries(store.treeNodes[0])).toEqual([
      { type: "schema", database: "main", schema: "main", label: "main" },
      { type: "schema", database: "main", schema: "reporting", label: "reporting" },
    ]);
    expect(store.getSidebarVisibleFilterSummary(connection.id)).toEqual({ mode: "database", isExplicit: true, selected: 1, total: 3 });
  });

  it("hides main schemas and unselected attached databases", async () => {
    const { store, connection } = await setupStore();

    await store.loadDatabases(connection.id, { force: true });
    await store.setVisibleDatabases(connection.id, ["warehouse"]);

    expect(rootEntries(store.treeNodes[0])).toEqual([{ type: "database", database: "warehouse", schema: undefined, label: "warehouse" }]);
    expect(store.getSidebarVisibleFilterSummary(connection.id)).toEqual({ mode: "database", isExplicit: true, selected: 1, total: 3 });
  });

  it("restores main schemas and every attached database after clearing the filter", async () => {
    const { store, connection, saveConnections } = await setupStore();
    await store.loadDatabases(connection.id, { force: true });
    await store.setVisibleDatabases(connection.id, ["warehouse"]);

    await store.clearVisibleDatabases(connection.id);

    expect(rootEntries(store.treeNodes[0])).toEqual([
      { type: "schema", database: "main", schema: "main", label: "main" },
      { type: "schema", database: "main", schema: "reporting", label: "reporting" },
      { type: "database", database: "analytics", schema: undefined, label: "analytics" },
      { type: "database", database: "warehouse", schema: undefined, label: "warehouse" },
    ]);
    expect(store.getSidebarVisibleFilterSummary(connection.id)).toEqual({ mode: "database", isExplicit: false, selected: 3, total: 3 });
    expect(saveConnections).toHaveBeenLastCalledWith([expect.objectContaining({ id: connection.id, visible_databases: undefined })]);
  });
});
