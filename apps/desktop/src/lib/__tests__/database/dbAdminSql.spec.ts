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

import { buildDuplicateTableStructurePlan, collectDuplicateTableColumnComments, damengDropSchemaExecutionSchema, damengDuplicateTableCreateOptions, duplicateTableStructureRequiresScript, oracleDuplicateTableCreateOptions } from "@/lib/database/dbAdminSql";

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

describe("damengDuplicateTableCreateOptions", () => {
  it("preserves columns, comments, primary keys, and independent supported indexes", () => {
    const options = damengDuplicateTableCreateOptions({
      schema: "APP",
      targetName: "orders_copy",
      tableComment: "orders clone",
      columns: [
        {
          name: "ID",
          data_type: "INT",
          is_nullable: false,
          column_default: "42",
          is_primary_key: true,
          extra: "IDENTITY(10, 2)",
          comment: "identifier",
        },
        {
          name: "TENANT_ID",
          data_type: "INT",
          is_nullable: false,
          column_default: null,
          is_primary_key: false,
          extra: null,
          comment: null,
        },
        {
          name: "EMAIL",
          data_type: "VARCHAR(255)",
          is_nullable: true,
          column_default: "'unknown'",
          is_primary_key: false,
          extra: null,
          comment: "email address",
        },
      ] as any,
      indexes: [
        { name: "PK_ORDERS", columns: ["ID"], is_unique: true, is_primary: true, index_type: "NORMAL" },
        { name: "IDX_ORDERS_TENANT_EMAIL", columns: ["TENANT_ID", "EMAIL"], is_unique: false, is_primary: false, index_type: "NORMAL" },
        { name: "UX_ORDERS_EMAIL_TENANT", columns: ["EMAIL", "TENANT_ID"], is_unique: true, is_primary: false, index_type: "NORMAL" },
        { name: "BMX_ORDERS_TENANT", columns: ["TENANT_ID"], is_unique: false, is_primary: false, index_type: "BITMAP" },
        { name: "SYS_INNER_ORDERS", columns: ["ID"], is_unique: false, is_primary: false, index_type: "INNER CLUSTER INDEX" },
        { name: "IDX_ORDERS_DOMAIN", columns: ["EMAIL"], is_unique: false, is_primary: false, index_type: "DOMAIN" },
      ] as any,
    });

    expect(options).toMatchObject({ databaseType: "dameng", schema: "APP", tableName: "ORDERS_COPY", tableComment: "orders clone" });
    expect(options.columns).toHaveLength(3);
    expect(options.columns[0]).toMatchObject({
      name: "ID",
      defaultValue: "42",
      isNullable: false,
      isPrimaryKey: true,
      comment: "identifier",
      extra: { autoIncrement: true, identity: { seed: 10, increment: 2 } },
      original: undefined,
      originalPosition: undefined,
    });
    expect(options.columns[2]).toMatchObject({ name: "EMAIL", defaultValue: "'unknown'", isNullable: true, comment: "email address" });
    expect(options.indexes).toHaveLength(3);
    expect(options.indexes.map((index) => index.columns)).toEqual([["TENANT_ID", "EMAIL"], ["EMAIL", "TENANT_ID"], ["TENANT_ID"]]);
    expect(options.indexes.map((index) => index.isUnique)).toEqual([false, true, false]);
    expect(options.indexes.map((index) => index.indexType)).toEqual(["NORMAL", "NORMAL", "BITMAP"]);
    expect(options.indexes.map((index) => index.name)).toEqual(["ORDERS_COPY_IDX1", "ORDERS_COPY_IDX2", "ORDERS_COPY_IDX3"]);
    expect(options.indexes.every((index) => index.original === undefined && index.isPrimary === false)).toBe(true);
    expect(options.foreignKeys).toEqual([]);
    expect(options.triggers).toEqual([]);
  });

  it("keeps deterministic index names stable when unsupported metadata is interleaved", () => {
    const columns = [{ name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: false, extra: null }] as any;
    const supportedIndexes = [
      { name: "IDX_ONE", columns: ["ID"], is_unique: false, is_primary: false, index_type: "NORMAL" },
      { name: "IDX_TWO", columns: ["ID"], is_unique: true, is_primary: false, index_type: "BITMAP" },
    ] as any;
    const interleavedIndexes = [supportedIndexes[0], { name: "SYS_INNER", columns: ["ID"], is_unique: false, is_primary: false, index_type: "INTERNAL INDEX" }, { name: "IDX_DOMAIN", columns: ["ID"], is_unique: false, is_primary: false, index_type: "DOMAIN" }, supportedIndexes[1]] as any;

    const expected = damengDuplicateTableCreateOptions({ targetName: "ORDERS_COPY", columns, indexes: supportedIndexes });
    const actual = damengDuplicateTableCreateOptions({ targetName: "ORDERS_COPY", columns, indexes: interleavedIndexes });

    expect(actual.indexes.map((index) => index.name)).toEqual(expected.indexes.map((index) => index.name));
    expect(actual.indexes.map((index) => index.indexType)).toEqual(["NORMAL", "BITMAP"]);
  });

  it("generates bounded, distinct names for long, quoted, and mixed-case targets", () => {
    const targetName = `Order"Archive_${"副本".repeat(70)}_mixedCase`;
    const options = damengDuplicateTableCreateOptions({
      targetName,
      columns: [{ name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: false, extra: null }] as any,
      indexes: [
        { name: "IDX_ONE", columns: ["ID"], is_unique: false, is_primary: false, index_type: "NORMAL" },
        { name: "IDX_TWO", columns: ["ID"], is_unique: false, is_primary: false, index_type: null },
      ] as any,
    });

    expect(options.tableName).toBe(targetName);
    expect(options.indexes).toHaveLength(2);
    expect(new Set(options.indexes.map((index) => index.name)).size).toBe(2);
    expect(options.indexes.every((index) => Array.from(index.name).length <= 128)).toBe(true);
    expect(options.indexes[0]?.name).toMatch(/_IDX1$/);
    expect(options.indexes[1]?.name).toMatch(/_IDX2$/);
  });

  it("keeps a no-index clone as a structured empty-table definition", () => {
    const options = damengDuplicateTableCreateOptions({
      targetName: "EMPTY_COPY",
      tableComment: "empty clone",
      columns: [{ name: "ID", data_type: "INT", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "identifier" }] as any,
      indexes: [],
    });

    expect(options.columns[0]).toMatchObject({ name: "ID", comment: "identifier" });
    expect(options.indexes).toEqual([]);
    expect(options.tableComment).toBe("empty clone");
  });

  it("keeps unquoted Dameng target folding compatible with the data-copy path", () => {
    const columns = [{ name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: false, extra: null }] as any;

    expect(damengDuplicateTableCreateOptions({ targetName: "orders_copy", columns, indexes: [] }).tableName).toBe("ORDERS_COPY");
    expect(damengDuplicateTableCreateOptions({ targetName: "OrdersCopy", columns, indexes: [] }).tableName).toBe("OrdersCopy");
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

  it("loads Dameng columns and indexes through the structured DDL builder", async () => {
    const columns = [{ name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true }];
    const indexes = [{ name: "IDX_ORDERS_ID", columns: ["ID"], is_unique: false, is_primary: false, index_type: "NORMAL" }];
    apiMock.getColumns.mockResolvedValue(columns);
    apiMock.listIndexes.mockResolvedValue(indexes);
    apiMock.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE ...;", "CREATE INDEX ...;"], warnings: [] });
    apiMock.buildDuplicateTableStructureSql.mockResolvedValue('CREATE TABLE "SYSDBA".ORDERS_COPY AS SELECT * FROM "SYSDBA"."ORDERS" WHERE 1=0;');

    const plan = await buildDuplicateTableStructurePlan({
      connectionId: "dameng-1",
      database: "DAMENG",
      databaseType: "dameng",
      schema: "SYSDBA",
      sourceName: "ORDERS",
      targetName: "orders_copy",
    });

    expect(apiMock.getColumns).toHaveBeenCalledWith("dameng-1", "DAMENG", "SYSDBA", "ORDERS", undefined);
    expect(apiMock.listIndexes).toHaveBeenCalledWith("dameng-1", "DAMENG", "SYSDBA", "ORDERS", undefined);
    expect(apiMock.buildCreateTableSql).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseType: "dameng",
        schema: "SYSDBA",
        tableName: "ORDERS_COPY",
      }),
    );
    expect(apiMock.buildDuplicateTableStructureSql).not.toHaveBeenCalled();
    expect(plan).toEqual({ sql: "CREATE TABLE ...;\nCREATE INDEX ...;", sourceColumns: columns, executeAsScript: true });
  });

  it("fails before DDL generation when Dameng column metadata loading fails", async () => {
    apiMock.getColumns.mockRejectedValue(new Error("metadata unavailable"));
    apiMock.listIndexes.mockResolvedValue([]);

    await expect(
      buildDuplicateTableStructurePlan({
        connectionId: "dameng-1",
        database: "DAMENG",
        databaseType: "dameng",
        schema: "SYSDBA",
        sourceName: "SOURCE",
        targetName: "COPY",
      }),
    ).rejects.toThrow("metadata unavailable");

    expect(apiMock.buildCreateTableSql).not.toHaveBeenCalled();
    expect(apiMock.buildDuplicateTableStructureSql).not.toHaveBeenCalled();
  });

  it("fails before DDL generation when Dameng index metadata loading fails", async () => {
    apiMock.getColumns.mockResolvedValue([{ name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: false }]);
    apiMock.listIndexes.mockRejectedValue(new Error("index metadata unavailable"));

    await expect(
      buildDuplicateTableStructurePlan({
        connectionId: "dameng-1",
        database: "DAMENG",
        databaseType: "dameng",
        schema: "SYSDBA",
        sourceName: "SOURCE",
        targetName: "COPY",
      }),
    ).rejects.toThrow("index metadata unavailable");

    expect(apiMock.buildCreateTableSql).not.toHaveBeenCalled();
    expect(apiMock.buildDuplicateTableStructureSql).not.toHaveBeenCalled();
  });

  it("fails rather than execute partial Dameng DDL when generation warns", async () => {
    apiMock.getColumns.mockResolvedValue([{ name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: false }]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE ...;"], warnings: ["unsupported metadata"] });

    await expect(
      buildDuplicateTableStructurePlan({
        connectionId: "dameng-1",
        database: "DAMENG",
        databaseType: "dameng",
        schema: "SYSDBA",
        sourceName: "SOURCE",
        targetName: "COPY",
      }),
    ).rejects.toThrow("unsupported metadata");

    expect(apiMock.buildDuplicateTableStructureSql).not.toHaveBeenCalled();
  });

  it("keeps representative non-Dameng clones on the generic path", async () => {
    apiMock.buildDuplicateTableStructureSql.mockResolvedValue('CREATE TABLE "copy" (LIKE "source" INCLUDING ALL);');

    const plan = await buildDuplicateTableStructurePlan({
      connectionId: "postgres-1",
      database: "app",
      databaseType: "postgres",
      schema: "public",
      sourceName: "source",
      targetName: "copy",
    });

    expect(apiMock.buildDuplicateTableStructureSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "postgres", sourceName: "source", targetName: "copy" }));
    expect(apiMock.getColumns).not.toHaveBeenCalled();
    expect(apiMock.listIndexes).not.toHaveBeenCalled();
    expect(apiMock.buildCreateTableSql).not.toHaveBeenCalled();
    expect(plan).toEqual({ sql: 'CREATE TABLE "copy" (LIKE "source" INCLUDING ALL);', sourceColumns: undefined, executeAsScript: false });
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
