// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, QueryResult } from "@/types/database";

const api = vi.hoisted(() => ({ getColumns: vi.fn(), listConstraints: vi.fn(), listIndexes: vi.fn(), listTriggers: vi.fn(), executeQuery: vi.fn(), buildCreateTableSql: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
import { buildDuplicateTableStructurePlan } from "@/lib/database/dbAdminSql";
import { executeOceanbaseTableClone, OceanbaseTableCloneError } from "@/lib/database/oceanbaseTableClone";

const result = (rows: unknown[][] = []): QueryResult => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 }) as QueryResult;
const options = { connectionId: "c", database: "db", databaseType: "oceanbase-oracle" as const, schema: "Source's Schema", sourceName: "Order", targetName: '"New""Table"' };
const columns: ColumnInfo[] = [
  { name: "a", data_type: "VARCHAR2(12 BYTE)", is_nullable: false, column_default: "'a''b'", is_primary_key: true, extra: "", comment: " first 'comment' " },
  { name: "b", data_type: "NUMBER(8,-2)", is_nullable: false, column_default: "-100", is_primary_key: true, extra: "", comment: null },
  { name: 'Mixed"Case', data_type: "VARCHAR2(7 CHAR)", is_nullable: true, column_default: null, is_primary_key: false, extra: "", comment: "中文" },
];

beforeEach(() => {
  vi.resetAllMocks();
  api.getColumns.mockResolvedValue(columns);
  api.listConstraints.mockResolvedValue([
    { name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["b", "a"], enabled: true, valid: true, deferrable: false },
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
    if (sql.includes("ALL_TABLES")) return result([["NO", "N"]]);
    if (sql.includes("ALL_INDEXES")) return result([["IX_SOURCE", "VISIBLE"]]);
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
  it("allows a target name already used by an independently namespaced index", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (args[2].includes("ROWNUM <= 1")) return result(args[2].includes("OBJECT_TYPE <> 'INDEX'") ? [] : [[options.targetName]]);
      return original(...args);
    });
    await expect(buildDuplicateTableStructurePlan(options)).resolves.toMatchObject({ oceanbaseClone: { targetName: 'New"Table' } });
  });

  it("preserves an invisible normal index in the executable plan", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => (args[2].includes("ALL_INDEXES") ? result([["IX_SOURCE", "INVISIBLE"]]) : original(...args)));
    const plan = await buildDuplicateTableStructurePlan(options);
    expect(plan.oceanbaseClone?.steps.find((step) => step.kind === "index")?.sql).toContain('("Mixed""Case" DESC, "b" ASC) INVISIBLE;');
  });

  it.each(
    [
      [],
      [["IX_SOURCE", null]],
      [["IX_SOURCE", "UNKNOWN"]],
      [
        ["IX_SOURCE", "VISIBLE"],
        ["IX_SOURCE", "INVISIBLE"],
      ],
    ].map((rows) => [rows]),
  )("refuses incomplete or ambiguous index visibility %j", async (rows) => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => (args[2].includes("ALL_INDEXES") ? result(rows) : original(...args)));
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toMatchObject({ key: "indexVisibility", values: { name: '"IX_SOURCE"' } });
  });

  it.each(["", '""', '"unfinished', "two words", "a.b", "a;drop table b"])("rejects an invalid new target %j before reading metadata", async (targetName) => {
    await expect(buildDuplicateTableStructurePlan({ ...options, targetName })).rejects.toMatchObject({ key: "invalidName" });
    expect(api.getColumns).not.toHaveBeenCalled();
  });

  it("refreshes cached source columns and comments before planning", async () => {
    const plan = await buildDuplicateTableStructurePlan({ ...options, sourceColumns: [], tableComment: "stale comment" });
    expect(api.getColumns).toHaveBeenCalledOnce();
    expect(plan.sourceColumns).toEqual(columns);
    expect(plan.sql).toContain("table''s comment");
    expect(plan.sql).not.toContain("stale comment");
  });

  it("reports partitioning as excluded", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => (args[2].includes("ALL_TABLES") ? result([["YES", "N"]]) : original(...args)));
    const plan = await buildDuplicateTableStructurePlan(options);
    expect(plan.oceanbaseClone?.exclusions).toContainEqual({ kind: "partitioning" });
  });

  it.each([[["NO", "Y"]], [], [[null, "N"]]])("refuses temporary or incomplete table properties %j", async (rows) => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => (args[2].includes("ALL_TABLES") ? result(rows) : original(...args)));
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toThrow();
    expect(api.buildCreateTableSql).not.toHaveBeenCalled();
  });

  it.each([
    ["ordersCopy", "ORDERSCOPY"],
    ['"OrdersCopy"', "OrdersCopy"],
  ])("preserves metadata identities while resolving only the new target %s", async (entered, stored) => {
    const plan = await buildDuplicateTableStructurePlan({ ...options, targetName: entered });
    const request = api.buildCreateTableSql.mock.calls[0]![0];
    expect(request.tableName).toBe(stored);
    expect(request.columns.map((column: any) => column.name)).toEqual(["a", "b", 'Mixed"Case']);
    expect(plan.sourceColumns).toBe(columns);
    expect(plan.oceanbaseClone?.targetName).toBe(stored);
    expect(api.executeQuery.mock.calls.find((call) => call[2].includes("ROWNUM <= 1"))?.[2]).toContain(`OBJECT_NAME = '${stored}'`);
    expect(plan.oceanbaseClone?.steps.find((step) => step.kind === "primaryKey")?.sql).toBe(`ALTER TABLE "Source's Schema"."${stored}" ADD PRIMARY KEY ("b", "a");`);
    expect(plan.oceanbaseClone?.steps.find((step) => step.kind === "comment" && step.sql.includes('"a"'))?.sql).toContain(`"${stored}"."a"`);
  });

  it.each(["ALL_TAB_COLS", "ALL_IND_COLUMNS", "ALL_CONSTRAINTS", "ALL_INDEXES"])("rejects short truncated %s metadata even without has_more", async (dictionary) => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (!args[2].includes(dictionary)) return original(...args);
      const partial = dictionary === "ALL_TAB_COLS" ? result() : dictionary === "ALL_IND_COLUMNS" ? await original(...args) : result([["UQ_SOURCE", "U", "UQ_BACKING"]]);
      return { ...partial, truncated: true, has_more: false };
    });
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toMatchObject({ key: "metadataTruncated" });
    if (dictionary !== "ALL_INDEXES") expect(api.buildCreateTableSql).not.toHaveBeenCalled();
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });
  it("excludes UNIQUE backing indexes and reports foreign keys missing from the constraints API", async () => {
    api.listConstraints.mockResolvedValue([
      { name: "PK_SOURCE", constraint_type: "PRIMARY KEY", columns: ["b", "a"], enabled: true, valid: true, deferrable: false },
      { name: "UQ_SOURCE", constraint_type: "UNIQUE", columns: ["a"] },
    ]);
    api.listIndexes.mockResolvedValue([
      { name: "UQ_BACKING", columns: ["a"], index_type: "NORMAL", is_unique: true },
      { name: "IX_STANDALONE", columns: ["b"], index_type: "NORMAL", is_unique: true },
    ]);
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[2].includes("ALL_INDEXES")) return result([["IX_STANDALONE", "VISIBLE"]]);
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
    expect(plan.oceanbaseClone?.steps.filter((step) => step.kind === "index")).toHaveLength(1);
    expect(plan.oceanbaseClone?.exclusions).toEqual(
      expect.arrayContaining([
        { kind: "constraint", name: "UQ_SOURCE", type: "UNIQUE" },
        { kind: "constraint", name: "FK_SOURCE", type: "FOREIGN KEY" },
      ]),
    );
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
    expect(plan.oceanbaseClone?.targetName).toBe('New"Table');
    expect(api.executeQuery.mock.calls.find((call) => call[2].includes("VIRTUAL_COLUMN"))?.[2]).toContain("FROM SYS.ALL_TAB_COLS WHERE");
  });
  it("refuses a UNIQUE constraint whose backing index identity is unavailable", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => (args[2].includes("ALL_CONSTRAINTS") ? result([["UQ_SOURCE", "U", null]]) : original(...args)));
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toMatchObject({ key: "uniqueIndexMetadata" });
  });
  it("carries FLOAT binary precision from metadata into the CREATE request", async () => {
    api.getColumns.mockResolvedValue([...columns, { name: "measurement", data_type: "FLOAT", numeric_precision: 24, numeric_scale: null, is_nullable: true, column_default: null, is_primary_key: false, extra: "" }]);
    const plan = await buildDuplicateTableStructurePlan(options);
    const request = api.buildCreateTableSql.mock.calls[0]![0];
    expect(request.columns.find((column: any) => column.name === "measurement")).toMatchObject({ dataType: "FLOAT(24)", original: undefined });
    expect(plan.oceanbaseClone?.columnCount).toBe(columns.length + 1);
  });

  it("rejects virtual columns even when source columns are supplied without their identity", async () => {
    const original = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args: Parameters<typeof original>) => (args[2].includes("VIRTUAL_COLUMN") ? result([['Computed"Value']]) : original(...args)));
    await expect(buildDuplicateTableStructurePlan({ ...options, sourceColumns: columns })).rejects.toMatchObject({ key: "virtualColumns", values: { names: '"Computed""Value"' } });
    expect(api.buildCreateTableSql).not.toHaveBeenCalled();
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
    expect(api.executeQuery.mock.calls.find((call) => call[2].includes("VIRTUAL_COLUMN"))?.[2]).toContain("OWNER = 'Source''s Schema' AND TABLE_NAME = 'Order'");
  });
  it("routes through column DDL and preserves compound key/index order, quoting and comments", async () => {
    const plan = await buildDuplicateTableStructurePlan(options);
    expect(api.buildCreateTableSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "oceanbase-oracle", schema: options.schema, tableName: 'New"Table', indexes: [], foreignKeys: [], triggers: [] }));
    const drafts = api.buildCreateTableSql.mock.calls[0]![0].columns;
    expect(drafts.map((column: any) => [column.dataType, column.isNullable, column.defaultValue, column.isPrimaryKey])).toEqual([
      ["VARCHAR2(12 BYTE)", false, "'a''b'", false],
      ["NUMBER(8,-2)", false, "-100", false],
      ["VARCHAR2(7 CHAR)", true, "", false],
    ]);
    expect(plan.sql).toContain('ADD PRIMARY KEY ("b", "a")');
    expect(plan.sql).toContain('("Mixed""Case" DESC, "b" ASC)');
    expect(plan.sql).toContain(`COMMENT ON TABLE "Source's Schema"."New""Table" IS ' table''s comment ';`);
    expect(plan.sql).toContain(`COMMENT ON COLUMN "Source's Schema"."New""Table"."a" IS ' first ''comment'' ';`);
    expect(plan.oceanbaseClone?.exclusions).toEqual(
      expect.arrayContaining([
        { kind: "constraint", name: "FK_SOURCE", type: "FOREIGN KEY" },
        { kind: "trigger", name: "TRG_SOURCE" },
        { kind: "index", name: "IX_EXPR", type: "FUNCTION-BASED NORMAL" },
      ]),
    );
    expect(plan.sql).not.toMatch(/CTAS|SELECT \*|CREATE TRIGGER|FOREIGN KEY|PK_SOURCE|IX_SOURCE/);
    expect(api.executeQuery.mock.calls.some((call) => call[2].includes("TABLE_OWNER = 'Source''s Schema'"))).toBe(true);
    expect(api.executeQuery.mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
  });

  it("resolves the current schema when the tree carries no owner", async () => {
    const plan = await buildDuplicateTableStructurePlan({ ...options, schema: undefined });
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
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toMatchObject({ key: "primaryKeyMetadata" });
  });

  it("stops after a lost response and reports committed, unknown and unexecuted steps", async () => {
    const plan = await buildDuplicateTableStructurePlan(options);
    const execute = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error("ORA-01031: index permission"));
    const error = await executeOceanbaseTableClone(plan.oceanbaseClone!, execute).catch((error) => error);
    expect(error).toBeInstanceOf(OceanbaseTableCloneError);
    expect(error.execution).toMatchObject({ failedPosition: 2, rejected: false });
    expect(error.execution.steps.slice(0, error.execution.failedPosition).map((step: { kind: string }) => step.kind)).toEqual(["table", "primaryKey"]);
    expect(error.execution.steps.slice(error.execution.failedPosition + 1).every((step: { kind: string }) => step.kind === "comment")).toBe(true);
    expect(error.execution.cause.message).toBe("ORA-01031: index permission");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.every((call) => !call[0].endsWith(";"))).toBe(true);
  });

  it("does not recommend deleting an existing target when CREATE fails or is unconfirmed", async () => {
    const plan = await buildDuplicateTableStructurePlan(options);
    const execute = vi.fn().mockResolvedValue({ ...result(), execution_error: true, error: { detail: "ORA-00955: name is already used" } });
    const error = await executeOceanbaseTableClone(plan.oceanbaseClone!, execute).catch((error) => error);
    expect(error.message).toContain("ORA-00955: name is already used");
    expect(error.execution).toMatchObject({ failedPosition: 0, rejected: true });
    expect(error.message).not.toContain("DROP TABLE");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves backend metadata error details before generating DDL", async () => {
    api.executeQuery.mockResolvedValue({ ...result(), execution_error: true, error: { detail: "ORA-01031: metadata permission" } });
    await expect(buildDuplicateTableStructurePlan(options)).rejects.toThrow("ORA-01031: metadata permission");
    expect(api.buildCreateTableSql).not.toHaveBeenCalled();
  });
});
