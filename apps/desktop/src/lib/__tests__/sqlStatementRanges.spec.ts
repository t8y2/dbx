import { describe, expect, it } from "vitest";
import { buildExecutionCandidates, executableStatementRanges, fullSqlRange, hasMultipleExecutionTargets, splitSqlStatementRanges, statementRangeAtCursor, supportsExecutionTargetPicker } from "../sqlStatementRanges";

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

  it("keeps Oracle PL/SQL blocks together and treats slash lines as delimiters", () => {
    const ranges = splitSqlStatementRanges(oraclePlSqlFixture, "oracle");
    expect(rangeSqlTexts(ranges)).toEqual([oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")), "SELECT 1"]);
    expect(ranges[0].sql).toContain("v_order_count NUMBER;");
    expect(ranges[0].sql).toContain("END;");
    expect(ranges[0].sql).not.toContain("\n/");
  });
});

describe("statementRangeAtCursor", () => {
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

  it("returns the full Oracle PL/SQL block for cursors inside nested statements", () => {
    const range = statementRangeAtCursor(oraclePlSqlFixture, indexOf(oraclePlSqlFixture, "ORDERS_10K", 2), "oracle");
    expect(range?.sql.trim()).toBe(oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")));
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

  it("returns MongoDB command ranges for newline-separated shell commands", () => {
    const sql = 'use archive\ndb.users.find({ status: "open" })\n  .limit(5)';
    const ranges = executableStatementRanges(sql, "mongodb");

    expect(rangeSqlTexts(ranges)).toEqual(["use archive", 'db.users.find({ status: "open" })\n  .limit(5)']);
    expect(ranges.map((range) => range.from)).toEqual([0, sql.indexOf("db.users.find")]);
  });

  it("does not split executable Oracle PL/SQL ranges at inner statement starts", () => {
    expect(rangeSqlTexts(executableStatementRanges(oraclePlSqlFixture, "oracle"))).toEqual([oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")), "SELECT 1"]);
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

  it("uses the cursor statement for the first candidate when there is no selection", () => {
    const sql = "SELECT *\nFROM users\nWHERE active = 1";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "users"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
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

  it("does not show multiple targets for MySQL DESC UPDATE joins", () => {
    const sql = "desc update  test_orders a\njoin test_users b\non a.id=b.id \nset a.name = '张三'\nwhere b.id > 10;";
    expect(hasMultipleExecutionTargets(sql, "mysql")).toBe(false);
  });
});

describe("supportsExecutionTargetPicker", () => {
  it("enables the picker for SQL database connections and Redis", () => {
    expect(supportsExecutionTargetPicker("mysql")).toBe(true);
    expect(supportsExecutionTargetPicker("postgres")).toBe(true);
    expect(supportsExecutionTargetPicker("sqlserver")).toBe(true);
    expect(supportsExecutionTargetPicker("sqlite")).toBe(true);
    expect(supportsExecutionTargetPicker("jdbc")).toBe(true);
    expect(supportsExecutionTargetPicker("redis")).toBe(true);
    expect(supportsExecutionTargetPicker("mongodb")).toBe(false);
    expect(supportsExecutionTargetPicker("elasticsearch")).toBe(false);
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
