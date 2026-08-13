import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { executableStatementRangeAtCursor, executableStatementRangeCacheForDoc, executableStatementRangeStartingAt, type ExecutableStatementRangeParser } from "@/lib/sql/executableStatementRangeCache";

describe("executableStatementRangeCacheForDoc", () => {
  it("tracks MongoDB commands for current-statement framing", () => {
    const sql = 'db.users.find({})\n\ndb.getCollection("audit.logs").countDocuments({})';
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mongodb");

    expect(executableStatementRangeAtCursor(cache, sql.indexOf("users"))?.sql).toBe("db.users.find({})");
    expect(executableStatementRangeAtCursor(cache, sql.indexOf("audit.logs"))?.sql).toBe('db.getCollection("audit.logs").countDocuments({})');
    expect(executableStatementRangeAtCursor(cache, doc.line(2).from)).toBeNull();
  });

  it("reuses parsed executable statement ranges for the same document and database type", () => {
    const doc = Text.of(["SELECT 1;", "SELECT 2;"]);
    const parse = vi.fn<ExecutableStatementRangeParser>(() => [
      { from: 0, to: 8, sql: "SELECT 1" },
      { from: 10, to: 18, sql: "SELECT 2" },
    ]);

    const first = executableStatementRangeCacheForDoc(null, doc, "mysql", parse);
    const second = executableStatementRangeCacheForDoc(first, doc, "mysql", parse);

    expect(second).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(executableStatementRangeStartingAt(second, 10)?.sql).toBe("SELECT 2");
  });

  it("resolves the exact multi-line statement for a gutter run button", () => {
    const doc = Text.of(["SELECT *", "FROM apis AS ap", "LIMIT 100;", "", "SELECT *", "FROM menus AS mn", "LIMIT 100;"]);

    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const secondStatementLine = doc.line(5);

    expect(executableStatementRangeStartingAt(cache, secondStatementLine.from)?.sql).toBe("SELECT *\nFROM menus AS mn\nLIMIT 100");
  });

  it("only exposes the routine start as executable when a MySQL procedure contains a CASE expression", () => {
    const sql = [
      "CREATE PROCEDURE p_case()",
      "BEGIN",
      "  INSERT INTO audit_log (status_text)",
      "  SELECT CASE WHEN active = 1 THEN 'active' ELSE 'inactive' END;",
      "  CASE WHEN active = 1 THEN SET @status_code = 1; ELSE SET @status_code = 0; END CASE;",
      "  DELETE FROM stale_rows WHERE expires_at < NOW();",
      "END;",
    ].join("\n");
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)?.sql).toBe(sql.slice(0, -1));
    expect(executableStatementRangeStartingAt(cache, doc.line(6).from)).toBeNull();
    expect(executableStatementRangeAtCursor(cache, doc.line(6).from + 4)?.sql).toBe(sql.slice(0, -1));
  });

  it("keeps MyBatis parameters in a Kingbase gutter execution range", () => {
    const sql = ["SELECT sum(nvl(a.medfee_sumamt, 0)) AS medfee_sumamt, a.insutype", "FROM yd_org_decla_detail a", "WHERE a.busin_type = '1' AND a.clr_ym = #{ym}", "GROUP BY a.clr_ym, a.insutype;"].join("\n");
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "kingbase");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)?.sql).toBe(sql.slice(0, -1));
  });

  it("keeps a valid placeholder-only line executable and respects disabled MyBatis syntax", () => {
    const sql = ["SELECT *", "FROM t", "#{where_clause};"].join("\n");
    const doc = Text.of(sql.split("\n"));
    const enabled = executableStatementRangeCacheForDoc(null, doc, "kingbase", { enabledSyntaxes: ["mybatis"] });
    const disabled = executableStatementRangeCacheForDoc(enabled, doc, "kingbase", { enabledSyntaxes: ["shell"] });

    expect(executableStatementRangeAtCursor(enabled, doc.line(3).from + 2)?.sql).toBe(sql.slice(0, -1));
    expect(executableStatementRangeAtCursor(disabled, doc.line(3).from + 2)).toBeNull();
    expect(disabled).not.toBe(enabled);
  });

  it("resolves statements with leading whitespace for gutter run buttons", () => {
    const doc = Text.of([" SELECT 1;", "  SELECT 2;", "\t SELECT 3;", "", "    "]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)?.sql).toBe("SELECT 1");
    expect(executableStatementRangeStartingAt(cache, doc.line(2).from)?.sql).toBe("SELECT 2");
    expect(executableStatementRangeStartingAt(cache, doc.line(3).from)?.sql).toBe("SELECT 3");
    expect(executableStatementRangeStartingAt(cache, doc.line(4).from)).toBeNull();
    expect(executableStatementRangeStartingAt(cache, doc.line(5).from)).toBeNull();
  });

  it.each(["/*& tenant:'gdx' */", "/*&tenant:mctest*/", "/*+ MAX_EXECUTION_TIME(1000) */", "/*@global:true*/", "/*proxy*/"])("resolves the SQL line after a preserved leading directive for gutter execution: %s", (directive) => {
    const sql = `SELECT 0;\n${directive}\nSELECT 1;`;
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(3).from)?.sql).toBe(`${directive}\nSELECT 1`);
  });

  it("keeps a same-line tenant hint in the gutter execution range", () => {
    const sql = "/*& tenant:'gdx' */ SELECT\n*\nFROM table";
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)?.sql).toBe(sql);
  });

  it("treats a SQL Server temporary table after a hint as executable content", () => {
    const sql = "/*+ hint */\n#temporary_table";
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "sqlserver");

    expect(executableStatementRangeStartingAt(cache, doc.line(2).from)?.sql).toBe(sql);
  });

  it("does not attach ordinary leading block comments to gutter execution", () => {
    const doc = Text.of(["/* comment */", "SELECT 1;", "/* comment only */"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)).toBeNull();
    expect(executableStatementRangeStartingAt(cache, doc.line(2).from)?.sql).toBe("SELECT 1");
    expect(executableStatementRangeStartingAt(cache, doc.line(3).from)).toBeNull();
  });

  it("does not resolve gutter run buttons when non-whitespace precedes the statement on the same line", () => {
    const doc = Text.of(["/* comment */ SELECT 1;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)).toBeNull();
    expect(executableStatementRangeStartingAt(cache, doc.toString().indexOf("SELECT"))?.sql).toBe("SELECT 1");
  });

  it("resolves the current statement from a cursor inside a continuation line", () => {
    const doc = Text.of(["SELECT *", "FROM apis AS ap", "LIMIT 100;", "", "SELECT *", "FROM menus AS mn", "LIMIT 100;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const cursor = doc.toString().indexOf("menus");

    expect(executableStatementRangeAtCursor(cache, cursor)?.sql).toBe("SELECT *\nFROM menus AS mn\nLIMIT 100");
  });

  it("keeps indentation and same-line semicolon gaps attached to the current statement", () => {
    const doc = Text.of(["SELECT 1;", "    SELECT 2;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const indentationCursor = doc.line(2).from + 2;
    const semicolonGapCursor = doc.toString().indexOf(";") + 1;

    expect(executableStatementRangeAtCursor(cache, indentationCursor)?.sql).toBe("SELECT 2");
    expect(executableStatementRangeAtCursor(cache, semicolonGapCursor)?.sql).toBe("SELECT 1");
  });

  it("keeps a standalone next-line semicolon attached to the current statement", () => {
    const sql = "SELECT *\nFROM users\n;\n\nSELECT * FROM audit;";
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const delimiterCursor = sql.indexOf(";");

    expect(executableStatementRangeAtCursor(cache, delimiterCursor)?.sql).toBe("SELECT *\nFROM users");
    expect(executableStatementRangeAtCursor(cache, delimiterCursor + 1)?.sql).toBe("SELECT *\nFROM users");
  });

  it("resolves a trailing-whitespace cursor on a multi-line statement tail to that statement", () => {
    const sql = "WITH x AS (SELECT 1)\nSELECT 2   \nSELECT 3;";
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const contentEnd = sql.indexOf("SELECT 2") + "SELECT 2".length;

    expect(executableStatementRangeAtCursor(cache, contentEnd)?.sql).toBe("WITH x AS (SELECT 1)\nSELECT 2");
    expect(executableStatementRangeAtCursor(cache, contentEnd + 1)?.sql).toBe("WITH x AS (SELECT 1)\nSELECT 2");
    expect(executableStatementRangeAtCursor(cache, contentEnd + 2)?.sql).toBe("WITH x AS (SELECT 1)\nSELECT 2");
  });

  it("keeps the simple single-line trailing-whitespace case on the current statement", () => {
    const sql = "SELECT 1;\nSELECT 2   \nSELECT 3;";
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const contentEnd = sql.indexOf("SELECT 2") + "SELECT 2".length;

    expect(executableStatementRangeAtCursor(cache, contentEnd)?.sql).toBe("SELECT 2");
    expect(executableStatementRangeAtCursor(cache, contentEnd + 1)?.sql).toBe("SELECT 2");
  });

  it("keeps a trailing-whitespace cursor on a non-final line of a multi-line statement in the frame cache", () => {
    const sql = "SELECT * FROM `profiles`;\nSELECT * FROM `users` AS uu   \nWHERE id = 2\nSELECT * FROM `orders`;";
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const markerEnd = sql.indexOf("uu") + 2;
    const lineEnd = sql.indexOf("\n", markerEnd);
    const expected = "SELECT * FROM `users` AS uu   \nWHERE id = 2";

    for (let pos = markerEnd; pos < lineEnd; pos += 1) {
      expect(executableStatementRangeAtCursor(cache, pos)?.sql).toBe(expected);
    }
  });

  it("does not attach a semicolon after a blank line to the previous statement", () => {
    const sql = "SELECT 1\n\n;";
    const doc = Text.of(sql.split("\n"));
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeAtCursor(cache, sql.indexOf(";"))).toBeNull();
  });

  it("returns null for blank and pure comment cursor lines", () => {
    const doc = Text.of(["SELECT 1;", "-- comment", "/* block comment */", "", "SELECT 2;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeAtCursor(cache, doc.line(2).from + 3)).toBeNull();
    expect(executableStatementRangeAtCursor(cache, doc.line(3).from + 3)).toBeNull();
    expect(executableStatementRangeAtCursor(cache, doc.line(4).from)).toBeNull();
  });

  it("resolves SQL after a leading block comment on the same line", () => {
    const doc = Text.of(["/* comment */ SELECT 1;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeAtCursor(cache, doc.toString().indexOf("SELECT"))?.sql).toBe("SELECT 1");
    expect(executableStatementRangeAtCursor(cache, doc.toString().indexOf("comment"))).toBeNull();
  });

  it("rebuilds the cache when the document instance changes", () => {
    const firstDoc = Text.of(["SELECT 1;"]);
    const secondDoc = Text.of(["SELECT 1;"]);
    const parse = vi.fn<ExecutableStatementRangeParser>(() => [{ from: 0, to: 8, sql: "SELECT 1" }]);

    const first = executableStatementRangeCacheForDoc(null, firstDoc, "mysql", parse);
    const second = executableStatementRangeCacheForDoc(first, secondDoc, "mysql", parse);

    expect(second).not.toBe(first);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the cache when the database type changes", () => {
    const doc = Text.of(["SELECT 1;"]);
    const parse = vi.fn<ExecutableStatementRangeParser>(() => [{ from: 0, to: 8, sql: "SELECT 1" }]);

    const mysql = executableStatementRangeCacheForDoc(null, doc, "mysql", parse);
    const postgres = executableStatementRangeCacheForDoc(mysql, doc, "postgres", parse);

    expect(postgres).not.toBe(mysql);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
