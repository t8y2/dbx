import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import { mysqlTableCharsetFromCollation, mysqlTableCollationSql, parseMysqlTableCharset, parseMysqlTableCollation } from "@/lib/table/mysqlTableCollation";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("mysqlTableCollation", () => {
  it.each([
    ["utf8mb4_0900_ai_ci", "utf8mb4"],
    [" utf8_general_ci ", "utf8"],
    ["utf8mb3_general_ci", "utf8mb3"],
    ["latin1_swedish_ci", "latin1"],
    ["gbk_chinese_ci", "gbk"],
    ["binary", "binary"],
    [null, ""],
    [undefined, ""],
    ["", ""],
  ])("resolves the table charset for collation %s", (collation, expected) => {
    expect(mysqlTableCharsetFromCollation(collation)).toBe(expected);
  });

  it("builds mode-independent lookup SQL for quoted and Unicode names", () => {
    const sql = mysqlTableCollationSql("db'x", "订单\\archive");
    expect(sql).toContain("TABLE_COLLATION AS table_collation");
    expect(sql).toContain("TABLE_SCHEMA = CONVERT(X'64622778' USING utf8mb4)");
    expect(sql).toContain("TABLE_NAME = CONVERT(X'e8aea2e58d955c61726368697665' USING utf8mb4)");
    expect(sql).not.toContain("db'x");
  });

  it("reads the reported collation regardless of column-name casing", () => {
    expect(parseMysqlTableCollation(result(["TABLE_COLLATION"], [["utf8mb4_0900_ai_ci"]]))).toBe("utf8mb4_0900_ai_ci");
    expect(parseMysqlTableCollation(result(["table_collation"], [[" utf8mb4_bin "]]))).toBe("utf8mb4_bin");
  });

  it("falls back to no table default when the server reports nothing usable", () => {
    // MySQL reports TABLE_COLLATION as NULL for views, and the lookup itself may fail.
    expect(parseMysqlTableCollation(result(["table_collation"], [[null]]))).toBe("");
    expect(parseMysqlTableCollation(result(["table_collation"], []))).toBe("");
    expect(parseMysqlTableCollation(result(["engine"], [["InnoDB"]]))).toBe("");
    expect(parseMysqlTableCollation(undefined)).toBe("");
  });

  it("derives the table charset and collation from the same metadata row", () => {
    expect(parseMysqlTableCharset(result(["TABLE_COLLATION"], [[" utf8mb4_0900_ai_ci "]]))).toEqual({
      charset: "utf8mb4",
      collation: "utf8mb4_0900_ai_ci",
    });
    expect(parseMysqlTableCharset(result(["table_collation"], [[null]]))).toEqual({
      charset: "",
      collation: "",
    });
  });
});
