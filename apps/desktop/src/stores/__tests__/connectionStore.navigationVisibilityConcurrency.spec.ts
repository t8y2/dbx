import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";

const visibilityFields = ["show_system_schemas", "visible_schemas", "visible_databases", "visible_database_patterns"] as const;

function config(id: string): ConnectionConfig {
  return { id, name: id, db_type: "postgres", host: `${id}.invalid`, port: 5432, username: "test", password: "", save_password: false, database: "app" } as ConnectionConfig;
}

async function fixture() {
  const persisted = new Map<string, ConnectionConfig>();
  const writes: Array<{ configs: ConnectionConfig[]; commit: () => void; fail: () => void }> = [];
  const saveConnections = vi.fn(
    (configs: ConnectionConfig[]) =>
      new Promise<void>((resolve, reject) => {
        const snapshot: ConnectionConfig[] = JSON.parse(JSON.stringify(configs));
        writes.push({
          configs: snapshot,
          commit: () => {
            snapshot.forEach((value) => persisted.set(value.id, value));
            resolve();
          },
          fail: () => reject(new Error("save failed")),
        });
      }),
  );
  const listDatabases = vi.fn().mockResolvedValue([{ name: "A" }, { name: "B" }]);
  const getColumns = vi.fn().mockResolvedValue([{ name: "id", data_type: "integer", is_nullable: false }]);
  const getTableDisplayDdl = vi.fn().mockResolvedValue("CREATE TABLE public.sample (id integer)");
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    saveConnections,
    listDatabases,
    getColumns,
    getTableDisplayDdl,
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [config("a"), config("b")];
  store.connections.forEach((value) => persisted.set(value.id, JSON.parse(JSON.stringify(value))));
  return { store, writes, persisted, listDatabases, getColumns, getTableDisplayDdl };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
});

describe("navigation visibility coordinated saves", () => {
  it.each(["oracle", "postgres"] as const)("saves an empty schema snapshot without changing execution defaults for %s", async (dbType) => {
    const { store, writes, persisted } = await fixture();
    store.connections[0] = { ...store.connections[0], db_type: dbType, default_schema: "APP", show_system_schemas: true, visible_databases: ["app"], visible_database_patterns: ["app%"], visible_schemas: { archive: ["history"] } };
    const save = store.setVisibleSchemas("a", "app", [], { names: ["APP", "SYS"], systemNames: new Set(["SYS"]) });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(store.getConfig("a")?.visible_schemas?.app).toBeUndefined();
    writes[0].commit();
    await save;
    expect(persisted.get("a")?.schema_visibility?.databases.app).toEqual(dbType === "oracle" ? { APP: false, app: true } : { APP: false });
    expect(persisted.get("a")?.visible_schemas).toEqual({ archive: ["history"] });
    expect(store.getConfig("a")?.default_schema).toBe("APP");
    expect(store.getConfig("a")?.database).toBe("app");
    expect(store.getConfig("a")?.visible_databases).toEqual(["app"]);
    expect(store.getConfig("a")?.visible_database_patterns).toEqual(["app%"]);
  });
  it("keeps schema edit context local to one edit session without changing or persisting its connection target", async () => {
    const { store, writes, persisted } = await fixture();
    store.startEditing("a", { visibleSchemaDatabase: "archive" });
    expect(store.editingConnectionId).toBe("a");
    expect(store.editingVisibleSchemaDatabase).toBe("archive");
    expect(store.getConfig("a")?.database).toBe("app");
    store.startEditing("a", { visibleSchemaDatabase: "other" });
    expect(store.editingVisibleSchemaDatabase).toBe("archive");
    store.stopEditing();
    expect(store.editingConnectionId).toBeNull();
    expect(store.editingVisibleSchemaDatabase).toBeUndefined();
    store.startEditing("a");
    expect(store.editingVisibleSchemaDatabase).toBeUndefined();
    store.stopEditing();
    store.startEditing("a", { visibleSchemaDatabase: "" });
    expect(store.editingVisibleSchemaDatabase).toBe("");
    store.startEditing("b");
    expect(store.editingConnectionId).toBe("b");
    expect(store.editingVisibleSchemaDatabase).toBeUndefined();
    expect(writes).toEqual([]);
    expect(persisted.get("a")?.database).toBe("app");
  });

  it("preserves different connections when persistence responses finish in reverse order", async () => {
    const { store, writes, persisted } = await fixture();
    const a = store.updateNavigationVisibility("a", "first", { filterSchemas: true, schemaNames: ["A"] });
    const b = store.updateNavigationVisibility("b", "second", { filterSchemas: true, schemaNames: ["B"] });
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1].commit();
    await b;
    writes[0].commit();
    await a;
    expect(store.getConfig("a")?.visible_schemas).toEqual({ first: ["A"] });
    expect(store.getConfig("b")?.visible_schemas).toEqual({ second: ["B"] });
    expect(persisted.get("a")?.visible_schemas).toEqual({ first: ["A"] });
    expect(persisted.get("b")?.visible_schemas).toEqual({ second: ["B"] });
  });

  it("serializes database-specific Schema edits and builds the second write from the first commit", async () => {
    const { store, writes, persisted } = await fixture();
    const first = store.updateNavigationVisibility("a", "first", { filterSchemas: true, schemaNames: ["A"] });
    const second = store.updateNavigationVisibility("a", "second", { filterSchemas: true, schemaNames: ["B"] });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].commit();
    await first;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].configs[0].visible_schemas).toEqual({ first: ["A"], second: ["B"] });
    writes[1].commit();
    await second;
    expect(store.getConfig("a")?.visible_schemas).toEqual({ first: ["A"], second: ["B"] });
    expect(persisted.get("a")?.visible_schemas).toEqual({ first: ["A"], second: ["B"] });
  });

  it("keeps a newly saved visibility range when an old connection form changes the target", async () => {
    const { store, writes, persisted } = await fixture();
    const old = { ...store.getConfig("a")! };
    const visibility = store.updateNavigationVisibility("a", "first", { filterSchemas: true, schemaNames: ["A"] });
    const edit = store.updateConnection({ ...old, host: "new-target.invalid" }, { preserveNavigationVisibility: visibilityFields });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].commit();
    await visibility;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].configs[0].visible_schemas).toEqual({ first: ["A"] });
    writes[1].commit();
    await edit;
    expect(store.getConfig("a")?.host).toBe("new-target.invalid");
    expect(store.getConfig("a")?.visible_schemas).toEqual({ first: ["A"] });
    expect(persisted.get("a")?.host).toBe("new-target.invalid");
    expect(persisted.get("a")?.visible_schemas).toEqual({ first: ["A"] });
  });

  it("rejects a queued old-target visibility patch after a target edit commits", async () => {
    const { store, writes, persisted } = await fixture();
    const old = { ...store.getConfig("a")! };
    const editing = store.updateConnection({ ...old, host: "new-target.invalid" });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const rejected = expect(store.updateNavigationVisibility("a", "first", { filterSchemas: true, schemaNames: ["OLD"], expectedFingerprint: connectionConfigFingerprint(old) })).rejects.toThrow();
    expect(writes).toHaveLength(1);
    writes[0].commit();
    await editing;
    await rejected;
    expect(writes).toHaveLength(1);
    expect(store.getConfig("a")?.host).toBe("new-target.invalid");
    expect(store.getConfig("a")?.visible_schemas).toBeUndefined();
    expect(persisted.get("a")?.host).toBe("new-target.invalid");
    expect(persisted.get("a")?.visible_schemas).toBeUndefined();
  });

  it("continues the next save after the previous persistence request fails", async () => {
    const { store, writes, persisted } = await fixture();
    const failed = expect(store.updateNavigationVisibility("a", "first", { filterSchemas: true, schemaNames: ["FAILED"] })).rejects.toThrow("save failed");
    const next = store.updateNavigationVisibility("a", "second", { filterSchemas: true, schemaNames: ["B"] });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].fail();
    await failed;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1].commit();
    await next;
    expect(store.getConfig("a")?.visible_schemas).toEqual({ second: ["B"] });
    expect(persisted.get("a")?.visible_schemas).toEqual({ second: ["B"] });
  });

  it("rejects an old-target edit queued behind a newer target commit", async () => {
    const { store, writes, persisted } = await fixture();
    const old = { ...store.getConfig("a")! };
    const current = store.updateConnection({ ...old, host: "new-target.invalid" });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const rejected = expect(store.updateConnection({ ...old, name: "stale edit" }, { expectedFingerprint: connectionConfigFingerprint(old) })).rejects.toThrow();
    writes[0].commit();
    await current;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toHaveLength(1);
    await rejected;
    expect(writes).toHaveLength(1);
    expect(store.getConfig("a")?.host).toBe("new-target.invalid");
    expect(persisted.get("a")?.host).toBe("new-target.invalid");
  });

  it("keeps default full updates capable of explicitly editing Nacos namespaces", async () => {
    const { store, writes, persisted } = await fixture();
    store.connections[0] = { ...store.connections[0], db_type: "nacos", visible_databases: ["old"] };
    const editing = store.updateConnection({ ...store.connections[0], visible_databases: ["new"] });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].commit();
    await editing;
    expect(store.getConfig("a")?.visible_databases).toEqual(["new"]);
    expect(persisted.get("a")?.visible_databases).toEqual(["new"]);
  });

  it("merges only the form's changed Schema database keys", async () => {
    const { store, writes, persisted } = await fixture();
    store.connections[0] = { ...store.connections[0], visible_schemas: { first: ["OLD_A"], second: ["OLD_B"] } };
    const old = { ...store.connections[0] };
    const visibility = store.updateNavigationVisibility("a", "second", { filterSchemas: true, schemaNames: ["B"] });
    const editing = store.updateConnection({ ...old, host: "new-target.invalid", visible_schemas: { ...old.visible_schemas, first: ["A"] } }, { preserveNavigationVisibility: visibilityFields.filter((field) => field !== "visible_schemas"), updatedVisibleSchemaKeys: ["first"] });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].commit();
    await visibility;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1].commit();
    await editing;
    expect(store.getConfig("a")?.visible_schemas).toEqual({ first: ["A"], second: ["B"] });
    expect(persisted.get("a")?.visible_schemas).toEqual({ first: ["A"], second: ["B"] });
  });

  it.each([
    { visible_databases: ["B"], visible_database_patterns: undefined },
    { visible_databases: undefined, visible_database_patterns: ["B"] },
  ])("invalidates database completion after a full form saves %j", async (visibility) => {
    const { store, writes, listDatabases } = await fixture();
    store.connections[0] = { ...store.connections[0], visible_databases: ["A"] };
    store.connectedIds.add("a");
    expect(await store.listCompletionDatabases("a")).toEqual(["A"]);
    const saving = store.updateConnection({ ...store.getConfig("a")!, ...visibility });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].commit();
    await saving;
    expect(await store.listCompletionDatabases("a")).toEqual(["B"]);
    expect(listDatabases).toHaveBeenCalledTimes(2);
  });

  it("refreshes visible navigation without discarding unrelated column or DDL caches", async () => {
    const { store, writes, listDatabases, getColumns, getTableDisplayDdl } = await fixture();
    store.connectedIds.add("a");
    const { loadObjectDdl } = await import("@/lib/metadata/objectDdlCache");
    const request = { connectionId: "a", database: "app", schema: "public", tableName: "sample" };
    await loadObjectDdl(request);
    expect(await store.listCompletionColumns("a", "app", "sample", "public")).toHaveLength(1);
    const saving = store.updateNavigationVisibility("a", "app", { filterSchemas: true, schemaNames: ["public"] });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].commit();
    await saving;
    store.treeNodes = [{ id: "a", type: "connection", label: "a", connectionId: "a", children: [] }];
    await store.refreshNavigationPresentation("a", { visibilityChanged: true });
    expect(listDatabases).toHaveBeenCalledOnce();
    expect(await store.listCompletionColumns("a", "app", "sample", "public")).toHaveLength(1);
    expect((await loadObjectDdl(request)).cacheStatus).toBe("memory");
    expect(getColumns).toHaveBeenCalledOnce();
    expect(getTableDisplayDdl).toHaveBeenCalledOnce();
    await store.refreshConnectionTreeNode(store.treeNodes[0]);
    await store.listCompletionColumns("a", "app", "sample", "public");
    expect((await loadObjectDdl(request)).cacheStatus).toBe("remote");
    expect(getColumns).toHaveBeenCalledTimes(2);
    expect(getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("filters a delayed database completion result using the latest saved visibility", async () => {
    const { store, writes, listDatabases } = await fixture();
    store.connections[0] = { ...store.connections[0], visible_databases: ["A"] };
    store.connectedIds.add("a");
    let finish!: (rows: Array<{ name: string }>) => void;
    listDatabases.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.listCompletionDatabases("a");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const saving = store.updateNavigationVisibility("a", "", { filterSchemas: false, databaseNames: ["B"] });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].commit();
    await saving;
    finish([{ name: "A" }, { name: "B" }]);
    expect(await pending).toEqual(["B"]);
    expect(await store.listCompletionDatabases("a")).toEqual(["B"]);
    expect(listDatabases).toHaveBeenCalledOnce();
  });
});
