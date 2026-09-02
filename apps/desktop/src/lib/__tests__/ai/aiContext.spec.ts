import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiSchemaSelectionSupported, buildAiContext, resolveAiDatabaseTarget, resolveAiNamespaceSelection, resolveDefaultAiSchema, runAgentStream } from "@/lib/ai/ai";
import type { AiConfig } from "@/types/ai";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const apiMock = vi.hoisted(() => ({
  listTables: vi.fn(),
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
    expect(apiMock.aiAgentStream).toHaveBeenCalledWith("session-1", expect.any(Object), "dameng-1", "APPDB", "REPORTING", "dameng", expect.any(Function), "agent", false, undefined, undefined, undefined, undefined);
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

  it("does not change non-Dameng namespace behavior", () => {
    expect(resolveAiDatabaseTarget(queryTab("analytics"), sqliteConnection())).toEqual({ database: "analytics" });
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
    expect(apiMock.aiAgentStream).toHaveBeenCalledWith("session-postgres", expect.any(Object), "postgres-1", "app", "main_chatdr", "postgres", expect.any(Function), "agent", false, undefined, undefined, undefined, undefined);
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
