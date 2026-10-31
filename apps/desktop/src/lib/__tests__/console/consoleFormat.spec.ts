import { describe, expect, it } from "vitest";
import { CONSOLE_CONTINUATION_PROMPT, consoleEntriesForResult, consolePrompt, consoleSqlForSafety, consoleStatementComplete, echoCommandText, isConsoleCommandLine, queryResultToConsoleText, supportsSqlConsole } from "@/lib/console/consoleFormat";
import type { QueryResult } from "@/types/database";

function result(overrides: Partial<QueryResult>): QueryResult {
  return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 50, ...overrides };
}

describe("consoleFormat", () => {
  it("classifies real statement boundaries without letting client literals hide writes", () => {
    expect(consoleSqlForSafety("PROMPT literal ' ;\nDESC emp\nDELETE FROM users;", "oracle")).toBe("DELETE FROM users");
    expect(consoleSqlForSafety("DESC emp\nEXEC mutate(1)\nRUN\nSET CONSTRAINTS ALL IMMEDIATE;", "oracle")).toBe("EXEC mutate(1);\nRUN;\nSET CONSTRAINTS ALL IMMEDIATE");
    expect(consoleSqlForSafety("\\d emp\nDELETE FROM users;", "postgres")).toBe("DELETE FROM users");
    expect(consoleSqlForSafety("PROMPT local-only; literal ' ", "oracle")).toBe("SELECT 1");
    expect(consoleSqlForSafety("SET SCHEMA DBX_TEST;", "dameng")).toBe("SET SCHEMA DBX_TEST;");
    for (const sql of ["/*!80000 DELETE FROM users */;", "/*!80000 DELETE FROM users */; SELECT 1;"]) {
      expect(consoleSqlForSafety(sql, "mysql")).toBe(sql);
    }
  });
  it("prompts match the native clients per family", () => {
    expect(consolePrompt("mysql")).toBe("mysql> ");
    expect(consolePrompt("doris")).toBe("mysql> ");
    expect(consolePrompt("postgres")).toBe("pgsql> ");
    expect(consolePrompt("opengauss")).toBe("pgsql> ");
    expect(consolePrompt("oracle")).toBe("SQL> ");
    expect(consolePrompt("yashandb")).toBe("SQL> ");
    expect(consolePrompt("sqlserver")).toBe("sql> ");
    expect(consolePrompt(undefined)).toBe("SQL> ");
  });

  it("echoes multi-line statements with the continuation prompt", () => {
    expect(echoCommandText("show databases", "mysql")).toBe("mysql> show databases");
    expect(echoCommandText("SELECT 1\nFROM t;", "mysql")).toBe(`mysql> SELECT 1\n${CONSOLE_CONTINUATION_PROMPT}FROM t;`);
    expect(echoCommandText("DESC emp", "oracle")).toBe("SQL> DESC emp");
  });

  it("evaluates statement completeness per dialect", () => {
    // MySQL-family: only `;` executes.
    expect(consoleStatementComplete("show databases", "mysql")).toBe(false);
    expect(consoleStatementComplete("show databases\n    ;", "mysql")).toBe(true);
    expect(consoleStatementComplete("SELECT 1;", "mysql")).toBe(true);
    expect(consoleStatementComplete("SELECT 1", "mysql")).toBe(false);
    expect(consoleStatementComplete("EXIT", "mysql")).toBe(true);
    expect(consoleStatementComplete("quit", "mysql")).toBe(true);
    // Oracle: console commands run immediately; SQL needs `;` or a `/` line.
    expect(consoleStatementComplete("DESC emp", "oracle")).toBe(true);
    expect(consoleStatementComplete("SET TIMING ON", "oracle")).toBe(true);
    expect(consoleStatementComplete("SELECT 1", "oracle")).toBe(false);
    expect(consoleStatementComplete("SELECT 1;", "oracle")).toBe(true);
    expect(consoleStatementComplete("BEGIN\nNULL;\nEND;\n/", "oracle")).toBe(true);
    // SQL Server: `;` or a lone GO line.
    expect(consoleStatementComplete("SELECT 1", "sqlserver")).toBe(false);
    expect(consoleStatementComplete("SELECT 1;", "sqlserver")).toBe(true);
    expect(consoleStatementComplete("SELECT 1\nGO", "sqlserver")).toBe(true);
    // PostgreSQL: psql console commands run immediately, SQL needs `;`.
    expect(consoleStatementComplete("\\d emp", "postgres")).toBe(true);
    expect(consoleStatementComplete("\\dt", "postgres")).toBe(true);
    expect(consoleStatementComplete("SELECT 1", "postgres")).toBe(false);
    expect(consoleStatementComplete("SELECT 1;", "postgres")).toBe(true);
    // Multi-line SET TRANSACTION is server SQL: needs the terminator.
    expect(consoleStatementComplete("SET TRANSACTION READ ONLY", "oracle")).toBe(false);
    expect(consoleStatementComplete("", "mysql")).toBe(false);
  });

  it("isConsoleCommandLine matches whole-line verbs only", () => {
    expect(isConsoleCommandLine("DESC emp", "oracle")).toBe(true);
    expect(isConsoleCommandLine("DESCRIBE emp", "oracle")).toBe(true);
    expect(isConsoleCommandLine("EXIT", "oracle")).toBe(true);
    expect(isConsoleCommandLine("SPOOL out.txt", "oracle")).toBe(true);
    expect(isConsoleCommandLine("@init.sql", "oracle")).toBe(true);
    expect(isConsoleCommandLine("SET CONSTRAINT ALL IMMEDIATE", "oracle")).toBe(false);
    expect(isConsoleCommandLine("SET TRANSACTION READ ONLY", "oracle")).toBe(false);
    expect(isConsoleCommandLine("DESCRIBE", "mysql")).toBe(false);
    expect(isConsoleCommandLine("\\d emp", "postgres")).toBe(true);
    expect(isConsoleCommandLine("\\dt+", "postgres")).toBe(true);
    expect(isConsoleCommandLine("\\dv", "postgres")).toBe(false);
  });

  it("recognizes disql commands without consuming DM8 server SET", () => {
    for (const sql of ["DESC t", "EXEC p(1)", "PROMPT hi", "SHOW USER", "RUN", "EXIT", "SET TIMING ON"]) {
      expect(isConsoleCommandLine(sql, "dameng")).toBe(true);
      expect(consoleStatementComplete(sql, "dameng")).toBe(true);
    }
    for (const sql of ["SET SCHEMA DBX_TEST", "SET SESSION TRANSACTION READ WRITE", "SET TIME ZONE '+08:00'"]) {
      expect(isConsoleCommandLine(sql, "dameng")).toBe(false);
      expect(consoleStatementComplete(sql, "dameng")).toBe(false);
      expect(consoleStatementComplete(`${sql};`, "dameng")).toBe(true);
    }
    expect(consoleStatementComplete("BEGIN\n NULL;\nEND;", "dameng")).toBe(false);
    expect(consoleStatementComplete("BEGIN\n NULL;\nEND;\n/", "dameng")).toBe(true);
  });

  it.each([
    ["SELECT 'first;", "postgres", false],
    ["SELECT 'first;\nsecond';", "postgres", true],
    ["SELECT $$first;\nGO", "postgres", false],
    ["SELECT $$first;\nGO\n$$;", "postgres", true],
    ["SELECT 1; /* unfinished", "mysql", false],
    ["SELECT 1; /* finished */", "mysql", true],
    ["SELECT 1; -- comment", "mysql", true],
    ["SELECT 1;\nSELECT 2", "mysql", false],
    ["SELECT 1;\nSELECT 2;", "mysql", true],
    ["BEGIN\n  NULL;", "oracle", false],
    ["BEGIN\n  NULL;\nEND;", "oracle", false],
    ["BEGIN\n  NULL;\nEND;\n/", "oracle", true],
    ["DECLARE\n  n NUMBER := 1;", "yashandb", false],
    ["BEGIN\n  NULL;\nEND;\n/\nSELECT 1;", "oracle", true],
    ["SELECT 'first\nGO", "sqlserver", false],
    ["SELECT 'first\nGO\nlast'\nGO", "sqlserver", true],
  ] as const)("checks lexical completion of %j for %s", (sql, dialect, expected) => {
    expect(consoleStatementComplete(sql, dialect)).toBe(expected);
  });

  it("uses the same command boundaries as the editor", () => {
    expect(isConsoleCommandLine("SET CONSTRAINTS ALL DEFERRED", "oracle")).toBe(false);
    expect(isConsoleCommandLine("DESC emp\nSELECT 1;", "oracle")).toBe(false);
    expect(consoleStatementComplete("-- comment\nDESC emp", "oracle")).toBe(true);
  });

  it("renders row sets as ASCII tables with a rows-in-set line", () => {
    const text = queryResultToConsoleText(
      result({
        columns: ["Database"],
        rows: [["information_schema"], ["dbx_test"]],
        execution_time_ms: 50,
      }),
    );
    expect(text).toBe(["+--------------------+", "| Database           |", "+--------------------+", "| information_schema |", "| dbx_test           |", "+--------------------+", "2 row(s) in set (0.05 sec)"].join("\n"));
  });

  it("renders message grids as plain lines and empty results as Query OK", () => {
    const message = queryResultToConsoleText(result({ columns: ["Message"], rows: [["step 1 done"]] }));
    expect(message).toBe("step 1 done");
    const ok = queryResultToConsoleText(result({ columns: [], rows: [], affected_rows: 2, execution_time_ms: 30 }));
    expect(ok).toBe("Query OK, 2 row(s) affected (0.03 sec)");
    const plainOk = queryResultToConsoleText(result({ columns: [], rows: [], affected_rows: 0 }));
    expect(plainOk).toBe("Query OK (0.05 sec)");
  });

  it("caps headers and padded cells as well as table borders", () => {
    const text = queryResultToConsoleText(result({ columns: ["header".repeat(1000)], rows: [["x".repeat(10000)], ["small"]] }));
    const lines = text.split("\n");
    expect(lines.slice(0, -1).every((line) => line.length === 124)).toBe(true);
    expect(text).toContain("...");
    expect(text).toContain("small");
  });

  it("routes execution errors to error entries and NULLs stay visible", () => {
    const entries = consoleEntriesForResult(result({ execution_error: true, columns: ["Error"], rows: [["ORA-00942: table or view does not exist"]] }));
    expect(entries).toEqual([{ kind: "error", text: "ORA-00942: table or view does not exist" }]);
    const table = queryResultToConsoleText(result({ columns: ["a"], rows: [[null]] }));
    expect(table).toContain("| NULL");
  });

  it("offers the console only for SQL surfaces", () => {
    expect(supportsSqlConsole("postgres")).toBe(true);
    expect(supportsSqlConsole("mysql")).toBe(true);
    expect(supportsSqlConsole("oracle")).toBe(true);
    expect(supportsSqlConsole("sqlserver")).toBe(true);
    expect(supportsSqlConsole("mongodb")).toBe(false);
    expect(supportsSqlConsole("redis")).toBe(false);
    expect(supportsSqlConsole("elasticsearch")).toBe(false);
    expect(supportsSqlConsole(undefined)).toBe(false);
  });
});
