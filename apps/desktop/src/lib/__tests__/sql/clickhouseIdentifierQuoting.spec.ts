import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";
import { quoteTableIdentifierIfNeeded } from "@/lib/table/tableSelectSql";
import { omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";
import { requiresClickhouseIdentifierQuote } from "@/lib/sql/sqlIdentifier";

const clickhouseInput = {
  databaseType: "clickhouse" as const,
  tables: [
    { name: "用户表", type: "table" as const },
    { name: "orders", type: "table" as const },
  ],
  columnsByTable: new Map([
    [
      "orders",
      [
        { name: "id", table: "orders" },
        { name: "user_id", table: "orders" },
        { name: "姓名", table: "orders" },
        { name: "时间", table: "orders" },
        { name: "prewhere", table: "orders" },
        { name: "final", table: "orders" },
        { name: "format", table: "orders" },
        { name: "settings", table: "orders" },
        { name: "col$1", table: "orders" },
        { name: "col-1", table: "orders" },
      ],
    ],
    [
      "用户表",
      [
        { name: "id", table: "用户表" },
        { name: "姓名", table: "用户表" },
      ],
    ],
  ]),
};

describe("clickhouse identifier quoting predicate", () => {
  it("quotes Chinese and non-ASCII identifiers", () => {
    expect(requiresClickhouseIdentifierQuote("姓名")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("时间")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("用户表")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("测试_col")).toBe(true);
  });

  it("quotes identifiers containing $ or hyphens or spaces", () => {
    expect(requiresClickhouseIdentifierQuote("col$1")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("col-1")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("col name")).toBe(true);
  });

  it("quotes ClickHouse-specific and standard SQL reserved keywords", () => {
    expect(requiresClickhouseIdentifierQuote("prewhere")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("final")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("format")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("settings")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("order")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("select")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("from")).toBe(true);
    expect(requiresClickhouseIdentifierQuote("where")).toBe(true);
  });

  it("leaves standard ASCII identifiers unquoted", () => {
    expect(requiresClickhouseIdentifierQuote("id")).toBe(false);
    expect(requiresClickhouseIdentifierQuote("user_id")).toBe(false);
    expect(requiresClickhouseIdentifierQuote("created_at")).toBe(false);
    expect(requiresClickhouseIdentifierQuote("UserName")).toBe(false);
  });
});

describe("clickhouse completion quoting", () => {
  it("backticks Chinese columns in WHERE clause completions while keeping standard English unquoted", () => {
    const sql = "SELECT * FROM orders WHERE ";
    const items = buildSqlCompletionItems(sql, sql.length, clickhouseInput);

    const nameCol = items.find((item) => item.type === "column" && item.label === "姓名");
    expect(nameCol?.apply).toBe("`姓名`");

    const timeCol = items.find((item) => item.type === "column" && item.label === "时间");
    expect(timeCol?.apply).toBe("`时间`");

    const idCol = items.find((item) => item.type === "column" && item.label === "id");
    expect(idCol?.apply).toBe("id");

    const userIdCol = items.find((item) => item.type === "column" && item.label === "user_id");
    expect(userIdCol?.apply).toBe("user_id");
  });

  it("backticks ClickHouse reserved keywords used as column names", () => {
    const sql = "SELECT * FROM orders WHERE ";
    const items = buildSqlCompletionItems(sql, sql.length, clickhouseInput);

    for (const keyword of ["prewhere", "final", "format", "settings"]) {
      const col = items.find((item) => item.type === "column" && item.label === keyword);
      expect(col?.apply).toBe(`\`${keyword}\``);
    }
  });

  it("backticks table name completions when table name is Chinese", () => {
    const sql = "SELECT * FROM ";
    const items = buildSqlCompletionItems(sql, sql.length, clickhouseInput);

    const chineseTable = items.find((item) => item.type === "table" && item.label === "用户表");
    expect(chineseTable?.apply).toBe("`用户表`");

    const ordersTable = items.find((item) => item.type === "table" && item.label === "orders");
    expect(ordersTable?.apply).toBe("orders");
  });

  it("backticks Chinese columns in alias-qualified completions", () => {
    const sql = "SELECT o. FROM orders o";
    const cursor = sql.indexOf(".");
    const items = buildSqlCompletionItems(sql, cursor + 1, clickhouseInput);

    const nameCol = items.find((item) => item.type === "column" && item.label === "姓名");
    expect(nameCol?.apply).toBe("`姓名`");

    const idCol = items.find((item) => item.type === "column" && item.label === "id");
    expect(idCol?.apply).toBe("id");
  });
});

describe("clickhouse tableSelectSql and DDL identifier quoting", () => {
  it("quotes Chinese and reserved names in quoteTableIdentifierIfNeeded", () => {
    expect(quoteTableIdentifierIfNeeded("clickhouse", "姓名")).toBe("`姓名`");
    expect(quoteTableIdentifierIfNeeded("clickhouse", "prewhere")).toBe("`prewhere`");
    expect(quoteTableIdentifierIfNeeded("clickhouse", "user_id")).toBe("user_id");
  });

  it("preserves quotes on Chinese column names when omitting DDL quotes for ClickHouse", () => {
    const ddl = "CREATE TABLE `orders` (`id` Int32, `姓名` String, `created_at` DateTime) ENGINE = MergeTree() ORDER BY id;";
    const cleaned = omitDdlIdentifierQuotes(ddl, "clickhouse");
    expect(cleaned).toBe("CREATE TABLE orders (id Int32, `姓名` String, created_at DateTime) ENGINE = MergeTree() ORDER BY id;");
  });
});
