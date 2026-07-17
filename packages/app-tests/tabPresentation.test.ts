import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { activeResultRun, databaseDisplayNameForTab, executionSummaryItems, middleEllipsis, nextExecutionSummaryView, resultGridCacheKey, resultRunItems, resultSourceRange, resultSqlForGrid, tabDisplayTitle, tabModeLabel, tabularResultItems } from "../../apps/desktop/src/lib/tabs/tabPresentation.ts";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import type { ConnectionConfig, QueryResult, QueryTab } from "../../apps/desktop/src/types/database.ts";

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function conn(id: string): ConnectionConfig {
  return {
    id,
    name: "Prod",
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
  };
}

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    sql: "",
    isExecuting: false,
    mode: "query",
    ...overrides,
  };
}

function result(columns: string[], overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns,
    rows: [],
    affected_rows: 0,
    execution_time_ms: 1,
    ...overrides,
  };
}

test("query tab display title uses custom title when present", () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  useConnectionStore().addEphemeralConnection(conn("conn-1"));
  const t = (key: string) => key;

  try {
    assert.equal(tabDisplayTitle(queryTab(), t), "Prod@app");
    assert.equal(tabDisplayTitle(queryTab({ title: "Revenue checks", customTitle: true }), t), "Revenue checks");
  } finally {
    restoreStorage();
  }
});

test("jdbc tabs use the connection target when database is empty", () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  useConnectionStore().addEphemeralConnection({
    ...conn("conn-1"),
    db_type: "jdbc",
    connection_string: "jdbc:oracle:thin:@172.20.66.143:20001:XE",
  });
  const t = (key: string) => (key === "editor.noDatabase" ? "No database selected" : key);

  try {
    assert.equal(databaseDisplayNameForTab("conn-1", "", t), "XE");
    assert.equal(
      tabDisplayTitle(
        queryTab({
          database: "",
          mode: "data",
          tableMeta: {
            schema: "SYSTEM",
            tableName: "DBX_JDBC_TEST",
            columns: [],
            primaryKeys: ["ID"],
          },
        }),
        t,
      ),
      "DBX_JDBC_TEST@XE.SYSTEM",
    );
  } finally {
    restoreStorage();
  }
});

test("zookeeper tabs use key browser labels", () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  useConnectionStore().addEphemeralConnection({
    ...conn("conn-1"),
    name: "ZK Prod",
    db_type: "zookeeper",
    port: 2181,
  });
  const t = (key: string) => (key === "tabs.zookeeper" ? "ZooKeeper" : key);

  try {
    const tab = queryTab({ mode: "zookeeper", database: "", title: "ZooKeeper Keys" });
    assert.equal(tabDisplayTitle(tab, t), "ZK Prod@keys");
    assert.equal(tabModeLabel(tab, t), "ZooKeeper");
  } finally {
    restoreStorage();
  }
});

test("GridFS tabs use dedicated titles and labels", () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  useConnectionStore().addEphemeralConnection({
    ...conn("conn-1"),
    name: "uat-mongo",
    db_type: "mongodb",
    port: 27017,
  });
  const t = (key: string) => {
    if (key === "tabs.gridfs") return "GridFS";
    if (key === "tabs.mongo") return "Mongo";
    return key;
  };

  try {
    const managerTab = queryTab({
      title: "GridFS",
      database: "amazon",
      mode: "mongo-gridfs" as QueryTab["mode"],
      sql: "",
    });
    const bucketTab = queryTab({
      title: "amazon.NMDocumentData_acc001",
      database: "amazon",
      mode: "mongo-bucket",
      sql: "NMDocumentData_acc001",
      mongoBucket: { bucketName: "NMDocumentData_acc001" },
    });

    assert.equal(tabDisplayTitle(managerTab, t), "GridFS@amazon");
    assert.equal(tabDisplayTitle(bucketTab, t), "NMDocumentData_acc001@amazon");
    assert.equal(tabModeLabel(managerTab, t), "GridFS");
    assert.equal(tabModeLabel(bucketTab, t), "GridFS");
  } finally {
    restoreStorage();
  }
});

test("tabular result items hide statement results without returned columns", () => {
  const results = [result([]), result(["id"]), result([]), result(["name"])];

  assert.deepEqual(
    tabularResultItems(results).map((item) => ({ index: item.index, n: item.n, columns: item.result.columns })),
    [
      { index: 1, n: 1, columns: ["id"] },
      { index: 3, n: 2, columns: ["name"] },
    ],
  );
  assert.deepEqual(tabularResultItems([result([])]), []);
  assert.deepEqual(tabularResultItems(undefined), []);
});

test("tabular result items expose source labels when available", () => {
  const results = [result([]), result(["id"], { sourceLabel: "public.users", sourceStatement: "select * from public.users" }), result(["name"], { sourceStatement: "select id, name, email, created_at from users where active = true order by created_at desc" })];

  assert.deepEqual(
    tabularResultItems(results).map((item) => ({ index: item.index, n: item.n, label: item.label, title: item.title })),
    [
      { index: 1, n: 1, label: "public.users", title: "public.users" },
      { index: 2, n: 2, label: undefined, title: "select id, name, email, created_at from users where active = true order by created_at desc" },
    ],
  );
  assert.deepEqual(
    tabularResultItems([result(["id"], { sourceLabel: "db.users" })]).map((item) => item.label),
    ["db.users"],
  );
});

test("middleEllipsis preserves the beginning and end of long source labels", () => {
  assert.equal(middleEllipsis("easy_manager_tool.tool_monitor_data_index_item"), "easy_manage...index_item");
  assert.equal(middleEllipsis("aaa.apis"), "aaa.apis");
});

test("resultSourceRange uses the result index for repeated SQL", () => {
  const sql = "select * from users;\nselect * from users;";
  assert.deepEqual(resultSourceRange(sql, { sourceStatement: "select * from users" }, 1, "mysql"), {
    from: sql.lastIndexOf("select"),
    to: sql.length - 1,
    sql: "select * from users",
  });
  assert.equal(resultSourceRange("select * from users;", { sourceStatement: "select * from orders" }, 0, "mysql"), undefined);
});

test("resultSourceRange resolves newline-separated MongoDB commands", () => {
  const sql = "db.model_field_group.find({})\n\ndb.model_info.find({})";
  const sourceStatement = "db.model_info.find({})";

  assert.deepEqual(resultSourceRange(sql, { sourceStatement }, 1, "mongodb"), {
    from: sql.indexOf(sourceStatement),
    to: sql.length,
    sql: sourceStatement,
  });
});

test("resultSourceRange resolves newline-separated Redis commands", () => {
  const sql = "GET first\n\nGET second";
  const sourceStatement = "GET second";

  assert.deepEqual(resultSourceRange(sql, { sourceStatement }, 1, "redis"), {
    from: sql.indexOf(sourceStatement),
    to: sql.length,
    sql: sourceStatement,
  });
});

test("resultSqlForGrid prefers the active result source statement", () => {
  const tab = queryTab({
    sql: "select * from users; select * from orders",
    lastExecutedSql: "select * from users; select * from orders",
    resultBaseSql: "select * from users; select * from orders",
    result: result(["id"], { sourceStatement: "select * from orders" }),
  });

  assert.equal(resultSqlForGrid(tab), "select * from orders");
  assert.equal(resultSqlForGrid(queryTab({ sql: "select 1", resultBaseSql: "select 2" })), "select 2");
  assert.equal(resultSqlForGrid(queryTab({ sql: "select 1", lastExecutedSql: "select 3" })), "select 3");
});

test("result run items expose ordered labels and active state", () => {
  const tab = queryTab({
    activeResultRunId: "run-2",
    resultRuns: [
      {
        id: "run-1",
        title: "Run 1",
        sequence: 1,
        sql: "select 1",
        createdAt: 10,
        result: result(["one"]),
      },
      {
        id: "run-2",
        title: "Run 2",
        sequence: 2,
        sql: "select 2",
        createdAt: 20,
        result: result(["two"]),
      },
    ],
  });

  assert.deepEqual(resultRunItems(tab), [
    { id: "run-1", title: "Run 1", sequence: 1, active: false },
    { id: "run-2", title: "Run 2", sequence: 2, active: true },
  ]);
  assert.equal(activeResultRun(tab)?.id, "run-2");
  assert.deepEqual(
    resultRunItems(queryTab()).map((item) => item.title),
    [],
  );
});

test("result grid cache key includes result run id and statement result index", () => {
  const tab = queryTab({ activeResultRunId: "run-7", activeResultIndex: 3 });

  assert.equal(resultGridCacheKey(tab), "tab-1-run-7-3");
  assert.equal(resultGridCacheKey(queryTab({ activeResultIndex: undefined })), "tab-1-current-0");
});

test("execution summary items include table and non-table statement results", () => {
  const items = executionSummaryItems({
    results: [result([]), result(["id"]), { ...result(["Error"]), rows: [["boom"]] }],
  });

  assert.deepEqual(
    items.map((item) => ({
      index: item.index,
      hasTabularResult: item.hasTabularResult,
      returnedColumns: item.returnedColumns,
      returnedRows: item.returnedRows,
      isError: item.isError,
    })),
    [
      { index: 0, hasTabularResult: false, returnedColumns: 0, returnedRows: 0, isError: false },
      { index: 1, hasTabularResult: true, returnedColumns: 1, returnedRows: 0, isError: false },
      { index: 2, hasTabularResult: true, returnedColumns: 1, returnedRows: 1, isError: true },
    ],
  );
});

test("execution summary button toggles back to result only when result view is available", () => {
  assert.equal(nextExecutionSummaryView("result", true), "summary");
  assert.equal(nextExecutionSummaryView("chart", true), "summary");
  assert.equal(nextExecutionSummaryView("summary", true), "result");
  assert.equal(nextExecutionSummaryView("summary", false), "summary");
});
