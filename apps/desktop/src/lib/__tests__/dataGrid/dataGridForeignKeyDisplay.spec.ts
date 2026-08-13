import { describe, expect, it } from "vitest";
import { collectForeignKeyDisplayValues, foreignKeyDisplayConfigMatches, foreignKeyDisplayMapFromResult, formatForeignKeyDisplayValue, singleColumnForeignKey, splitForeignKeyDisplayValues } from "@/lib/dataGrid/dataGridForeignKeyDisplay";
import { buildColumnForeignKeyMap } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { QueryResult } from "@/types/database";

describe("dataGridForeignKeyDisplay", () => {
  it("only enables dictionary display for a single-column foreign key", () => {
    const single = buildColumnForeignKeyMap([{ name: "fk_user", column: "user_id", ref_schema: "public", ref_table: "users", ref_column: "id" }]).get("user_id");
    const composite = buildColumnForeignKeyMap([
      { name: "fk_item", column: "order_id", ref_table: "items", ref_column: "order_id" },
      { name: "fk_item", column: "line_no", ref_table: "items", ref_column: "line_no" },
    ]).get("order_id");

    expect(singleColumnForeignKey(single)?.ref_table).toBe("users");
    expect(singleColumnForeignKey(composite)).toBeUndefined();
  });

  it("matches a saved configuration against current foreign-key metadata", () => {
    const config = { kind: "foreign-key-display" as const, refSchema: "public", refTable: "users", refColumn: "id", displayColumn: "name" };
    expect(foreignKeyDisplayConfigMatches(config, { name: "fk_user", column: "user_id", ref_schema: "PUBLIC", ref_table: "USERS", ref_column: "ID" })).toBe(true);
    expect(foreignKeyDisplayConfigMatches(config, { name: "fk_user", column: "user_id", ref_schema: "public", ref_table: "accounts", ref_column: "id" })).toBe(false);
    expect(foreignKeyDisplayConfigMatches(config, { name: "fk_user", column: "user_id", ref_schema: "archive", ref_table: "users", ref_column: "id" })).toBe(false);
  });

  it("deduplicates current-page keys with type-safe identities and bounded batches", () => {
    const rows = [[100], [100], ["100"], [null], [101], [{ id: 1 }]] as QueryResult["rows"];
    const values = collectForeignKeyDisplayValues(rows, 0);
    expect(values).toEqual([100, "100", 101]);
    expect(splitForeignKeyDisplayValues(values, 2)).toEqual([[100, "100"], [101]]);
  });

  it("builds labels from query results and preserves raw values when no useful label exists", () => {
    const result = {
      columns: ["id", "name", "code"],
      rows: [
        [100, "张三", "U100"],
        [101, "李四", "U101"],
        [102, null, "U102"],
        [103, "  ", "U103"],
        [100, "重复", "U100-duplicate"],
      ],
    } as QueryResult;
    const labels = foreignKeyDisplayMapFromResult(result);
    const codeLabels = foreignKeyDisplayMapFromResult(result, "ID", "CODE");

    expect(formatForeignKeyDisplayValue(100, labels)).toBe("100 (张三)");
    expect(formatForeignKeyDisplayValue(102, labels)).toBe("102");
    expect(formatForeignKeyDisplayValue(103, labels)).toBe("103");
    expect(formatForeignKeyDisplayValue(null, labels)).toBe("NULL");
    expect(formatForeignKeyDisplayValue("same", new Map([["string\u0000same", "same"]]))).toBe("same");
    expect(formatForeignKeyDisplayValue(100, codeLabels)).toBe("100 (U100)");
    expect(foreignKeyDisplayMapFromResult(result, "missing", "code")).toEqual(new Map());
  });
});
