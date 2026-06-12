import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { databaseDisplayNameForTab, executionSummaryItems, tabDisplayTitle, tabularResultItems } from "../../apps/desktop/src/lib/tabPresentation.ts";
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

function result(columns: string[]): QueryResult {
  return {
    columns,
    rows: [],
    affected_rows: 0,
    execution_time_ms: 1,
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
