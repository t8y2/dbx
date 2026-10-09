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
    // Expanded subqueries use the same one-field-per-line rule as the outer
    // SELECT, while their clauses remain aligned under the opening parenthesis.
    expect(await format(sql)).toBe(
      lines(
        "SELECT loc_id,",
        "       loc_name,",
        "       loc_type,",
        "       delivery_emp_num,",
        "       update_time",
        "FROM (SELECT *,",
        "             ROW_NUMBER() OVER (PARTITION BY loc_id ORDER BY update_time DESC) AS rn",
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
        "SELECT HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID,",
        "       HIMMS_XDSBDJ.YNKE,",
        "       himms_zwxsysj_sysj(V_HIMMS_XDSBDJ.HIMMS_XDSBDJ_ID) AS SJSYSJ",
        "FROM HIMMS_XDSBDJ",
        "    LEFT JOIN (SELECT himms_xdsbdj_id,",
        "                      MAX(SJ) SJ",
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
    expect(await format(sql)).toBe(lines("SELECT a,", "       b", "FROM t", "WHERE alpha = 1", "      AND beta = 2", "      AND gamma = 3", "      AND delta = 4", "      AND epsilon = 5", "      AND zeta = 6", "      AND eta = 7", "      AND theta = 8;"));
  });

  it("puts a wrapped condition's operators where the setting asks", async () => {
    const sql = "SELECT a, b FROM t WHERE alpha = 1 AND beta = 2 AND gamma = 3 AND delta = 4 AND epsilon = 5 AND zeta = 6 AND eta = 7 AND theta = 8;";

    // `after` ends the previous line with the operator instead.
    expect(await format(sql, { logicalOperatorNewline: "after" })).toContain("WHERE alpha = 1 AND\n      beta = 2 AND");
    // `none` keeps the condition on the clause's line, however long it gets.
    expect(await format(sql, { logicalOperatorNewline: "none" })).toBe(lines("SELECT a,", "       b", "FROM t", "WHERE alpha = 1 AND beta = 2 AND gamma = 3 AND delta = 4 AND epsilon = 5 AND zeta = 6 AND eta = 7 AND theta = 8;"));
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

    // The scalar subquery stays compact within its own SELECT field.
    expect(await format(sql)).toBe(lines("SELECT (SELECT count(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS order_count,", "       c.name", "FROM customers c;"));
  });

  it("keeps a CASE expression compact (#10783)", async () => {
    expect(await format("SELECT CASE WHEN a = 1 THEN 'one' WHEN a = 2 THEN 'two' ELSE 'other' END AS label FROM t;")).toBe("SELECT CASE WHEN a = 1 THEN 'one' WHEN a = 2 THEN 'two' ELSE 'other' END AS label FROM t;");
  });

  it("puts each SELECT field on its own line even in a short query (#10783)", async () => {
    expect(await format("SELECT id, CASE WHEN a = 1 THEN 'one' ELSE 'other' END AS label, coalesce(a, b) FROM t;")).toBe(lines("SELECT id,", "       CASE WHEN a = 1 THEN 'one' ELSE 'other' END AS label,", "       coalesce(a, b)", "FROM t;"));
  });

  it("puts fields on separate lines when SELECT has a modifier (#10783)", async () => {
    expect(await format("SELECT DISTINCT a, b FROM t;")).toBe(lines("SELECT DISTINCT a,", "                b", "FROM t;"));
    expect(await format("SELECT DISTINCT ON (key) a, b FROM t;")).toBe(lines("SELECT DISTINCT ON (KEY) a,", "                b", "FROM t;"));
  });

  it("keeps nested and simple CASE expressions compact", async () => {
    const sql = "SELECT SUM(CASE WHEN a = 1 AND b = 2 THEN 1 ELSE 0 END) AS total, CASE a WHEN 1 THEN CASE b WHEN 2 THEN 'x  y' END ELSE 'other' END AS label FROM t;";
    const expected = lines("SELECT SUM(CASE WHEN a = 1 AND b = 2 THEN 1 ELSE 0 END)                  AS total,", "       CASE a WHEN 1 THEN CASE b WHEN 2 THEN 'x  y' END ELSE 'other' END AS label", "FROM t;");
    expect(await format(sql)).toBe(expected);
    expect(await format(expected)).toBe(expected);
  });

  it("falls back to unaligned fields when an aligned alias would overflow the line width", async () => {
    // Alignment pads every alias to one column past the widest expression, so
    // the short expression's long alias lands exactly at the 120-column width;
    // one more character and the whole list keeps the plain one-space layout.
    const fitting = `SELECT ${"a".repeat(60)} AS total, ${"b".repeat(30)} AS ${"y".repeat(49)} FROM t;`;
    expect(await format(fitting)).toBe(lines(`SELECT ${"a".repeat(60)} AS total,`, `       ${"b".repeat(30)}${" ".repeat(31)}AS ${"y".repeat(49)}`, "FROM t;"));

    const overflowing = `SELECT ${"a".repeat(60)} AS total, ${"b".repeat(30)} AS ${"y".repeat(50)} FROM t;`;
    expect(await format(overflowing)).toBe(lines(`SELECT ${"a".repeat(60)} AS total,`, `       ${"b".repeat(30)} AS ${"y".repeat(50)}`, "FROM t;"));
  });

  it("keeps an unaliased field plain while the aliased ones align", async () => {
    expect(await format("SELECT a, b AS x, c AS yyy FROM t;")).toBe(lines("SELECT a,", "       b AS x,", "       c AS yyy", "FROM t;"));

    // The alignment column comes from the aliased expressions only, so the
    // bare field stays untouched beside the padded aliases.
    expect(await format("SELECT a, bb AS x, c AS yyy FROM t;")).toBe(lines("SELECT a,", "       bb AS x,", "       c  AS yyy", "FROM t;"));
  });

  it("preserves comments and width wrapping inside CASE expressions", async () => {
    const commented = await format(lines("SELECT id, CASE WHEN a = 1 THEN 'one' -- retain this", "ELSE 'other' END AS label FROM t;"));
    expect(commented).toContain("-- retain this\n");
    expect(commented).toContain("ELSE 'other'");
    expect(await format(commented)).toBe(commented);

    const longCase = await format(`SELECT id, CASE WHEN a = 1 THEN '${"x".repeat(100)}' ELSE 'other' END AS label FROM t;`);
    expect(longCase).toContain("CASE\n");
    expect(longCase).toContain("END AS label");
    expect(await format(longCase)).toBe(longCase);
  });

  it("gives a set operation its own line", async () => {
    expect(await format("SELECT a FROM t UNION ALL SELECT b FROM u;")).toBe(lines("SELECT a", "FROM t", "UNION ALL", "SELECT b", "FROM u;"));
  });

  it("keeps comments and does not fold them onto a line", async () => {
    const sql = lines("-- heading", "SELECT a, -- why", "       b", "FROM t; /* trailing */");

    expect(await format(sql)).toBe(lines("-- heading", "SELECT a,", "       -- why", "       b", "FROM t;", "", "/* trailing */"));
  });

  it("keeps PostgreSQL casts tight", async () => {
    expect(await format("select coalesce(a, b)::text, (x + y)::int from t;", {}, "postgres")).toBe(lines("SELECT coalesce(a, b)::text,", "       (x + y)::int", "FROM t;"));
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

  it("keeps every branch of a union whose operands are parenthesized (#10472)", async () => {
    const sql = lines(
      "SELECT a.id, a.starttime, t.name AS taskName",
      "FROM ( (SELECT l.id, l.starttime FROM `log_1_4` l WHERE l.taskid = 'abc' ORDER BY l.starttime DESC LIMIT 0, 10)",
      "UNION ALL (SELECT l.id, l.starttime FROM `log_2_4` l WHERE l.taskid = 'abc' ORDER BY l.starttime DESC LIMIT 0, 10)",
      "UNION ALL (SELECT l.id, l.starttime FROM `log_3_4` l WHERE l.taskid = 'abc' ORDER BY l.starttime DESC LIMIT 0, 10) ) a",
      "INNER JOIN task t ON a.taskid = t.id WHERE 1 = 1 ORDER BY a.starttime DESC LIMIT 0, 10",
    );

    // A bare `SELECT` after the operator becomes a sibling clause, but a
    // parenthesized branch stays inside the set-operation node. Printing the
    // keyword alone deleted every branch after the first one.
    expect(await format(sql)).toBe(
      lines(
        "SELECT a.id,",
        "       a.starttime,",
        "       t.name AS taskName",
        "FROM ((SELECT l.id, l.starttime FROM `log_1_4` l WHERE l.taskid = 'abc' ORDER BY l.starttime DESC LIMIT 0, 10)",
        "      UNION ALL",
        "      (SELECT l.id, l.starttime FROM `log_2_4` l WHERE l.taskid = 'abc' ORDER BY l.starttime DESC LIMIT 0, 10)",
        "      UNION ALL",
        "      (SELECT l.id, l.starttime FROM `log_3_4` l WHERE l.taskid = 'abc' ORDER BY l.starttime DESC LIMIT 0, 10)) a",
        "    INNER JOIN task t ON a.taskid = t.id",
        "WHERE 1 = 1",
        "ORDER BY a.starttime DESC",
        "LIMIT 0, 10",
      ),
    );
  });

  it("drops no branch of a long parenthesized union chain (#10472)", async () => {
    const branches = Array.from({ length: 12 }, (_, index) => `SELECT l.id, l.payload FROM log_${index + 1}_4 l WHERE l.taskid = 'abc' AND l.ytenant_id = '0000MEJRT61ACN8QOZ0000' ORDER BY l.starttime DESC LIMIT 0, 10`);
    const sql = `SELECT a.id FROM ( ${branches.map((branch) => `(${branch})`).join(" UNION ALL ")} ) a`;

    const formatted = await format(sql);

    for (let index = 0; index < branches.length; index += 1) expect(formatted).toContain(`log_${index + 1}_4`);
    expect(formatted.match(/UNION ALL/g)).toHaveLength(branches.length - 1);
    expect(formatted.match(/0000MEJRT61ACN8QOZ0000/g)).toHaveLength(branches.length);
  });

  it("formats a dialect without its own grammar", async () => {
    expect(await format("select * from t where a = 1 and b = 2;", {}, "generic")).toBe("SELECT * FROM t WHERE a = 1 AND b = 2;");
  });

  it("formats a query with leading comma position (#7723, #5110)", async () => {
    const sql = lines("SELECT loc_id, loc_name, loc_type, delivery_emp_num, update_time", "FROM tbl", "WHERE rn = 1;");

    expect(await format(sql, { commaPosition: "before" })).toBe(lines("SELECT loc_id", "     , loc_name", "     , loc_type", "     , delivery_emp_num", "     , update_time", "FROM tbl", "WHERE rn = 1;"));
  });

  it("formats aligned projection aliases with leading commas", async () => {
    const sql = lines("SELECT id AS emp_id, department_name AS dept, active_status AS status", "FROM employees;");

    expect(await format(sql, { commaPosition: "before" })).toBe(lines("SELECT id              AS emp_id", "     , department_name AS dept", "     , active_status   AS status", "FROM employees;"));
  });

  it("formats CREATE TABLE with leading commas in DDL", async () => {
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

    expect(await format(sql, { commaPosition: "before" })).toBe(
      lines(
        "CREATE TABLE IF NOT EXISTS `delivery_emp_info`",
        "(",
        "    `id`                varchar(20)  PRIMARY KEY NOT NULL COMMENT '主键'",
        "  , `emp_id`            varchar(20)              NOT NULL COMMENT '员工id'",
        "  , `delivery_type_ids` varchar(512)         DEFAULT NULL COMMENT '负责的运送类型id集合'",
        "  , `update_time`       datetime                 NOT NULL COMMENT '更新时间'",
        "  , CONSTRAINT idx_emp_phone UNIQUE (emp_id, emp_phone_num) COMMENT '运送员id电话唯一'",
        ") ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin COMMENT '运达员信息表';",
      ),
    );
  });

  it("preserves keyword case when keywordCase is preserve (#11382)", async () => {
    const sql = lines("select id as emp_id, name as emp_name", "from employees", "where status = 1 and dept = 'sales'", "order by id desc", "limit 10;");
    expect(await format(sql, { keywordCase: "preserve" })).toBe(lines("select id   as emp_id,", "       name as emp_name", "from employees", "where status = 1", "      and dept = 'sales'", "order by id desc", "limit 10;"));
  });

  it("converts keyword case to lower when keywordCase is lower (#11382)", async () => {
    const sql = lines("SELECT id AS emp_id, name AS emp_name", "FROM employees", "WHERE status = 1 AND dept = 'sales'", "ORDER BY id DESC", "LIMIT 10;");
    expect(await format(sql, { keywordCase: "lower" })).toBe(lines("select id   as emp_id,", "       name as emp_name", "from employees", "where status = 1", "      and dept = 'sales'", "order by id desc", "limit 10;"));
  });

  it("preserves keyword case in join, union, case expression and ddl (#11382)", async () => {
    const joinSql = "select a.id from t1 left join t2 on t1.id = t2.id;";
    expect(await format(joinSql, { keywordCase: "preserve" })).toBe(lines("select a.id", "from t1", "    left join t2 on t1.id = t2.id;"));

    const unionSql = lines("select 1", "union all", "select 2;");
    expect(await format(unionSql, { keywordCase: "preserve" })).toBe(lines("select 1", "union all", "select 2;"));

    const caseSql = "select case when a = 1 then 'one' else 'other' end as val from t;";
    expect(await format(caseSql, { keywordCase: "preserve" })).toBe("select case when a = 1 then 'one' else 'other' end as val from t;");

    const ddlSql = "create table test (id int, name varchar(255));";
    expect(await format(ddlSql, { keywordCase: "preserve" })).toBe("create table test (id int, name varchar(255));");
  });
});
