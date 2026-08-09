import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  getColumns: vi.fn(),
  getTableComment: vi.fn(),
  listIndexes: vi.fn(),
  listForeignKeys: vi.fn(),
  listTriggers: vi.fn(),
  buildCreateTableSql: vi.fn(),
  buildDuplicateTableStructureSql: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

import { buildDuplicateTableStructurePlan, collectDuplicateTableColumnComments, damengDropSchemaExecutionSchema, duplicateTableStructureRequiresScript, oracleDuplicateTableCreateOptions } from "@/lib/database/dbAdminSql";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("collectDuplicateTableColumnComments", () => {
  it("preserves meaningful whitespace and excludes whitespace-only comments", () => {
    expect(
      collectDuplicateTableColumnComments([
        { name: "LEADING", comment: "  leading" },
        { name: "TRAILING", comment: "trailing  " },
        { name: "BOTH", comment: "  Owner's; display name  " },
        { name: "WHITESPACE_ONLY", comment: " \t\n" },
        { name: "EMPTY", comment: "" },
        { name: "NULL", comment: null },
      ]),
    ).toEqual([
      { name: "LEADING", comment: "  leading" },
      { name: "TRAILING", comment: "trailing  " },
      { name: "BOTH", comment: "  Owner's; display name  " },
    ]);
  });
});

describe("duplicateTableStructureRequiresScript", () => {
  it("detects generated table and column comment statements", () => {
    expect(duplicateTableStructureRequiresScript('CREATE TABLE "copy" (LIKE "source" INCLUDING ALL);\nCOMMENT ON TABLE "copy" IS \'orders\';')).toBe(true);
    expect(duplicateTableStructureRequiresScript('CREATE TABLE "copy" AS SELECT * FROM "source" WHERE 1=0;\nCOMMENT ON COLUMN "copy"."id" IS \'identifier\';')).toBe(true);
  });

  it("keeps single-statement structure copies on the query path", () => {
    expect(duplicateTableStructureRequiresScript('CREATE TABLE "copy" (LIKE "source" INCLUDING ALL);')).toBe(false);
  });
});

describe("oracleDuplicateTableCreateOptions", () => {
  it("preserves metadata while assigning non-conflicting dependent object names", () => {
    const options = oracleDuplicateTableCreateOptions({
      schema: "HR",
      targetName: "CUSTOMER_ORDERS_ARCHIVE_COPY",
      tableComment: "orders archive",
      columns: [
        {
          name: "ID",
          data_type: "NUMBER",
          is_nullable: false,
          column_default: "42",
          is_primary_key: true,
          comment: "identifier",
        },
      ] as any,
      indexes: [
        { name: "PK_CUSTOMER_ORDERS", columns: ["ID"], is_unique: true, is_primary: true },
        { name: "IDX_CUSTOMER_ORDERS_ID", columns: ["ID"], is_unique: false, is_primary: false },
      ] as any,
      foreignKeys: [{ name: "FK_CUSTOMER", column: "ID", ref_table: "CUSTOMERS", ref_column: "ID" }] as any,
      triggers: [{ name: "TRG_CUSTOMER_ORDERS", timing: "BEFORE EACH ROW", event: "INSERT", statement: "BEGIN NULL; END;" }] as any,
    });

    expect(options.tableName).toBe("CUSTOMER_ORDERS_ARCHIVE_COPY");
    expect(options.tableComment).toBe("orders archive");
    expect(options.columns[0]).toMatchObject({ name: "ID", defaultValue: "42", isPrimaryKey: true, comment: "identifier", original: undefined });
    expect(options.indexes).toHaveLength(1);
    expect(options.indexes[0]?.name).toMatch(/_IDX1$/);
    expect(options.indexes[0]?.name.length).toBeLessThanOrEqual(30);
    expect(options.foreignKeys?.[0]?.name).toMatch(/_FK1$/);
    expect(options.triggers?.[0]?.name).toMatch(/_TRG1$/);
    expect(options.foreignKeys?.[0]?.original).toBeUndefined();
    expect(options.triggers?.[0]?.original).toBeUndefined();
  });
});

describe("buildDuplicateTableStructurePlan", () => {
  it("loads Oracle metadata through the list APIs and builds a script", async () => {
    const columns = [{ name: "ID", data_type: "NUMBER", is_nullable: false, column_default: "42", is_primary_key: true }];
    const indexes = [{ name: "IDX_ORDERS_ID", columns: ["ID"], is_unique: false, is_primary: false }];
    const foreignKeys = [{ name: "FK_ORDERS_CUSTOMER", column: "ID", ref_schema: "CRM", ref_table: "CUSTOMERS", ref_column: "ID", on_delete: "CASCADE" }];
    const triggers = [{ name: "TRG_ORDERS", timing: "BEFORE EACH ROW", event: "INSERT", statement: "BEGIN NULL; END;" }];
    apiMock.getColumns.mockResolvedValue(columns);
    apiMock.getTableComment.mockResolvedValue("orders");
    apiMock.listIndexes.mockResolvedValue(indexes);
    apiMock.listForeignKeys.mockResolvedValue(foreignKeys);
    apiMock.listTriggers.mockResolvedValue(triggers);
    apiMock.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE ...;", "CREATE INDEX ...;"], warnings: [] });

    const plan = await buildDuplicateTableStructurePlan({
      connectionId: "oracle-1",
      database: "XEPDB1",
      databaseType: "oracle",
      schema: "HR",
      sourceName: "ORDERS",
      targetName: "ORDERS_COPY",
    });

    expect(apiMock.getColumns).toHaveBeenCalledWith("oracle-1", "XEPDB1", "HR", "ORDERS", undefined);
    expect(apiMock.getTableComment).toHaveBeenCalledWith("oracle-1", "XEPDB1", "HR", "ORDERS", undefined);
    expect(apiMock.listIndexes).toHaveBeenCalledWith("oracle-1", "XEPDB1", "HR", "ORDERS", undefined);
    expect(apiMock.listForeignKeys).toHaveBeenCalledWith("oracle-1", "XEPDB1", "HR", "ORDERS", undefined);
    expect(apiMock.listTriggers).toHaveBeenCalledWith("oracle-1", "XEPDB1", "HR", "ORDERS", undefined);
    expect(apiMock.buildCreateTableSql).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseType: "oracle",
        schema: "HR",
        tableName: "ORDERS_COPY",
        tableComment: "orders",
      }),
    );
    expect(plan).toEqual({ sql: "CREATE TABLE ...;\nCREATE INDEX ...;", sourceColumns: columns, executeAsScript: true });
  });

  it("keeps Dameng CTAS available when comment metadata loading fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiMock.getColumns.mockRejectedValue(new Error("metadata unavailable"));
    apiMock.buildDuplicateTableStructureSql.mockResolvedValue('CREATE TABLE "COPY" AS SELECT * FROM "SOURCE" WHERE 1=0;');

    const plan = await buildDuplicateTableStructurePlan({
      connectionId: "dameng-1",
      database: "DAMENG",
      databaseType: "dameng",
      schema: "SYSDBA",
      sourceName: "SOURCE",
      targetName: "COPY",
    });

    expect(apiMock.buildDuplicateTableStructureSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "dameng", columnComments: [] }));
    expect(plan.sql).toContain("CREATE TABLE");
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("keeps Oracle cloning available when optional table comment loading fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const columns = [{ name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true }];
    apiMock.getTableComment.mockRejectedValue(new Error("not available"));
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
    apiMock.listTriggers.mockResolvedValue([]);
    apiMock.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE ...;"], warnings: [] });

    const plan = await buildDuplicateTableStructurePlan({
      connectionId: "oracle-web",
      database: "XEPDB1",
      databaseType: "oracle",
      schema: "HR",
      sourceName: "ORDERS",
      targetName: "ORDERS_COPY",
      sourceColumns: columns as any,
    });

    expect(apiMock.buildCreateTableSql).toHaveBeenCalledWith(expect.objectContaining({ tableComment: undefined }));
    expect(plan.sql).toBe("CREATE TABLE ...;");
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});

describe("damengDropSchemaExecutionSchema", () => {
  it("uses the login schema when dropping a different schema", () => {
    expect(damengDropSchemaExecutionSchema("APP", "TARGET")).toBe("APP");
  });

  it("fails closed when dropping the login schema", () => {
    expect(damengDropSchemaExecutionSchema("APP", "APP")).toBeNull();
  });

  it("fails closed when the username is missing", () => {
    expect(damengDropSchemaExecutionSchema(undefined, "TARGET")).toBeNull();
  });
});
