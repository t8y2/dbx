import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { defaultRedisKeyGrouping } from "@/lib/redis/redisKeyGrouping";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(extra: Partial<ConnectionConfig> = {}) {
  const persisted = new Map<string, ConnectionConfig>();
  const saveConnections = vi.fn(async (configs: ConnectionConfig[], removedIds: string[] = []) => {
    configs.forEach((config) => persisted.set(config.id, JSON.parse(JSON.stringify(config))));
    removedIds.forEach((id) => persisted.delete(id));
  });
  const listSchemaInfos = vi.fn(async () => [{ name: "public" }, { name: "reporting" }, { name: "pg_catalog" }]);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    saveConnections,
    listSchemaInfos,
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [{ id: "pg", name: "PG", db_type: "postgres", host: "test.invalid", port: 5432, username: "test", password: "", database: "app", ...extra }];
  return { store, persisted, saveConnections, listSchemaInfos };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
});

describe("successful Schema reads migrate legacy visibility", () => {
  it("reads SQL Server system candidates, hides them by default and keeps an explicit choice after reload", async () => {
    const { store, listSchemaInfos, persisted } = await fixture({ db_type: "sqlserver", username: "app_user", default_schema: "dbo", visible_databases: ["app"], visible_database_patterns: ["app%"] });
    listSchemaInfos.mockResolvedValue([{ name: "dbo" }, { name: "sales" }, { name: "sys" }, { name: "INFORMATION_SCHEMA" }, { name: "db_owner" }]);
    const selection = await store.readVisibleSchemaSelection("pg", "app");
    expect(listSchemaInfos).toHaveBeenCalledWith("pg", "app", true);
    expect(selection.names).toEqual(["dbo", "sales", "sys", "INFORMATION_SCHEMA", "db_owner"]);
    expect([...selection.systemNames]).toEqual(["sys", "INFORMATION_SCHEMA", "db_owner"]);
    expect(selection.visibleNames).toEqual(["dbo", "sales"]);
    expect(persisted.get("pg")?.schema_visibility?.databases.app).toEqual({});
    await store.setVisibleSchemas("pg", "app", ["dbo", "sys"], { names: selection.names, systemNames: selection.systemNames });
    store.connections = [JSON.parse(JSON.stringify(persisted.get("pg")))];
    expect((await store.readVisibleSchemaSelection("pg", "app", true)).visibleNames).toEqual(["dbo", "sys"]);
    expect(store.getConfig("pg")?.default_schema).toBe("dbo");
    expect(store.getConfig("pg")?.database).toBe("app");
    expect(store.getConfig("pg")?.visible_databases).toEqual(["app"]);
    expect(store.getConfig("pg")?.visible_database_patterns).toEqual(["app%"]);
  });
  it("shares one root bucket without replacing the API execution owner when database is absent", async () => {
    const { store, saveConnections, listSchemaInfos } = await fixture({ db_type: "oracle", database: undefined, visible_schemas: { "": [] } });
    listSchemaInfos.mockResolvedValue([{ name: "APP" }, { name: "SYS" }]);
    expect((await store.readVisibleSchemaSelection("pg", "APP")).visibleNames).toEqual([]);
    expect(listSchemaInfos).toHaveBeenCalledWith("pg", "APP", true);
    expect(store.getConfig("pg")?.schema_visibility?.databases).toEqual({ "": { APP: false } });
    await store.readVisibleSchemaSelection("pg", "");
    expect(saveConnections).toHaveBeenCalledTimes(1);
    expect(store.getConfig("pg")?.database).toBeUndefined();
    const revision = store.completionCacheRevision("pg", "APP");
    await store.updateNavigationVisibility("pg", "", { filterSchemas: true, schemaNames: ["APP"], schemaCandidates: ["APP", "SYS"], systemSchemaNames: new Set(["SYS"]) });
    expect(store.completionCacheRevision("pg", "APP")).toBeGreaterThan(revision);
    listSchemaInfos.mockResolvedValue([{ name: "APP" }, { name: "NEW_APP" }, { name: "SYS" }]);
    expect((await store.readVisibleSchemaSelection("pg", "APP")).visibleNames).toEqual(["APP", "NEW_APP"]);
  });
  it("serializes a global timeout save with migration of the same connection", async () => {
    const { store, saveConnections, persisted } = await fixture({ connect_timeout_inherit: true, connect_timeout_secs: 10, visible_schemas: { app: [] } });
    const pending = deferred<void>();
    saveConnections.mockImplementationOnce(async (configs) => {
      await pending.promise;
      configs.forEach((config) => persisted.set(config.id, JSON.parse(JSON.stringify(config))));
    });
    const settings = store.applyGlobalTimeouts({ connectTimeoutSecs: 30 });
    await vi.waitFor(() => expect(saveConnections).toHaveBeenCalledTimes(1));
    const stale = expect(store.readVisibleSchemaSelection("pg", "app")).rejects.toThrow("superseded");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveConnections).toHaveBeenCalledTimes(1);
    pending.resolve();
    await settings;
    await stale;
    await store.readVisibleSchemaSelection("pg", "app");
    expect(store.getConfig("pg")?.connect_timeout_secs).toBe(30);
    expect(persisted.get("pg")?.schema_visibility?.databases.app).toEqual({ public: false, reporting: false });
    expect(store.getConfig("pg")?.schema_visibility).toEqual(persisted.get("pg")?.schema_visibility);
  });

  it.each(["add", "redis-alias", "redis-group"])("retains another connection's migration when a %s save finishes later", async (writer) => {
    const { store, saveConnections, persisted } = await fixture({ visible_schemas: { app: [] } });
    const other = { ...store.connections[0], id: "other", name: "Other", db_type: "redis" as const, port: 6379 };
    if (writer !== "add") store.connections.push(other);
    const pending = deferred<void>();
    saveConnections.mockImplementationOnce(async (configs) => {
      await pending.promise;
      configs.forEach((config) => persisted.set(config.id, JSON.parse(JSON.stringify(config))));
    });
    const saving = writer === "add" ? store.addConnection(other) : writer === "redis-alias" ? store.setRedisDatabaseAlias("other", 0, "Alias") : store.updateRedisKeyGrouping("other", { ...defaultRedisKeyGrouping(), enabled: true });
    await vi.waitFor(() => expect(saveConnections).toHaveBeenCalledTimes(1));
    await store.readVisibleSchemaSelection("pg", "app");
    pending.resolve();
    await saving;
    expect(store.getConfig("pg")?.schema_visibility?.databases.app).toEqual({ public: false, reporting: false });
    expect(store.getConfig("pg")?.schema_visibility).toEqual(persisted.get("pg")?.schema_visibility);
  });
  it("merges a manually edited database named __proto__ as an ordinary persisted key", async () => {
    const { store, persisted } = await fixture({ visible_schemas: {}, schema_visibility: { migrate_legacy: false, databases: {} } });
    const databases = JSON.parse('{"__proto__":{"constructor":false}}');
    await store.updateConnection({ ...store.connections[0], schema_visibility: { migrate_legacy: false, databases } }, { updatedVisibleSchemaKeys: ["__proto__"] });
    expect(persisted.get("pg")?.schema_visibility?.databases).toEqual(databases);
    expect(Object.hasOwn(store.connections[0].schema_visibility!.databases, "__proto__")).toBe(true);
  });
  it("reads complete candidates and migrates once without changing execution defaults", async () => {
    const { store, saveConnections, listSchemaInfos, persisted } = await fixture({ default_schema: "reporting", visible_schemas: { app: ["reporting"] } });
    expect((await store.readVisibleSchemaSelection("pg", "app")).visibleNames).toEqual(["reporting"]);
    expect(listSchemaInfos).toHaveBeenCalledWith("pg", "app", true);
    expect(persisted.get("pg")?.schema_visibility).toEqual({ migrate_legacy: true, databases: { app: { public: false } } });
    expect(store.getConfig("pg")?.default_schema).toBe("reporting");
    expect(store.getConfig("pg")?.database).toBe("app");
    await store.readVisibleSchemaSelection("pg", "app");
    expect(saveConnections).toHaveBeenCalledTimes(1);
  });

  it("uses new defaults without writing for a genuinely new connection", async () => {
    const { store, saveConnections } = await fixture({ schema_visibility: { migrate_legacy: false, databases: {} } });
    expect((await store.readVisibleSchemaSelection("pg", "app")).visibleNames).toEqual(["public", "reporting"]);
    expect(saveConnections).not.toHaveBeenCalled();
  });

  it("does not migrate a connection that only exists as an ephemeral preview", async () => {
    const { store, saveConnections } = await fixture();
    const config = store.connections[0];
    store.connections = [];
    store.addEphemeralConnection(config);
    await store.readVisibleSchemaSelection("pg", "app");
    expect(saveConnections).not.toHaveBeenCalled();
    expect(store.connections[0].schema_visibility).toBeUndefined();
  });

  it.each([{ one_time: true }, { id: "__visible_schema_draft_test" }])("does not persist temporary connections: %j", async (extra) => {
    const { store, saveConnections } = await fixture(extra);
    await store.readVisibleSchemaSelection(store.connections[0].id, "app");
    expect(saveConnections).not.toHaveBeenCalled();
    expect(store.connections[0].schema_visibility).toBeUndefined();
  });

  it("does not mark failed reads migrated and retries the read", async () => {
    const { store, saveConnections, listSchemaInfos } = await fixture();
    listSchemaInfos.mockRejectedValueOnce(new Error("read failed"));
    await expect(store.readVisibleSchemaSelection("pg", "app")).rejects.toThrow("read failed");
    expect(saveConnections).not.toHaveBeenCalled();
    expect(store.connections[0].schema_visibility).toBeUndefined();
    await store.readVisibleSchemaSelection("pg", "app");
    expect(saveConnections).toHaveBeenCalledTimes(1);
  });

  it("does not publish a failed save and retries persistence", async () => {
    const { store, saveConnections } = await fixture({ visible_schemas: { app: [] } });
    saveConnections.mockRejectedValueOnce(new Error("save failed"));
    await expect(store.readVisibleSchemaSelection("pg", "app")).rejects.toThrow("save failed");
    expect(store.connections[0].schema_visibility).toBeUndefined();
    expect((await store.readVisibleSchemaSelection("pg", "app")).visibleNames).toEqual([]);
    expect(saveConnections).toHaveBeenCalledTimes(2);
  });

  it("accepts a successful empty complete list and preserves unavailable selections", async () => {
    const { store, saveConnections, listSchemaInfos } = await fixture({ visible_schemas: { app: ["later"] } });
    listSchemaInfos.mockResolvedValueOnce([]);
    expect((await store.readVisibleSchemaSelection("pg", "app")).visibleNames).toEqual([]);
    expect(store.connections[0].schema_visibility?.databases.app).toEqual({ later: true });
    expect(saveConnections).toHaveBeenCalledTimes(1);
  });

  it("merges two database migrations and leaves unvisited databases legacy", async () => {
    const { store, saveConnections, persisted } = await fixture({ visible_schemas: { app: [], archive: ["reporting"], unvisited: ["history"] } });
    await Promise.all([store.readVisibleSchemaSelection("pg", "app"), store.readVisibleSchemaSelection("pg", "archive")]);
    expect(store.connections[0].schema_visibility).toEqual({ migrate_legacy: true, databases: { app: { public: false, reporting: false }, archive: { public: false } } });
    expect(persisted.get("pg")?.schema_visibility).toEqual(store.connections[0].schema_visibility);
    expect(saveConnections).toHaveBeenCalledTimes(2);
    expect(store.connections[0].visible_schemas?.unvisited).toEqual(["history"]);
  });

  it("does not overwrite a manual save that finishes during the complete read", async () => {
    const { store, listSchemaInfos, saveConnections } = await fixture({ visible_schemas: { app: [] } });
    const read = deferred<Array<{ name: string }>>();
    listSchemaInfos.mockReturnValueOnce(read.promise);
    const loading = store.readVisibleSchemaSelection("pg", "app");
    await store.updateNavigationVisibility("pg", "app", { filterSchemas: true, schemaNames: ["public"], schemaCandidates: ["public", "reporting", "pg_catalog"], systemSchemaNames: new Set(["pg_catalog"]) });
    read.resolve([{ name: "public" }, { name: "reporting" }, { name: "pg_catalog" }]);
    expect((await loading).visibleNames).toEqual(["public"]);
    expect(saveConnections).toHaveBeenCalledTimes(1);
  });

  it("rejects an old-target read before saving", async () => {
    const { store, listSchemaInfos, saveConnections } = await fixture();
    const read = deferred<Array<{ name: string }>>();
    listSchemaInfos.mockReturnValueOnce(read.promise);
    const loading = expect(store.readVisibleSchemaSelection("pg", "app")).rejects.toThrow();
    store.connections[0] = { ...store.connections[0], host: "other.invalid" };
    read.resolve([{ name: "public" }]);
    await loading;
    expect(saveConnections).not.toHaveBeenCalled();
  });

  it("waits for an in-flight migration before deleting the connection", async () => {
    const { store, saveConnections, persisted } = await fixture();
    const pending = deferred<void>();
    saveConnections.mockImplementationOnce(async (configs) => {
      await pending.promise;
      configs.forEach((config) => persisted.set(config.id, JSON.parse(JSON.stringify(config))));
    });
    const migrating = store.readVisibleSchemaSelection("pg", "app");
    await vi.waitFor(() => expect(saveConnections).toHaveBeenCalledTimes(1));
    const deleting = store.removeConnection("pg");
    expect(saveConnections).toHaveBeenCalledTimes(1);
    pending.resolve();
    await migrating;
    await deleting;
    expect(store.getConfig("pg")).toBeUndefined();
    expect(persisted.has("pg")).toBe(false);
    expect(saveConnections).toHaveBeenLastCalledWith([], ["pg"]);
  });

  it("keeps another connection's migration when deletion finishes later", async () => {
    const { store, saveConnections, persisted } = await fixture();
    store.connections.push({ ...store.connections[0], id: "other", visible_schemas: { app: [] } });
    const pending = deferred<void>();
    saveConnections.mockImplementationOnce(async () => {
      await pending.promise;
    });
    const deleting = store.removeConnection("pg");
    await vi.waitFor(() => expect(saveConnections).toHaveBeenCalledTimes(1));
    await store.readVisibleSchemaSelection("other", "app");
    pending.resolve();
    await deleting;
    expect(store.getConfig("other")?.schema_visibility?.databases.app).toEqual({ public: false, reporting: false });
    expect(store.getConfig("other")?.schema_visibility).toEqual(persisted.get("other")?.schema_visibility);
  });

  it.each(["default", "rename", "database-filter"])("keeps a queued %s edit and the in-flight migration", async (kind) => {
    const { store, saveConnections, persisted } = await fixture({ visible_schemas: { app: [] } });
    const save = deferred<void>();
    saveConnections.mockImplementationOnce(async (configs) => {
      await save.promise;
      configs.forEach((config) => persisted.set(config.id, JSON.parse(JSON.stringify(config))));
    });
    const migrating = store.readVisibleSchemaSelection("pg", "app");
    await vi.waitFor(() => expect(saveConnections).toHaveBeenCalledTimes(1));
    const editing = kind === "default" ? store.setDefaultSchema("pg", "reporting") : kind === "rename" ? store.renameConnection("pg", "New name") : store.updateNavigationVisibility("pg", "", { filterSchemas: false, databaseNames: ["archive"], databasePatterns: ["test%"] });
    save.resolve();
    await migrating;
    await editing;
    expect(persisted.get("pg")?.schema_visibility?.databases.app).toEqual({ public: false, reporting: false });
    expect(store.connections[0].schema_visibility).toEqual(persisted.get("pg")?.schema_visibility);
    if (kind === "default") expect(store.connections[0].default_schema).toBe("reporting");
    if (kind === "rename") expect(store.connections[0].name).toBe("New name");
    if (kind === "database-filter") expect(store.connections[0].visible_database_patterns).toEqual(["test%"]);
  });
});
