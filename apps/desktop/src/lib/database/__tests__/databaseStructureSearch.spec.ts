import { describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api.ts";
import { effectiveDatabaseSearchScope, mapStructureSearchRows, runDatabaseStructureSearch, runSqlCatalogStructureSearch, structureHitPreview, supportsDatabaseStructureSearchFromManifest } from "@/lib/database/databaseStructureSearch";
import { supportsDatabaseStructureSearch } from "@/lib/database/databaseStructureSearchCapabilities";

describe("databaseStructureSearch", () => {
  it("maps catalog rows into structure hits", () => {
    const hits = mapStructureSearchRows(
      ["object_schema", "object_name", "column_name", "column_comment"],
      [
        ["public", "users", "email", "User email"],
        ["public", "users", "id", null],
      ],
      "mail",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.columnName).toBe("email");
    expect(hits[0]?.matchedIn).toEqual(["name", "comment"]);
  });

  it("maps object_type when present in catalog rows", () => {
    const hits = mapStructureSearchRows(["object_schema", "object_name", "object_type", "column_name", "column_comment"], [["public", "users", "VIEW", "email", null]], "email");
    expect(hits[0]?.tableType).toBe("VIEW");
  });

  it("maps table comment rows into table-level hits without a column", () => {
    const hits = mapStructureSearchRows(["object_schema", "object_name", "column_name", "column_comment", "table_comment"], [["public", "orders", null, null, "订单主表"]], "订单");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tableName).toBe("orders");
    expect(hits[0]?.columnName).toBeUndefined();
    expect(hits[0]?.tableComment).toBe("订单主表");
    expect(hits[0]?.matchedIn).toEqual(["tableComment"]);
  });

  it("builds previews from table comment hits", () => {
    const preview = structureHitPreview({
      tableName: "orders",
      tableComment: "订单主表",
      matchedIn: ["tableComment"],
    });
    expect(preview).toBe("订单主表");
  });

  it("builds previews from structure hits", () => {
    const preview = structureHitPreview({
      tableName: "users",
      columnName: "email",
      columnComment: "Primary contact email",
      matchedIn: ["name", "comment"],
    });
    expect(preview).toContain("email");
    expect(preview).toContain("Primary contact email");
  });

  it("falls back to data scope for unsupported engines", () => {
    expect(effectiveDatabaseSearchScope("structure", "redis")).toBe("data");
    expect(supportsDatabaseStructureSearchFromManifest("redis")).toBe(false);
    expect(supportsDatabaseStructureSearchFromManifest("mysql")).toBe(true);
    expect(supportsDatabaseStructureSearchFromManifest("dameng")).toBe(true);
  });

  it("does not claim dropped SQL catalog engines", () => {
    for (const dbType of ["cassandra", "hive", "exasol", "vertica", "informix", "iris"] as const) {
      expect(supportsDatabaseStructureSearch(dbType)).toBe(false);
      expect(effectiveDatabaseSearchScope("structure", dbType)).toBe("data");
    }
  });

  it("uses the provided execution id for catalog SQL", async () => {
    const buildSpy = vi.spyOn(api, "buildDatabaseStructureSearchSql").mockResolvedValue({ sql: "SELECT 1" });
    const executeQuery = vi.fn().mockResolvedValue({
      columns: ["object_name", "column_name"],
      rows: [["users", "email"]],
    });

    await runSqlCatalogStructureSearch({
      connectionId: "c1",
      databaseType: "mysql",
      database: "app",
      term: "email",
      executionId: "exec-structure-1",
      listTables: async () => [],
      getColumns: async () => [],
      executeQuery,
    });

    expect(executeQuery).toHaveBeenCalledWith("SELECT 1", "exec-structure-1");
    buildSpy.mockRestore();
  });

  it("aborts document structure search between tables", async () => {
    let abortBeforeNextTable = false;
    const getColumns = vi.fn().mockImplementation(async () => {
      abortBeforeNextTable = true;
      return [{ name: "email", data_type: "varchar" }];
    });

    const hits = await runDatabaseStructureSearch({
      connectionId: "c1",
      databaseType: "mongodb",
      database: "app",
      term: "email",
      executionId: "exec-doc-1",
      shouldAbort: () => abortBeforeNextTable,
      listTables: async () => [
        { name: "users", table_type: "VIEW" },
        { name: "orders", table_type: "TABLE" },
      ],
      getColumns,
      executeQuery: vi.fn(),
    });

    expect(getColumns).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tableType).toBe("VIEW");
  });
});
