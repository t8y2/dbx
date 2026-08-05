import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAiContext, resolveAiDatabaseTarget, resolveAiNamespaceSelection, resolveDefaultAiSchema, runAgentStream } from "@/lib/ai/ai";
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
