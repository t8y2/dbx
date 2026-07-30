import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAiContext } from "@/lib/ai/ai";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const apiMock = vi.hoisted(() => ({
  listTables: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  listForeignKeys: vi.fn(),
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

function queryTab(database: string): QueryTab {
  return {
    id: "tab-1",
    title: "Query",
    connectionId: "sqlite-1",
    database,
    sql: "",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "query",
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
