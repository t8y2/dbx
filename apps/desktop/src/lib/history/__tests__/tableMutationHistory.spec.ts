import { describe, expect, it, vi } from "vitest";
import { recordTableMutationHistory, type TableMutationHistoryStore } from "@/lib/history/tableMutationHistory";
import { primarySqlOperation } from "@/lib/history/historyActivityKind";

describe("tableMutationHistory", () => {
  it("records drop table operation to history store", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const store: TableMutationHistoryStore = { add: addMock };

    await recordTableMutationHistory(store, {
      connectionId: "conn-1",
      connectionName: "Production DB",
      database: "main",
      sql: "DROP TABLE users;",
      elapsedMs: 120,
      success: true,
      target: "users",
    });

    expect(addMock).toHaveBeenCalledOnce();
    expect(addMock).toHaveBeenCalledWith({
      connection_id: "conn-1",
      connection_name: "Production DB",
      database: "main",
      sql: "DROP TABLE users;",
      execution_time_ms: 120,
      success: true,
      error: undefined,
      activity_kind: "schema_change",
      operation: "DROP",
      target: "users",
      affected_rows: undefined,
    });
  });

  it("records truncate table operation as data_change", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const store: TableMutationHistoryStore = { add: addMock };

    await recordTableMutationHistory(store, {
      connectionId: "conn-1",
      connectionName: "Production DB",
      database: "analytics",
      sql: "TRUNCATE TABLE event_logs;",
      elapsedMs: 45,
      success: true,
      target: "event_logs",
    });

    expect(addMock).toHaveBeenCalledOnce();
    expect(addMock).toHaveBeenCalledWith({
      connection_id: "conn-1",
      connection_name: "Production DB",
      database: "analytics",
      sql: "TRUNCATE TABLE event_logs;",
      execution_time_ms: 45,
      success: true,
      error: undefined,
      activity_kind: "data_change",
      operation: "TRUNCATE",
      target: "event_logs",
      affected_rows: undefined,
    });
  });

  it("records empty table (delete) operation as data_change", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const store: TableMutationHistoryStore = { add: addMock };

    await recordTableMutationHistory(store, {
      connectionId: "conn-1",
      database: "testdb",
      sql: "DELETE FROM session_cache;",
      elapsedMs: 15,
      success: true,
      target: "session_cache",
      affectedRows: 100,
    });

    expect(addMock).toHaveBeenCalledOnce();
    expect(addMock).toHaveBeenCalledWith({
      connection_id: "conn-1",
      connection_name: "",
      database: "testdb",
      sql: "DELETE FROM session_cache;",
      execution_time_ms: 15,
      success: true,
      error: undefined,
      activity_kind: "data_change",
      operation: "DELETE",
      target: "session_cache",
      affected_rows: 100,
    });
  });

  it("records failed mutations with error message and clears affected_rows", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const store: TableMutationHistoryStore = { add: addMock };

    await recordTableMutationHistory(store, {
      connectionId: "conn-1",
      database: "testdb",
      sql: "DROP TABLE protected_table;",
      elapsedMs: 8,
      success: false,
      error: "Permission denied",
      target: "protected_table",
      affectedRows: 5,
    });

    expect(addMock).toHaveBeenCalledOnce();
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Permission denied",
        affected_rows: undefined,
      }),
    );
  });

  it("handles batch multi-statement SQL", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const store: TableMutationHistoryStore = { add: addMock };

    await recordTableMutationHistory(store, {
      connectionId: "conn-1",
      database: "testdb",
      sql: "TRUNCATE TABLE t1;\nTRUNCATE TABLE t2;",
      elapsedMs: 50,
      success: true,
      target: "t1, t2",
    });

    expect(addMock).toHaveBeenCalledOnce();
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activity_kind: "data_change",
        operation: "TRUNCATE",
        target: "t1, t2",
      }),
    );
  });

  it("safely ignores undefined store, empty SQL, or empty connectionId", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const store: TableMutationHistoryStore = { add: addMock };

    await recordTableMutationHistory(undefined, {
      connectionId: "conn-1",
      database: "db",
      sql: "DROP TABLE t1;",
    });
    expect(addMock).not.toHaveBeenCalled();

    await recordTableMutationHistory(store, {
      connectionId: "conn-1",
      database: "db",
      sql: "   \n  ",
    });
    expect(addMock).not.toHaveBeenCalled();

    await recordTableMutationHistory(store, {
      connectionId: "",
      database: "db",
      sql: "DROP TABLE t1;",
    });
    expect(addMock).not.toHaveBeenCalled();
  });
});

describe("primarySqlOperation", () => {
  it("extracts primary SQL verb accurately", () => {
    expect(primarySqlOperation("DROP TABLE t1")).toBe("DROP");
    expect(primarySqlOperation("truncate table t1")).toBe("TRUNCATE");
    expect(primarySqlOperation("DELETE FROM t1")).toBe("DELETE");
    expect(primarySqlOperation("-- leading comment\nDROP TABLE t1")).toBe("DROP");
    expect(primarySqlOperation("/* block comment */ ALTER TABLE t1")).toBe("ALTER");
    expect(primarySqlOperation("")).toBe("SQL");
  });
});
