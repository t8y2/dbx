import { describe, expect, it, vi } from "vitest";
import { hasQueryExecutionLog, isDisplayingHistoricalQueryResult, queryExecutionLog, supportsQueryExecutionLog } from "@/lib/query/queryExecutionLog";
import type { BatchSqlExecution, BatchStatementExecutionItem, DatabaseType, QueryResult } from "@/types/database";

type LogTab = Parameters<typeof queryExecutionLog>[0];

const t = (key: string, params?: Record<string, string | number>) => {
  if (key === "executionSummary.sql") return "SQL";
  if (key === "executionSummary.time") return "Time";
  if (key === "grid.rowsAffected") return `${params?.count} rows affected`;
  return key.replace("executionSummary.statuses.", "");
};

function statement(statementIndex: number, overrides: Partial<BatchStatementExecutionItem> = {}): BatchStatementExecutionItem {
  return { statementIndex, sql: `UPDATE t SET value = ${statementIndex + 1}`, from: 0, to: 10, status: "success", ...overrides };
}

function batch(items: BatchStatementExecutionItem[], overrides: Partial<BatchSqlExecution> = {}): BatchSqlExecution {
  return { executionId: "new", submittedSql: items.map((item) => item.sql).join(";\n"), editorFingerprint: "fingerprint", sourceOffset: 0, completed: items.filter((item) => item.status === "success" || item.status === "error").length, total: items.length, startedAt: 1, items, ...overrides };
}

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return { columns: [], rows: [], affected_rows: 2, execution_time_ms: 14, sourceStatement: "INSERT INTO t VALUES (1), (2)", ...overrides };
}

function log(overrides: Partial<LogTab> = {}) {
  return queryExecutionLog({ isExecuting: false, ...overrides }, t);
}

describe("queryExecutionLog", () => {
  it("enables SQL execution logs without adding SQL output to non-SQL workspaces", () => {
    const sqlTypes: DatabaseType[] = ["mysql", "postgres", "sqlite", "sqlserver", "oracle", "jdbc", "opengauss"];
    const nonSqlTypes: Array<DatabaseType | undefined> = [undefined, "mongodb", "redis", "neo4j", "nebula", "elasticsearch", "qdrant", "nacos", "etcd"];
    for (const databaseType of sqlTypes) expect(supportsQueryExecutionLog(databaseType), databaseType).toBe(true);
    for (const databaseType of nonSqlTypes) expect(supportsQueryExecutionLog(databaseType), databaseType).toBe(false);
  });

  it("includes every DML statement, zero affected rows and individual elapsed times", () => {
    const first = "UPDATE `ai2001`.`device`\nSET `device_name` = `device_name`\nWHERE 1 = 0";
    const second = "UPDATE `ai2001`.`device`\nSET `device_id` = `device_id`\nWHERE 1 = 0";
    expect(log({ batchSqlExecution: batch([statement(0, { sql: first, affectedRows: 0, executionTimeMs: 0 }), statement(1, { sql: second, affectedRows: 0, executionTimeMs: 14 })]) })).toEqual({
      severity: "INFO",
      message: `SQL #1 · success\n${first}\n> 0 rows affected\n> Time: 0 ms\n\nSQL #2 · success\n${second}\n> 0 rows affected\n> Time: 14 ms`,
    });
  });

  it("distinguishes failures and unexecuted statements without reporting successful metrics for them", () => {
    const output = log({
      batchSqlExecution: batch([
        statement(0, { affectedRows: 1, executionTimeMs: 20 }),
        statement(1, { status: "error", error: "permission denied", affectedRows: 90, executionTimeMs: 2001 }),
        statement(2, { status: "skipped", affectedRows: 91, executionTimeMs: 92 }),
        statement(3, { status: "cancelled", affectedRows: 93, executionTimeMs: 94 }),
        statement(4, { status: "running", affectedRows: 95, executionTimeMs: 96 }),
        statement(5, { status: "pending", affectedRows: 97, executionTimeMs: 98 }),
      ]),
    });
    expect(output?.severity).toBe("ERROR");
    const blocks = output!.message.split("\n\n");
    expect(blocks[0]).toContain("> 1 rows affected\n> Time: 20 ms");
    expect(blocks[1]).toBe("SQL #2 · error\nUPDATE t SET value = 2\n> Time: 2.0 s\n> permission denied");
    expect(blocks.slice(2)).toEqual(["SQL #3 · skipped\nUPDATE t SET value = 3", "SQL #4 · cancelled\nUPDATE t SET value = 4", "SQL #5 · running\nUPDATE t SET value = 5", "SQL #6 · pending\nUPDATE t SET value = 6"]);
  });

  it("keeps unknown coalesced progress metrics unknown instead of using a retained result", () => {
    const output = log({
      isExecuting: true,
      executionId: "new",
      result: result({ affected_rows: 999, execution_time_ms: 888, sourceExecutionId: "old" }),
      batchSqlExecution: batch([statement(0), statement(1, { affectedRows: 0, executionTimeMs: 10 })]),
    });
    expect(output?.message.split("\n\n")[0]).toBe("SQL #1 · success\nUPDATE t SET value = 1");
    expect(output?.message).not.toContain("999");
    expect(output?.message).not.toContain("888");
  });

  it("logs a new batch without mixing in SQL or counts from its previous displayed dataset", () => {
    expect(
      log({
        isExecuting: true,
        executionId: "new",
        result: result({ sourceStatement: "SELECT 'previous execution'", sourceExecutionId: "old" }),
        batchSqlExecution: batch([statement(0, { sql: "UPDATE new_table SET value = 1", status: "running" })]),
      })?.message,
    ).toBe("SQL #1 · running\nUPDATE new_table SET value = 1");
  });

  it("suppresses nonbatch retained results during a new execution until that execution publishes results", () => {
    for (const sourceExecutionId of [undefined, "old"]) {
      expect(log({ isExecuting: true, executionId: "new", result: result({ sourceExecutionId }) })).toBeUndefined();
    }
    expect(log({ isExecuting: true, executionId: "new", result: result({ sourceExecutionId: "new" }) })?.message).toContain("INSERT INTO t VALUES (1), (2)");
  });

  it("continues to display an archived batch selected while another execution is running", () => {
    const archived = batch([statement(0, { sql: "UPDATE archived SET value = 1", affectedRows: 3, executionTimeMs: 42 })], { executionId: "old", finishedAt: 100 });
    expect(log({ isExecuting: true, executionId: "new", activeResultRunId: "archive", executingResultRunId: "new-run", batchSqlExecution: archived })?.message).toBe("SQL #1 · success\nUPDATE archived SET value = 1\n> 3 rows affected\n> Time: 42 ms");
  });

  it("preserves selected nonbatch history while another run executes, but suppresses the old payload of the run being refreshed", () => {
    const archivedResult = result({ sourceExecutionId: "old" });
    for (const executingResultRunId of [null, "another-run"]) {
      expect(log({ isExecuting: true, executionId: "new", activeResultRunId: "archive", executingResultRunId, resultRunSelectionExecutionId: "new", result: archivedResult })?.message).toContain("INSERT INTO t VALUES (1), (2)");
    }
    expect(log({ isExecuting: true, executionId: "new", activeResultRunId: "archive", executingResultRunId: "archive", resultRunSelectionExecutionId: "new", result: archivedResult })).toBeUndefined();
  });

  it("distinguishes auto-kept results from explicitly selected history across execution lifecycles", () => {
    const tab: LogTab = { isExecuting: true, executionId: "new", activeResultRunId: "archive", executingResultRunId: null, result: result({ sourceExecutionId: "old" }) };
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(false);
    expect(hasQueryExecutionLog(tab)).toBe(false);
    expect(log(tab)).toBeUndefined();
    tab.resultRunSelectionExecutionId = "new";
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(true);
    expect(hasQueryExecutionLog(tab)).toBe(true);
    expect(log(tab)?.message).toContain("INSERT INTO t");
    tab.batchSqlExecution = batch([statement(0, { status: "running" })]);
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(false);
    tab.batchSqlExecution = undefined;
    tab.executionId = "next";
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(false);
    expect(hasQueryExecutionLog(tab)).toBe(false);
    tab.isExecuting = false;
    expect(hasQueryExecutionLog(tab)).toBe(true);
  });

  it("checks batch presence without reading statement SQL, progress or metrics", () => {
    const currentBatch = batch([statement(0)]);
    const unreadable = () => {
      throw new Error("presence must not traverse statements");
    };
    for (const key of ["sql", "status", "affectedRows", "executionTimeMs"]) Object.defineProperty(currentBatch.items[0], key, { get: unreadable });
    expect(hasQueryExecutionLog({ isExecuting: true, batchSqlExecution: currentBatch })).toBe(true);
  });

  it("uses the same result eligibility for cheap presence and rendered output", () => {
    const fixtures: Partial<LogTab>[] = [
      {},
      { result: result() },
      { results: [result({ server_message: true }), result({ manual_transaction_no_statement: true })] },
      { result: result({ sourceStatement: "  " }) },
      { isExecuting: true, executionId: "new", result: result({ sourceExecutionId: "old" }) },
      { isExecuting: true, executionId: "new", result: result({ sourceExecutionId: "new" }) },
      { isExecuting: true, executionId: "new", activeResultRunId: "archive", resultRunSelectionExecutionId: "new", result: result({ sourceExecutionId: "old" }) },
      { batchSqlExecution: batch([]), result: result() },
    ];
    for (const fixture of fixtures) expect(hasQueryExecutionLog({ isExecuting: false, ...fixture })).toBe(!!log(fixture));
  });

  it("reuses translations within one large log and refreshes them when the language changes", () => {
    const tab: LogTab = { isExecuting: false, batchSqlExecution: batch(Array.from({ length: 5000 }, (_, index) => statement(index, { affectedRows: 0, executionTimeMs: 1 }))) };
    const firstTranslation = vi.fn(t);
    const output = queryExecutionLog(tab, firstTranslation)!;
    expect(firstTranslation).toHaveBeenCalledTimes(4);
    expect(output.message.match(/SQL #/g)).toHaveLength(5000);
    const secondTranslation = vi.fn((key: string, params?: Record<string, string | number>) => `translated:${t(key, params)}`);
    const translated = queryExecutionLog(tab, secondTranslation)!;
    expect(secondTranslation).toHaveBeenCalledTimes(4);
    expect(translated.message).toContain("translated:SQL #5000 · translated:success");
    expect(translated.message).toContain("> translated:0 rows affected\n> translated:Time: 1 ms");
  });

  it("supports nonbatch execution responses without losing multiple results or an error belonging to the same statement", () => {
    const first = result({ statement_index: 0, sourceStatement: "CALL process_items()", affected_rows: 2, execution_time_ms: 10 });
    const second = result({ statement_index: 0, sourceStatement: "CALL process_items()", columns: ["Error"], rows: [["processing failed"]], execution_error: true, affected_rows: 0, execution_time_ms: 12 });
    const output = log({ results: [first, second] });
    expect(output?.severity).toBe("ERROR");
    expect(output?.message).toBe("SQL #1 · success\nCALL process_items()\n> 2 rows affected\n> Time: 10 ms\n\nSQL #1 · error\nCALL process_items()\n> Time: 12 ms\n> processing failed");
  });

  it("does not treat a column called Error as an execution failure", () => {
    expect(log({ result: result({ columns: ["Error"], rows: [["a regular value"]] }) })?.severity).toBe("INFO");
  });

  it("excludes server-message and no-statement results and never substitutes editor SQL for absent source SQL", () => {
    expect(log({ results: [result({ server_message: true, columns: ["Message"], rows: [["notice"]] }), result({ manual_transaction_no_statement: true }), result({ sourceStatement: undefined }), result({ sourceStatement: "   " })] })).toBeUndefined();
    expect(log()).toBeUndefined();
  });

  it("uses the latest resumed batch snapshot without duplicating prior failed attempts", () => {
    const prior = batch([statement(0, { affectedRows: 1, executionTimeMs: 10 }), statement(1, { status: "error", error: "failed attempt" }), statement(2, { status: "skipped" })]);
    const resumed = batch([prior.items[0]!, statement(1, { affectedRows: 2, executionTimeMs: 20 }), statement(2, { affectedRows: 3, executionTimeMs: 30 })]);
    const output = log({ batchSqlExecution: resumed });
    expect(output?.severity).toBe("INFO");
    expect(output?.message.match(/SQL #/g)).toHaveLength(3);
    expect(output?.message).not.toContain("failed attempt");
    expect(output?.message).toContain("> 3 rows affected");
  });

  it("reports cancellation and a backend-only error detail without fabricating elapsed values", () => {
    expect(log({ batchSqlExecution: batch([statement(0, { status: "cancelled" })]) })).toEqual({ severity: "WARNING", message: "SQL #1 · cancelled\nUPDATE t SET value = 1" });
    expect(log({ batchSqlExecution: batch([statement(0, { status: "error", errorDetails: { code: "DBX-JDBC-4001", detail: "database failure" } })]) })?.message).toBe("SQL #1 · error\nUPDATE t SET value = 1\n> database failure");
  });

  it("leaves the source batch, results and server notices untouched", () => {
    const tab: LogTab = { isExecuting: false, batchSqlExecution: batch([statement(0, { affectedRows: 0, executionTimeMs: 14 })]), result: result({ messages: [{ severity: "NOTICE", message: "server notice", code: "00000", hint: "hint" }] }) };
    const before = JSON.stringify(tab);
    log(tab);
    expect(JSON.stringify(tab)).toBe(before);
    expect(log(tab)?.message).not.toContain("server notice");
  });

  it("returns the complete large batch as one copyable text block", () => {
    const output = log({ batchSqlExecution: batch(Array.from({ length: 5000 }, (_, index) => statement(index, { affectedRows: 0, executionTimeMs: 1 }))) });
    expect(output?.message.match(/SQL #/g)).toHaveLength(5000);
    expect(output?.message).toContain("SQL #5000 · success\nUPDATE t SET value = 5000\n> 0 rows affected\n> Time: 1 ms");
  });
});
