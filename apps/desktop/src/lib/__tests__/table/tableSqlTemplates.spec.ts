import { describe, expect, it } from "vitest";

import { buildTableDeleteTemplate, buildTableInsertTemplate, buildTableSelectTemplate, buildTableUpdateTemplate, insertTemplatePrimaryKeyConflicts } from "@/lib/table/tableSqlTemplates";
import type { ColumnInfo } from "@/types/database";

describe("buildTableSelectTemplate", () => {
  it("can omit identifier quotes for a new-query table reference", () => {
    expect(
      buildTableSelectTemplate({
        databaseType: "postgres",
        schema: "public",
        tableName: "dbx_smoke",
        quoteIdentifiers: false,
      }),
    ).toBe("SELECT *\nFROM public.dbx_smoke;");
  });

  it("keeps required quotes for columns when identifier quoting is disabled", () => {
    expect(
      buildTableSelectTemplate({
        databaseType: "dameng",
        tableName: "DBX_TEST",
        columns: [
          { name: "ORDER", data_type: "VARCHAR" },
          { name: "CUSTOMER_NAME", data_type: "VARCHAR" },
        ],
        quoteIdentifiers: false,
      }),
    ).toBe('SELECT "ORDER", CUSTOMER_NAME\nFROM DBX_TEST;');
  });

  it("applies the same identifier policy to update templates", () => {
    expect(
      buildTableUpdateTemplate({
        databaseType: "oracle",
        tableName: "DBX_TEST",
        columns: [
          { name: "ID", data_type: "NUMBER", is_primary_key: true },
          { name: "ORDER", data_type: "VARCHAR" },
        ],
        quoteIdentifiers: false,
      }),
    ).toBe("UPDATE DBX_TEST\nSET \"ORDER\" = 'ORDER_value'\nWHERE ID = 0;");
  });
});

describe.each(["oracle", "oceanbase-oracle"] as const)("%s table template identifier policy", (databaseType) => {
  it.each([
    [false, '"id", "OrderId", AGENT_NAME, "SELECT", "created at", "A""B"', '"OrderId" = 0,\n    AGENT_NAME = 0,\n    "SELECT" = 0,\n    "created at" = 0,\n    "A""B" = 0'],
    [true, '"id", "OrderId", "AGENT_NAME", "SELECT", "created at", "A""B"', '"OrderId" = 0,\n    "AGENT_NAME" = 0,\n    "SELECT" = 0,\n    "created at" = 0,\n    "A""B" = 0'],
  ] as const)("preserves object names with quoteIdentifiers=%s", (quoteIdentifiers, selectColumns, assignments) => {
    const options = {
      databaseType,
      schema: "App",
      tableName: "Orders",
      columns: ["id", "OrderId", "AGENT_NAME", "SELECT", "created at", 'A"B'].map((name) => ({ name, data_type: "NUMBER", is_primary_key: name === "id" })),
      quoteIdentifiers,
    };
    expect(buildTableSelectTemplate(options)).toBe(`SELECT ${selectColumns}\nFROM "App"."Orders";`);
    expect(buildTableUpdateTemplate(options)).toBe(`UPDATE "App"."Orders"\nSET ${assignments}\nWHERE "id" = 0;`);
    expect(buildTableDeleteTemplate(options)).toBe('DELETE FROM "App"."Orders"\nWHERE "id" = 0;');
  });
});

describe("buildTableInsertTemplate string placeholder length", () => {
  function column(partial: Partial<ColumnInfo> & Pick<ColumnInfo, "name" | "data_type">): ColumnInfo {
    return { is_nullable: true, column_default: null, is_primary_key: false, extra: null, ...partial };
  }

  it("keeps the placeholder unchanged when length metadata is missing", () => {
    const sql = buildTableInsertTemplate({
      databaseType: "oracle",
      tableName: "t",
      columns: [column({ name: "CRYPTO_MODE", data_type: "varchar2" })],
    });
    expect(sql).toBe('INSERT INTO "t" ("CRYPTO_MODE")\nVALUES (\'CRYPTO_MODE_value\');');
  });

  it("truncates the name part so the placeholder fits the declared length", () => {
    const sql = buildTableInsertTemplate({
      databaseType: "oracle",
      tableName: "t",
      columns: [column({ name: "CRYPTO_MODE", data_type: "varchar2", character_maximum_length: 16 })],
    });
    expect(sql).toBe('INSERT INTO "t" ("CRYPTO_MODE")\nVALUES (\'CRYPTO_MOD_value\');');
  });

  it("clips the suffix when the column is shorter than the suffix", () => {
    const sql = buildTableInsertTemplate({
      databaseType: "oracle",
      tableName: "t",
      columns: [column({ name: "status", data_type: "varchar2", character_maximum_length: 3 })],
    });
    expect(sql).toBe('INSERT INTO "t" ("status")\nVALUES (\'_va\');');
  });

  it("budgets multi-byte column names by bytes", () => {
    const sql = buildTableInsertTemplate({
      databaseType: "oracle",
      tableName: "t",
      columns: [column({ name: "部门", data_type: "varchar2", character_maximum_length: 9 })],
    });
    expect(sql).toBe('INSERT INTO "t" ("部门")\nVALUES (\'部_value\');');
  });
});

describe("buildTableInsertTemplate rowCount", () => {
  function column(partial: Partial<ColumnInfo> & Pick<ColumnInfo, "name" | "data_type">): ColumnInfo {
    return { is_nullable: true, column_default: null, is_primary_key: false, extra: null, ...partial };
  }

  const mysqlColumns: ColumnInfo[] = [column({ name: "id", data_type: "int", is_primary_key: true }), column({ name: "name", data_type: "varchar" }), column({ name: "age", data_type: "int" }), column({ name: "created_at", data_type: "datetime" })];

  it("keeps the single-row output unchanged without rowCount", () => {
    const sql = buildTableInsertTemplate({ databaseType: "mysql", tableName: "users", columns: mysqlColumns });
    expect(sql).toBe("INSERT INTO `users` (`id`, `name`, `age`, `created_at`)\nVALUES (0, 'name_value', 0, CURRENT_TIMESTAMP);");
  });

  it("treats rowCount=1 the same as the default", () => {
    const single = buildTableInsertTemplate({ databaseType: "mysql", tableName: "users", columns: mysqlColumns });
    const explicit = buildTableInsertTemplate({ databaseType: "mysql", tableName: "users", columns: mysqlColumns, rowCount: 1 });
    expect(explicit).toBe(single);
  });

  it("generates numbered values per row when rowCount > 1", () => {
    const sql = buildTableInsertTemplate({ databaseType: "mysql", tableName: "users", columns: mysqlColumns, rowCount: 3 });
    expect(sql).toBe(
      [
        "INSERT INTO `users` (`id`, `name`, `age`, `created_at`)",
        "VALUES (1, 'name_value_1', 1, CURRENT_TIMESTAMP);",
        "",
        "INSERT INTO `users` (`id`, `name`, `age`, `created_at`)",
        "VALUES (2, 'name_value_2', 2, CURRENT_TIMESTAMP);",
        "",
        "INSERT INTO `users` (`id`, `name`, `age`, `created_at`)",
        "VALUES (3, 'name_value_3', 3, CURRENT_TIMESTAMP);",
      ].join("\n"),
    );
  });

  it("generates a distinct uuid per row for postgres uuid columns", () => {
    const sql = buildTableInsertTemplate({ databaseType: "postgres", tableName: "users", columns: [column({ name: "id", data_type: "uuid" })], rowCount: 3 });
    const values = [...sql.matchAll(/VALUES \('([0-9a-f-]{36})'::uuid\);/g)].map((match) => match[1]!);
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(3);
  });

  it("still returns the single TODO template when no columns are insertable", () => {
    const columns = [column({ name: "id", data_type: "int", extra: "auto_increment" })];
    const sql = buildTableInsertTemplate({ databaseType: "mysql", tableName: "t", columns, rowCount: 3 });
    expect(sql).toBe("INSERT INTO `t`\n/* TODO: add column values */\nVALUES ();");
  });

  it("generates one statement per row for tdengine stable tables with static tag placeholders", () => {
    const columns = [column({ name: "ts", data_type: "timestamp" }), column({ name: "current", data_type: "float" }), column({ name: "location", data_type: "varchar", comment: "TAG" })];
    const sql = buildTableInsertTemplate({ databaseType: "tdengine", tableName: "meters", columns, tableType: "STABLE", rowCount: 2 });
    expect(sql).toBe(["INSERT INTO /* child_table_name */ USING meters", "TAGS ('location_value')", "VALUES (NOW, 1);", "", "INSERT INTO /* child_table_name */ USING meters", "TAGS ('location_value')", "VALUES (NOW, 2);"].join("\n"));
  });

  it("clamps oversized rowCount to the max", () => {
    const columns = [column({ name: "id", data_type: "int" })];
    const sql = buildTableInsertTemplate({ databaseType: "mysql", tableName: "t", columns, rowCount: 5000 });
    expect(sql.split("\n\n")).toHaveLength(1000);
  });

  it("clamps row numbers to narrow numeric column ranges", () => {
    const columns = [column({ name: "id", data_type: "tinyint", numeric_precision: 3 }), column({ name: "code", data_type: "number", numeric_precision: 2 }), column({ name: "wide", data_type: "int", numeric_precision: 10 })];
    const sql = buildTableInsertTemplate({ databaseType: "mysql", tableName: "t", columns, rowCount: 200 });
    const values = [...sql.matchAll(/VALUES \((\d+), (\d+), (\d+)\);/g)];
    expect(values).toHaveLength(200);
    expect(values[126]![1]).toBe("127");
    expect(values[199]![1]).toBe("127");
    expect(values[98]![2]).toBe("99");
    expect(values[199]![2]).toBe("99");
    expect(values[199]![3]).toBe("200");
  });

  it("does not clamp row numbers when precision metadata is missing", () => {
    const columns = [column({ name: "id", data_type: "int" })];
    const sql = buildTableInsertTemplate({ databaseType: "mysql", tableName: "t", columns, rowCount: 200 });
    const values = [...sql.matchAll(/VALUES \((\d+)\);/g)];
    expect(values[199]![1]).toBe("200");
  });

  it("truncates string placeholders to the column character limit while keeping the row suffix", () => {
    const columns = [column({ name: "CRYPTO_MODE", data_type: "varchar2", character_maximum_length: 16 }), column({ name: "note", data_type: "varchar2", character_maximum_length: 64 })];
    const sql = buildTableInsertTemplate({ databaseType: "oracle", tableName: "t", columns, rowCount: 12 });
    const values = [...sql.matchAll(/VALUES \('([^']*)', '([^']*)'\);/g)];
    expect(values).toHaveLength(12);
    expect(values[0]![1]).toBe("CRYPTO_M_value_1");
    expect(values[1]![1]).toBe("CRYPTO_M_value_2");
    expect(values[9]![1]).toBe("CRYPTO__value_10");
    expect(values[0]![2]).toBe("note_value_1");
    expect(values.every((match) => match[1]!.length <= 16 && match[2]!.length <= 64)).toBe(true);
  });

  it("falls back to the bare row number when the column cannot hold the placeholder suffix", () => {
    const columns = [column({ name: "status", data_type: "varchar2", character_maximum_length: 4 })];
    const sql = buildTableInsertTemplate({ databaseType: "oracle", tableName: "t", columns, rowCount: 2 });
    const values = [...sql.matchAll(/VALUES \('([^']*)'\);/g)];
    expect(values[0]![1]).toBe("1");
    expect(values[1]![1]).toBe("2");
  });
});

describe("insertTemplatePrimaryKeyConflicts", () => {
  function column(partial: Partial<ColumnInfo> & Pick<ColumnInfo, "name" | "data_type">): ColumnInfo {
    return { is_nullable: true, column_default: null, is_primary_key: false, extra: null, ...partial };
  }

  it("flags numeric primary keys whose cap is below the row count", () => {
    const columns = [column({ name: "id", data_type: "tinyint", numeric_precision: 3, is_primary_key: true })];
    expect(insertTemplatePrimaryKeyConflicts(columns, 200)).toEqual([{ column: "id", reason: "numeric-cap", cap: 127 }]);
  });

  it("ignores non-key, auto-generated and wide-enough columns", () => {
    const columns = [
      column({ name: "status", data_type: "tinyint", numeric_precision: 3 }),
      column({ name: "rowid", data_type: "int", is_primary_key: true, extra: "auto_increment" }),
      column({ name: "code", data_type: "int", numeric_precision: 10, is_primary_key: true }),
      column({ name: "ref", data_type: "uuid", is_primary_key: true }),
      column({ name: "slug", data_type: "varchar", is_primary_key: true }),
    ];
    expect(insertTemplatePrimaryKeyConflicts(columns, 200)).toEqual([]);
  });

  it("flags date/time primary keys as static duplicates", () => {
    const columns = [column({ name: "day", data_type: "date", is_primary_key: true })];
    expect(insertTemplatePrimaryKeyConflicts(columns, 3)).toEqual([{ column: "day", reason: "static-value" }]);
  });

  it("returns nothing for single-row generation", () => {
    const columns = [column({ name: "id", data_type: "tinyint", numeric_precision: 3, is_primary_key: true })];
    expect(insertTemplatePrimaryKeyConflicts(columns, 1)).toEqual([]);
  });
});
