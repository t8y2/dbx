import { describe, expect, it } from "vitest";
import { queryResultBaseSql, queryResultExecutionSql, tabularResultItems } from "@/lib/tabs/tabPresentation";
import type { QueryTab } from "@/types/database";

function queryTab(overrides: Partial<QueryTab>): QueryTab {
  return {
    id: "tab-1",
    title: "SQL",
    connectionId: "conn-1",
    database: "db",
    sql: "SELECT * FROM dbo.first;\nSELECT * FROM dbo.second;",
    originalSql: "",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "query",
    ...overrides,
  } as QueryTab;
}

describe("query result SQL selection", () => {
  it("uses the active result source statement for multi-result query actions", () => {
    const tab = queryTab({
      resultBaseSql: "SELECT * FROM dbo.first;\nSELECT * FROM dbo.second;",
      result: {
        columns: ["id"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
        sourceStatement: "SELECT * FROM dbo.second",
      },
    });

    expect(queryResultBaseSql(tab)).toBe("SELECT * FROM dbo.second");
    expect(queryResultExecutionSql(tab)).toBe("SELECT * FROM dbo.second");
  });

  it("prefers the sorted SQL when the active result is sorted", () => {
    const tab = queryTab({
      resultSortedSql: "SELECT * FROM dbo.second ORDER BY id DESC",
      result: {
        columns: ["id"],
        rows: [[2]],
        affected_rows: 0,
        execution_time_ms: 1,
        sourceStatement: "SELECT * FROM dbo.second",
      },
    });

    expect(queryResultBaseSql(tab)).toBe("SELECT * FROM dbo.second");
    expect(queryResultExecutionSql(tab)).toBe("SELECT * FROM dbo.second ORDER BY id DESC");
  });
});

describe("query result labels", () => {
  it("uses source labels while keeping the full statement as the title", () => {
    const [item] = tabularResultItems([
      {
        columns: ["id"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
        sourceLabel: "app.users",
        sourceStatement: "SELECT * FROM users",
      },
    ]);

    expect(item?.label).toBe("app.users");
    expect(item?.title).toBe("SELECT * FROM users");
  });

  it("does not expose SQL text as a visible fallback label", () => {
    const [item] = tabularResultItems([
      {
        columns: ["value"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
        sourceStatement: "SELECT 1",
      },
    ]);

    expect(item?.label).toBeUndefined();
    expect(item?.title).toBe("SELECT 1");
  });
});
