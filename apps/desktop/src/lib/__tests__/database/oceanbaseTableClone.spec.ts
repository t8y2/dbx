// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, QueryResult } from "@/types/database";

const api = vi.hoisted(() => ({ getColumns: vi.fn(), listConstraints: vi.fn(), listIndexes: vi.fn(), listTriggers: vi.fn(), executeQuery: vi.fn(), buildCreateTableSql: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
import { buildDuplicateTableStructurePlan } from "@/lib/database/dbAdminSql";
import { confirmOceanbaseTableClone, executeOceanbaseTableClone, OceanbaseTableCloneError } from "@/lib/database/oceanbaseTableClone";

const result = (rows: unknown[][] = []): QueryResult => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 }) as QueryResult;
const options = { connectionId: "c", database: "db", databaseType: "oceanbase-oracle" as const, schema: "Source's Schema", sourceName: "Order", targetSchema: "Target Schema", targetName: 'New"Table' };
const columns: ColumnInfo[] = [
  { name: "a", data_type: "VARCHAR2(12 BYTE)", is_nullable: false, column_default: "'a''b'", is_primary_key: true, extra: "", comment: " first 'comment' " },
  { name: "b", data_type: "NUMBER(8,-2)", is_nullable: false, column_default: "-100", is_primary_key: true, extra: "", comment: null },
  { name: 'Mixed"Case', data_type: "VARCHAR2(7 CHAR)", is_nullable: true, column_default: null, is_primary_key: false, extra: "", comment: "中文" },
];

beforeEach(() => {
  vi.resetAllMocks();
  api.getColumns.mockResolvedValue(columns);
  api.listConstraints.mockResolvedValue([
    { name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["b", "a"], enabled: true, valid: true },
    { name: "FK_SOURCE", constraint_type: "FOREIGN KEY", columns: ["a"] },
  ]);
  api.listIndexes.mockResolvedValue([
    { name: "PK_SOURCE", columns: ["b", "a"], is_primary: true },
    { name: "IX_SOURCE", columns: ['Mixed"Case', "b"], index_type: "NORMAL", is_unique: false },
    { name: "IX_EXPR", columns: ["SYS_NC1"], index_type: "FUNCTION-BASED NORMAL" },
  ]);
  api.listTriggers.mockResolvedValue([{ name: "TRG_SOURCE" }]);
  api.executeQuery.mockImplementation(async (_connection, _database, sql: string) => {
    if (sql.includes("SYS_CONTEXT")) return result([[options.schema]]);
    if (sql.includes("ALL_TAB_COMMENTS")) return result([[" table's comment "]]);
    if (sql.includes("ALL_IND_COLUMNS"))
      return result([
        ["IX_SOURCE", 'Mixed"Case', 1, "DESC"],
        ["IX_SOURCE", "b", 2, "ASC"],
      ]);
    return result();
  });
  api.buildCreateTableSql.mockResolvedValue({ statements: ['CREATE TABLE "Target Schema"."New""Table" ("a" VARCHAR2(12 BYTE) NOT NULL, "b" NUMBER(8,-2) NOT NULL, "Mixed""Case" VARCHAR2(7 CHAR));'], warnings: [] });
});

describe("OceanBase Oracle structure clone", () => {
  it.each(["ALL_TAB_COLS", "ALL_IND_COLUMNS", "ALL_CONSTRAINTS"])("rejects short truncated %s metadata even without has_more", async (dictionary) => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (!args[2].includes(dictionary)) return original(...args);
      const partial = dictionary === "ALL_TAB_COLS" ? result() : dictionary === "ALL_IND_COLUMNS" ? await original(...args) : result([["UQ_SOURCE", "U", "UQ_BACKING"]]);
      return { ...partial, truncated: true, has_more: false };
    });
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toThrow("Clone metadata was truncated. No DDL was executed.");
    expect(api.buildCreateTableSql).not.toHaveBeenCalled();
  });
  it("excludes UNIQUE backing indexes and reports foreign keys missing from the constraints API", async () => {
    api.listConstraints.mockResolvedValue([
      { name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["b", "a"], enabled: true, valid: true },
      { name: "UQ_SOURCE", constraint_type: "UNIQUE", columns: ["a"] },
    ]);
    api.listIndexes.mockResolvedValue([
      { name: "UQ_BACKING", columns: ["a"], index_type: "NORMAL", is_unique: true },
      { name: "IX_STANDALONE", columns: ["b"], index_type: "NORMAL", is_unique: true },
    ]);
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[2].includes("ALL_CONSTRAINTS"))
        return result([
          ["UQ_SOURCE", "U", "UQ_BACKING"],
          ["FK_SOURCE", "R", null],
        ]);
      if (args[2].includes("ALL_IND_COLUMNS"))
        return result([
          ["UQ_BACKING", "a", 1, "ASC"],
          ["IX_STANDALONE", "b", 1, "ASC"],
        ]);
      return original(...args);
    });
    const plan = await buildDuplicateTableStructurePlan(options);
    expect(plan.oceanbaseClone?.copied.join("\n")).not.toContain("UQ_BACKING");
    expect(plan.oceanbaseClone?.copied.join("\n")).toContain("IX_STANDALONE");
    expect(plan.oceanbaseClone?.excluded).toEqual(expect.arrayContaining(['UNIQUE: "UQ_SOURCE"', 'FOREIGN KEY: "FK_SOURCE"']));
    expect(plan.sql).toContain("CREATE UNIQUE INDEX");
  });
  it("reads virtual-column identity from the OceanBase ALL_TAB_COLS dictionary", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[2].includes("VIRTUAL_COLUMN") && args[2].includes("ALL_TAB_COLUMNS")) {
        return { ...result(), execution_error: true, error: { detail: "ORA-00904: invalid identifier 'VIRTUAL_COLUMN'" } };
      }
      return original(...args);
    });
    const plan = await buildDuplicateTableStructurePlan(options);
    expect(plan.oceanbaseClone?.targetName).toBe(options.targetName);
    expect(api.executeQuery.mock.calls.find((call) => call[2].includes("VIRTUAL_COLUMN"))?.[2]).toContain("FROM SYS.ALL_TAB_COLS WHERE");
  });
  it("refuses a UNIQUE constraint whose backing index identity is unavailable", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => (args[2].includes("ALL_CONSTRAINTS") ? result([["UQ_SOURCE", "U", null]]) : original(...args)));
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toThrow("unique-constraint index metadata is unavailable");
  });
  it("carries FLOAT binary precision from metadata into the CREATE request", async () => {
    api.getColumns.mockResolvedValue([...columns, { name: "measurement", data_type: "FLOAT", numeric_precision: 24, numeric_scale: null, is_nullable: true, column_default: null, is_primary_key: false, extra: "" }]);
    const plan = await buildDuplicateTableStructurePlan(options);
    const request = api.buildCreateTableSql.mock.calls[0]![0];
    expect(request.columns.find((column: any) => column.name === "measurement")).toMatchObject({ dataType: "FLOAT(24)", original: undefined });
    expect(plan.oceanbaseClone?.copied.join("\n")).toContain('"measurement"');
  });

  it("rejects virtual columns even when source columns are supplied without their identity", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => (args[2].includes("VIRTUAL_COLUMN") ? result([['Computed"Value']]) : original(...args)));
    await expect(buildDuplicateTableStructurePlan({ ...options, sourceColumns: columns })).rejects.toThrow('Cloning virtual columns is not supported: "Computed""Value". No DDL was executed.');
    expect(api.buildCreateTableSql).not.toHaveBeenCalled();
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
    expect(api.executeQuery.mock.calls.find((call) => call[2].includes("VIRTUAL_COLUMN"))?.[2]).toContain("OWNER = 'Source''s Schema' AND TABLE_NAME = 'Order'");
  });
  it("routes through column DDL and preserves compound key/index order, quoting and comments", async () => {
    const plan = await buildDuplicateTableStructurePlan(options);
    expect(api.buildCreateTableSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "oceanbase-oracle", schema: options.targetSchema, tableName: options.targetName, indexes: [], foreignKeys: [], triggers: [] }));
    const drafts = api.buildCreateTableSql.mock.calls[0]![0].columns;
    expect(drafts.map((column: any) => [column.dataType, column.isNullable, column.defaultValue, column.isPrimaryKey])).toEqual([
      ["VARCHAR2(12 BYTE)", false, "'a''b'", false],
      ["NUMBER(8,-2)", false, "-100", false],
      ["VARCHAR2(7 CHAR)", true, "", false],
    ]);
    expect(plan.sql).toContain('ADD PRIMARY KEY ("b", "a")');
    expect(plan.sql).toContain('("Mixed""Case" DESC, "b" ASC)');
    expect(plan.sql).toContain('COMMENT ON TABLE "Target Schema"."New""Table" IS \' table\'\'s comment \';');
    expect(plan.sql).toContain('COMMENT ON COLUMN "Target Schema"."New""Table"."a" IS \' first \'\'comment\'\' \';');
    expect(plan.oceanbaseClone?.excluded).toEqual(expect.arrayContaining(['FOREIGN KEY: "FK_SOURCE"', 'TRIGGER: "TRG_SOURCE"', 'INDEX (FUNCTION-BASED NORMAL): "IX_EXPR"']));
    expect(plan.sql).not.toMatch(/CTAS|SELECT \*|CREATE TRIGGER|FOREIGN KEY|PK_SOURCE|IX_SOURCE/);
    expect(api.executeQuery.mock.calls.some((call) => call[2].includes("TABLE_OWNER = 'Source''s Schema'"))).toBe(true);
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it("resolves the current schema when the tree carries no owner", async () => {
    const plan = await buildDuplicateTableStructurePlan({ ...options, schema: undefined, targetSchema: undefined });
    expect(plan.oceanbaseClone?.targetSchema).toBe(options.schema);
    expect(api.getColumns).toHaveBeenCalledWith("c", "db", options.schema, "Order", undefined);
  });

  it.each(["missing table", "target conflict", "missing index direction", "truncated dictionary", "permission denied"])("refuses DDL preparation for %s", async (failure) => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      const sql = String(args[2]);
      if (failure === "permission denied") throw new Error("ORA-01031: insufficient privileges");
      if (failure === "missing table" && sql.includes("ALL_TAB_COMMENTS")) return result();
      if (failure === "target conflict" && sql.includes("ROWNUM <= 1")) return result([[options.targetName]]);
      if (failure === "missing index direction" && sql.includes("ALL_IND_COLUMNS"))
        return result([
          ["IX_SOURCE", 'Mixed"Case', 1, null],
          ["IX_SOURCE", "b", 2, "ASC"],
        ]);
      if (failure === "truncated dictionary") return { ...result(), has_more: true };
      return original(...args);
    });
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toThrow();
    expect(api.executeQuery.mock.calls.every((call) => String(call[2]).startsWith("SELECT "))).toBe(true);
  });

  it("does not invent a primary key when its ordered metadata is missing", async () => {
    api.listConstraints.mockResolvedValue([]);
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toThrow("primary-key metadata is incomplete");
  });

  it("requires confirmation of the exact target and exclusions before dispatch", async () => {
    const plan = await buildDuplicateTableStructurePlan(options);
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    const t = vi.fn((_key: string, values?: Record<string, string>) => JSON.stringify(values));
    expect(confirmOceanbaseTableClone(plan, t)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Target Schema"));
    expect(t).toHaveBeenCalledWith("contextMenu.oceanbaseClonePreview", expect.objectContaining({ excluded: expect.stringContaining("TRG_SOURCE") }));
    vi.unstubAllGlobals();
  });

  it("stops after a partial DDL failure and reports committed objects plus manual recovery", async () => {
    const plan = await buildDuplicateTableStructurePlan(options);
    const execute = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error("ORA-01031: index permission"));
    const error = await executeOceanbaseTableClone(plan.oceanbaseClone!, execute).catch((error) => error);
    expect(error).toBeInstanceOf(OceanbaseTableCloneError);
    expect(error.message).toContain('Completed (committed):\nTABLE "Target Schema"."New""Table"\nPRIMARY KEY');
    expect(error.message).toContain('DROP TABLE "Target Schema"."New""Table";');
    expect(error.message).toContain("No automatic rollback");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.every((call) => !call[0].endsWith(";"))).toBe(true);
  });

  it("does not recommend deleting an existing target when CREATE fails or is unconfirmed", async () => {
    const plan = await buildDuplicateTableStructurePlan(options);
    const execute = vi.fn().mockResolvedValue({ ...result(), execution_error: true, error: { detail: "ORA-00955: name is already used" } });
    const error = await executeOceanbaseTableClone(plan.oceanbaseClone!, execute).catch((error) => error);
    expect(error.message).toContain("ORA-00955: name is already used");
    expect(error.message).toContain("None confirmed");
    expect(error.message).not.toContain("DROP TABLE");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves backend metadata error details before generating DDL", async () => {
    api.executeQuery.mockResolvedValue({ ...result(), execution_error: true, error: { detail: "ORA-01031: metadata permission" } });
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toThrow("ORA-01031: metadata permission");
    expect(api.buildCreateTableSql).not.toHaveBeenCalled();
  });
});
