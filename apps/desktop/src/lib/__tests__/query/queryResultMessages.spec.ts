import { describe, expect, it } from "vitest";
import { queryResultMessages } from "@/lib/query/queryResultMessages";
import { defaultViewForResult, statementRunsWithoutResultGrid } from "@/lib/query/queryResultDefaultView";
import type { QueryResult } from "@/types/database";

const messageResult: QueryResult = { columns: ["Message"], rows: [["before"], [""]], affected_rows: 0, execution_time_ms: 1, server_message: true };

describe("statementRunsWithoutResultGrid", () => {
  it("flags write and DDL statements that have no grid to show while running", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "insert into t select * from s",
      "UPDATE t SET a = 1",
      "DELETE FROM t WHERE id = 1",
      "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET a = 1",
      "CREATE TABLE t (id int)",
      "ALTER TABLE t ADD COLUMN a int",
      "DROP TABLE t",
      "TRUNCATE TABLE t",
      "BEGIN",
      "COMMIT",
      "SET autocommit = 1",
      "USE app",
      "  \n -- leading line comment\n /* block */ UPDATE t SET a = 1;",
    ]) {
      expect(statementRunsWithoutResultGrid(sql), sql).toBe(true);
    }
  });

  it("keeps statements that can return rows on the data tab", () => {
    for (const sql of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "SHOW TABLES", "DESCRIBE t", "EXPLAIN SELECT 1", "VALUES (1)", "CALL proc()", "EXEC proc", '{ "find": "users" }', "", "   "]) {
      expect(statementRunsWithoutResultGrid(sql), sql).toBe(false);
    }
  });
});

describe("SQL Server result messages", () => {
  it("collects tagged messages around data and errors in execution order", () => {
    const data: QueryResult = { columns: ["Message"], rows: [["not a notice"]], affected_rows: 0, execution_time_ms: 1 };
    const error: QueryResult = { ...data, columns: ["Error"], rows: [["failed"]], execution_error: true };
    const results = [messageResult, data, { ...messageResult, rows: [["between"]] }, error, { ...messageResult, rows: [["after"]] }];

    expect(results.flatMap(queryResultMessages).map(({ message }) => message)).toEqual(["before", "", "between", "after"]);
    expect(queryResultMessages(data)).toEqual([]);
    expect(queryResultMessages(error)).toEqual([]);
    expect(messageResult.rows).toEqual([["before"], [""]]);
  });

  it("preserves structured metadata without duplicating message rows", () => {
    const messages = [{ severity: "WARNING", message: "warning", code: "01000", detail: "detail" }];
    expect(queryResultMessages({ ...messageResult, messages })).toBe(messages);
    expect(queryResultMessages({ rows: [], messages })).toBe(messages);
    expect(queryResultMessages({ ...messageResult, rows: [[null], []] })).toEqual([]);
  });

  it("opens message-only output and preserves other databases' default views", () => {
    expect(defaultViewForResult(messageResult)).toBe("messages");
    expect(defaultViewForResult({ ...messageResult, rows: [] })).toBe("summary");
    expect(defaultViewForResult({ columns: [], rows: [], affected_rows: 0, messages: [{ severity: "NOTICE", message: "postgres" }] })).toBe("messages");
    expect(defaultViewForResult({ columns: [], rows: [], affected_rows: 1, messages: [{ severity: "INFO", message: "Records: 1" }] })).toBe("summary");
    expect(defaultViewForResult({ columns: [], rows: [], affected_rows: 0 })).toBe("summary");
  });
});
