import { describe, expect, it } from "vitest";
import { buildTableInsertTemplate } from "@/lib/table/tableSqlTemplates";
import type { ColumnInfo } from "@/types/database";

function column(partial: Partial<ColumnInfo> & Pick<ColumnInfo, "name" | "data_type">): ColumnInfo {
  return { is_nullable: true, column_default: null, is_primary_key: false, extra: null, ...partial };
}

describe("buildTableInsertTemplate string placeholder length", () => {
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
