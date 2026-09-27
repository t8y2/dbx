import { describe, expect, it } from "vitest";

import type { BackendError, SqlErrorPosition } from "@/lib/backend/errorUtils";
import { mapExecutedOffsetToSource, scalarPositionToUtf16Offset, sqlErrorDisplayPosition, sqlErrorEditorOffset, sqlErrorHasMessagePosition } from "@/lib/sql/errorPosition";
import type { QueryResult } from "@/types/database";

function backendError(position?: SqlErrorPosition): BackendError {
  return {
    version: 1,
    code: "DBX-JDBC-4001",
    messageKey: "backendErrors.jdbc.sqlFailed",
    messageParams: { stage: "execute" },
    source: "jdbcAgent",
    operationOutcome: "unknown",
    detail: "ERROR: relation does not exist",
    ...(position ? { errorPosition: position } : {}),
  };
}

function errorResult(options: { editorStatement?: string; sourceFrom?: number; sourceTo?: number; executedStatement?: string; position?: SqlErrorPosition; message?: string }): QueryResult {
  const statement = options.editorStatement ?? "";
  return {
    columns: ["Error"],
    rows: [[options.message ?? "ERROR: relation does not exist"]],
    affected_rows: 0,
    execution_time_ms: 0,
    execution_error: true,
    error: backendError(options.position),
    sourceStatement: statement,
    sourceFrom: options.sourceFrom ?? 0,
    sourceTo: options.sourceTo ?? statement.length,
    ...(options.executedStatement ? { executedStatement: options.executedStatement } : {}),
  };
}

describe("sqlErrorEditorOffset", () => {
  it("maps a first-line column to an absolute editor offset", () => {
    const sql = "SELECT * FROM no_such_table";
    const result = errorResult({
      editorStatement: sql,
      position: { line: 1, column: 15, offset: 14 },
    });

    expect(sqlErrorEditorOffset({ editorSql: sql, result })).toEqual({ offset: 14, line: 1, column: 15 });
  });

  it("maps a later-line column", () => {
    const statement = "SELECT *\nFROM missing";
    const result = errorResult({
      editorStatement: statement,
      position: { line: 2, column: 6, offset: 14 },
    });

    expect(sqlErrorEditorOffset({ editorSql: statement, result })).toEqual({ offset: 14, line: 2, column: 6 });
  });

  it("adds the statement's absolute start offset in a multi-statement editor", () => {
    const statement = "SELECT *\nFROM missing";
    const editorSql = "SELECT 1;\n" + statement;
    const start = editorSql.indexOf(statement);
    const result = errorResult({
      editorStatement: statement,
      sourceFrom: start,
      sourceTo: start + statement.length,
      position: { line: 2, column: 6, offset: 14 },
    });

    expect(sqlErrorEditorOffset({ editorSql, result })).toEqual({ offset: start + 14, line: 2, column: 6 });
  });

  it("converts scalar-value columns to UTF-16 offsets for astral characters", () => {
    const statement = "SELECT '😀' FROM t";
    // Code-point column of FROM: S E L E C T space ' 😀 ' space = 11 chars, so FROM is column 12.
    const result = errorResult({
      editorStatement: statement,
      position: { line: 1, column: 12, offset: 11 },
    });

    // UTF-16 offset: the emoji occupies two code units, so 'FROM' starts at 12.
    expect(sqlErrorEditorOffset({ editorSql: statement, result })).toEqual({ offset: 12, line: 1, column: 12 });
  });

  it("returns undefined when the result carries no position", () => {
    const sql = "SELECT 1";
    const result = errorResult({ editorStatement: sql });

    expect(sqlErrorEditorOffset({ editorSql: sql, result })).toBeUndefined();
  });

  it("returns undefined when the statement no longer matches the editor", () => {
    const result = errorResult({
      editorStatement: "SELECT * FROM gone",
      position: { line: 1, column: 15, offset: 14 },
    });

    expect(sqlErrorEditorOffset({ editorSql: "SELECT 1", result })).toBeUndefined();
  });

  it("clamps instead of failing when the position line is beyond the statement", () => {
    const sql = "SELECT 1";
    const result = errorResult({
      editorStatement: sql,
      position: { line: 5, column: 1, offset: 4 },
    });

    // The position is relative to the statement, so a bad line clamps to its end.
    expect(sqlErrorEditorOffset({ editorSql: sql, result })?.offset).toBe(sql.length);
  });

  describe("when the executed statement differs from the source", () => {
    it("projects an appended LIMIT/OFFSET position back onto the source", () => {
      const source = "SELECT * FROM t";
      const executed = "SELECT * FROM t LIMIT 100 OFFSET 0;";
      const tableOffset = executed.indexOf("FROM t") + "FROM ".length;
      const result = errorResult({
        editorStatement: source,
        executedStatement: executed,
        position: { line: 1, column: tableOffset + 1, offset: tableOffset },
      });

      expect(sqlErrorEditorOffset({ editorSql: source, result })?.offset).toBe(source.indexOf("FROM t") + "FROM ".length);
    });

    it("projects a pagination wrapper position back onto the inner statement", () => {
      const source = "SELECT * FROM t";
      const executed = "SELECT * FROM (SELECT * FROM t) AS dbx_page LIMIT 100 OFFSET 0;";
      const tableOffset = executed.indexOf("FROM t") + "FROM ".length;
      const result = errorResult({
        editorStatement: source,
        executedStatement: executed,
        position: { line: 1, column: tableOffset + 1, offset: tableOffset },
      });

      expect(sqlErrorEditorOffset({ editorSql: source, result })?.offset).toBe(source.indexOf("FROM t") + "FROM ".length);
    });

    it("projects an injected hidden-key column position back onto the source", () => {
      const source = "SELECT * FROM users";
      const executed = 'SELECT *, "id" AS "__dbx_hidden_pk" FROM users LIMIT 100 OFFSET 0;';
      const tableOffset = executed.indexOf("FROM users") + "FROM ".length;
      const result = errorResult({
        editorStatement: source,
        executedStatement: executed,
        position: { line: 1, column: tableOffset + 1, offset: tableOffset },
      });

      expect(sqlErrorEditorOffset({ editorSql: source, result })?.offset).toBe(source.indexOf("users"));
    });

    it("keeps a multi-line position aligned when the wrapper is on the first line only", () => {
      const source = "SELECT *\nFROM users\nWHERE id = 1";
      const executed = `SELECT * FROM (${source}) AS dbx_page LIMIT 100 OFFSET 0;`;
      const executedMissing = executed.indexOf("users");
      const result = errorResult({
        editorStatement: source,
        executedStatement: executed,
        // `users` is on line 2 of both texts.
        position: { line: 2, column: 6, offset: executedMissing + 5 },
      });

      expect(sqlErrorEditorOffset({ editorSql: source, result })?.offset).toBe(source.indexOf("users"));
    });
  });
});

describe("when the engine reports its position only in the error message", () => {
  it("resolves the Oracle Agent offset and labels it with the caret's row/column", () => {
    const sql = "SELECT nope_col\nFROM dual";
    const result = errorResult({
      editorStatement: sql,
      message: 'ORA-00904: "NOPE_COL": invalid identifier error occur at position: 7',
    });

    expect(sqlErrorEditorOffset({ editorSql: sql, result })).toEqual({ offset: 7, line: 1, column: 8 });
    // The label must describe the caret, not the executed statement it was projected from.
    expect(sqlErrorDisplayPosition({ editorSql: sql, result })).toEqual({ line: 1, column: 8 });
  });

  it("maps an offset on a later line to that line and column", () => {
    const sql = "SELECT 1\nFROM dual\nWHERE to_number('abc') = 1";
    const offset = sql.indexOf("'abc'");
    const result = errorResult({ editorStatement: sql, message: `ORA-01722: invalid number error occur at position: ${offset}` });

    const mapped = sqlErrorEditorOffset({ editorSql: sql, result });
    // `'abc'` starts at column 17 of "WHERE to_number('abc') = 1".
    expect(mapped).toEqual({ offset, line: 3, column: 17 });
    expect(sqlErrorDisplayPosition({ editorSql: sql, result })).toEqual({ line: 3, column: 17 });
  });

  it("projects a message offset back onto the source when DBX rewrote the statement", () => {
    const source = "SELECT * FROM users";
    const executed = 'SELECT *, "id" AS "__dbx_hidden_pk" FROM users LIMIT 100 OFFSET 0;';
    const result = errorResult({
      editorStatement: source,
      executedStatement: executed,
      message: `ORA-00942: table or view does not exist error occur at position: ${executed.indexOf("users")}`,
    });

    const mapped = sqlErrorEditorOffset({ editorSql: source, result });
    expect(mapped?.offset).toBe(source.indexOf("users"));
    // The label follows the projected source text, so it stays consistent with the caret.
    expect(sqlErrorDisplayPosition({ editorSql: source, result })).toEqual({ line: 1, column: mapped!.offset + 1 });
  });

  it("uses a textual location when the message carries one", () => {
    const sql = "SELECT 1\nFROM missing";
    const result = errorResult({ editorStatement: sql, message: "syntax error at line 2, column 6" });

    expect(sqlErrorEditorOffset({ editorSql: sql, result })).toEqual({ offset: 14, line: 2, column: 6 });
  });

  it("returns undefined when neither the envelope nor the message carries a position", () => {
    const sql = "SELECT nope_col FROM dual";
    const result = errorResult({ editorStatement: sql, message: 'ORA-00904: "NOPE_COL": invalid identifier' });

    expect(sqlErrorEditorOffset({ editorSql: sql, result })).toBeUndefined();
    expect(sqlErrorDisplayPosition({ editorSql: sql, result })).toBeUndefined();
  });

  it("still returns undefined when the message offset cannot be found in the editor", () => {
    const result = errorResult({ editorStatement: "SELECT * FROM gone", message: "ORA-00942: table or view does not exist error occur at position: 14" });

    expect(sqlErrorEditorOffset({ editorSql: "SELECT 1", result })).toBeUndefined();
  });
});

describe("sqlErrorHasMessagePosition", () => {
  it("detects the positions engines put in the message text", () => {
    expect(sqlErrorHasMessagePosition('ORA-00904: "X": invalid identifier error occur at position: 9')).toBe(true);
    expect(sqlErrorHasMessagePosition("syntax error at line 2, column 4")).toBe(true);
    expect(sqlErrorHasMessagePosition("ERROR 1054 (42S22): Unknown column 'nope_col' in 'field list'")).toBe(false);
    expect(sqlErrorHasMessagePosition("")).toBe(false);
  });
});

describe("scalarPositionToUtf16Offset", () => {
  it("converts scalar line/column to a UTF-16 offset", () => {
    expect(scalarPositionToUtf16Offset("SELECT '😀' FROM t", 1, 12)).toBe(12);
  });

  it("clamps a column past the end of its line", () => {
    expect(scalarPositionToUtf16Offset("SELECT 1\nFROM t", 1, 999)).toBe("SELECT 1".length);
  });
});

describe("mapExecutedOffsetToSource", () => {
  it("returns the offset unchanged when both texts are identical", () => {
    expect(mapExecutedOffsetToSource("SELECT 1", "SELECT 1", 4)).toBe(4);
  });

  it("maps an append-only rewrite through the shared prefix", () => {
    expect(mapExecutedOffsetToSource("SELECT 1 LIMIT 10", "SELECT 1", 4)).toBe(4);
  });

  it("clamps offsets in the appended region to the source end", () => {
    expect(mapExecutedOffsetToSource("SELECT 1 LIMIT 10", "SELECT 1", 15)).toBe("SELECT 1".length);
  });
});
