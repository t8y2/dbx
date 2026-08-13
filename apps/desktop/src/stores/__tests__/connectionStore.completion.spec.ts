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

function mysqlConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "mysql-1",
    name: "MySQL",
    db_type: "mysql",
    port: 3306,
    username: "root",
  } as ConnectionConfig;
}

function redisConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "redis-1",
    name: "Redis",
    db_type: "redis",
    port: 6379,
    database: "0",
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

function sapHanaConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "hana-1",
    name: "SAP HANA",
    db_type: "saphana",
    port: 30015,
    username: "SYSTEM",
    database: "",
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

function damengConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "dameng-1",
    name: "Dameng",
    db_type: "dameng",
    port: 5236,
    username: "dbx_test",
    database: "",
  } as ConnectionConfig;
}

function dorisConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "doris-1",
    name: "Doris",
    db_type: "doris",
    port: 9030,
    username: "root",
    database: "sales",
  } as ConnectionConfig;
}

function tdengineConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "tdengine-1",
    name: "TDengine",
    db_type: "tdengine",
    port: 6041,
    username: "root",
    database: "issue_5685",
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

  it("does not replace the active connection during a cold metadata search", async () => {
    const connectDb = vi.fn().mockResolvedValue("pg-1");
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "users", kind: "table", schema: "public" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      connectionDatabaseInfo: vi.fn().mockResolvedValue(null),
      connectionIdentifierQuote: vi.fn().mockResolvedValue('"'),
      completionAssistantSearch,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.activeConnectionId = "already-active";

    const tables = await store.listCompletionTables("pg-1", "app", "users", 20, undefined, true, undefined, undefined, { activateConnection: false });

    expect(connectDb).toHaveBeenCalledOnce();
    expect(store.connectedIds.has("pg-1")).toBe(true);
    expect(store.activeConnectionId).toBe("already-active");
    expect(tables).toEqual([{ name: "users", schema: "public", type: "table" }]);
  });

  it("falls back to the server COMMAND catalog when COMMAND DOCS is unsupported", async () => {
    const redisExecuteCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("unknown subcommand 'DOCS'"))
      .mockResolvedValueOnce({
        command: "COMMAND",
        safety: "allowed",
        value: [["get", 2, ["readonly"], 1, 1, 1, ["@read"], [], [], []]],
      });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      redisExecuteCommand,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [redisConnection()];
    store.connectedIds.add("redis-1");

    const docs = await store.listRedisCompletionCommandDocs("redis-1", "0");
    const cached = await store.listRedisCompletionCommandDocs("redis-1", "0");

    expect(redisExecuteCommand).toHaveBeenNthCalledWith(1, "redis-1", 0, "COMMAND DOCS");
    expect(redisExecuteCommand).toHaveBeenNthCalledWith(2, "redis-1", 0, "COMMAND");
    expect(redisExecuteCommand).toHaveBeenCalledTimes(2);
    expect(docs).toEqual([
      {
        name: "GET",
        summary: undefined,
        since: undefined,
        group: undefined,
        arity: 2,
        keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }],
      },
    ]);
    expect(cached).toEqual(docs);
  });

  it("merges COMMAND key positions into COMMAND DOCS metadata", async () => {
    const redisExecuteCommand = vi
      .fn()
      .mockResolvedValueOnce({
        command: "COMMAND DOCS",
        safety: "allowed",
        value: { get: { summary: "Returns a value.", arguments: [{ name: "key", type: "key" }] } },
      })
      .mockResolvedValueOnce({
        command: "COMMAND",
        safety: "allowed",
        value: [["get", 2, ["readonly"], 1, 1, 1, ["@read"], [], [], []]],
      });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      redisExecuteCommand,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [redisConnection()];
    store.connectedIds.add("redis-1");

    const docs = await store.listRedisCompletionCommandDocs("redis-1", "0");

    expect(docs[0]).toMatchObject({
      name: "GET",
      arity: 2,
      keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }],
    });
  });

  it("does not let an invalidated Redis metadata request overwrite fresh cache", async () => {
    const staleDocs = deferred<{ command: string; safety: string; value: unknown }>();
    const freshDocs = deferred<{ command: string; safety: string; value: unknown }>();
    let docsRequestCount = 0;
    const redisExecuteCommand = vi.fn((_connectionId: string, _database: number, command: string) => {
      if (command === "COMMAND DOCS") {
        docsRequestCount += 1;
        return docsRequestCount === 1 ? staleDocs.promise : freshDocs.promise;
      }
      return Promise.resolve({
        command: "COMMAND",
        safety: "allowed",
        value: [["get", 2, ["readonly"], 1, 1, 1, ["@read"], [], [], []]],
      });
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      redisExecuteCommand,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [redisConnection()];
    store.connectedIds.add("redis-1");

    const staleRequest = store.listRedisCompletionCommandDocs("redis-1", "0");
    await vi.waitFor(() => expect(redisExecuteCommand).toHaveBeenCalledTimes(1));
    store.invalidateCompletionCache("redis-1");
    const freshRequest = store.listRedisCompletionCommandDocs("redis-1", "0");
    freshDocs.resolve({ command: "COMMAND DOCS", safety: "allowed", value: { get: { summary: "fresh" } } });
    await expect(freshRequest).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: "GET", summary: "fresh" })]));

    staleDocs.resolve({ command: "COMMAND DOCS", safety: "allowed", value: { get: { summary: "stale" } } });
    await staleRequest;

    await expect(store.listRedisCompletionCommandDocs("redis-1", "0")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: "GET", summary: "fresh" })]));
  });

  it("does not suggest binary Redis key displays that the command input cannot execute", async () => {
    const redisScanKeysBatch = vi.fn().mockResolvedValue({
      cursor: 0,
      keys: [
        { key_display: "plain", key_raw: "cGxhaW4=", key_type: "string", ttl: -1 },
        { key_display: String.raw`literal\\xAC`, key_raw: "bGl0ZXJhbFx4QUM=", key_type: "string", ttl: -1 },
        { key_display: "\\xac", key_raw: "rA==", key_type: "string", ttl: -1 },
      ],
      total_keys: 3,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      redisScanKeysBatch,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [redisConnection()];
    store.connectedIds.add("redis-1");

    await expect(store.listRedisCompletionKeys("redis-1", "0")).resolves.toEqual(["plain", String.raw`literal\\xAC`]);
  });

  it("preserves TDengine stable type in completion metadata", async () => {
    const listTables = vi.fn().mockResolvedValue([
      { name: "test_tb", table_type: "STABLE", comment: null },
      { name: "ordinary_table", table_type: "TABLE", comment: null },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [tdengineConnection()];
    store.connectedIds.add("tdengine-1");

    const tables = await store.listCompletionTables("tdengine-1", "issue_5685");

    expect(tables).toEqual([
      { name: "test_tb", type: "table", tableType: "STABLE" },
      { name: "ordinary_table", type: "table" },
    ]);
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

  it("lets Oracle resolve CURRENT_SCHEMA for unqualified column completion", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [],
      incomplete: false,
      fallback_used: false,
    });
    const getColumns = vi.fn().mockResolvedValue([{ name: "REPORT_ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    const columns = await store.listCompletionColumns("oracle-1", "ORCL", "ORDERS", undefined, { clientSessionId: "tab-a", version: 0 });

    expect(completionAssistantSearch).not.toHaveBeenCalled();
    expect(getColumns).toHaveBeenCalledWith("oracle-1", "ORCL", "", "ORDERS", undefined, "tab-a");
    expect(columns).toEqual([expect.objectContaining({ name: "REPORT_ID", table: "ORDERS", schema: undefined, dataType: "NUMBER" })]);
    expect(store.lookupLocalCompletionColumns("oracle-1", "ORCL", "ORDERS")).toEqual([]);
  });

  it("uses the Dameng login schema for unqualified column completion", async () => {
    const completionAssistantSearch = vi.fn().mockRejectedValue(new Error("assistant unavailable"));
    const getColumns = vi.fn().mockResolvedValue([{ name: "ID", data_type: "BIGINT", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [damengConnection()];
    store.connectedIds.add("dameng-1");

    const first = await store.listCompletionColumns("dameng-1", "", "tb_user");
    const cached = await store.listCompletionColumns("dameng-1", "", "tb_user");

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(getColumns).toHaveBeenCalledTimes(1);
    expect(getColumns).toHaveBeenCalledWith("dameng-1", "", "dbx_test", "tb_user", undefined, undefined);
    expect(first).toEqual([expect.objectContaining({ name: "ID", table: "tb_user", schema: "dbx_test" })]);
    expect(cached).toEqual(first);
  });

  it("rejects assistant columns returned for a different MySQL parent table", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [
        { name: "status", kind: "column", schema: "app", parent_schema: "app", parent_name: "TB_KPI_SET_SCORE_DETAIL", data_type: "tinyint" },
        { name: "priority", kind: "column", schema: "app", parent_schema: "app", parent_name: "tb_kpi_set_score_relationship", data_type: "smallint" },
        { name: "archived_status", kind: "column", schema: "archive", parent_schema: "archive", parent_name: "tb_kpi_set_score_detail", data_type: "tinyint" },
        { name: "legacy_flag", kind: "column", schema: "app", data_type: "tinyint" },
      ],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns: vi.fn(),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [mysqlConnection()];
    store.connectedIds.add("mysql-1");

    const columns = await store.listCompletionColumns("mysql-1", "app", "tb_kpi_set_score_detail", "app");

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ parent_name: "tb_kpi_set_score_detail", parent_schema: "app" }));
    expect(columns.map((column) => [column.name, column.table])).toEqual([
      ["status", "tb_kpi_set_score_detail"],
      ["legacy_flag", "tb_kpi_set_score_detail"],
    ]);
  });

  it("normalizes unquoted Oracle aliases while preserving quoted case before catalog lookup", async () => {
    const completionAssistantSearch = vi.fn();
    const getColumns = vi.fn().mockResolvedValue([]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    await store.listCompletionColumns("oracle-1", "ORCL", "orders_alias", undefined, { clientSessionId: "tab-a", version: 0, tableQuoted: false });
    await store.listCompletionColumns("oracle-1", "ORCL", "orders_alias", undefined, { clientSessionId: "tab-a", version: 1, tableQuoted: true });
    await store.listCompletionColumns("oracle-1", "ORCL", "Orders_Alias", undefined, { clientSessionId: "tab-a", version: 2, tableQuoted: true });

    expect(getColumns.mock.calls.map((call) => call[3])).toEqual(["ORDERS_ALIAS", "orders_alias", "Orders_Alias"]);
    expect(completionAssistantSearch).not.toHaveBeenCalled();
  });

  it("normalizes unquoted SAP HANA table and schema names before column lookup", async () => {
    const completionAssistantSearch = vi.fn(async (request: { parent_name?: string | null; parent_schema?: string | null }) => ({
      candidates: [
        {
          name: request.parent_name === "ACDOCA" ? "BELNR" : "MixedColumn",
          kind: "column",
          schema: request.parent_schema,
          parent_schema: request.parent_schema,
          parent_name: request.parent_name,
          data_type: "NVARCHAR",
        },
      ],
      incomplete: false,
      fallback_used: false,
    }));

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns: vi.fn(),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [sapHanaConnection()];
    store.connectedIds.add("hana-1");

    const unquoted = await store.listCompletionColumns("hana-1", "", "acdoca", "saphanadb", { tableQuoted: false, schemaQuoted: false });
    const quoted = await store.listCompletionColumns("hana-1", "", "MixedTable", "MixedSchema", { tableQuoted: true, schemaQuoted: true });

    expect(completionAssistantSearch.mock.calls.map(([request]) => ({ schema: request.schema, parent_schema: request.parent_schema, parent_name: request.parent_name }))).toEqual([
      { schema: "SAPHANADB", parent_schema: "SAPHANADB", parent_name: "ACDOCA" },
      { schema: "MixedSchema", parent_schema: "MixedSchema", parent_name: "MixedTable" },
    ]);
    expect(unquoted).toEqual([expect.objectContaining({ name: "BELNR", table: "ACDOCA", schema: "SAPHANADB" })]);
    expect(quoted).toEqual([expect.objectContaining({ name: "MixedColumn", table: "MixedTable", schema: "MixedSchema" })]);
  });

  it("invalidates only the changed table completion metadata", async () => {
    const getColumns = vi.fn(async (_connectionId: string, _database: string, _schema: string, table: string) => [
      {
        name: `${table}_column_${getColumns.mock.calls.length}`,
        data_type: "integer",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        extra: null,
      },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch: vi.fn().mockRejectedValue(new Error("assistant unavailable")),
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [sqlServerConnection()];
    store.connectedIds.add("sqlserver-1");

    await store.listCompletionColumns("sqlserver-1", "app", "users", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "orders", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "users", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "orders", "dbo");
    expect(getColumns.mock.calls.map((call) => call[3])).toEqual(["users", "orders"]);

    expect(store.invalidateCompletionTableCache("sqlserver-1", "app", "users", "dbo")).toBeGreaterThan(0);

    await store.listCompletionColumns("sqlserver-1", "app", "users", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "orders", "dbo");
    expect(getColumns.mock.calls.map((call) => call[3])).toEqual(["users", "orders", "users"]);
  });

  it("keeps the same table cached in other catalogs", async () => {
    const getColumns = vi.fn(async (_connectionId: string, _database: string, _schema: string, table: string, catalog?: string) => [
      {
        name: `${catalog}_${table}`,
        data_type: "integer",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        extra: null,
      },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch: vi.fn(),
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [dorisConnection()];
    store.connectedIds.add("doris-1");

    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "internal");
    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "hive");
    expect(getColumns.mock.calls.map((call) => call[4])).toEqual(["internal", "hive"]);

    expect(store.invalidateCompletionTableCache("doris-1", "sales", "users", undefined, "internal")).toBeGreaterThan(0);

    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "internal");
    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "hive");
    expect(getColumns.mock.calls.map((call) => call[4])).toEqual(["internal", "hive", "internal"]);
  });

  it("keeps quoted and unquoted Oracle objects separate in the local column index", async () => {
    const completionAssistantSearch = vi.fn(async (request: { parent_name?: string | null }) => ({
      candidates: [
        {
          name: request.parent_name === "ORDERS_ALIAS" ? "UPPER_ID" : "LOWER_ID",
          kind: "column",
          schema: "APP",
          parent_schema: "APP",
          parent_name: request.parent_name,
          data_type: "NUMBER",
        },
      ],
      incomplete: false,
      fallback_used: false,
    }));

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns: vi.fn(),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    await store.listCompletionColumns("oracle-1", "ORCL", "orders_alias", "APP", { tableQuoted: false, schemaQuoted: false });
    await store.listCompletionColumns("oracle-1", "ORCL", "orders_alias", "APP", { tableQuoted: true, schemaQuoted: false });

    expect(store.lookupLocalCompletionColumns("oracle-1", "ORCL", "ORDERS_ALIAS", "APP").map((column) => column.name)).toEqual(["UPPER_ID"]);
    expect(store.lookupLocalCompletionColumns("oracle-1", "ORCL", "orders_alias", "APP").map((column) => column.name)).toEqual(["LOWER_ID"]);
    expect(store.lookupLocalCompletionColumns("oracle-1", "ORCL", "orders_alias", "app", undefined, { tableQuoted: false, schemaQuoted: false }).map((column) => column.name)).toEqual(["UPPER_ID"]);
    expect(store.lookupLocalCompletionColumns("oracle-1", "ORCL", "orders_alias", "APP", undefined, { tableQuoted: true, schemaQuoted: false }).map((column) => column.name)).toEqual(["LOWER_ID"]);
  });

  it("isolates Oracle CURRENT_SCHEMA column caches by tab and context version", async () => {
    const completionAssistantSearch = vi.fn();
    const getColumns = vi
      .fn()
      .mockResolvedValueOnce([{ name: "APP_ID", data_type: "NUMBER", is_nullable: false }])
      .mockResolvedValueOnce([{ name: "REPORT_ID", data_type: "NUMBER", is_nullable: false }])
      .mockResolvedValueOnce([{ name: "SYSTEM_ID", data_type: "NUMBER", is_nullable: false }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    const app = await store.listCompletionColumns("oracle-1", "ORCL", "SHARED_TABLE", undefined, { clientSessionId: "tab-a", version: 0 });
    const cachedApp = await store.listCompletionColumns("oracle-1", "ORCL", "SHARED_TABLE", undefined, { clientSessionId: "tab-a", version: 0 });
    const reporting = await store.listCompletionColumns("oracle-1", "ORCL", "SHARED_TABLE", undefined, { clientSessionId: "tab-a", version: 1 });
    const independentTab = await store.listCompletionColumns("oracle-1", "ORCL", "SHARED_TABLE", undefined, { clientSessionId: "tab-b", version: 0 });

    expect(app.map((column) => column.name)).toEqual(["APP_ID"]);
    expect(cachedApp.map((column) => column.name)).toEqual(["APP_ID"]);
    expect(reporting.map((column) => column.name)).toEqual(["REPORT_ID"]);
    expect(independentTab.map((column) => column.name)).toEqual(["SYSTEM_ID"]);
    expect(getColumns).toHaveBeenCalledTimes(3);
    expect(getColumns.mock.calls.map((call) => call[5])).toEqual(["tab-a", "tab-a", "tab-b"]);
    expect(completionAssistantSearch).not.toHaveBeenCalled();
  });

  it("keeps explicit Oracle schema completion on the shared assistant path", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "EXPLICIT_ID", kind: "column", schema: "REPORTING", parent_schema: "REPORTING", parent_name: "SHARED_TABLE", data_type: "NUMBER" }],
      incomplete: false,
      fallback_used: false,
    });
    const getColumns = vi.fn();

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [oracleConnection()];
    store.connectedIds.add("oracle-1");

    const columns = await store.listCompletionColumns("oracle-1", "ORCL", "SHARED_TABLE", "REPORTING", { clientSessionId: "tab-a", version: 2 });

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ schema: "REPORTING", parent_schema: "REPORTING", parent_name: "SHARED_TABLE" }));
    expect(getColumns).not.toHaveBeenCalled();
    expect(columns).toEqual([expect.objectContaining({ name: "EXPLICIT_ID", schema: "REPORTING" })]);
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

  it("searches the server-reported SQL Server default schema without treating the username as a schema", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "st_area", kind: "function", schema: "app_user", data_type: "float" }],
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

    const objects = await store.listCompletionObjects("sqlserver-1", "app", "st_", 20, undefined, undefined, false, "app_user");

    expect(completionAssistantSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "app_user",
        parent_schema: null,
        mask: "st_",
      }),
    );
    expect(objects).toEqual([
      expect.objectContaining({
        name: "st_area",
        schema: "app_user",
        type: "function",
        dataType: "float",
        applyName: "app_user.st_area",
        boost: 1000,
      }),
    ]);
  });

  it("prefers an explicit SQL Server routine schema over the current default schema", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "calculate_tax", kind: "function", schema: "sales", data_type: "decimal" }],
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

    await store.listCompletionObjects("sqlserver-1", "BarDB", "calculate_", 20, "sales", undefined, false, "app_user");

    expect(completionAssistantSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        database: "BarDB",
        schema: "sales",
        parent_schema: "sales",
        mask: "calculate_",
      }),
    );
  });

  it("caches SQL Server completion context independently for each database", async () => {
    const getSqlServerCompletionContext = vi.fn(async (_connectionId: string, database: string) => ({
      default_schema: database === "BarDB" ? "bar_user" : "foo_user",
      supports_session_database_switch: true,
    }));

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      getSqlServerCompletionContext,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [sqlServerConnection()];
    store.connectedIds.add("sqlserver-1");

    const foo = await store.getSqlServerCompletionContext("sqlserver-1", "FooDB");
    const fooCached = await store.getSqlServerCompletionContext("sqlserver-1", "FooDB");
    const bar = await store.getSqlServerCompletionContext("sqlserver-1", "BarDB");

    expect(foo).toMatchObject({ default_schema: "foo_user" });
    expect(fooCached).toEqual(foo);
    expect(bar).toMatchObject({ default_schema: "bar_user" });
    expect(getSqlServerCompletionContext).toHaveBeenCalledTimes(2);
  });

  it("keeps SQL Server routine results isolated across databases", async () => {
    const completionAssistantSearch = vi.fn(async (request: { database: string }) => ({
      candidates: [{ name: request.database === "BarDB" ? "bar_proc" : "foo_proc", kind: "procedure", schema: "app_user" }],
      incomplete: false,
      fallback_used: false,
    }));

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

    const foo = await store.listCompletionObjects("sqlserver-1", "FooDB", "", 20, undefined, undefined, false, "app_user");
    const bar = await store.listCompletionObjects("sqlserver-1", "BarDB", "", 20, undefined, undefined, false, "app_user");

    expect(foo.map((object) => object.name)).toEqual(["foo_proc"]);
    expect(bar.map((object) => object.name)).toEqual(["bar_proc"]);
    expect(completionAssistantSearch).toHaveBeenCalledTimes(2);
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

  it("keeps Doris table completion caches isolated by catalog", async () => {
    const listTables = vi.fn(async (...args: unknown[]) => {
      const catalog = args[7];
      return [{ name: catalog ? "external_orders" : "internal_orders", table_type: "BASE TABLE", comment: null }];
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [dorisConnection()];
    store.connectedIds.add("doris-1");

    const internal = await store.listCompletionTables("doris-1", "sales", "orders", 20);
    const external = await store.listCompletionTables("doris-1", "sales", "orders", 20, undefined, false, undefined, "hive_catalog");

    expect(listTables).toHaveBeenNthCalledWith(1, "doris-1", "sales", "sales", "orders", 20);
    expect(listTables).toHaveBeenNthCalledWith(2, "doris-1", "sales", "", "orders", 20, undefined, undefined, "hive_catalog");
    expect(internal).toEqual([{ name: "internal_orders", catalog: undefined, type: "table" }]);
    expect(external).toEqual([{ name: "external_orders", catalog: "hive_catalog", type: "table" }]);
    expect(store.lookupLocalCompletionTables("doris-1", "sales", "", 20)).toEqual(internal);
    expect(store.lookupLocalCompletionTables("doris-1", "sales", "", 20, undefined, "hive_catalog")).toEqual(external);
  });

  it("passes Doris catalog to column metadata and isolates same-name table caches", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({ candidates: [], incomplete: false, fallback_used: false });
    const getColumns = vi.fn(async (_connectionId: string, _database: string, _schema: string, _table: string, catalog?: string) => [
      {
        name: catalog ? "external_id" : "internal_id",
        data_type: "BIGINT",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        extra: null,
        comment: null,
      },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [dorisConnection()];
    store.connectedIds.add("doris-1");

    const internal = await store.listCompletionColumns("doris-1", "sales", "orders");
    const external = await store.listCompletionColumns("doris-1", "sales", "orders", undefined, undefined, "hive_catalog");

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(getColumns).toHaveBeenNthCalledWith(1, "doris-1", "sales", "sales", "orders", undefined, undefined);
    expect(getColumns).toHaveBeenNthCalledWith(2, "doris-1", "sales", "sales", "orders", "hive_catalog", undefined);
    expect(internal.map((column) => column.name)).toEqual(["internal_id"]);
    expect(external.map((column) => column.name)).toEqual(["external_id"]);
    expect(store.lookupLocalCompletionColumns("doris-1", "sales", "orders").map((column) => column.name)).toEqual(["internal_id"]);
    expect(store.lookupLocalCompletionColumns("doris-1", "sales", "orders", undefined, "hive_catalog").map((column) => column.name)).toEqual(["external_id"]);
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

  it("invalidates cached completion databases for a connection", async () => {
    const listDatabases = vi
      .fn()
      .mockResolvedValueOnce([{ name: "Archive" }])
      .mockResolvedValueOnce([{ name: "Reporting" }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listDatabases,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [sqlServerConnection()];
    store.connectedIds.add("sqlserver-1");

    expect(await store.listCompletionDatabases("sqlserver-1")).toEqual(["Archive"]);
    expect(await store.listCompletionDatabases("sqlserver-1")).toEqual(["Archive"]);

    store.invalidateCompletionCache("sqlserver-1");

    expect(await store.listCompletionDatabases("sqlserver-1")).toEqual(["Reporting"]);
    expect(listDatabases).toHaveBeenCalledTimes(2);
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
