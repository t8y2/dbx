import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api.ts";
import { fetchDatabaseSearchColumns, findSearchColumns, searchColumnsTableKey } from "@/lib/database/databaseSearchColumns";

afterEach(() => {
  vi.restoreAllMocks();
});

function rowsResult(columns: string[], rows: unknown[][]) {
  return { columns, rows };
}

describe("databaseSearchColumns", () => {
  it("groups catalog rows by table with lowercase keys", async () => {
    const buildSpy = vi.spyOn(api, "buildDatabaseSearchColumnsSql").mockResolvedValue({ sql: "SELECT 1" });
    const executeQuery = vi.fn().mockResolvedValue(
      rowsResult(
        ["TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "IS_PRIMARY_KEY"],
        [
          ["USERS", "ID", "NUMBER", 1],
          ["USERS", "EMAIL", "VARCHAR2", 0],
          ["ORDERS", "ID", "NUMBER", 1],
        ],
      ),
    );

    const map = await fetchDatabaseSearchColumns({
      databaseType: "dameng",
      database: "app",
      schema: "DLWEB",
      executeQuery,
      executionId: "exec-1",
    });

    expect(buildSpy).toHaveBeenCalledWith({ databaseType: "dameng", database: "app", schema: "DLWEB" });
    const users = findSearchColumns(map, "DLWEB", "app", "USERS");
    expect(users).toHaveLength(2);
    expect(users?.[0]).toEqual({ name: "ID", data_type: "NUMBER", is_primary_key: true });
    expect(users?.[1]?.is_primary_key).toBe(false);
    expect(findSearchColumns(map, "dlweb", "app", "users")).toHaveLength(2);
    expect(findSearchColumns(map, "DLWEB", "app", "ORDERS")).toHaveLength(1);
  });

  it("normalizes primary key flag variants", async () => {
    vi.spyOn(api, "buildDatabaseSearchColumnsSql").mockResolvedValue({ sql: "SELECT 1" });
    const executeQuery = vi.fn().mockResolvedValue(
      rowsResult(
        ["table_name", "column_name", "data_type", "is_primary_key"],
        [
          ["t1", "a", "int", true],
          ["t1", "b", "int", false],
          ["t2", "a", "int", "1"],
          ["t2", "b", "int", "0"],
          ["t3", "a", "int", 1],
          ["t3", "b", "int", 0],
        ],
      ),
    );

    const map = await fetchDatabaseSearchColumns({ databaseType: "postgres", database: "app", executeQuery, executionId: "e" });
    const t1 = findSearchColumns(map, undefined, "app", "t1")!;
    const t2 = findSearchColumns(map, undefined, "app", "t2")!;
    const t3 = findSearchColumns(map, undefined, "app", "t3")!;
    expect(t1.map((c) => c.is_primary_key)).toEqual([true, false]);
    expect(t2.map((c) => c.is_primary_key)).toEqual([true, false]);
    expect(t3.map((c) => c.is_primary_key)).toEqual([true, false]);
  });

  it("returns empty map when builder yields no sql", async () => {
    const buildSpy = vi.spyOn(api, "buildDatabaseSearchColumnsSql").mockResolvedValue(null);
    const executeQuery = vi.fn();
    const map = await fetchDatabaseSearchColumns({ databaseType: "dameng", database: "app", executeQuery, executionId: "e" });
    expect(map.size).toBe(0);
    expect(buildSpy).toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("returns empty map when the catalog result is truncated so callers fall back per-table", async () => {
    vi.spyOn(api, "buildDatabaseSearchColumnsSql").mockResolvedValue({ sql: "SELECT 1" });
    const executeQuery = vi.fn().mockResolvedValue({
      columns: ["TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "IS_PRIMARY_KEY"],
      rows: [
        ["USERS", "ID", "NUMBER", 1],
        ["USERS", "EMAIL", "VARCHAR2", 0],
      ],
      truncated: true,
    });

    const map = await fetchDatabaseSearchColumns({
      databaseType: "dameng",
      database: "app",
      schema: "DLWEB",
      executeQuery,
      executionId: "exec-1",
    });

    expect(map.size).toBe(0);
  });

  it("returns empty map when the catalog query fails", async () => {
    vi.spyOn(api, "buildDatabaseSearchColumnsSql").mockResolvedValue({ sql: "SELECT 1" });
    const executeQuery = vi.fn().mockRejectedValue(new Error("permission denied"));
    const map = await fetchDatabaseSearchColumns({ databaseType: "mysql", database: "app", executeQuery, executionId: "e" });
    expect(map.size).toBe(0);
  });

  it("skips bulk fetch for unsupported dialects without calling the builder", async () => {
    const buildSpy = vi.spyOn(api, "buildDatabaseSearchColumnsSql");
    const map = await fetchDatabaseSearchColumns({ databaseType: "sqlite", database: "app", executeQuery: vi.fn(), executionId: "e" });
    expect(map.size).toBe(0);
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("keys use schema when present and database otherwise", () => {
    expect(searchColumnsTableKey("public", "app", "Users")).toBe("public\nusers");
    expect(searchColumnsTableKey(undefined, "app", "Users")).toBe("app\nusers");
    expect(searchColumnsTableKey("  ", "app", "Users")).toBe("app\nusers");
  });
});
