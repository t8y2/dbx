import assert from "node:assert/strict";
import { computed, toRaw } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { test, vi } from "vitest";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";
import type { ColumnInfo, ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

vi.mock("vue-i18n", async () => {
  const actual = await vi.importActual<typeof import("vue-i18n")>("vue-i18n");
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

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
    name: id,
    db_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("data reload executes before slow metadata refresh completes", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const { useDataGridActions } = await import("../../apps/desktop/src/composables/useDataGridActions.ts");
  let executeBody: any;
  let resolveColumns!: (columns: ColumnInfo[]) => void;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/connection/check-health") {
      return Response.json(null);
    }
    if (url.pathname === "/api/schema/columns") {
      return Response.json(await new Promise<ColumnInfo[]>((resolve) => (resolveColumns = resolve)));
    }
    if (url.pathname === "/api/schema/indexes") {
      return Response.json([]);
    }
    if (url.pathname === "/api/query/build-table-select-sql") {
      return Response.json("SELECT * FROM `users` LIMIT 50 OFFSET 0");
    }
    if (url.pathname === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return Response.json([{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    }
    return new Response(`unexpected ${url.pathname}`, { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    connectionStore.addEphemeralConnection(conn("mysql-1"));
    const tabId = queryStore.createTab("mysql-1", "app", "users", "data");
    queryStore.setTableMeta(tabId, { tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] });
    const tab = queryStore.tabs.find((item) => item.id === tabId);
    assert.ok(tab);

    const actions = useDataGridActions(computed(() => tab));
    const reload = actions.onReloadData(undefined, undefined, undefined, undefined, 50, 0);

    await waitFor(() => !!executeBody, 5_000);
    assert.equal(executeBody.clientSessionId, tabId);
    assert.deepEqual(tab.result?.rows, [[1]]);

    await waitFor(() => typeof resolveColumns === "function");
    resolveColumns([
      {
        name: "id",
        data_type: "int",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        extra: null,
      },
    ]);
    await reload;
    await waitFor(() => tab.tableMeta?.columns.length === 1);
    assert.equal(tab.tableMeta?.primaryKeys[0], "id");
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("data reload preserves current page offset instead of resetting to page 1", async () => {
  // Verifies the fix: onReloadData called with offset=400 (page 5, pageSize=100)
  // should pass offset=400 to build-table-select-sql and store it in resultPageOffset,
  // rather than defaulting to offset=0.
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const { useDataGridActions } = await import("../../apps/desktop/src/composables/useDataGridActions.ts");
  let buildSqlOptions: any;
  let executePagination: any;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/connection/check-health") return Response.json(null);
    if (url.pathname === "/api/schema/columns") return Response.json([]);
    if (url.pathname === "/api/schema/indexes") return Response.json([]);
    if (url.pathname === "/api/query/build-table-select-sql") {
      buildSqlOptions = JSON.parse(String(init?.body ?? "{}"))?.options;
      return Response.json(`SELECT * FROM \`orders\` LIMIT 100 OFFSET ${buildSqlOptions?.offset ?? 0}`);
    }
    if (url.pathname === "/api/query/execute-multi") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      executePagination = body?.page_offset;
      return Response.json([{ columns: ["id"], rows: [[42]], affected_rows: 0, execution_time_ms: 1 }]);
    }
    return new Response(`unexpected ${url.pathname}`, { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    connectionStore.addEphemeralConnection(conn("mysql-1"));
    const tabId = queryStore.createTab("mysql-1", "app", "orders", "data");
    queryStore.setTableMeta(tabId, { tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] });
    const tab = queryStore.tabs.find((item) => item.id === tabId);
    assert.ok(tab);

    const actions = useDataGridActions(computed(() => tab));
    // Simulate refresh from page 5 with pageSize=100 → offset=400
    await actions.onReloadData(undefined, undefined, undefined, undefined, 100, 400);

    assert.equal(buildSqlOptions?.offset, 400, "build-table-select-sql must receive offset=400 to stay on page 5");
    assert.equal(buildSqlOptions?.limit, 100, "limit must be 100");
    assert.equal(tab.resultPageOffset, 400, "resultPageOffset must be 400 after reload to keep DataGrid on page 5");
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("infinite pagination fetches and appends only the next table segment", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const { useDataGridActions } = await import("../../apps/desktop/src/composables/useDataGridActions.ts");
  let buildSqlOptions: any;
  let executeBody: any;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/connection/check-health") return Response.json(null);
    if (url.pathname === "/api/query/build-table-select-sql") {
      buildSqlOptions = JSON.parse(String(init?.body ?? "{}"))?.options;
      return Response.json("SELECT * FROM `orders` LIMIT 100 OFFSET 100");
    }
    if (url.pathname === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return Response.json([{ columns: ["id"], rows: [[101], [102]], affected_rows: 0, execution_time_ms: 2 }]);
    }
    return new Response(`unexpected ${url.pathname}`, { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({ infiniteScroll: true, infiniteScrollMaxRows: 5000 });
    connectionStore.addEphemeralConnection(conn("mysql-1"));
    const tabId = queryStore.createTab("mysql-1", "app", "orders", "data");
    queryStore.setTableMeta(tabId, { tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] });
    const tab = queryStore.tabs.find((item) => item.id === tabId);
    assert.ok(tab);
    const firstRow = [1] as (string | number | boolean | null)[];
    tab.result = { columns: ["id"], rows: [firstRow], affected_rows: 0, execution_time_ms: 1 };
    tab.resultPageLimit = 100;
    tab.resultPageOffset = 0;

    const actions = useDataGridActions(computed(() => tab));
    await actions.onPaginate(1, 100);

    assert.equal(buildSqlOptions?.offset, 1);
    assert.equal(buildSqlOptions?.limit, 100);
    assert.equal(executeBody.maxRows, 100, "the backend receives one segment, not a cumulative limit");
    assert.equal(tab.result?.rows.length, 3);
    assert.equal(toRaw(tab.result?.rows[0]), firstRow, "existing row identity must survive append");
    assert.deepEqual(tab.result?.rows.slice(1), [[101], [102]]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query toolbar refresh reruns the complete multi-result SQL and keeps the active result", async () => {
  const restoreStorage = installMemoryStorage();
  const { useDataGridActions } = await import("../../apps/desktop/src/composables/useDataGridActions.ts");

  try {
    setActivePinia(createPinia());
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("mysql-1", "app", "query", "query");
    const tab = queryStore.tabs.find((item) => item.id === tabId);
    assert.ok(tab);

    const batchSql = "select * from users; select * from orders";
    const refreshedResults = [
      { columns: ["id"], rows: [[11]], affected_rows: 0, execution_time_ms: 1, sourceStatement: "select * from users" },
      { columns: ["id"], rows: [[22]], affected_rows: 0, execution_time_ms: 1, sourceStatement: "select * from orders" },
    ];
    tab.sql = batchSql;
    tab.lastExecutedSql = batchSql;
    tab.resultBaseSql = batchSql;
    tab.results = refreshedResults.map((result) => ({ ...result, rows: result.rows.map((row) => [...row]) }));
    tab.activeResultIndex = 1;
    tab.result = tab.results[1];
    tab.resultSortColumn = "id";
    tab.resultSortColumnIndex = 0;
    tab.resultSortDirection = "desc";
    tab.resultSortMode = "database";
    tab.resultSortedSql = "select * from orders order by id desc";

    const executeTabSql = vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (_tabId, _sql, options) => {
      assert.equal(tab.resultSortColumn, undefined);
      assert.equal(tab.resultSortColumnIndex, undefined);
      assert.equal(tab.resultSortDirection, undefined);
      assert.equal(tab.resultSortMode, undefined);
      assert.equal(tab.resultSortedSql, undefined);
      tab.results = refreshedResults;
      if (!options?.preserveActiveResultIndex) tab.activeResultIndex = 0;
      tab.result = refreshedResults[tab.activeResultIndex ?? 0];
    });
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData("select * from orders", undefined, undefined, undefined, 100, 0, "refresh");
    await actions.onReloadData("select * from orders", undefined, undefined, undefined, 100, 0, "refresh");

    assert.equal(executeTabSql.mock.calls.length, 2);
    for (const call of executeTabSql.mock.calls) {
      assert.equal(call[1], batchSql);
      assert.deepEqual(call[2], {
        resultBaseSql: batchSql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
        preserveActiveResultIndex: true,
      });
    }
    assert.equal(tab.results?.length, 2);
    assert.equal(tab.activeResultIndex, 1);
    assert.deepEqual(tab.result, refreshedResults[1]);
  } finally {
    restoreStorage();
  }
});
