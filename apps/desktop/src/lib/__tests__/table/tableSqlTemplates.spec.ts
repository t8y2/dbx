import { describe, expect, it } from "vitest";

import { buildTableDeleteTemplate, buildTableInsertTemplate, buildTableSelectTemplate, buildTableUpdateTemplate } from "@/lib/table/tableSqlTemplates";
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
