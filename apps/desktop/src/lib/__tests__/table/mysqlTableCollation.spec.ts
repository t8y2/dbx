import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import { mysqlTableCharsetChangeSql, mysqlTableCharsetFromCollation, mysqlTableCollationBelongsToCharset, mysqlTableCollationSql, parseMysqlTableCharset, parseMysqlTableCollation } from "@/lib/table/mysqlTableCollation";

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

  it("matches collations to their charset, treating utf8 as utf8mb3", () => {
    expect(mysqlTableCollationBelongsToCharset("utf8mb4_0900_ai_ci", "utf8mb4")).toBe(true);
    expect(mysqlTableCollationBelongsToCharset("utf8_general_ci", "utf8mb3")).toBe(true);
    expect(mysqlTableCollationBelongsToCharset("utf8mb3_general_ci", "utf8")).toBe(true);
    expect(mysqlTableCollationBelongsToCharset("latin1_swedish_ci", "utf8mb4")).toBe(false);
    expect(mysqlTableCollationBelongsToCharset("", "utf8mb4")).toBe(false);
    expect(mysqlTableCollationBelongsToCharset("utf8mb4_bin", "")).toBe(false);
  });

  it("builds the default-charset ALTER matching the server-side builder", () => {
    expect(mysqlTableCharsetChangeSql({ database: "shop", table: "订单", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" })).toBe("ALTER TABLE `shop`.`订单` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
    // No database qualifier keeps the current schema; a missing collation leaves the server default.
    expect(mysqlTableCharsetChangeSql({ database: "", table: "orders", charset: "utf8mb4" })).toBe("ALTER TABLE `orders` DEFAULT CHARACTER SET utf8mb4");
    expect(mysqlTableCharsetChangeSql({ database: null, table: "orders", charset: "utf8", collation: "utf8_general_ci" })).toBe("ALTER TABLE `orders` DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci");
  });

  it("refuses charset/collation names that would need quoting", () => {
    expect(mysqlTableCharsetChangeSql({ database: "shop", table: "orders", charset: "utf8mb4; DROP TABLE x" })).toBeUndefined();
    expect(mysqlTableCharsetChangeSql({ database: "shop", table: "orders", charset: "utf8mb4", collation: "utf8mb4_bin'" })).toBeUndefined();
    // Collation belongs to another charset: the server would reject it anyway.
    expect(mysqlTableCharsetChangeSql({ database: "shop", table: "orders", charset: "utf8mb4", collation: "latin1_swedish_ci" })).toBeUndefined();
    expect(mysqlTableCharsetChangeSql({ database: "shop", table: "  ", charset: "utf8mb4" })).toBeUndefined();
  });
});
