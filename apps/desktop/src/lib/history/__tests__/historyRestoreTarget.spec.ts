import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@/lib/backend/api";
import type { ConnectionConfig, QueryTab } from "@/types/database";
import { canReuseTabForHistoryRestore, resolveHistorySqlRestoreTarget } from "../historyRestoreTarget";

describe("resolveHistorySqlRestoreTarget", () => {
  const pgConfig: ConnectionConfig = {
    id: "pg-1",
    name: "PostgreSQL Local",
    db_type: "postgresql",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
    database: "postgres",
    default_schema: "public",
  };

  const mysqlConfig: ConnectionConfig = {
    id: "mysql-1",
    name: "MySQL Prod",
    db_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
    database: "ecommerce",
  };

  const sqliteConfig: ConnectionConfig = {
    id: "sqlite-1",
    name: "SQLite Main",
    db_type: "sqlite",
    database: "/path/to/db.sqlite",
  };

  const configs: Record<string, ConnectionConfig> = {
    "pg-1": pgConfig,
    "mysql-1": mysqlConfig,
    "sqlite-1": sqliteConfig,
  };

  const getConfig = (id: string) => configs[id];
  const connections = [pgConfig, mysqlConfig, sqliteConfig];

  const baseEntry: HistoryEntry = {
    id: "entry-1",
    connection_id: "pg-1",
    connection_name: "PostgreSQL Local",
    database: "analytics",
    sql: "SELECT * FROM page_views;",
    executed_at: "2026-10-21T00:00:00Z",
    execution_time_ms: 42,
    success: true,
  };

  it("resolves target directly from history entry connection_id and database", () => {
    const target = resolveHistorySqlRestoreTarget({
      entry: baseEntry,
      getConfig,
      connections,
    });

    expect(target).toEqual({
      connectionId: "pg-1",
      database: "analytics",
      schema: "public",
    });
  });

  it("resolves connection by connection_name if connection_id was deleted or unknown", () => {
    const entry: HistoryEntry = {
      ...baseEntry,
      connection_id: "old-deleted-id",
      connection_name: "MySQL Prod",
      database: "ecommerce",
    };

    const target = resolveHistorySqlRestoreTarget({
      entry,
      getConfig,
      connections,
    });

    expect(target).toEqual({
      connectionId: "mysql-1",
      database: "ecommerce",
      schema: undefined,
    });
  });

  it("extracts schema from details_json when available", () => {
    const entry: HistoryEntry = {
      ...baseEntry,
      details_json: JSON.stringify({ schema: "custom_schema", table: "users" }),
    };

    const target = resolveHistorySqlRestoreTarget({
      entry,
      getConfig,
      connections,
    });

    expect(target).toEqual({
      connectionId: "pg-1",
      database: "analytics",
      schema: "custom_schema",
    });
  });

  it("does not choose an arbitrary connection when a deleted connection name is ambiguous", () => {
    const duplicate = { ...mysqlConfig, id: "mysql-2", host: "another-host" };
    const target = resolveHistorySqlRestoreTarget({
      entry: { ...baseEntry, connection_id: "deleted-id", connection_name: mysqlConfig.name },
      getConfig,
      connections: [...connections, duplicate],
      firstConnectionId: "mysql-1",
    });

    expect(target).toBeNull();
  });

  it("falls back to active tab schema when active tab shares the same connection and database", () => {
    const activeTab = {
      id: "tab-1",
      connectionId: "pg-1",
      database: "analytics",
      schema: "tenant_42",
      mode: "query",
      sql: "",
    } as QueryTab;

    const target = resolveHistorySqlRestoreTarget({
      entry: baseEntry,
      activeTab,
      getConfig,
      connections,
    });

    expect(target).toEqual({
      connectionId: "pg-1",
      database: "analytics",
      schema: "tenant_42",
    });
  });

  it("normalizes sqlite namespace when connection is sqlite", () => {
    const entry: HistoryEntry = {
      ...baseEntry,
      connection_id: "sqlite-1",
      connection_name: "SQLite Main",
      database: "main",
    };

    const target = resolveHistorySqlRestoreTarget({
      entry,
      getConfig,
      connections,
    });

    expect(target).toEqual({
      connectionId: "sqlite-1",
      database: "main",
      schema: undefined,
    });
  });

  it("falls back to active tab or first connection when entry connection fields are absent", () => {
    const emptyEntry: HistoryEntry = {
      ...baseEntry,
      connection_id: undefined,
      connection_name: "",
      database: "",
    };

    const activeTab = {
      id: "tab-2",
      connectionId: "mysql-1",
      database: "billing",
      mode: "query",
      sql: "SELECT 1;",
    } as QueryTab;

    const target = resolveHistorySqlRestoreTarget({
      entry: emptyEntry,
      activeTab,
      firstConnectionId: "pg-1",
      getConfig,
      connections,
    });

    expect(target).toEqual({
      connectionId: "mysql-1",
      database: "billing",
      schema: undefined,
    });
  });

  it("returns null when no connection can be determined", () => {
    const emptyEntry: HistoryEntry = {
      ...baseEntry,
      connection_id: undefined,
      connection_name: "",
      database: "",
    };

    const target = resolveHistorySqlRestoreTarget({
      entry: emptyEntry,
      getConfig: () => undefined,
      connections: [],
    });

    expect(target).toBeNull();
  });
});

describe("canReuseTabForHistoryRestore", () => {
  const target = {
    connectionId: "pg-1",
    database: "analytics",
    schema: "public",
  };

  const createCleanTab = (overrides: Partial<QueryTab> = {}): QueryTab =>
    ({
      id: "tab-1",
      title: "query_1",
      connectionId: "pg-1",
      database: "analytics",
      schema: "public",
      mode: "query",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      ...overrides,
    }) as QueryTab;

  it("allows reusing an active query tab that is blank and on the same connection, database, and schema", () => {
    const tab = createCleanTab();
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(true);
  });

  it("treats whitespace-only SQL as empty and allows reusing", () => {
    const tab = createCleanTab({ sql: "   \n\t  " });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(true);
  });

  it("rejects when tab has existing SQL to prevent clearing user work", () => {
    const tab = createCleanTab({ sql: "SELECT * FROM users WHERE active = true;" });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects when tab is on a different connection", () => {
    const tab = createCleanTab({ connectionId: "mysql-1" });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects when tab is on a different database", () => {
    const tab = createCleanTab({ database: "production" });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects when tab is on a different schema", () => {
    const tab = createCleanTab({ schema: "archive" });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects non-query tabs (e.g. data grid)", () => {
    const tab = createCleanTab({ mode: "data" });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects tabs linked to external SQL files", () => {
    const tab = createCleanTab({ externalSqlPath: "/path/to/script.sql" });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects tabs linked to saved SQL in library", () => {
    const tab = createCleanTab({ savedSqlId: "saved-sql-123" });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects tabs displaying object source views", () => {
    const tab = createCleanTab({ objectSource: { schema: "public", name: "v_stats", objectType: "view" } });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects tabs that are currently executing queries", () => {
    const tab = createCleanTab({ isExecuting: true });
    expect(canReuseTabForHistoryRestore(tab, target)).toBe(false);
  });

  it("rejects tabs that contain active query results", () => {
    const tabWithResult = createCleanTab({
      result: { columns: ["id"], rows: [[1]], execution_time_ms: 10, affected_rows: null },
    });
    expect(canReuseTabForHistoryRestore(tabWithResult, target)).toBe(false);

    const tabWithResults = createCleanTab({
      results: [{ columns: ["id"], rows: [[1]], execution_time_ms: 10, affected_rows: null }],
    });
    expect(canReuseTabForHistoryRestore(tabWithResults, target)).toBe(false);
  });

  it("rejects when tab is undefined", () => {
    expect(canReuseTabForHistoryRestore(undefined, target)).toBe(false);
  });
});
