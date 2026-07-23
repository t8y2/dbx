import { describe, expect, it } from "vitest";
import { buildExecutionCandidates, currentExecutableStatementRange, executableStatementRanges, fullSqlRange, hasMultipleExecutionTargets, splitSqlStatementRanges, statementRangeAtCursor, supportsExecutionTargetPicker } from "@/lib/sql/sqlStatementRanges";

function indexOf(sql: string, needle: string, occurrence = 1): number {
  let from = 0;
  let idx = -1;
  for (let i = 0; i < occurrence; i += 1) {
    idx = sql.indexOf(needle, from);
    if (idx === -1) return -1;
    from = idx + needle.length;
  }
  return idx;
}

function rangeSqlTexts(ranges: Array<{ sql: string }>): string[] {
  return ranges.map((range) => range.sql.trim());
}

function candidateKinds(candidates: Array<{ kind: string }>): string[] {
  return candidates.map((candidate) => candidate.kind);
}

function candidateLabels(candidates: Array<{ label: string }>): string[] {
  return candidates.map((candidate) => candidate.label);
}

function candidateSummaries(candidates: Array<{ kind: string; sql: string }>): string[] {
  return candidates.map((candidate) => `${candidate.kind}:${candidate.sql.trim()}`);
}

const oraclePlSqlFixture = `DECLARE
  v_order_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_order_count
  FROM "DBX_TEST"."ORDERS_10K";

  IF v_order_count = 0 THEN
    INSERT INTO "DBX_TEST"."STORES"
      ("ID", "STORE_CODE", "STORE_NAME", "CITY", "OPENED_AT")
    SELECT 10001, 'TEST_STORE_001', '测试门店', '上海', SYSDATE
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DBX_TEST"."STORES" WHERE "ID" = 10001
    );

    INSERT INTO "DBX_TEST"."PRODUCTS"
      ("ID", "SKU", "PRODUCT_NAME", "CATEGORY", "PRICE")
    SELECT 10001, 'TEST_SKU_001', '测试商品', '测试分类', 99.90
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DBX_TEST"."PRODUCTS" WHERE "ID" = 10001
    );

    INSERT INTO "DBX_TEST"."ORDERS_10K"
      ("ID", "ORDER_NO", "STORE_ID", "PRODUCT_ID", "CUSTOMER_NAME", "QUANTITY", "AMOUNT", "ORDER_STATUS", "CREATED_AT")
    SELECT 10001, 'TEST_ORDER_001', 10001, 10001, '测试客户', 2, 199.80, 'PAID', SYSDATE
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DBX_TEST"."ORDERS_10K" WHERE "ORDER_NO" = 'TEST_ORDER_001'
    );

    COMMIT;
  END IF;
END;
/
SELECT 1;`;

const oracleIssue2405PlSql = `DECLARE
   PRE_TRD_DATE   INTEGER ;
BEGIN
   SELECT 1 + 2 INTO PRE_TRD_DATE FROM DUAL;
END;`;

const gaussDbNestedProcedure = `CREATE OR REPLACE PROCEDURE public.dbx_issue_4318()
AS
BEGIN
  BEGIN
    NULL;
  END;
  NULL;
END;`;

const mysqlRoutineFixture = `CREATE PROCEDURE p()
BEGIN
  SELECT 1;
  IF 1 = 1 THEN
    SELECT 'ok';
  END IF;
END;
SELECT 2;`;

const mysqlRoutineWithLoopsFixture = `CREATE PROCEDURE p_loop()
BEGIN
  WHILE 1 = 0 DO
    SELECT 'while; still body';
  END WHILE;
  REPEAT
    SELECT 'repeat; still body';
  UNTIL 1 = 1 END REPEAT;
END;
SELECT 2;`;

const mysqlDelimitedRoutineFixture = `DELIMITER //
CREATE PROCEDURE sp_insert_random_users(IN p_count INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE v_name VARCHAR(32);

  WHILE i < p_count DO
    SET v_name = CONCAT('user_', i);
    INSERT INTO t_user (username) VALUES (v_name);
    SET i = i + 1;
  END WHILE;
END //
DELIMITER ;

CALL sp_insert_random_users(100);`;

const sapHanaDoBlockFixture = `DO
BEGIN
  SELECT 1 AS "Result" FROM DUMMY;
END;
SELECT 2 FROM DUMMY;`;

describe("splitSqlStatementRanges", () => {
  it("splits multiple top-level statements", () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("keeps a trailing statement without a semicolon", () => {
    const sql = "SELECT 1;\nSELECT 2";
    const ranges = splitSqlStatementRanges(sql);
    expect(rangeSqlTexts(ranges)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    const sql = "INSERT INTO t VALUES ('a;b;c');\nSELECT 1";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["INSERT INTO t VALUES ('a;b;c')", "SELECT 1"]);
  });

  it("handles doubled single quotes as escaped quotes", () => {
    const sql = "SELECT 'it''s; ok';\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 'it''s; ok'", "SELECT 2"]);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    const sql = 'SELECT "a;b";\nSELECT 2';
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(['SELECT "a;b"', "SELECT 2"]);
  });

  it("ignores semicolons inside backtick identifiers (MySQL)", () => {
    const sql = "SELECT `a;b`;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT `a;b`", "SELECT 2"]);
  });

  it("ignores semicolons inside bracket identifiers (SQL Server)", () => {
    const sql = "SELECT [a;b];\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT [a;b]", "SELECT 2"]);
  });

  it("ignores semicolons in line comments", () => {
    const sql = "SELECT 1 -- a; b\n;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons in hash line comments", () => {
    const sql = "SELECT 1 # a; b\n;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons in block comments", () => {
    const sql = "SELECT /* a; b */ 1;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT /* a; b */ 1", "SELECT 2"]);
  });

  it("handles Postgres dollar quoting", () => {
    const sql = "SELECT $$ a; b $$;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT $$ a; b $$", "SELECT 2"]);
  });

  it("skips MySQL delimiter commands and empty custom delimiter statements", () => {
    const sql = "select COUNT(1) FROM your_table;\ndelimiter ;;\nselect COUNT(1) FROM your_table;\n\n;;\ndelimiter ;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "mysql"))).toEqual(["select COUNT(1) FROM your_table", "select COUNT(1) FROM your_table;"]);
  });

  it("keeps MySQL routine blocks together without delimiter commands", () => {
    const ranges = splitSqlStatementRanges(mysqlRoutineFixture, "mysql");
    expect(rangeSqlTexts(ranges)).toEqual([mysqlRoutineFixture.slice(0, mysqlRoutineFixture.indexOf("\nSELECT 2;")).replace(/;$/, "").trim(), "SELECT 2"]);
    expect(ranges[0].sql).toContain("SELECT 1;");
    expect(ranges[0].sql).toContain("END IF;");
    expect(ranges[0].sql).not.toMatch(/END;$/);
  });

  it("does not merge regular MySQL transaction statements as routine blocks", () => {
    const sql = "BEGIN; INSERT INTO t VALUES (1); COMMIT;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "mysql"))).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
  });

  it("treats SQL Server GO lines as batch delimiters", () => {
    const sql = "SELECT 1\nGO\nSELECT 2;\n  GO 2\nSELECT 3";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "sqlserver"))).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("does not treat GO inside strings or comments as a SQL Server batch delimiter", () => {
    const sql = "SELECT 'GO'\n-- GO\nSELECT 2\nGO\nSELECT 3";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "sqlserver"))).toEqual(["SELECT 'GO'\n-- GO\nSELECT 2", "SELECT 3"]);
  });

  it("keeps Oracle PL/SQL blocks together and treats slash lines as delimiters", () => {
    const ranges = splitSqlStatementRanges(oraclePlSqlFixture, "oracle");
    expect(rangeSqlTexts(ranges)).toEqual([oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")), "SELECT 1"]);
    expect(ranges[0].sql).toContain("v_order_count NUMBER;");
    expect(ranges[0].sql).toContain("END;");
    expect(ranges[0].sql).not.toContain("\n/");
  });

  it("keeps issue #2405 Oracle PL/SQL block together without a slash delimiter", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges(oracleIssue2405PlSql, "oracle"))).toEqual([oracleIssue2405PlSql]);
  });

  it("keeps nested GaussDB procedure blocks together", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges(gaussDbNestedProcedure, "gaussdb"))).toEqual([gaussDbNestedProcedure]);
  });

  it("keeps SAP HANA DO blocks together", () => {
    const ranges = splitSqlStatementRanges(sapHanaDoBlockFixture, "saphana");

    expect(rangeSqlTexts(ranges)).toEqual([sapHanaDoBlockFixture.slice(0, sapHanaDoBlockFixture.indexOf("\nSELECT 2")), "SELECT 2 FROM DUMMY"]);
    expect(ranges[0].sql).toContain('SELECT 1 AS "Result" FROM DUMMY;');
    expect(ranges[0].sql).toContain("END;");
  });
});

describe("statementRangeAtCursor", () => {
  it("splits Elasticsearch REST requests without semicolons", () => {
    const sql = `# node information
GET /_nodes/stats/jvm?pretty

// search orders
POST /orders/_search
{
  "query": { "match_all": {} }
}

HEAD /orders`;

    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "elasticsearch"))).toEqual(["GET /_nodes/stats/jvm?pretty", 'POST /orders/_search\n{\n  "query": { "match_all": {} }\n}', "HEAD /orders"]);
    expect(hasMultipleExecutionTargets(sql, "elasticsearch")).toBe(true);
  });

  it("targets the Elasticsearch request following a comment", () => {
    const sql = "# JVM statistics\nGET /_nodes/stats/jvm?pretty\n\nGET /_cluster/health";

    expect(statementRangeAtCursor(sql, indexOf(sql, "JVM"), "elasticsearch")?.sql).toBe("GET /_nodes/stats/jvm?pretty");
    expect(statementRangeAtCursor(sql, indexOf(sql, "cluster"), "elasticsearch")?.sql).toBe("GET /_cluster/health");
  });

  it("splits and targets Elasticsearch requests after block comments", () => {
    const sql = `/* node information
   including JVM details */
GET /_nodes/stats/jvm?pretty

/* cluster information */
GET /_cluster/health`;

    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "elasticsearch"))).toEqual(["GET /_nodes/stats/jvm?pretty", "GET /_cluster/health"]);
    expect(statementRangeAtCursor(sql, indexOf(sql, "JVM details"), "elasticsearch")?.sql).toBe("GET /_nodes/stats/jvm?pretty");
    expect(statementRangeAtCursor(sql, indexOf(sql, "cluster information"), "elasticsearch")?.sql).toBe("GET /_cluster/health");
  });

  it("ignores request-looking lines inside Elasticsearch block comments", () => {
    const sql = `GET /_cluster/health

/* disabled cleanup
DELETE /important-index
*/
GET /_cat/indices`;

    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "elasticsearch"))).toEqual(["GET /_cluster/health", "GET /_cat/indices"]);
    expect(statementRangeAtCursor(sql, indexOf(sql, "important-index"), "elasticsearch")?.sql).toBe("GET /_cat/indices");
  });

  it("returns the first statement when the cursor is inside it", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const pos = indexOf(sql, "1");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the second statement when the cursor is inside it", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const pos = indexOf(sql, "2");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns the statement when the cursor is in indentation before it", () => {
    const sql = "SELECT 1;\n    SELECT 2;";
    const indentationPos = sql.indexOf("    SELECT 2") + 2;
    const range = statementRangeAtCursor(sql, indentationPos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns the previous statement when the cursor is in same-line whitespace after its semicolon", () => {
    const sql = "SELECT 1;   SELECT 2;";
    const gapPos = sql.indexOf(";") + 2;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the previous statement when the cursor is just after its semicolon before a later statement", () => {
    const sql = "SELECT *\nFROM system_dept;\n\nSELECT *\nFROM sys;";
    const gapPos = sql.indexOf(";") + 1;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT *\nFROM system_dept");
  });

  it("keeps a semicolon-line-end cursor on the current multi-line statement", () => {
    const sql = "SELECT *\nFROM system_dept;";
    const gapPos = sql.indexOf(";") + 1;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT *\nFROM system_dept");
  });

  it("returns the next same-line statement when the cursor is inside it", () => {
    const sql = "SELECT 1;   SELECT 2;";
    const pos = indexOf(sql, "SELECT 2") + 1;
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns a statement even without a trailing semicolon", () => {
    const sql = "SELECT 1";
    const pos = indexOf(sql, "1");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("stops at the next top-level statement start when the cursor statement has no semicolon", () => {
    const sql = "SELECT 1\nSELECT 2;\nSELECT 3;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the later top-level statement when earlier statements are missing semicolons", () => {
    const sql = "SELECT 1\nSELECT 2;\nSELECT 3;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "2"));
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("keeps newline set-operation SELECT operands with the cursor statement", () => {
    const sql = "select * from tbA\nunion\nselect * from tbB";
    const expected = "select * from tbA\nunion\nselect * from tbB";

    expect(statementRangeAtCursor(sql, indexOf(sql, "tbA"))?.sql.trim()).toBe(expected);
    expect(statementRangeAtCursor(sql, indexOf(sql, "tbB"))?.sql.trim()).toBe(expected);
  });

  it("keeps newline set-operation operands with ALL modifiers together", () => {
    const sql = "select * from tbA\nunion all\nselect * from tbB\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "tbA"));

    expect(range?.sql.trim()).toBe("select * from tbA\nunion all\nselect * from tbB");
  });

  it("keeps a multi-line select together when continuation lines do not start statements", () => {
    const sql = "SELECT id,\n  name\nFROM users\nWHERE active = 1\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "name"));
    expect(range?.sql.trim()).toBe("SELECT id,\n  name\nFROM users\nWHERE active = 1");
  });

  it("keeps a CTE main query with its WITH statement", () => {
    const sql = "WITH active_users AS (\n  SELECT * FROM users\n)\nSELECT * FROM active_users\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "active_users", 2));
    expect(range?.sql.trim()).toBe("WITH active_users AS (\n  SELECT * FROM users\n)\nSELECT * FROM active_users");
  });

  it("keeps update assignments with the UPDATE statement", () => {
    const sql = "UPDATE users\nSET name = 'a'\nWHERE id = 1\nSELECT * FROM users;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "name"));
    expect(range?.sql.trim()).toBe("UPDATE users\nSET name = 'a'\nWHERE id = 1");
  });

  it("keeps MySQL ALTER TABLE column comments with the column definition", () => {
    const sql =
      "ALTER TABLE `yb_course_order`\n  ADD COLUMN `audit_status` tinyint(4) DEFAULT NULL\n    COMMENT '审核状态：0-待审核，1-已通过，2-已拒绝',\n  ADD COLUMN `close_reason` varchar(30) DEFAULT NULL\n    COMMENT '关闭原因：timeout-超时关闭，cancel-取消关闭，refund-退款关闭',\n  ADD COLUMN `paid_completion_time` datetime DEFAULT NULL\n    COMMENT '订单完成支付(付清)时间 首次全额支付完成时记录，全部退款后不重置';";

    expect(statementRangeAtCursor(sql, indexOf(sql, "ALTER"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "close_reason"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL CREATE TABLE options with table comments", () => {
    const sql = `CREATE TABLE test_1 (
  id bigint NOT NULL AUTO_INCREMENT COMMENT '主键id',
  deleted tinyint NOT NULL DEFAULT 0 COMMENT '删除标志(0:有效 1：无效)',
  locked tinyint NOT NULL DEFAULT 0 COMMENT '是否锁定(0.否,1.是)',
  version int NOT NULL DEFAULT 0 COMMENT '版本号',
  creatorId bigint DEFAULT NULL COMMENT '创建人ID',
  createBy varchar(100) DEFAULT NULL COMMENT '创建人名称',
  createdTime timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updaterId bigint DEFAULT NULL COMMENT '修改人ID',
  updatedBy varchar(100) DEFAULT NULL COMMENT '修改人名称',
  updatedTime timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (id)
)
ENGINE = INNODB,
CHARACTER SET utf8mb4,
COLLATE utf8mb4_general_ci,
COMMENT = '测试';`;

    expect(statementRangeAtCursor(sql, indexOf(sql, "CREATE"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "COMMENT ="), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
    expect(statementRangeAtCursor(sql, indexOf(sql, "COMMENT ="))?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL CREATE TABLE comments without equals as table options", () => {
    const sql = "CREATE TABLE test_2 (\n  id bigint NOT NULL\n)\nCOMMENT '测试';";

    expect(statementRangeAtCursor(sql, indexOf(sql, "COMMENT"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
    expect(statementRangeAtCursor(sql, indexOf(sql, "COMMENT"))?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("does not merge standard COMMENT ON statements into preceding CREATE TABLE statements", () => {
    const sql = "CREATE TABLE users (id int)\nCOMMENT ON TABLE users IS 'Users';";

    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual(["CREATE TABLE users (id int)", "COMMENT ON TABLE users IS 'Users'"]);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual(["CREATE TABLE users (id int)", "COMMENT ON TABLE users IS 'Users'"]);
  });

  it("keeps a line-start comment column inside a select projection", () => {
    const sql = "SELECT\n  id,\n  comment,\n  created_at\nFROM project_info\nWHERE deleted = 0;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "comment"))?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL ALTER TABLE drop column clauses with the statement", () => {
    const sql = "ALTER TABLE t\n  DROP COLUMN a,\n  DROP COLUMN b;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "ALTER"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "DROP COLUMN b"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL ALTER TABLE alter column clauses with the statement", () => {
    const sql = "ALTER TABLE t\n  ALTER COLUMN name SET NOT NULL;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "ALTER"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "ALTER COLUMN"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL ALTER TABLE truncate partition clauses with the statement", () => {
    const sql = "ALTER TABLE ems.r_r_curve_e_hour\nTRUNCATE PARTITION p202602, p202603, p202604, p202605, p202606;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "ALTER"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "TRUNCATE"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL truncate partition clauses when comments separate ALTER TABLE", () => {
    const sql = "ALTER /* online ddl */ TABLE t\nTRUNCATE PARTITION p0;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "TRUNCATE"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL truncate partition clauses when comments precede PARTITION", () => {
    const sql = "ALTER TABLE t\nTRUNCATE /* keep */ PARTITION p0;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "TRUNCATE"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps standalone truncate table statements separate from preceding alter statements", () => {
    const sql = "ALTER TABLE events ADD COLUMN source varchar(100)\nTRUNCATE TABLE events;";

    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual(["ALTER TABLE events ADD COLUMN source varchar(100)", "TRUNCATE TABLE events"]);
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual(["ALTER TABLE events ADD COLUMN source varchar(100)", "TRUNCATE TABLE events"]);
  });

  it("keeps issue #4045 ClickHouse ALTER TABLE UPDATE mutation together", () => {
    const sql = `ALTER TABLE m2_db.history_data5
UPDATE value = 14.06
WHERE uuid IN (
    SELECT uuid
    FROM m2_db.pt_uuid_mapping
    WHERE point_id = 'TEST_Location_1_L2_METER_2_AE_DIFF_H'
)
AND ts = toDateTime('2026-07-15 12:00:00');`;

    expect(statementRangeAtCursor(sql, indexOf(sql, "ALTER"), "clickhouse")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "UPDATE"), "clickhouse")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "clickhouse"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps a simple ClickHouse ALTER TABLE UPDATE mutation together", () => {
    const sql = "ALTER TABLE `events` ON CLUSTER 'analytics'\nUPDATE value = 1\nWHERE id = 42;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "UPDATE"), "clickhouse")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "clickhouse"))).toEqual([sql.slice(0, -1)]);
  });

  it("separates statements after a ClickHouse ALTER TABLE UPDATE mutation", () => {
    const mutation = "ALTER TABLE events\nUPDATE value = 1\nWHERE id = 42";
    const sql = `${mutation};\nSELECT * FROM events;\nUPDATE audit SET processed = 1;`;

    expect(rangeSqlTexts(executableStatementRanges(sql, "clickhouse"))).toEqual([mutation, "SELECT * FROM events", "UPDATE audit SET processed = 1"]);
  });

  it("does not merge independent UPDATE statements into other ALTER statements", () => {
    const otherDatabaseSql = "ALTER TABLE events\nUPDATE audit SET processed = 1;";
    const clickHouseSql = "ALTER TABLE events ADD COLUMN source String\nUPDATE audit SET processed = 1;";

    expect(rangeSqlTexts(executableStatementRanges(otherDatabaseSql, "postgres"))).toEqual(["ALTER TABLE events", "UPDATE audit SET processed = 1"]);
    expect(rangeSqlTexts(executableStatementRanges(otherDatabaseSql, "mysql"))).toEqual(["ALTER TABLE events", "UPDATE audit SET processed = 1"]);
    expect(rangeSqlTexts(executableStatementRanges(clickHouseSql, "clickhouse"))).toEqual(["ALTER TABLE events ADD COLUMN source String", "UPDATE audit SET processed = 1"]);
  });

  it("keeps insert-select with the INSERT statement", () => {
    const sql = "INSERT INTO archived_users (id, name)\nSELECT id, name FROM users\nUPDATE users SET archived = 1;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "archived_users"));
    expect(range?.sql.trim()).toBe("INSERT INTO archived_users (id, name)\nSELECT id, name FROM users");
  });

  it("keeps explain target SQL with the EXPLAIN statement", () => {
    const sql = "EXPLAIN\nSELECT * FROM users\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"));
    expect(range?.sql.trim()).toBe("EXPLAIN\nSELECT * FROM users");
  });

  it("keeps issue #3567 EXPLAIN options and CTE target as one statement", () => {
    const sql = "explain (analyze,buffers)\nwith tmp as(select* from test.tt)\nselect * from tmp;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "explain"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "select * from tmp"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps EXPLAIN ANALYZE with a CTE main query as one statement", () => {
    const sql = "explain analyze\nwith tmp as (select 1)\nselect * from tmp;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "explain"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps a plain EXPLAIN CTE target as one statement without merging later queries", () => {
    const sql = "EXPLAIN\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp\nSELECT * FROM logs;";
    const expected = "EXPLAIN\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"))?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([expected, "SELECT * FROM logs"]);
  });

  it("does not merge a query after an inline EXPLAIN options CTE statement", () => {
    const sql = "EXPLAIN (ANALYZE) WITH tmp AS (SELECT 1)\nSELECT * FROM tmp\nSELECT 2;";
    const expected = "EXPLAIN (ANALYZE) WITH tmp AS (SELECT 1)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"), "postgres")?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([expected, "SELECT 2"]);
  });

  it("keeps EXPLAIN options CTE UPDATE assignments as one statement", () => {
    const sql = "EXPLAIN (ANALYZE)\nWITH tmp AS (SELECT 1)\nUPDATE t\nSET x = 1;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "SET"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps CTE INSERT ... SELECT with the WITH statement", () => {
    const sql = "WITH tmp AS (SELECT 1)\nINSERT INTO t (id)\nSELECT * FROM tmp;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "INSERT"))?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("does not merge a query after a CTE INSERT ... SELECT statement", () => {
    const sql = "WITH tmp AS (SELECT 1)\nINSERT INTO t (id)\nSELECT * FROM tmp\nSELECT 2;";
    const expected = "WITH tmp AS (SELECT 1)\nINSERT INTO t (id)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "INSERT"))?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([expected, "SELECT 2"]);
  });

  it("does not merge a query after an INSERT with a CTE source query", () => {
    const sql = "INSERT INTO t (id)\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp\nSELECT 2;";
    const expected = "INSERT INTO t (id)\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "INSERT"))?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([expected, "SELECT 2"]);
  });

  it("skips block comments inside EXPLAIN options when resolving the target", () => {
    const sql = "EXPLAIN (ANALYZE /* ) */) UPDATE t\nSET x = 1;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "SET"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
  });

  it("recovers later statements from an unclosed EXPLAIN option list", () => {
    const sql = "EXPLAIN (ANALYZE\nSELECT 1\nSELECT 2;";
    const explainSql = "EXPLAIN (ANALYZE\nSELECT 1";

    expect(statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"), "postgres")?.sql.trim()).toBe(explainSql);
    expect(statementRangeAtCursor(sql, indexOf(sql, "SELECT 2"), "postgres")?.sql.trim()).toBe("SELECT 2");
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([explainSql, "SELECT 2"]);
  });

  it("does not treat a DESCRIBE subquery paren as EXPLAIN options", () => {
    const sql = "DESCRIBE (SELECT 1)\nSELECT 2;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "DESCRIBE"), "clickhouse")?.sql.trim()).toBe("DESCRIBE (SELECT 1)");
    expect(rangeSqlTexts(executableStatementRanges(sql, "clickhouse"))).toEqual(["DESCRIBE (SELECT 1)", "SELECT 2"]);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual(["DESCRIBE (SELECT 1)", "SELECT 2"]);
  });

  it("keeps MySQL DESC UPDATE joins as one statement", () => {
    const sql = "desc update  test_orders a\njoin test_users b\non a.id=b.id \nset a.name = '张三'\nwhere b.id > 10;";
    expect(statementRangeAtCursor(sql, indexOf(sql, "desc"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "set"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL EXPLAIN UPDATE assignments as one statement", () => {
    const sql = "EXPLAIN UPDATE test_orders a\nJOIN test_users b ON a.id=b.id\nSET a.name = '张三'\nWHERE b.id > 10;";
    expect(statementRangeAtCursor(sql, indexOf(sql, "SET"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps MySQL REPLACE function calls inside UPDATE assignments", () => {
    const sql = `UPDATE ecm_archive_prepare_pool
SET
  request_json =
    REPLACE(
      request_json,
      '"paperFlag":null',
      '"paperFlag":false'
    ),
  process_flag = 0
WHERE request_json LIKE '%"paperFlag":null%';`;

    expect(statementRangeAtCursor(sql, indexOf(sql, "REPLACE"), "mysql")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual([sql.slice(0, -1)]);
  });

  it("does not merge a plain MySQL DESC table statement with the next query", () => {
    const sql = "DESC users\nSELECT * FROM users;";
    expect(statementRangeAtCursor(sql, indexOf(sql, "DESC"), "mysql")?.sql.trim()).toBe("DESC users");
    expect(statementRangeAtCursor(sql, indexOf(sql, "SELECT"), "mysql")?.sql.trim()).toBe("SELECT * FROM users");
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual(["DESC users", "SELECT * FROM users"]);
  });

  it("does not include comments between soft statement blocks", () => {
    const sql = "SELECT 1\n-- explain the next query\n/* still next query notes */\nSELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("detects a soft statement start after a leading block comment on the same line", () => {
    const sql = "SELECT 1\n/* next */ SELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "2"));
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("uses database-specific soft statement keywords", () => {
    const sql = "SELECT 1\nDO $$ BEGIN RAISE NOTICE 'x'; END $$;";
    expect(statementRangeAtCursor(sql, indexOf(sql, "1"))?.sql.trim()).toBe("SELECT 1\nDO $$ BEGIN RAISE NOTICE 'x'; END $$");
    expect(statementRangeAtCursor(sql, indexOf(sql, "1"), "postgres")?.sql.trim()).toBe("SELECT 1");
    expect(statementRangeAtCursor(sql, indexOf(sql, "DO"), "postgres")?.sql.trim()).toBe("DO $$ BEGIN RAISE NOTICE 'x'; END $$");
  });

  it("returns null when the cursor is on a blank line", () => {
    const sql = "SELECT 1;\n\nSELECT 2;";
    const blankLinePos = sql.indexOf("\n") + 1;
    expect(statementRangeAtCursor(sql, blankLinePos)).toBeNull();
  });

  it("returns null for an empty document", () => {
    expect(statementRangeAtCursor("", 0)).toBeNull();
  });

  it("does not treat comment semicolons as delimiters", () => {
    const sql = "SELECT 1; -- drop; this\nSELECT 2;";
    const pos = indexOf(sql, "2");
    expect(statementRangeAtCursor(sql, pos)?.sql.trim()).toBe("SELECT 2");
  });

  it("exposes offsets aligned to the statement body", () => {
    const sql = "  SELECT 1;\nSELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.from).toBe(2);
    expect(range?.sql).toBe("SELECT 1");
  });

  it("skips MySQL delimiter commands when resolving the cursor statement", () => {
    const sql = "select COUNT(1) FROM your_table;\ndelimiter ;;\nselect COUNT(1) FROM your_table;\n\n;;\ndelimiter ;";
    expect(statementRangeAtCursor(sql, indexOf(sql, "COUNT", 2), "mysql")?.sql.trim()).toBe("select COUNT(1) FROM your_table;");
    expect(statementRangeAtCursor(sql, indexOf(sql, "delimiter"), "mysql")).toBeNull();
  });

  it("returns the full MySQL routine block for cursors inside nested statements", () => {
    const range = statementRangeAtCursor(mysqlRoutineFixture, indexOf(mysqlRoutineFixture, "ok"), "mysql");
    expect(range?.sql.trim()).toBe(mysqlRoutineFixture.slice(0, mysqlRoutineFixture.indexOf("\nSELECT 2;")).replace(/;$/, "").trim());
  });

  it("returns null on SQL Server GO batch delimiter lines", () => {
    const sql = "SELECT 1\nGO\nSELECT 2";
    expect(statementRangeAtCursor(sql, indexOf(sql, "GO"), "sqlserver")).toBeNull();
  });

  it("returns the current SQL Server batch around GO delimiters", () => {
    const sql = "SELECT 1\nGO\nSELECT 2\nGO\nSELECT 3";
    expect(statementRangeAtCursor(sql, indexOf(sql, "1"), "sqlserver")?.sql.trim()).toBe("SELECT 1");
    expect(statementRangeAtCursor(sql, indexOf(sql, "2"), "sqlserver")?.sql.trim()).toBe("SELECT 2");
    expect(statementRangeAtCursor(sql, indexOf(sql, "3"), "sqlserver")?.sql.trim()).toBe("SELECT 3");
  });

  it("returns the full Oracle PL/SQL block for cursors inside nested statements", () => {
    const range = statementRangeAtCursor(oraclePlSqlFixture, indexOf(oraclePlSqlFixture, "ORDERS_10K", 2), "oracle");
    expect(range?.sql.trim()).toBe(oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")));
  });

  it("returns the full issue #2405 Oracle PL/SQL block for cursors inside the block", () => {
    for (const cursor of [indexOf(oracleIssue2405PlSql, "PRE_TRD_DATE"), indexOf(oracleIssue2405PlSql, "SELECT 1 + 2"), indexOf(oracleIssue2405PlSql, "END;")]) {
      expect(statementRangeAtCursor(oracleIssue2405PlSql, cursor, "oracle")?.sql.trim()).toBe(oracleIssue2405PlSql);
    }
  });

  it("returns the full GaussDB procedure for cursors after a nested block", () => {
    const outerNull = indexOf(gaussDbNestedProcedure, "NULL;", 2);
    expect(statementRangeAtCursor(gaussDbNestedProcedure, outerNull, "gaussdb")?.sql.trim()).toBe(gaussDbNestedProcedure);
  });

  it("returns the full SAP HANA DO block for cursors inside nested statements", () => {
    const range = statementRangeAtCursor(sapHanaDoBlockFixture, indexOf(sapHanaDoBlockFixture, "Result"), "saphana");

    expect(range?.sql.trim()).toBe(sapHanaDoBlockFixture.slice(0, sapHanaDoBlockFixture.indexOf("\nSELECT 2")));
  });
});

describe("executableStatementRanges", () => {
  it("returns statement ranges starting only at statement starts", () => {
    const sql = "SELECT *\nFROM users\nWHERE active = 1;\nSELECT 2;";
    const ranges = executableStatementRanges(sql);
    expect(rangeSqlTexts(ranges)).toEqual(["SELECT *\nFROM users\nWHERE active = 1", "SELECT 2"]);
    expect(ranges.map((range) => range.from)).toEqual([0, sql.indexOf("SELECT 2")]);
  });

  it("returns Redis executable command lines", () => {
    const sql = "GET user:1\n# comment\n  DEL user:2  ";
    const ranges = executableStatementRanges(sql, "redis");
    expect(rangeSqlTexts(ranges)).toEqual(["GET user:1", "DEL user:2"]);
    expect(ranges.map((range) => range.from)).toEqual([0, sql.indexOf("DEL")]);
  });

  it("keeps MySQL REPLACE INTO as an executable statement start", () => {
    const sql = "SELECT 1\nREPLACE INTO users (id, name) VALUES (1, 'a');";
    expect(rangeSqlTexts(executableStatementRanges(sql, "mysql"))).toEqual(["SELECT 1", "REPLACE INTO users (id, name) VALUES (1, 'a')"]);
  });

  it("returns MongoDB command ranges for newline-separated shell commands", () => {
    const sql = 'use archive\ndb.users.find({ status: "open" })\n  .limit(5)';
    const ranges = executableStatementRanges(sql, "mongodb");

    expect(rangeSqlTexts(ranges)).toEqual(["use archive", 'db.users.find({ status: "open" })\n  .limit(5)']);
    expect(ranges.map((range) => range.from)).toEqual([0, sql.indexOf("db.users.find")]);
  });

  it("does not split executable Oracle PL/SQL ranges at inner statement starts", () => {
    expect(rangeSqlTexts(executableStatementRanges(oraclePlSqlFixture, "oracle"))).toEqual([oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")), "SELECT 1"]);
  });

  it("returns the issue #2405 Oracle PL/SQL block as one executable range", () => {
    expect(rangeSqlTexts(executableStatementRanges(oracleIssue2405PlSql, "oracle"))).toEqual([oracleIssue2405PlSql]);
  });

  it("does not split executable MySQL routine ranges at inner statements", () => {
    expect(rangeSqlTexts(executableStatementRanges(mysqlRoutineFixture, "mysql"))).toEqual([mysqlRoutineFixture.slice(0, mysqlRoutineFixture.indexOf("\nSELECT 2;")).replace(/;$/, "").trim(), "SELECT 2"]);
  });

  it("does not split executable MySQL routine ranges at WHILE and REPEAT endings", () => {
    expect(rangeSqlTexts(executableStatementRanges(mysqlRoutineWithLoopsFixture, "mysql"))).toEqual([mysqlRoutineWithLoopsFixture.slice(0, mysqlRoutineWithLoopsFixture.indexOf("\nSELECT 2;")).replace(/;$/, "").trim(), "SELECT 2"]);
  });

  it("does not expose run targets for statements inside a delimited MySQL routine", () => {
    expect(rangeSqlTexts(executableStatementRanges(mysqlDelimitedRoutineFixture, "mysql"))).toEqual([mysqlDelimitedRoutineFixture.slice(mysqlDelimitedRoutineFixture.indexOf("CREATE PROCEDURE"), mysqlDelimitedRoutineFixture.indexOf(" //\nDELIMITER")), "CALL sp_insert_random_users(100)"]);
  });

  it("does not split executable SAP HANA DO ranges at inner statements", () => {
    expect(rangeSqlTexts(executableStatementRanges(sapHanaDoBlockFixture, "saphana"))).toEqual([sapHanaDoBlockFixture.slice(0, sapHanaDoBlockFixture.indexOf("\nSELECT 2")), "SELECT 2 FROM DUMMY"]);
  });

  it("returns executable SQL Server batches without GO delimiter lines", () => {
    expect(rangeSqlTexts(executableStatementRanges("SELECT 1\nGO\nSELECT 2;", "sqlserver"))).toEqual(["SELECT 1", "SELECT 2"]);
  });
});

describe("currentExecutableStatementRange", () => {
  it("uses the current SQL statement range for multi-line DDL", () => {
    const sql = "ALTER TABLE `yb_course_order`\n  ADD COLUMN `audit_status` tinyint(4) DEFAULT NULL\n    COMMENT '审核状态：0-待审核，1-已通过，2-已拒绝',\n  ADD COLUMN `close_reason` varchar(30) DEFAULT NULL\n    COMMENT '关闭原因：timeout-超时关闭，cancel-取消关闭，refund-退款关闭';\nSELECT 1;";

    expect(currentExecutableStatementRange(sql, indexOf(sql, "close_reason"), "mysql")?.sql.trim()).toBe(sql.slice(0, sql.indexOf(";\nSELECT")));
  });

  it("returns null on blank and pure comment lines", () => {
    const sql = "SELECT 1;\n-- comment\n\nSELECT 2;";

    expect(currentExecutableStatementRange(sql, indexOf(sql, "comment"), "mysql")).toBeNull();
    expect(currentExecutableStatementRange(sql, sql.indexOf("\n\n") + 1, "mysql")).toBeNull();
  });

  it("uses the current Redis command line", () => {
    const sql = "GET user:1\n  DEL user:2\n# comment";

    expect(currentExecutableStatementRange(sql, indexOf(sql, "DEL"), "redis")?.sql).toBe("DEL user:2");
    expect(currentExecutableStatementRange(sql, indexOf(sql, "comment"), "redis")).toBeNull();
  });

  it("does not expose current statement framing for MongoDB", () => {
    const sql = "db.users.find({})";

    expect(currentExecutableStatementRange(sql, indexOf(sql, "users"), "mongodb")).toBeNull();
  });
});

describe("fullSqlRange", () => {
  it("returns the trimmed full document", () => {
    const sql = "  SELECT 1;  \n";
    const range = fullSqlRange(sql);
    expect(range?.sql).toBe("SELECT 1;");
  });

  it("returns null for an empty/whitespace document", () => {
    expect(fullSqlRange("   \n  ")).toBeNull();
  });
});

describe("buildExecutionCandidates", () => {
  it("returns a single candidate when only the cursor statement exists", () => {
    const sql = "SELECT 1";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("returns current + all in order for multiple statements", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "2"));
    expect(candidateKinds(candidates)).toEqual(["cursor", "all"]);
  });

  it("preserves leading optimizer hints in current statement candidates", () => {
    const hintedSql = "/*+ SET(polar_csi.enable_query on) SET(polar_csi.cost_threshold 0)*/\nselect count(1) from xxx";
    const sql = `select 1;\n${hintedSql};`;
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "count"), "postgres");

    expect(candidates[0].sql).toBe(hintedSql);
  });

  it("uses the cursor statement for the first candidate when there is no selection", () => {
    const sql = "SELECT *\nFROM users\nWHERE active = 1";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "users"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("uses the whole set-operation statement for cursor execution candidates", () => {
    const sql = "select * from tbA\nunion\nselect * from tbB\nSELECT * FROM logs;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "tbA"));

    expect(candidateSummaries(candidates)).toEqual(["cursor:select * from tbA\nunion\nselect * from tbB", "all:select * from tbA\nunion\nselect * from tbB\nSELECT * FROM logs;"]);
  });

  it("uses the current command line for Redis cursor candidates", () => {
    const sql = "GET user:1\nDEL user:2\nHGETALL user:3";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "user:2"), "redis");
    expect(candidateSummaries(candidates)).toEqual(["cursor:DEL user:2", "all:GET user:1\nDEL user:2\nHGETALL user:3"]);
    expect(candidateLabels(candidates)).toEqual(["currentCommand", "allCommands"]);
  });

  it("returns only all for Redis when the cursor is on a comment line", () => {
    const sql = "GET user:1\n# comment\nDEL user:2";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "comment"), "redis");
    expect(candidateSummaries(candidates)).toEqual(["all:GET user:1\n# comment\nDEL user:2"]);
  });

  it("returns current + all when the cursor is in indentation before a statement", () => {
    const sql = "SELECT 1;\n    SELECT 2;";
    const indentationPos = sql.indexOf("    SELECT 2") + 2;
    const candidates = buildExecutionCandidates(sql, indentationPos);
    expect(candidateSummaries(candidates)).toEqual(["cursor:SELECT 2", "all:SELECT 1;\n    SELECT 2;"]);
    expect(candidateLabels(candidates)).toEqual(["currentStatement", "allStatements"]);
  });

  it("uses the current statement when the cursor is immediately after its semicolon before a blank line", () => {
    const sql = "select 1;\n\nselect 2;";
    const cursorAfterFirstSemicolon = sql.indexOf(";") + 1;
    const candidates = buildExecutionCandidates(sql, cursorAfterFirstSemicolon);
    expect(candidateSummaries(candidates)).toEqual(["cursor:select 1", "all:select 1;\n\nselect 2;"]);
  });

  it("dedupes when the cursor statement equals the full document", () => {
    const sql = "SELECT 1;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("returns only 'all' when the cursor is on a blank line", () => {
    const sql = "SELECT 1;\n\nSELECT 2;";
    const candidates = buildExecutionCandidates(sql, sql.indexOf("\n") + 1);
    expect(candidateKinds(candidates)).toEqual(["all"]);
  });

  it("returns no candidates for an empty document", () => {
    expect(buildExecutionCandidates("", 0)).toEqual([]);
  });

  it("returns only 'all' when the cursor has no statement but the document has SQL", () => {
    // Cursor past the end on a trailing blank line.
    const sql = "SELECT 1;\nSELECT 2;\n";
    const candidates = buildExecutionCandidates(sql, sql.length);
    expect(candidateKinds(candidates)).toEqual(["all"]);
  });

  it("uses the MySQL statement body for delimiter scripts", () => {
    const sql = "select COUNT(1) FROM your_table;\ndelimiter ;;\nselect COUNT(1) FROM your_table;\n\n;;\ndelimiter ;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "COUNT", 2), "mysql");
    expect(candidateSummaries(candidates)).toEqual(["cursor:select COUNT(1) FROM your_table;", "all:select COUNT(1) FROM your_table;\ndelimiter ;;\nselect COUNT(1) FROM your_table;\n\n;;\ndelimiter ;"]);
  });

  it("uses the current SQL Server batch for cursor candidates", () => {
    const sql = "SELECT 1\nGO\nSELECT 2;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "2"), "sqlserver");
    expect(candidateSummaries(candidates)).toEqual(["cursor:SELECT 2", "all:SELECT 1\nGO\nSELECT 2;"]);
  });
});

describe("hasMultipleExecutionTargets", () => {
  it("returns false for a single SQL statement", () => {
    expect(hasMultipleExecutionTargets("SELECT 1;")).toBe(false);
  });

  it("returns true for multiple SQL statements", () => {
    expect(hasMultipleExecutionTargets("SELECT 1;\nSELECT 2;")).toBe(true);
  });

  it("ignores comments when counting SQL statements", () => {
    expect(hasMultipleExecutionTargets("-- check one thing\nSELECT 1;")).toBe(false);
  });

  it("counts executable Redis command lines", () => {
    expect(hasMultipleExecutionTargets("GET user:1", "redis")).toBe(false);
    expect(hasMultipleExecutionTargets("GET user:1\n# comment\nDEL user:2", "redis")).toBe(true);
  });

  it("counts MySQL delimiter scripts by executable statements", () => {
    const sql = "select COUNT(1) FROM your_table;\ndelimiter ;;\nselect COUNT(1) FROM your_table;\n\n;;\ndelimiter ;";
    expect(hasMultipleExecutionTargets(sql, "mysql")).toBe(true);
  });

  it("counts MySQL routine blocks without delimiter by executable statements", () => {
    expect(hasMultipleExecutionTargets(mysqlRoutineFixture, "mysql")).toBe(true);
  });

  it("counts SQL Server GO batches as multiple execution targets", () => {
    expect(hasMultipleExecutionTargets("SELECT 1\nGO\nSELECT 2", "sqlserver")).toBe(true);
  });

  it("does not show multiple targets for MySQL DESC UPDATE joins", () => {
    const sql = "desc update  test_orders a\njoin test_users b\non a.id=b.id \nset a.name = '张三'\nwhere b.id > 10;";
    expect(hasMultipleExecutionTargets(sql, "mysql")).toBe(false);
  });
});

describe("supportsExecutionTargetPicker", () => {
  it("enables the picker for SQL database connections, Redis, and Elasticsearch", () => {
    expect(supportsExecutionTargetPicker("mysql")).toBe(true);
    expect(supportsExecutionTargetPicker("postgres")).toBe(true);
    expect(supportsExecutionTargetPicker("sqlserver")).toBe(true);
    expect(supportsExecutionTargetPicker("sqlite")).toBe(true);
    expect(supportsExecutionTargetPicker("jdbc")).toBe(true);
    expect(supportsExecutionTargetPicker("redis")).toBe(true);
    expect(supportsExecutionTargetPicker("mongodb")).toBe(false);
    expect(supportsExecutionTargetPicker("elasticsearch")).toBe(true);
    expect(supportsExecutionTargetPicker("qdrant")).toBe(false);
    expect(supportsExecutionTargetPicker("milvus")).toBe(false);
    expect(supportsExecutionTargetPicker("weaviate")).toBe(false);
    expect(supportsExecutionTargetPicker("chromadb")).toBe(false);
    expect(supportsExecutionTargetPicker("etcd")).toBe(false);
    expect(supportsExecutionTargetPicker("zookeeper")).toBe(false);
    expect(supportsExecutionTargetPicker("mq")).toBe(false);
    expect(supportsExecutionTargetPicker("neo4j")).toBe(false);
    expect(supportsExecutionTargetPicker(undefined)).toBe(false);
  });
});
