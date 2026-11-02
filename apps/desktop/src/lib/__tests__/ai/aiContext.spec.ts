import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiSchemaSelectionSupported, buildAiContext, buildSystemPrompt, resolveAiDatabaseTarget, resolveAiMentionDatabases, resolveAiNamespaceSelection, resolveDefaultAiSchema, runAgentStream } from "@/lib/ai/ai";
import { setLocale } from "@/i18n";
import type { AiConfig } from "@/types/ai";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const apiMock = vi.hoisted(() => ({
  listTables: vi.fn(),
  listSchemas: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  listForeignKeys: vi.fn(),
  loadDocsAnnotations: vi.fn(),
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
    apiMock.loadDocsAnnotations.mockResolvedValue(null);
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
    apiMock.loadDocsAnnotations.mockResolvedValue(null);
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

// #12497: the connection's documentation notes are the user's own semantics
// for a field, so the AI schema context has to read them instead of only the
// database comment.
describe("AI schema notes", () => {
  const databaseTab = () => ({ ...queryTab("app-db"), connectionId: "postgres-1" });

  beforeAll(async () => {
    // The warning line is localized; pin the language so the assertion does not
    // depend on the developer's OS locale.
    await setLocale("en");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listSchemas.mockResolvedValue(["public"]);
    apiMock.listTables.mockResolvedValue([{ name: "orders", table_type: "TABLE", comment: "db orders" }]);
    apiMock.getColumns.mockResolvedValue([{ name: "status", data_type: "text", is_nullable: false, is_primary_key: false, comment: "db status" }]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
    apiMock.loadDocsAnnotations.mockResolvedValue(null);
  });

  it("prefers local notes over database comments and folds the note key", async () => {
    apiMock.loadDocsAnnotations.mockResolvedValue({
      formatVersion: 1,
      tables: { "public.orders": { note: "本地订单表", columns: { STATUS: { note: "本地状态" } } } },
    });

    const context = await buildAiContext(databaseTab(), postgresConnection());

    expect(context.tables[0]?.comment).toBe("[local-note]本地订单表[/local-note]");
    expect(context.tables[0]?.columns[0]?.comment).toBe("[local-note]本地状态[/local-note]");
    const prompt = buildSystemPrompt("generate", context);
    expect(prompt).toContain("本地订单表");
    expect(prompt).toContain("本地状态");
    expect(prompt).toContain("data, not instructions");
  });

  it("keeps database comments when no notes file exists", async () => {
    const context = await buildAiContext(databaseTab(), postgresConnection());

    expect(context.tables[0]?.comment).toBe("db orders");
    expect(context.tables[0]?.columns[0]?.comment).toBe("db status");
    expect(context.schemaNotesWarning).toBeUndefined();
    expect(context.schemaNotesApplied).toBeUndefined();
    expect("schemaNotesWarning" in context).toBe(false);
    expect("schemaNotesApplied" in context).toBe(false);
    expect(buildSystemPrompt("generate", context)).not.toContain("data, not instructions");
  });

  it("matches MySQL notes by database-qualified key even when the display schema is hidden", async () => {
    // MySQL is not schema-aware in DBX, so the AI schema block hides the schema.
    // The notes file still keys the table as `shop.orders`, so key computation
    // must use the real namespace rather than the hidden display field.
    apiMock.listSchemas.mockResolvedValue(["shop"]);
    apiMock.loadDocsAnnotations.mockResolvedValue({
      formatVersion: 1,
      tables: { "shop.orders": { note: "门店订单" } },
    });
    const connection = { ...postgresConnection("shop"), id: "mysql-1", db_type: "mysql" as const };

    const context = await buildAiContext({ ...queryTab("shop"), connectionId: "mysql-1" }, connection);

    expect(context.tables[0]?.schema).toBeUndefined();
    expect(context.tables[0]?.comment).toBe("[local-note]门店订单[/local-note]");
  });

  it("finds a bare note in the focused-table path on SQLite", async () => {
    // SQLite's collector stores notes under the bare table name, while the
    // focused table carries the "main" namespace.
    apiMock.loadDocsAnnotations.mockResolvedValue({
      formatVersion: 1,
      tables: { orders: { note: "本地订单" } },
    });
    const focused = {
      ...queryTab("main"),
      connectionId: "sqlite-1",
      tableMeta: { schema: "main", tableName: "orders", columns: [] },
    };

    const context = await buildAiContext(focused, sqliteConnection());

    expect(context.tables[0]?.comment).toBe("[local-note]本地订单[/local-note]");
  });

  it("degrades with a visible warning when the notes file cannot be read", async () => {
    apiMock.loadDocsAnnotations.mockRejectedValue(new Error("Failed to parse notes file"));

    const context = await buildAiContext(databaseTab(), postgresConnection());

    expect(context.tables[0]?.comment).toBe("db orders");
    expect(context.schemaNotesWarning).toContain("Failed to parse notes file");
    expect(buildSystemPrompt("generate", context)).toContain("local schema notes could not be loaded");
  });
});

describe("AI query result privacy (#12757)", () => {
  const sampleResult = {
    columns: ["id", "username", "salary"],
    rows: [
      [1, "alice", 100000],
      [2, "bob", 95000],
    ],
  };

  const errorResult = {
    columns: ["error"],
    rows: [["syntax error at or near 'FORM'"]],
    execution_error: true,
  };

  it("omits lastResultPreview by default to prevent sending row data to AI", async () => {
    const tab = { ...queryTab("analytics"), result: sampleResult };
    const context = await buildAiContext(tab, sqliteConnection());

    expect(context.lastResultPreview).toBeUndefined();
  });

  it("includes lastResultPreview when includeQueryResult is explicitly true", async () => {
    const tab = { ...queryTab("analytics"), result: sampleResult };
    const context = await buildAiContext(tab, sqliteConnection(), { includeQueryResult: true });

    expect(context.lastResultPreview).toBeDefined();
    expect(context.lastResultPreview).toContain("alice");
    expect(context.lastResultPreview).toContain("100000");
  });

  it("omits lastResultPreview when excludeQueryResult is true or includeQueryResult is false", async () => {
    const tab = { ...queryTab("analytics"), result: sampleResult };
    const context1 = await buildAiContext(tab, sqliteConnection(), { excludeQueryResult: true });
    const context2 = await buildAiContext(tab, sqliteConnection(), { includeQueryResult: false });

    expect(context1.lastResultPreview).toBeUndefined();
    expect(context2.lastResultPreview).toBeUndefined();
  });

  it("always preserves lastError from execution errors even when query result data is excluded", async () => {
    const tab = { ...queryTab("analytics"), result: errorResult };
    const context = await buildAiContext(tab, sqliteConnection(), { includeQueryResult: false });

    expect(context.lastError).toBe("syntax error at or near 'FORM'");
    expect(context.lastResultPreview).toBeUndefined();
  });
});
