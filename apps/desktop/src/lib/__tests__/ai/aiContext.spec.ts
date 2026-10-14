import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiSchemaSelectionSupported, buildAiContext, resolveAiDatabaseTarget, resolveAiMentionDatabases, resolveAiNamespaceSelection, resolveDefaultAiSchema, runAgentStream } from "@/lib/ai/ai";
import type { AiConfig } from "@/types/ai";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const apiMock = vi.hoisted(() => ({
  listTables: vi.fn(),
  listSchemas: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  listForeignKeys: vi.fn(),
  aiAgentStream: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

function sqliteConnection(database?: string): ConnectionConfig {
  return {
    id: "sqlite-1",
    name: "SQLite",
    db_type: "sqlite",
    host: "/tmp/real.sqlite",
    port: 0,
    username: "",
    password: "",
    database,
  };
}

function queryTab(database: string, schema?: string): QueryTab {
  return {
    id: "tab-1",
    title: "Query",
    connectionId: "sqlite-1",
    database,
    schema,
    sql: "",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "query",
  };
}

function damengConnection(database = "APPDB"): ConnectionConfig {
  return {
    id: "dameng-1",
    name: "Dameng",
    db_type: "dameng",
    host: "127.0.0.1",
    port: 5236,
    username: "APP_USER",
    password: "",
    database,
  };
}

function postgresConnection(database = "app"): ConnectionConfig {
  return {
    id: "postgres-1",
    name: "PostgreSQL",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "app_user",
    password: "",
    database,
  };
}

function aiConfig(): AiConfig {
  return {
    provider: "openai",
    apiKey: "",
    authMethod: "api-key",
    endpoint: "",
    model: "test-model",
    apiStyle: "responses",
  };
}

describe("SQLite AI context routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listTables.mockResolvedValue([]);
    apiMock.getColumns.mockResolvedValue([]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
  });

  it("uses main for a stale path-shaped SQLite database value", async () => {
    const context = await buildAiContext(queryTab("/tmp/stale.sqlite"), sqliteConnection("/tmp/legacy.sqlite"));

    expect(context.database).toBe("main");
    expect(apiMock.listTables).toHaveBeenCalledWith("sqlite-1", "main", "main");
  });

  it("preserves an attached SQLite database alias", async () => {
    const context = await buildAiContext(queryTab("analytics"), sqliteConnection());

    expect(context.database).toBe("analytics");
    expect(apiMock.listTables).toHaveBeenCalledWith("sqlite-1", "analytics", "analytics");
  });

  // A mention records the database it was listed from verbatim; it has to be
  // read through the same namespace resolution as the run (#11660).
  it("reads a mention recorded with a path-shaped SQLite database from main", async () => {
    const context = await buildAiContext(queryTab("/tmp/real.sqlite"), sqliteConnection(), {
      mentionedTables: [{ raw: "@users", database: "/tmp/real.sqlite", table: "users" }],
    });

    expect(apiMock.getColumns).toHaveBeenCalledWith("sqlite-1", "main", "main", "users");
    expect(context.tables).toEqual([expect.objectContaining({ name: "users" })]);
    expect(context.tables[0]?.database).toBeUndefined();
  });
});

describe("Dameng AI context routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listTables.mockResolvedValue([]);
    apiMock.getColumns.mockResolvedValue([]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
    apiMock.aiAgentStream.mockResolvedValue("done");
  });

  it("keeps the connection database while routing metadata through the selected schema", async () => {
    const tab = { ...queryTab("APPDB", "REPORTING"), connectionId: "dameng-1" };
    const context = await buildAiContext(tab, damengConnection());

    expect(context.database).toBe("APPDB");
    expect(context.schema).toBe("REPORTING");
    expect(apiMock.listTables).toHaveBeenCalledWith("dameng-1", "APPDB", "REPORTING");

    await runAgentStream(
      {
        config: aiConfig(),
        action: "general",
        mode: "agent",
        instruction: "inspect orders",
        context,
      },
      [],
      vi.fn(),
      "session-1",
    );
    expect(apiMock.aiAgentStream).toHaveBeenCalledWith("session-1", expect.any(Object), "dameng-1", "APPDB", "REPORTING", "dameng", expect.any(Function), "agent", false, undefined, undefined, undefined, undefined, undefined, undefined, false);
  });

  it("models the AI selector as a schema and chooses the connected user by default", () => {
    const connection = damengConnection();
    expect(resolveAiNamespaceSelection(queryTab("APPDB", "REPORTING"), connection)).toEqual({
      kind: "schema",
      value: "REPORTING",
    });
    expect(resolveDefaultAiSchema(connection, ["ARCHIVE", "APP_USER", "REPORTING"])).toBe("APP_USER");
    expect(resolveDefaultAiSchema(connection, ["REPORTING", "ARCHIVE"])).toBe("REPORTING");
  });

  it("lists @ mention tables from the databases picked in the composer", () => {
    const connection = postgresConnection();
    expect(resolveAiMentionDatabases(queryTab("db_first"), connection, ["db_second"])).toEqual(["db_second"]);
    expect(resolveAiMentionDatabases(queryTab("db_first"), connection, ["db_second", "db_first"])).toEqual(["db_second", "db_first"]);
    expect(resolveAiMentionDatabases(queryTab("db_first"), connection, [])).toEqual(["db_first"]);
    expect(resolveAiMentionDatabases(queryTab("db_first"), damengConnection(), ["ignored"])).toEqual(["db_first"]);
  });

  it("does not change non-Dameng namespace behavior", () => {
    expect(resolveAiDatabaseTarget(queryTab("analytics"), sqliteConnection())).toEqual({ database: "analytics" });
  });
});

// #11660: several databases can be selected at once, so `@` has to list and
// resolve against every one of them instead of only the first.
describe("AI multi-database table mentions", () => {
  const tab = { ...queryTab("db_first"), connectionId: "postgres-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listSchemas.mockResolvedValue(["public"]);
    apiMock.listTables.mockResolvedValue([]);
    apiMock.getColumns.mockResolvedValue([{ name: "id", data_type: "integer", is_nullable: false, is_primary_key: true }]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
    apiMock.aiAgentStream.mockResolvedValue("done");
  });

  it("lists every selected database and falls back to the tab's own one", () => {
    const connection = postgresConnection();
    expect(resolveAiMentionDatabases(queryTab("db_first"), connection, ["db_first", "db_second"])).toEqual(["db_first", "db_second"]);
    expect(resolveAiMentionDatabases(queryTab("db_first"), connection, [])).toEqual(["db_first"]);
    // Dameng's top-level selector is a schema, so the database stays the tab's.
    expect(resolveAiMentionDatabases(queryTab("db_first"), damengConnection(), ["ignored"])).toEqual(["db_first"]);
    expect(resolveAiMentionDatabases(queryTab(""), postgresConnection(""), [])).toEqual([]);
  });

  it("loads a qualified mention from its own database and qualifies it in the prompt", async () => {
    const context = await buildAiContext(tab, postgresConnection(), {
      databases: ["db_first", "db_second"],
      mentionedTables: [{ raw: "@db_second.public.logs", database: "db_second", schema: "public", table: "logs" }],
    });

    expect(apiMock.getColumns).toHaveBeenCalledWith("postgres-1", "db_second", "public", "logs");
    expect(context.tables).toEqual([expect.objectContaining({ database: "db_second", schema: "public", name: "logs" })]);

    await runAgentStream({ config: aiConfig(), action: "general", mode: "ask", instruction: "inspect logs", context }, [], vi.fn(), "session-multi");
    // The schema block has to name the database, or the model cannot tell two
    // same-named tables of different databases apart.
    expect(apiMock.aiAgentStream.mock.calls[0]?.[1]?.systemPrompt).toContain("db_second.public.logs");
  });

  it("keeps same-named tables of two databases as two entries", async () => {
    const context = await buildAiContext(tab, postgresConnection(), {
      databases: ["db_first", "db_second"],
      mentionedTables: [
        { raw: "@db_first.public.logs", database: "db_first", schema: "public", table: "logs" },
        { raw: "@db_second.public.logs", database: "db_second", schema: "public", table: "logs" },
      ],
    });

    expect(context.tables.map((table) => table.database)).toEqual(["db_first", "db_second"]);
  });

  it("does not list a mention of the tab's own table twice", async () => {
    const focused = { ...tab, tableMeta: { schema: "public", tableName: "logs", columns: [] } };
    const context = await buildAiContext(focused, postgresConnection(), {
      databases: ["db_first", "db_second"],
      mentionedTables: [{ raw: "@db_first.public.logs", database: "db_first", schema: "public", table: "logs" }],
    });

    expect(context.tables.filter((table) => table.name === "logs")).toHaveLength(1);
  });

  it("inherits the focused table's schema for a differently-cased database name", async () => {
    const focused = { ...tab, tableMeta: { schema: "public", tableName: "logs", columns: [] } };
    await buildAiContext(focused, postgresConnection(), {
      databases: ["db_first"],
      mentionedTables: [{ raw: "@DB_FIRST.logs", database: "DB_FIRST", table: "logs" }],
    });

    expect(apiMock.getColumns).toHaveBeenCalledWith("postgres-1", "DB_FIRST", "public", "logs");
  });

  it("drops a mention of a database outside the run scope", async () => {
    const context = await buildAiContext(tab, postgresConnection(), {
      databases: ["db_first"],
      mentionedTables: [{ raw: "@db_third.public.logs", database: "db_third", schema: "public", table: "logs" }],
    });

    expect(apiMock.getColumns).not.toHaveBeenCalled();
    expect(context.tables).toEqual([]);
  });

  // A mention typed without a database belongs to the run's own database, so it
  // has to deduplicate against that database's schema dump (#11660).
  it("does not repeat an unqualified mention already loaded with the schema", async () => {
    apiMock.listTables.mockResolvedValue([{ name: "users", table_type: "TABLE" }]);
    const context = await buildAiContext(tab, postgresConnection(), {
      databases: ["db_first", "db_second"],
      mentionedTables: [{ raw: "@public.users", schema: "public", table: "users" }],
    });

    expect(context.tables.filter((table) => table.name === "users")).toHaveLength(1);
  });

  it("loads a MySQL-style db.table mention from its own database", async () => {
    const connection: ConnectionConfig = { ...postgresConnection(), id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app-db" };
    const context = await buildAiContext({ ...queryTab("app-db"), connectionId: "mysql-1" }, connection, {
      databases: ["app-db", "analytics"],
      mentionedTables: [{ raw: "@analytics.users", database: "analytics", table: "users" }],
    });

    // MySQL has no separate schema level, so the database doubles as the schema.
    expect(apiMock.getColumns).toHaveBeenCalledWith("mysql-1", "analytics", "analytics", "users");
    expect(context.tables).toEqual([expect.objectContaining({ database: "analytics", name: "users" })]);
    expect(context.tables[0]?.schema).toBeUndefined();
  });
});

describe("PostgreSQL AI schema routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listTables.mockResolvedValue([]);
    apiMock.getColumns.mockResolvedValue([]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
    apiMock.aiAgentStream.mockResolvedValue("done");
  });

  it("scopes metadata and agent tools to the selected schema", async () => {
    const tab = { ...queryTab("app", "main_chatdr"), connectionId: "postgres-1" };
    const connection = postgresConnection();
    const context = await buildAiContext(tab, connection);

    expect(resolveAiDatabaseTarget(tab, connection)).toEqual({ database: "app", schema: "main_chatdr" });
    expect(context.schema).toBe("main_chatdr");
    expect(apiMock.listTables).toHaveBeenCalledWith("postgres-1", "app", "main_chatdr");

    await runAgentStream(
      {
        config: aiConfig(),
        action: "general",
        mode: "agent",
        instruction: "inspect chat_dial_in",
        context,
      },
      [],
      vi.fn(),
      "session-postgres",
    );
    expect(apiMock.aiAgentStream).toHaveBeenCalledWith("session-postgres", expect.any(Object), "postgres-1", "app", "main_chatdr", "postgres", expect.any(Function), "agent", false, undefined, undefined, undefined, undefined, undefined, undefined, false);
  });
});

describe("AI schema selector visibility", () => {
  it("matches the effective type consumed by resolveAiDatabaseTarget", () => {
    const gbaseLikeMysql: ConnectionConfig = {
      id: "gbase-1",
      name: "GBase",
      db_type: "gbase",
      host: "localhost",
      port: 5258,
      username: "dbx",
      password: "",
      database: "app",
    };
    // gbase is schema-aware at the raw metadata level but maps to a
    // MySQL-like effective type, so the AI target ignores schema selections
    // and the selector must stay hidden to avoid a silently dropped choice.
    expect(aiSchemaSelectionSupported(gbaseLikeMysql)).toBe(false);
    const tab: QueryTab = queryTab("app", "sysmaster");
    expect(resolveAiDatabaseTarget(tab, gbaseLikeMysql)).toEqual({ database: "app" });

    const postgres: ConnectionConfig = { ...gbaseLikeMysql, id: "pg-1", db_type: "postgres" };
    expect(aiSchemaSelectionSupported(postgres)).toBe(true);
    expect(resolveAiDatabaseTarget(queryTab("app", "public"), postgres)).toEqual({ database: "app", schema: "public" });
  });
});

describe("Plugin AI context", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])("skips database metadata even with stale table context: %s", async (withTable) => {
    const connection: ConnectionConfig = { ...postgresConnection(), db_type: "plugin", plugin_id: "sample.plugin" };
    const tab = { ...queryTab("stale-db", "public"), connectionId: connection.id, tableMeta: withTable ? { schema: "public", tableName: "stale_table", columns: [] } : undefined };
    const context = await buildAiContext(tab, connection, { mentionedTables: [{ schema: "public", table: "stale_mention" }], sqlFiles: [{ name: "notes.sql", content: "SELECT 1" }] });
    expect(context.databaseType).toBe("plugin");
    expect(context.connectionName).toBe(connection.name);
    expect(context.tables).toEqual([]);
    expect(context.truncated).toBe(false);
    expect(context.sqlFiles).toEqual([{ name: "notes.sql", content: "SELECT 1" }]);
    expect(apiMock.listTables).not.toHaveBeenCalled();
    expect(apiMock.getColumns).not.toHaveBeenCalled();
    expect(apiMock.listIndexes).not.toHaveBeenCalled();
    expect(apiMock.listForeignKeys).not.toHaveBeenCalled();
  });
});

// #10058 R8: the selection has to reach the request through the context object
// the prompt builders already treat as untrusted data — not as an instruction.
describe("AI selection context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listTables.mockResolvedValue([]);
    apiMock.getColumns.mockResolvedValue([]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
  });

  it("passes attached selections through to the context", async () => {
    const selections = [{ id: "s1", source: "editor" as const, label: "query-1", content: "select 1" }];

    const context = await buildAiContext(queryTab("analytics"), sqliteConnection(), { selections });

    expect(context.selections).toEqual(selections);
  });

  it("omits the field entirely when nothing was attached", async () => {
    // Older callers and fixtures compare whole context objects; an always-present
    // empty array would show up as a diff in every one of them.
    const context = await buildAiContext(queryTab("analytics"), sqliteConnection());

    expect(context.selections).toBeUndefined();
    expect("selections" in context).toBe(false);
  });
});
