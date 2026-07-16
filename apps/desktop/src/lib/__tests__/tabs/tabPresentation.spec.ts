import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionGroupDisplayName, middleEllipsis, queryResultBaseSql, queryResultExecutionSql, resultSourceRange, statementExecutionMarkers, tabTooltipLines, tabularResultItems } from "@/lib/tabs/tabPresentation";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const translations: Record<string, string> = {
  "tabs.tooltipConnection": "Connection:",
  "tabs.tooltipGroup": "Group:",
  "tabs.tooltipDatabase": "Database:",
  "connectionGroup.ungroupedLabel": "Ungrouped",
  "editor.noDatabase": "No database",
};

const translate = (key: string) => translations[key] ?? key;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  });
  setActivePinia(createPinia());
});

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
  it("preserves both ends when shortening long source labels", () => {
    expect(middleEllipsis("easy_manager_tool.tool_monitor_data_index_item")).toBe("easy_manage...index_item");
    expect(middleEllipsis("aaa.apis")).toBe("aaa.apis");
    expect(middleEllipsis("abcdef", 4)).toBe("a...");
  });

  it("uses the full source label as the result tab tooltip", () => {
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
    expect(item?.displayLabel).toBe("app.users");
    expect(item?.labelTruncated).toBe(false);
    expect(item?.title).toBe("app.users");
  });

  it("exposes a middle-shortened display label while retaining the full tooltip", () => {
    const [item] = tabularResultItems([
      {
        columns: ["id"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
        sourceLabel: "easy_manager_tool.tool_monitor_data_index_item",
        sourceStatement: "SELECT * FROM tool_monitor_data_index_item",
      },
    ]);

    expect(item?.displayLabel).toBe("easy_manage...index_item");
    expect(item?.labelTruncated).toBe(true);
    expect(item?.title).toBe("easy_manager_tool.tool_monitor_data_index_item");
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

describe("tab group presentation", () => {
  it("adds the full, live group path to tab tooltips", () => {
    const store = useConnectionStore();
    store.connections = [{ id: "conn-1", name: "PostgreSQL", db_type: "postgres", database: "app" } as ConnectionConfig];
    store.sidebarLayout = {
      groups: [
        { id: "project", name: "Project", collapsed: false },
        { id: "staging", name: "Staging", collapsed: false },
      ],
      order: [
        {
          type: "group",
          id: "project",
          children: [{ type: "group", id: "staging", children: [{ type: "connection", id: "conn-1" }] }],
        },
      ],
    };

    expect(connectionGroupDisplayName("conn-1", translate)).toBe("Project / Staging");
    expect(tabTooltipLines(queryTab({ database: "app" }), translate)).toEqual([
      { label: "Connection:", value: "PostgreSQL" },
      { label: "Group:", value: "Project / Staging" },
      { label: "Database:", value: "app" },
    ]);
  });

  it("labels a top-level connection as ungrouped", () => {
    const store = useConnectionStore();
    store.connections = [{ id: "conn-1", name: "PostgreSQL", db_type: "postgres", database: "app" } as ConnectionConfig];
    store.sidebarLayout = {
      groups: [],
      order: [{ type: "connection", id: "conn-1" }],
    };

    expect(connectionGroupDisplayName("conn-1", translate)).toBe("Ungrouped");
  });
});

describe("query result source ranges", () => {
  it("prefers the preserved editor range for a selected duplicate statement", () => {
    const sql = "SELECT * FROM users;\nSELECT * FROM users;";
    const from = sql.lastIndexOf("SELECT");

    expect(resultSourceRange(sql, { sourceStatement: "SELECT * FROM users", sourceFrom: from, sourceTo: sql.length - 1 }, 0, "mysql")).toEqual({
      from,
      to: sql.length - 1,
      sql: "SELECT * FROM users",
    });
  });

  it("uses the result index to distinguish repeated statements", () => {
    const sql = "SELECT * FROM users;\nSELECT * FROM users;";
    const range = resultSourceRange(sql, { sourceStatement: "SELECT * FROM users" }, 1, "mysql");

    expect(range).toEqual({
      from: sql.lastIndexOf("SELECT"),
      to: sql.length - 1,
      sql: "SELECT * FROM users",
    });
  });

  it("resolves newline-separated MongoDB commands with the Mongo shell parser", () => {
    const sql = "db.model_field_group.find({})\n\ndb.model_info.find({})";
    const sourceStatement = "db.model_info.find({})";
    const range = resultSourceRange(sql, { sourceStatement }, 1, "mongodb");

    expect(range).toEqual({
      from: sql.indexOf(sourceStatement),
      to: sql.length,
      sql: sourceStatement,
    });
  });

  it("resolves newline-separated Redis commands with the Redis parser", () => {
    const sql = "GET first\n\nGET second";
    const sourceStatement = "GET second";
    const range = resultSourceRange(sql, { sourceStatement }, 1, "redis");

    expect(range).toEqual({
      from: sql.indexOf(sourceStatement),
      to: sql.length,
      sql: sourceStatement,
    });
  });

  it("does not highlight a stale or ambiguous statement", () => {
    expect(resultSourceRange("SELECT * FROM users;", { sourceStatement: "SELECT * FROM orders" }, 0, "mysql")).toBeUndefined();
    expect(resultSourceRange("SELECT * FROM users; SELECT * FROM users;", { sourceStatement: "SELECT * FROM users" }, undefined, "mysql")).toBeUndefined();
  });
});

describe("statement execution markers", () => {
  it("projects explicit statement indexes to current editor lines", () => {
    const sql = "SELECT 1;\nSELECT * FROM missing;\nSELECT 3;";
    const secondFrom = sql.indexOf("SELECT *");
    const markers = statementExecutionMarkers(
      sql,
      [
        { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 0, sourceStatement: "SELECT 1", sourceFrom: 0, sourceTo: 8 },
        { columns: ["Error"], rows: [["no such table"]], affected_rows: 0, execution_time_ms: 1, execution_error: true, statement_index: 1, sourceStatement: "SELECT * FROM missing", sourceFrom: secondFrom, sourceTo: secondFrom + "SELECT * FROM missing".length },
      ],
      "sqlite",
      sql,
    );

    expect(markers).toEqual([
      { from: 0, status: "success", successCount: 1, errorCount: 0 },
      { from: secondFrom, status: "error", successCount: 0, errorCount: 1 },
    ]);
  });

  it("omits unindexed query-level errors and single-statement executions", () => {
    expect(statementExecutionMarkers("SELECT 1; SELECT 2;", [{ columns: ["Error"], rows: [["pool failed"]], affected_rows: 0, execution_time_ms: 1, execution_error: true }], "mysql", "SELECT 1; SELECT 2;")).toEqual([]);
    expect(statementExecutionMarkers("SELECT 1", [{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 0, sourceStatement: "SELECT 1", sourceFrom: 0, sourceTo: 8 }], "mysql", "SELECT 1")).toEqual([]);
  });

  it("keeps duplicate statements scoped by preserved absolute ranges", () => {
    const sql = "SELECT * FROM users;\nSELECT * FROM users;";
    const from = sql.lastIndexOf("SELECT");

    expect(statementExecutionMarkers(sql, [{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 1, sourceStatement: "SELECT * FROM users", sourceFrom: from, sourceTo: sql.length - 1 }], "mysql", sql)).toEqual([
      { from, status: "success", successCount: 1, errorCount: 0 },
    ]);
  });

  it("aggregates same-line statements with error precedence", () => {
    const sql = "SELECT 1; SELECT bad;";
    expect(
      statementExecutionMarkers(
        sql,
        [
          { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 0, sourceStatement: "SELECT 1", sourceFrom: 0, sourceTo: 8 },
          { columns: ["Error"], rows: [["bad"]], affected_rows: 0, execution_time_ms: 1, execution_error: true, statement_index: 1, sourceStatement: "SELECT bad", sourceFrom: 10, sourceTo: 20 },
        ],
        "mysql",
        sql,
      ),
    ).toEqual([{ from: 0, status: "error", successCount: 1, errorCount: 1 }]);
  });

  it("invalidates every marker after the editor document changes", () => {
    const executedSql = "SELECT 1;\nSELECT 2;";
    expect(statementExecutionMarkers(`-- edited\n${executedSql}`, [{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 0, sourceStatement: "SELECT 1" }], "mysql", "stale-editor-fingerprint", executedSql)).toEqual([]);
  });
});
