import { describe, expect, it } from "vitest";
import { queryErrorSelection, queryResultSelection } from "@/lib/ai/aiExternalContext";
import { AI_SELECTION_CONTEXT_MAX_CHARS } from "@/lib/ai/aiAttachments";
import type { QueryResult, QueryTab } from "@/types/database";

type ResultTab = Pick<QueryTab, "title" | "result" | "resultSortedSql" | "resultBaseSql" | "lastExecutedSql">;

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: ["id", "name"],
    column_types: ["INTEGER", "VARCHAR"],
    rows: [
      [1, "alice"],
      [2, "bob"],
    ],
    affected_rows: 0,
    execution_time_ms: 4,
    ...overrides,
  };
}

function tab(overrides: Partial<ResultTab> = {}): ResultTab {
  return { title: "Query 1", result: result(), resultBaseSql: "SELECT id, name FROM users", ...overrides };
}

describe("queryResultSelection", () => {
  it("returns nothing without a result, for execution errors, or when no row is loaded", () => {
    expect(queryResultSelection(undefined)).toBeUndefined();
    expect(queryResultSelection({ title: "Query 1" })).toBeUndefined();
    expect(queryResultSelection(tab({ result: result({ execution_error: true }) }))).toBeUndefined();
    expect(queryResultSelection(tab({ result: result({ rows: [] }) }))).toBeUndefined();
    expect(queryResultSelection(tab({ result: result({ columns: [], column_types: [] }) }))).toBeUndefined();
  });

  it("attaches the executed SQL, typed columns and rows as a query-result selection", () => {
    const selection = queryResultSelection(tab())!;
    expect(selection.source).toBe("query-result");
    expect(selection.label).toBe("Query 1");
    expect(selection.content).toContain("Executed SQL:\nSELECT id, name FROM users");
    expect(selection.content).toContain("Columns (2):\n- id (INTEGER)\n- name (VARCHAR)");
    expect(selection.content).toContain("Loaded rows: 2");
    expect(selection.content).toContain('Rows (showing 2 of 2 loaded):\n#1: id=1, name="alice"\n#2: id=2, name="bob"');
    expect(selection.content).not.toContain("Result truncated");
    expect(selection.truncated).toBeUndefined();
  });

  it("prefers the SQL the displayed result was actually run with", () => {
    const selection = queryResultSelection(tab({ resultSortedSql: "SELECT * FROM users ORDER BY id DESC" }))!;
    expect(selection.content).toContain("Executed SQL:\nSELECT * FROM users ORDER BY id DESC");
  });

  it("stops at the row cap and says how many loaded rows were left out", () => {
    const rows = Array.from({ length: 100 }, (_, index) => [index, `name-${index}`]);
    const selection = queryResultSelection(tab({ result: result({ rows }) }))!;
    expect(selection.content).toContain("Rows (showing 30 of 100 loaded):");
    expect(selection.content).toContain('#30: id=29, name="name-29"');
    expect(selection.content).not.toContain("#31:");
    expect(selection.content).toContain("(Result truncated: 70 more loaded row(s) not sent.)");
  });

  it("truncates individual values and the executed SQL instead of dumping them whole", () => {
    const selection = queryResultSelection(tab({ result: result({ rows: [[1, "x".repeat(300)]] }) }))!;
    expect(selection.content).toContain("x".repeat(199));
    expect(selection.content).not.toContain("x".repeat(201));
    expect(selection.content).toContain("…");

    const longSql = `SELECT ${"a".repeat(5_000)}`;
    const sqlSelection = queryResultSelection(tab({ resultBaseSql: longSql }))!;
    expect(sqlSelection.content).toContain("a".repeat(3_900));
    expect(sqlSelection.content).not.toContain("a".repeat(4_000));
  });

  it("keeps the whole payload inside the selection budget for wide result sets", () => {
    const columnCount = 50;
    const columns = Array.from({ length: columnCount }, (_, index) => `column_${index}`);
    const rows = Array.from({ length: 100 }, () => Array.from({ length: columnCount }, () => "v".repeat(300)));
    const selection = queryResultSelection(tab({ result: result({ columns, column_types: [], rows }) }))!;
    expect(selection.content.length).toBeLessThan(AI_SELECTION_CONTEXT_MAX_CHARS);
    expect(selection.content).toContain("Result truncated:");
  });

  it("clips one pathological column name instead of starving the rows", () => {
    const longColumn = "c".repeat(5_000);
    const selection = queryResultSelection(tab({ result: result({ columns: [longColumn], column_types: ["MEGA"], rows: [[42]] }) }))!;
    expect(selection.content.length).toBeLessThan(AI_SELECTION_CONTEXT_MAX_CHARS);
    const columnLine = selection.content.split("\n").find((line) => line.startsWith("- c"))!;
    // Clipped to the per-column cap, so the header cannot eat the whole budget.
    expect(columnLine.length).toBeLessThanOrEqual(200);
    expect(columnLine.endsWith("…")).toBe(true);
    // The row is still attached, and the value is actually sent: clipping the
    // joined line used to land inside the column name, before `=42`.
    const rowLine = selection.content.split("\n").find((line) => line.startsWith("#1:"))!;
    expect(rowLine).toContain("=42");
    expect(rowLine.length).toBeLessThanOrEqual(1_200);
  });

  it("stops at a cell boundary and still sends the values of the cells that fit", () => {
    const columns = ["a", "b", "c", "d", "e", "f"];
    // Each value is clipped by the per-value cap (~201 chars), so cells are wide
    // enough that only the first five fit inside the 1 200-char line budget.
    const rows = [columns.map((letter) => `${letter.toUpperCase()}_MARKER${letter.repeat(250)}`)];
    const selection = queryResultSelection(tab({ result: result({ columns, column_types: [], rows }) }))!;
    const rowLine = selection.content.split("\n").find((line) => line.startsWith("#1:"))!;
    expect(rowLine).toContain("A_MARKER");
    expect(rowLine).toContain("E_MARKER");
    expect(rowLine).not.toContain("F_MARKER");
    expect(rowLine.endsWith(", …")).toBe(true);
    expect(rowLine.length).toBeLessThanOrEqual(1_200);
  });

  it("sends a value even when the single column name is longer than the row budget", () => {
    const selection = queryResultSelection(tab({ result: result({ columns: ["d".repeat(5_000)], column_types: [], rows: [["VALUE_MARKER"]] }) }))!;
    const rowLine = selection.content.split("\n").find((line) => line.startsWith("#1:"))!;
    expect(rowLine).toContain("VALUE_MARKER");
    expect(rowLine.length).toBeLessThanOrEqual(1_200);
  });

  it("caps the column section for very wide results but still sends rows", () => {
    const columnCount = 500;
    const columns = Array.from({ length: columnCount }, (_, index) => `column_${index}`);
    const rows = Array.from({ length: 10 }, () => Array.from({ length: columnCount }, () => "v".repeat(120)));
    const selection = queryResultSelection(tab({ result: result({ columns, column_types: columns.map(() => "VARCHAR"), rows }) }))!;
    expect(selection.content.length).toBeLessThan(AI_SELECTION_CONTEXT_MAX_CHARS);
    expect(selection.content).toMatch(/… \(\d{3} more column\(s\) not listed\)/);
    expect(selection.content).toContain("Loaded rows: 10");
    expect(selection.content).toContain("#1:");
    // Worst-case header stays bounded by construction: SQL cap + column section
    // budget + the counted lines, i.e. far below the row budget.
    const columnSection = selection.content.split("Columns (500):\n")[1]!.split("\n\nLoaded rows: 10")[0]!;
    expect(columnSection.length).toBeLessThanOrEqual(2_100);
  });

  it("clips a row wider than the row budget and keeps the truncation footer intact", () => {
    const columnCount = 50;
    const columns = Array.from({ length: columnCount }, (_, index) => `column_${index}`);
    const rows = Array.from({ length: 20 }, () => Array.from({ length: columnCount }, () => "v".repeat(300)));
    const selection = queryResultSelection(tab({ result: result({ columns, column_types: [], rows }) }))!;
    expect(selection.content.length).toBeLessThan(AI_SELECTION_CONTEXT_MAX_CHARS);
    const firstRowLine = selection.content.split("\n").find((line) => line.startsWith("#1:"))!;
    // The clipped row is visible data, not a dropped row.
    expect(firstRowLine.length).toBeLessThanOrEqual(1_200);
    expect(firstRowLine).toContain("column_0=");
    expect(firstRowLine.endsWith("…")).toBe(true);
    expect(selection.content).toMatch(/\(Result truncated: \d+ more loaded row\(s\) not sent\.\)$/);
  });

  it("never cuts the truncation footer, even at the worst-case header size", () => {
    const columns = Array.from({ length: 500 }, (_, index) => `${"c".repeat(5_000)}_${index}`);
    const rows = Array.from({ length: 40 }, () => Array.from({ length: 500 }, () => "v".repeat(300)));
    const selection = queryResultSelection(
      tab({
        resultBaseSql: `SELECT ${"a".repeat(5_000)}`,
        result: result({ columns, column_types: columns.map(() => "VARCHAR"), rows }),
      }),
    )!;
    const header = selection.content.split("\n\nRows (showing")[0]!;
    // Header is bounded by construction: SQL cap (~4 000) + column section
    // budget (~2 100) + counted lines, i.e. well inside the row budget.
    expect(header.length).toBeLessThanOrEqual(6_300);
    expect(selection.content.length).toBeLessThan(AI_SELECTION_CONTEXT_MAX_CHARS);
    expect(selection.content).toContain("#1:");
    expect(selection.content).toMatch(/\(Result truncated: \d+ more loaded row\(s\) not sent\.\)$/);
  });
});

describe("queryErrorSelection", () => {
  it("still captures the executed SQL for Fix with AI", () => {
    expect(queryErrorSelection(tab())).toEqual({ source: "query-error", label: "Query 1", content: "SELECT id, name FROM users" });
    expect(queryErrorSelection(undefined)).toBeUndefined();
  });
});
