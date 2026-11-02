import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

beforeEach(() => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  setActivePinia(createPinia());
});

afterEach(() => vi.unstubAllGlobals());

async function createHarness(mode: "simple" | "grouped" = "simple", disk = new Map<string, string>()) {
  const listSchemaInfos = vi.fn(async (_id: string, _database: string) => [
    { name: "PUBLIC", comment: null },
    { name: "Sales Area", comment: null },
  ]);
  const listTables = vi.fn(async (_id: string, database: string, schema: string) => [{ name: "SHARED_TABLE", table_type: "TABLE", schema, comment: database }]);
  const getColumns = vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_nullable: false }]);
  const loadSchemaCache = vi.fn(async (key: string) => disk.get(key) ?? null);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    deleteSchemaCachePrefix: vi.fn(async (prefix: string) => {
      for (const key of disk.keys()) if (key.startsWith(prefix)) disk.delete(key);
    }),
    listSchemaInfos,
    listTables,
    getColumns,
    listObjects: vi.fn().mockResolvedValue([]),
    loadSchemaCache,
    saveSchemaCache: vi.fn(async (key: string, value: string) => {
      disk.set(key, value);
    }),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  useSettingsStore().editorSettings.sidebarObjectDisplay = mode;
  const store = useConnectionStore();
  const connection = { id: "snowflake-test", name: "Snowflake", db_type: "snowflake", database: "DEFAULT_DB", host: "fixture.invalid", port: 443, username: "", password: "" } as ConnectionConfig;
  const databases: TreeNode[] = ["DEFAULT_DB", "OTHER_DB"].map((database) => ({ id: `${connection.id}:${database}`, label: database, type: "database", connectionId: connection.id, database, children: [] }));
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: databases }];
  return { store, connection, databases, listSchemaInfos, listTables, getColumns, loadSchemaCache, disk };
}

describe("Snowflake sidebar namespace metadata", () => {
  it.each(["simple", "grouped"] as const)("loads database/schema/table/column scopes in %s mode", async (mode) => {
    const { store, connection, databases, listSchemaInfos, listTables, getColumns } = await createHarness(mode);
    for (const database of databases) {
      await store.loadTreeNodeChildren(database);
      expect(listSchemaInfos).toHaveBeenCalledWith(connection.id, database.database);
      const schemas = database.children!.filter((node) => node.type === "schema");
      expect(schemas.map((node) => node.schema)).toEqual(["PUBLIC", "Sales Area"]);
      for (const schema of schemas) {
        await store.loadTreeNodeChildren(schema);
        const parent = mode === "simple" ? schema : schema.children!.find((node) => node.type === "group-tables")!;
        if (mode === "grouped") await store.loadTreeNodeChildren(parent);
        const table = parent.children!.find((node) => node.type === "table")!;
        expect(table).toMatchObject({ label: "SHARED_TABLE", database: database.database, schema: schema.schema, comment: database.database });
        await store.loadTreeNodeChildren(table);
        const columns = table.children!.find((node) => node.type === "group-columns")!;
        await store.loadTreeNodeChildren(columns);
        expect(getColumns).toHaveBeenCalledWith(connection.id, database.database, schema.schema, "SHARED_TABLE", undefined);
        expect(columns.children?.map((node) => node.label)).toContain("ID (NUMBER)");
      }
    }
    expect(listTables.mock.calls.every((args) => ["PUBLIC", "Sales Area"].includes(args[2]))).toBe(true);
  });

  it("reuses cached schema metadata and refreshes changed schemas explicitly", async () => {
    const { store, databases, listSchemaInfos } = await createHarness();
    const database = databases[1]!;
    await store.loadTreeNodeChildren(database);
    await store.loadTreeNodeChildren(database);
    expect(listSchemaInfos).toHaveBeenCalledOnce();
    listSchemaInfos.mockResolvedValue([{ name: "NEW_SCHEMA", comment: null }]);
    await store.loadTreeNodeChildren(database, { force: true });
    expect(listSchemaInfos).toHaveBeenCalledTimes(2);
    expect(database.children?.filter((node) => node.type === "schema").map((node) => node.schema)).toEqual(["NEW_SCHEMA"]);
  });

  it("restores persisted schema and table metadata after store reload", async () => {
    const first = await createHarness();
    await first.store.loadTreeNodeChildren(first.databases[1]!);
    const schema = first.databases[1]!.children!.find((node) => node.schema === "PUBLIC")!;
    await first.store.loadTreeNodeChildren(schema);
    expect(first.disk.size).toBeGreaterThan(0);
    vi.resetModules();
    setActivePinia(createPinia());
    const restored = await createHarness("simple", first.disk);
    let finishRefresh!: (tables: Awaited<ReturnType<typeof restored.listTables>>) => void;
    restored.listTables.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    await restored.store.loadTreeNodeChildren(restored.databases[1]!);
    const restoredSchema = restored.databases[1]!.children!.find((node) => node.schema === "PUBLIC")!;
    await restored.store.loadTreeNodeChildren(restoredSchema);
    expect(restored.listSchemaInfos).not.toHaveBeenCalled();
    expect(restoredSchema.children).toEqual(expect.arrayContaining([expect.objectContaining({ label: "SHARED_TABLE", database: "OTHER_DB", schema: "PUBLIC" })]));
    finishRefresh([{ name: "REFRESHED_TABLE", table_type: "TABLE", schema: "PUBLIC", comment: "OTHER_DB" }]);
    await vi.waitFor(() => expect(restoredSchema.children).toEqual(expect.arrayContaining([expect.objectContaining({ label: "REFRESHED_TABLE", database: "OTHER_DB", schema: "PUBLIC" })])));
  });

  it.each(["empty", "denied"])("preserves %s schema results without a flat table fallback", async (state) => {
    const { store, databases, listSchemaInfos, listTables } = await createHarness();
    const database = databases[1]!;
    if (state === "empty") {
      listSchemaInfos.mockResolvedValue([]);
      await store.loadTreeNodeChildren(database);
    } else {
      listSchemaInfos.mockRejectedValueOnce(new Error("permission denied"));
      await expect(store.loadTreeNodeChildren(database)).rejects.toThrow("permission denied");
    }
    expect(database.children?.filter((node) => node.type === "schema" || node.type === "table")).toEqual([]);
    expect(listTables).not.toHaveBeenCalled();
    if (state === "denied") {
      await store.loadTreeNodeChildren(database, { force: true });
      expect(database.children?.filter((node) => node.type === "schema")).toHaveLength(2);
    }
  });
});
