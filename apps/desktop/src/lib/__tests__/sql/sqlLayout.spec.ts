import { describe, expect, it } from "vitest";
import { formatSqlText } from "@/lib/sql/sqlFormatter";
import { DEFAULT_SQL_FORMATTER_SETTINGS, type SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";

/**
 * Golden tests for the layout engine behind DBX's default formatting style.
 * The expectations for the queries in issues #827, #4850 and #5170 pin the
 * real-world shapes those reports asked for; the rest pin the rules those
 * examples exercise — the collapse of short statements, the wrap of long ones,
 * element alignment, and column alignment in `CREATE TABLE`.
 */

type Dialect = Parameters<typeof formatSqlText>[1];

async function format(sql: string, overrides: Partial<SqlFormatterSettings> = {}, dialect: Dialect = "mysql") {
  return formatSqlText(sql, dialect, { ...DEFAULT_SQL_FORMATTER_SETTINGS, ...overrides });
}

const lines = (...rows: string[]) => rows.join("\n");

describe("sql layout", () => {
  it("formats a query with a derived table (#827)", async () => {
    const sql = lines(
      "SELECT loc_id, loc_name, loc_type, delivery_emp_num, update_time",
      "FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY loc_id ORDER BY update_time DESC) AS rn",
      "      FROM responsible_area_info",
      "      WHERE DATE_FORMAT(update_time, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')) t",
      "WHERE rn = 1;",
    );

    // The subquery's clauses align under the `(` that opens it, and the closing
    // `)` stays on the last clause's line.
    //
    // The subquery's two select elements could be split; the screenshots in
    // #827 and #4850 disagree on that point (both are two-element lists, one
    // split, one not), so the keeping rule here is the one #4850's rendering
    // matches.
    expect(await format(sql)).toBe(
      lines(
        "SELECT loc_id,",
        "       loc_name,",
        "       loc_type,",
        "       delivery_emp_num,",
        "       update_time",
        "FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY loc_id ORDER BY update_time DESC) AS rn",
        "      FROM responsible_area_info",
        "      WHERE DATE_FORMAT(update_time, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')) t",
        "WHERE rn = 1;",
      ),
    );
  });

  it("keeps a long statement's clauses apart (#4850)", async () => {
    const sql = lines(
      "SELECT HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID, HIMMS_XDSBDJ.YNKE, himms_zwxsysj_sysj(V_HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID) AS SJSYSJ",
      "FROM HIMMS_XDSBDJ",
      "LEFT JOIN (SELECT himms_xdsbdj_id, MAX(SJ) SJ FROM himms_zwxqdjc GROUP BY himms_xdsbdj_id) SUB_QDJC ON HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID = SUB_QDJC.himms_xdsbdj_id",
      "WHERE HIMMS_XDSBDJ.tybz IS NULL;",
    );

    // The user-defined function is written without a space, and the join's
    // subquery expands rather than pushing `ON` onto a line of its own.
    expect(await format(sql)).toBe(
      lines(
        "SELECT HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID, HIMMS_XDSBDJ.YNKE, himms_zwxsysj_sysj(V_HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID) AS SJSYSJ",
        "FROM HIMMS_XDSBDJ",
        "    LEFT JOIN (SELECT himms_xdsbdj_id, MAX(SJ) SJ",
        "               FROM himms_zwxqdjc",
        "               GROUP BY himms_xdsbdj_id) SUB_QDJC ON HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID = SUB_QDJC.himms_xdsbdj_id",
        "WHERE HIMMS_XDSBDJ.tybz IS NULL;",
      ),
    );
  });

  it("collapses a statement that fits on one line (#5170)", async () => {
    const sql = lines("SELECT", "  *", "FROM", "  task", "ORDER BY", "  created_at DESC;");

    expect(await format(sql)).toBe("SELECT * FROM task ORDER BY created_at DESC;");
  });

  it("aligns CREATE TABLE columns", async () => {
    const sql = lines(
      "CREATE TABLE IF NOT EXISTS `delivery_emp_info`",
      "(",
      "  `id` varchar(20) PRIMARY KEY NOT NULL COMMENT '主键',",
      "  `emp_id` varchar(20) NOT NULL COMMENT '员工id',",
      "  `delivery_type_ids` varchar(512) DEFAULT NULL COMMENT '负责的运送类型id集合',",
      "  `update_time` datetime NOT NULL COMMENT '更新时间',",
      "  CONSTRAINT idx_emp_phone UNIQUE (emp_id, emp_phone_num) COMMENT '运送员id电话唯一'",
      ") ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin COMMENT '运达员信息表';",
    );

    // Name, type and modifiers each get their own column, so the definitions'
    // `COMMENT`s line up; the constraint's `(` keeps its space.
    expect(await format(sql)).toBe(
      lines(
        "CREATE TABLE IF NOT EXISTS `delivery_emp_info`",
        "(",
        "  `id`                varchar(20)  PRIMARY KEY NOT NULL COMMENT '主键',",
        "  `emp_id`            varchar(20)              NOT NULL COMMENT '员工id',",
        "  `delivery_type_ids` varchar(512)         DEFAULT NULL COMMENT '负责的运送类型id集合',",
        "  `update_time`       datetime                 NOT NULL COMMENT '更新时间',",
        "  CONSTRAINT idx_emp_phone UNIQUE (emp_id, emp_phone_num) COMMENT '运送员id电话唯一'",
        ") ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin COMMENT '运达员信息表';",
      ),
    );
  });

  it("keeps a call shaped like a call at any nesting depth", async () => {
    const sql = "INSERT INTO t (a, b) VALUES (f(x), g(y)) ON DUPLICATE KEY UPDATE b = f(g(b));";

    // The insert target's column list is spaced; the calls inside the values,
    // and inside another call's arguments, are not.
    expect(await format(sql)).toBe("INSERT INTO t (a, b) VALUES (f(x), g(y)) ON DUPLICATE KEY UPDATE b = f(g(b));");
  });

  it("breaks a long condition before each logical operator", async () => {
    const sql = "SELECT a, b FROM t WHERE alpha = 1 AND beta = 2 AND gamma = 3 AND delta = 4 AND epsilon = 5 AND zeta = 6 AND eta = 7 AND theta = 8;";

    // The statement is too long to collapse, and the default
    // `logicalOperatorNewline: "before"` starts each continuation line with the
    // operator, aligned under the condition's first operand like any other
    // clause item.
    expect(await format(sql)).toBe(lines("SELECT a, b", "FROM t", "WHERE alpha = 1", "      AND beta = 2", "      AND gamma = 3", "      AND delta = 4", "      AND epsilon = 5", "      AND zeta = 6", "      AND eta = 7", "      AND theta = 8;"));
  });

  it("puts a wrapped condition's operators where the setting asks", async () => {
    const sql = "SELECT a, b FROM t WHERE alpha = 1 AND beta = 2 AND gamma = 3 AND delta = 4 AND epsilon = 5 AND zeta = 6 AND eta = 7 AND theta = 8;";

    // `after` ends the previous line with the operator instead.
    expect(await format(sql, { logicalOperatorNewline: "after" })).toContain("WHERE alpha = 1 AND\n      beta = 2 AND");
    // `none` keeps the condition on the clause's line, however long it gets.
    expect(await format(sql, { logicalOperatorNewline: "none" })).toBe(lines("SELECT a, b", "FROM t", "WHERE alpha = 1 AND beta = 2 AND gamma = 3 AND delta = 4 AND epsilon = 5 AND zeta = 6 AND eta = 7 AND theta = 8;"));
  });

  it("expands a parenthesized list that does not fit, aligned under its first item", async () => {
    const sql = `SELECT * FROM t WHERE id IN (${Array.from({ length: 16 }, (_, index) => 100000 + index).join(", ")});`;

    expect(await format(sql)).toBe(
      lines(
        "SELECT *",
        "FROM t",
        "WHERE id IN (100000,",
        "             100001,",
        "             100002,",
        "             100003,",
        "             100004,",
        "             100005,",
        "             100006,",
        "             100007,",
        "             100008,",
        "             100009,",
        "             100010,",
        "             100011,",
        "             100012,",
        "             100013,",
        "             100014,",
        "             100015);",
      ),
    );
  });

  it("keeps a small subquery inline", async () => {
    expect(await format("SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE a = 1 AND b = 2);")).toBe("SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE a = 1 AND b = 2);");
  });

  it("collapses each clause independently", async () => {
    const sql = "SELECT (SELECT count(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS order_count, c.name FROM customers c;";

    // The scalar subquery fits, the select list does not: only the second one
    // breaks.
    expect(await format(sql)).toBe(lines("SELECT (SELECT count(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS order_count, c.name", "FROM customers c;"));
  });

  it("never joins a CASE onto one line", async () => {
    expect(await format("SELECT CASE WHEN a = 1 THEN 'one' WHEN a = 2 THEN 'two' ELSE 'other' END AS label FROM t;")).toBe(lines("SELECT CASE", "         WHEN a = 1 THEN 'one'", "         WHEN a = 2 THEN 'two'", "         ELSE 'other'", "       END AS label", "FROM t;"));
  });

  it("gives a set operation its own line", async () => {
    expect(await format("SELECT a FROM t UNION ALL SELECT b FROM u;")).toBe(lines("SELECT a", "FROM t", "UNION ALL", "SELECT b", "FROM u;"));
  });

  it("keeps comments and does not fold them onto a line", async () => {
    const sql = lines("-- heading", "SELECT a, -- why", "       b", "FROM t; /* trailing */");

    expect(await format(sql)).toBe(lines("-- heading", "SELECT a,", "       -- why", "       b", "FROM t;", "", "/* trailing */"));
  });

  it("keeps PostgreSQL casts tight", async () => {
    expect(await format("select coalesce(a, b)::text, (x + y)::int from t;", {}, "postgres")).toBe("SELECT coalesce(a, b)::text, (x + y)::int FROM t;");
  });

  it("keeps the comma of a MySQL LIMIT offset", async () => {
    expect(await format("SELECT a FROM t LIMIT 5, 10;", {}, "mysql")).toBe("SELECT a FROM t LIMIT 5, 10;");
  });

  it("indents with tabs when asked", async () => {
    const sql = "SELECT alpha_column, beta_column, gamma_column, delta_column FROM some_really_long_table_name WHERE first_condition = 1 AND second_condition = 2 AND third_condition = 3;";

    // Only the leading indentation becomes a tab; the alignment padding stays
    // spaces so a continuation column lands where it was measured.
    expect(await format(sql, { useTabs: true, tabWidth: 4 })).toBe(["SELECT alpha_column,", "\t   beta_column,", "\t   gamma_column,", "\t   delta_column", "FROM some_really_long_table_name", "WHERE first_condition = 1", "\t  AND second_condition = 2", "\t  AND third_condition = 3;"].join("\n"));
  });

  it("moves a FROM source to its own line when configured", async () => {
    const sql = "SELECT alpha_column, beta_column, gamma_column, delta_column FROM some_really_long_table_name WHERE first_condition = 1 AND second_condition = 2 AND third_condition = 3;";

    expect(await format(sql, { fromClauseLayout: "newLine" })).toBe(
      lines("SELECT alpha_column,", "       beta_column,", "       gamma_column,", "       delta_column", "FROM", "  some_really_long_table_name", "WHERE first_condition = 1", "      AND second_condition = 2", "      AND third_condition = 3;"),
    );
  });

  it("honours the blank lines between queries", async () => {
    const sql = "SELECT 1;\nSELECT 2;";

    expect(await format(sql, { linesBetweenQueries: 0 })).toBe(lines("SELECT 1;", "SELECT 2;"));
    expect(await format(sql, { linesBetweenQueries: 1 })).toBe(lines("SELECT 1;", "", "SELECT 2;"));
    expect(await format(sql, { linesBetweenQueries: 2 })).toBe(lines("SELECT 1;", "", "", "SELECT 2;"));
  });

  it("keeps a blank source line when the setting is on", async () => {
    expect(await format(lines("-- heading", "", "SELECT a FROM t;"), { preserveEmptyLines: true })).toBe(lines("-- heading", "", "SELECT a", "FROM t;"));
  });

  it("falls back to sql-formatter for the tabular indent styles", async () => {
    // The tabular layouts pad every clause to a fixed column; the default
    // layout rules do not reproduce them, so those settings keep the upstream
    // formatter.
    expect(await format("SELECT a, b FROM t WHERE x = 1;", { indentStyle: "tabularLeft" })).toBe(lines("SELECT    a,", "          b", "FROM      t", "WHERE     x = 1;"));
  });

  it("formats a dialect without its own grammar", async () => {
    expect(await format("select * from t where a = 1 and b = 2;", {}, "generic")).toBe("SELECT * FROM t WHERE a = 1 AND b = 2;");
  });
});
