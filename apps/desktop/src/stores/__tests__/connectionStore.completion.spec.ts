import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function postgresConnection(): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
    read_only: false,
  } as ConnectionConfig;
}

function oracleConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "oracle-1",
    name: "Oracle 11g",
    db_type: "oracle",
    port: 1521,
    username: "APP",
    database: "ORCL",
  } as ConnectionConfig;
}

function sqlServerConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "sqlserver-1",
    name: "SQL Server",
    db_type: "sqlserver",
    port: 1433,
    username: "sa",
    database: "app",
  } as ConnectionConfig;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("connectionStore completion assistant", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("deduplicates in-flight assistant table requests", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "accounts", kind: "table", schema: "public" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["public"]),
      listTables: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const [first, second] = await Promise.all([store.listCompletionTables("pg-1", "app", "acc", 20, "public"), store.listCompletionTables("pg-1", "app", "acc", 20, "public")]);

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ name: "accounts", schema: "public", type: "table" });
  });

  it("returns fallback metadata when assistant table search fails", async () => {
    const completionAssistantSearch = vi.fn().mockRejectedValue(new Error("assistant unavailable"));
    const listTables = vi.fn().mockResolvedValue([{ name: "accounts", table_type: "BASE TABLE", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["public"]),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const tables = await store.listCompletionTables("pg-1", "app", "acc", 20, "public");

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(listTables).toHaveBeenCalledWith("pg-1", "app", "public", "acc", 20);
    expect(tables).toEqual([{ name: "accounts", schema: "public", type: "table" }]);
  });

  it("keeps schema-qualified local table completion scoped to the selected schema", async () => {
    const completionAssistantSearch = vi.fn().mockRejectedValue(new Error("assistant unavailable"));
    const listTables = vi.fn(async (_connectionId: string, _database: string, schema: string, filter: string) => {
      if (schema === "dim_game_base" && filter === "dim") {
        return [{ name: "dim_game", table_type: "BASE TABLE", comment: null }];
      }
      return [];
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["dim_game_base", "dws_game_sdk_base"]),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const dimTables = await store.listCompletionTables("pg-1", "app", "dim", 20, "dim_game_base");
    const dwsTables = store.lookupLocalCompletionTables("pg-1", "app", "d", 20, "dws_game_sdk_base");

    expect(dimTables).toEqual([{ name: "dim_game", schema: "dim_game_base", type: "table" }]);
    expect(dwsTables).toEqual([]);
  });

  it("preserves table filter casing for assistant searches", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "TEST_USERS", kind: "table", schema: "SYSDBA" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["SYSDBA"]),
      listTables: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const tables = await store.listCompletionTables("pg-1", "app", "TEST_", 20, "SYSDBA");

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ mask: "TEST_", schema: "SYSDBA", parent_schema: "SYSDBA" }));
    expect(tables).toEqual([{ name: "TEST_USERS", schema: "SYSDBA", type: "table" }]);
  });

  it("scopes Oracle table completion to a qualified schema case-insensitively", async () => {
    const completionAssistantSearch = vi.fn(async (request: { schema?: string | null }) => ({
      candidates: request.schema?.toLowerCase() === "scott" ? [{ name: "EMP", kind: "table", schema: "SCOTT", data_type: "TABLE" }] : [],
      incomplete: false,
      fallback_used: false,
    }));

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listTables: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    const tables = await store.listCompletionTables("oracle-1", "ORCL", "", 20, "scott", false, "APP");

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ schema: "scott", parent_schema: "scott", global_search: false, mask: "" }));
    expect(tables).toEqual([expect.objectContaining({ name: "EMP", schema: "SCOTT", applyName: "EMP", boost: 2400 })]);
    expect(store.lookupLocalCompletionTables("oracle-1", "ORCL", "", 20, "scott")).toEqual(tables);
  });

  it("maps global Oracle tables with safe qualification and schema priority", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [
        { name: "DEPT_DICT", kind: "table", schema: "APP", data_type: "TABLE" },
        { name: "DEPT_DICT", kind: "view", schema: "COMM", data_type: "VIEW" },
        { name: "V_DEPT_DICT", kind: "view", schema: "SYS", data_type: "VIEW" },
        { name: "DEPT_DICT_ALIAS", kind: "table", schema: "PUBLIC", data_type: "SYNONYM" },
      ],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listTables: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    const tables = await store.listCompletionTables("oracle-1", "ORCL", "DEPT_D", 20, "APP", true);

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ schema: "APP", parent_schema: null, global_search: true, mask: "DEPT_D" }));
    expect(tables).toEqual([
      expect.objectContaining({ name: "DEPT_DICT", schema: "APP", applyName: "DEPT_DICT", boost: 2400 }),
      expect.objectContaining({ name: "DEPT_DICT", schema: "COMM", applyName: "COMM.DEPT_DICT", boost: 0 }),
      expect.objectContaining({ name: "V_DEPT_DICT", schema: "SYS", applyName: "SYS.V_DEPT_DICT", boost: -1200 }),
      expect.objectContaining({ name: "DEPT_DICT_ALIAS", schema: "PUBLIC", applyName: "DEPT_DICT_ALIAS", detail: "PUBLIC · synonym", boost: 1200 }),
    ]);
  });

  it("maps Oracle package members without scanning every schema", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "CALCULATE_BONUS", kind: "function", schema: "HR", parent_schema: "HR", parent_name: "PAYROLL", data_type: "FUNCTION" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listObjects: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    const objects = await store.listCompletionObjects("oracle-1", "ORCL", "CALC", 20, "HR", "PAYROLL", false, "APP");

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ object_kinds: ["routine"], mask: "CALC", schema: "APP", parent_schema: "HR", parent_name: "PAYROLL", global_search: false }));
    expect(objects).toEqual([expect.objectContaining({ name: "CALCULATE_BONUS", schema: "HR", type: "function", parentSchema: "HR", parentName: "PAYROLL", dataType: undefined, applyName: "HR.CALCULATE_BONUS", boost: 0 })]);
  });

  it("loads PostgreSQL routines by prefix and preserves return metadata", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "st_area", kind: "function", schema: "public", data_type: "double precision", comment: "Returns an area" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listCompletionObjects: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const objects = await store.listCompletionObjects("pg-1", "app", "st_", 20, "public", undefined, false, "public", ["function"]);

    expect(completionAssistantSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        object_kinds: ["function"],
        mask: "st_",
        schema: "public",
        parent_schema: "public",
        match_mode: "prefix",
      }),
    );
    expect(objects).toEqual([
      expect.objectContaining({
        name: "st_area",
        schema: "public",
        type: "function",
        dataType: "double precision",
        comment: "Returns an area",
        applyName: "st_area",
        boost: 1000,
      }),
    ]);
  });

  it("searches default SQL Server schemas without treating the username as a schema", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "st_area", kind: "function", schema: "dbo", data_type: "float" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listCompletionObjects: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [sqlServerConnection()];
    store.connectedIds.add("sqlserver-1");

    const objects = await store.listCompletionObjects("sqlserver-1", "app", "st_", 20);

    expect(completionAssistantSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: null,
        parent_schema: null,
        mask: "st_",
      }),
    );
    expect(objects).toEqual([
      expect.objectContaining({
        name: "st_area",
        schema: "dbo",
        type: "function",
        dataType: "float",
        applyName: "dbo.st_area",
        boost: 1000,
      }),
    ]);
  });

  it("limits concurrent completion column metadata requests per connection database", async () => {
    const gates = [deferred<any[]>(), deferred<any[]>(), deferred<any[]>(), deferred<any[]>()];
    let activeColumns = 0;
    let maxActiveColumns = 0;
    const getColumns = vi.fn((_connectionId: string, _database: string, _schema: string, table: string) => {
      const index = Number(table.replace("table_", ""));
      activeColumns++;
      maxActiveColumns = Math.max(maxActiveColumns, activeColumns);
      return gates[index].promise.finally(() => {
        activeColumns--;
      });
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch: vi.fn().mockResolvedValue({ candidates: [], incomplete: false, fallback_used: false }),
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const requests = [0, 1, 2, 3].map((index) => store.listCompletionColumns("pg-1", "app", `table_${index}`, "public"));

    await vi.waitFor(() => expect(getColumns).toHaveBeenCalledTimes(2));
    expect(maxActiveColumns).toBe(2);
    gates[0].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    await vi.waitFor(() => expect(getColumns).toHaveBeenCalledTimes(3));
    gates[1].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    gates[2].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    gates[3].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);

    await Promise.all(requests);
    expect(maxActiveColumns).toBe(2);
  });

  it("evicts old completion database entries", async () => {
    const listDatabases = vi.fn(async (connectionId: string) => [{ name: `db_${connectionId}` }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listDatabases,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();

    for (let index = 0; index < 51; index++) {
      const id = `pg-${index}`;
      store.addEphemeralConnection({ ...postgresConnection(), id, name: `Postgres ${index}` });
      await store.listCompletionDatabases(id);
    }

    await store.listCompletionDatabases("pg-0");

    expect(listDatabases).toHaveBeenCalledTimes(52);
  });

  it("evicts old completion schema entries", async () => {
    const listSchemas = vi.fn(async (_connectionId: string, database: string) => [`schema_${database}`]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listSchemas,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(postgresConnection());

    for (let index = 0; index < 51; index++) {
      await store.listCompletionSchemas("pg-1", `db_${index}`);
    }

    await store.listCompletionSchemas("pg-1", "db_0");

    expect(listSchemas).toHaveBeenCalledTimes(52);
  });
});
